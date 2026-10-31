//! Supervisor for the private local voice worker (`native/voice`): Chatterbox speech synthesis
//! and faster-whisper speech recognition, both on the CPU.
//!
//! The worker is a child process that speaks JSON lines over stdio. There is no TCP
//! listener, and the worker starts with Hugging Face in offline mode, so it cannot reach
//! the network at run time. Audio is relayed to exactly one window as Tauri events; no
//! credentials are involved anywhere on this path.
//!
//! The worker starts on demand and loads the synthesis models only when speech is wanted, so a
//! worker launched just to transcribe the microphone answers within a few seconds.

use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const EVENT_STATUS: &str = "miss-minutes:voice-status";
pub const EVENT_CHUNK: &str = "miss-minutes:voice-chunk";
pub const EVENT_END: &str = "miss-minutes:voice-end";

/// The released chatterbox-tts package ships only the Turbo architecture.
pub const MODEL: &str = "turbo";
const MODEL_FILE: &str = "t3_turbo_v1.safetensors";
const MAX_TEXT_BYTES: usize = 6000;
const STDERR_TAIL_LINES: usize = 12;

const MIN_TRANSCRIBE_SECONDS: f64 = 0.1;
const MAX_TRANSCRIBE_SECONDS: f64 = 120.0;
/// Covers starting Python and loading the recognizer on first use. Decoding itself runs many
/// times faster than real time, so the per-second allowance only matters for a wedged worker.
const TRANSCRIBE_BASE_TIMEOUT: Duration = Duration::from_secs(45);
/// Real-time factors measured on very short clips are dominated by fixed overhead.
const MIN_RTF_SAMPLE_SECONDS: f64 = 1.0;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// The worker, its Python environment and the model files are all present.
    pub installed: bool,
    pub starting: bool,
    pub ready: bool,
    pub model: Option<String>,
    /// "builtin" for the model's own neutral voice, otherwise the prepared voice name.
    pub voice: Option<String>,
    pub sample_rate: Option<u32>,
    pub load_seconds: Option<f64>,
    pub last_error: Option<String>,
    /// Why the engine is not installed, phrased as the next step to take.
    pub detail: Option<String>,
    /// Seconds of speech rendered per second of compute, from warm-up and later renders.
    /// Below 1.0 the engine cannot keep up with a live reply on this PC.
    pub realtime_factor: Option<f64>,
    /// The speech recognition model, once the worker has loaded it.
    pub transcriber: Option<String>,
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    epoch: u64,
}

struct PendingTranscript {
    epoch: u64,
    reply: mpsc::Sender<Result<String, String>>,
}

/// State shared with the threads that read the worker's output.
struct Shared {
    status: Mutex<VoiceStatus>,
    /// Job id -> label of the window that should play it.
    targets: Mutex<HashMap<String, String>>,
    /// Transcription requests waiting for the worker, by request id.
    pending: Mutex<HashMap<String, PendingTranscript>>,
    /// Set by the first `start`. A worker launched only to transcribe has nobody to notify.
    app: Mutex<Option<AppHandle>>,
    /// Incremented for every worker process, so a late reader never clobbers a newer worker.
    epoch: AtomicU64,
}

struct Inner {
    root: Option<PathBuf>,
    worker: Mutex<Option<Worker>>,
    shared: Arc<Shared>,
    next_request: AtomicU64,
}

pub struct VoiceHost {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|_| "Voice state is unavailable.".to_owned())
}

impl VoiceHost {
    pub fn new() -> Self {
        let host = Self {
            inner: Arc::new(Inner {
                root: locate_root(),
                worker: Mutex::new(None),
                shared: Arc::new(Shared {
                    status: Mutex::new(VoiceStatus::default()),
                    targets: Mutex::new(HashMap::new()),
                    pending: Mutex::new(HashMap::new()),
                    app: Mutex::new(None),
                    epoch: AtomicU64::new(0),
                }),
                next_request: AtomicU64::new(0),
            }),
        };
        host.inner.refresh_installed();
        host
    }

    pub fn status(&self) -> VoiceStatus {
        self.inner.refresh_installed();
        self.inner.shared.status.lock().map(|status| status.clone()).unwrap_or_default()
    }

    pub fn is_ready(&self) -> bool {
        self.inner.shared.status.lock().map(|status| status.ready).unwrap_or(false)
    }

    /// Starts the worker if needed and asks it to load the speech models. Returns immediately;
    /// readiness is announced through `EVENT_STATUS` once the models are loaded.
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let inner = &self.inner;
        if let Ok(mut slot) = inner.shared.app.lock() {
            *slot = Some(app.clone());
        }
        let root = inner
            .root
            .clone()
            .ok_or_else(|| "The voice engine folder (native/voice) was not found.".to_owned())?;
        if let Some(problem) = install_problem(&root) {
            inner.set_error(&problem);
            return Err(problem);
        }
        inner.ensure_worker(&root)?;

        let load = {
            let mut status = lock(&inner.shared.status)?;
            if status.ready || status.starting {
                false // already loading or loaded
            } else {
                status.starting = true;
                status.last_error = None;
                status.model = Some(MODEL.to_owned());
                true
            }
        };
        if load {
            if let Err(error) = inner.send(&json!({ "op": "load_tts" })) {
                inner.set_error(&error);
                return Err(error);
            }
            inner.shared.emit_status();
        }
        Ok(())
    }

    /// Queues speech. A newer request replaces the one in progress, which is how an
    /// interruption should behave in a live assistant.
    pub fn speak(&self, id: &str, text: &str, style: &str, target: &str) -> Result<(), String> {
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(format!("Speech must contain 1 to {MAX_TEXT_BYTES} bytes of text."));
        }
        if !self.is_ready() {
            return Err("The local voice is not ready.".to_owned());
        }
        if let Ok(mut targets) = self.inner.shared.targets.lock() {
            if targets.len() > 64 {
                targets.clear(); // a stuck job can never accumulate
            }
            targets.insert(id.to_owned(), target.to_owned());
        }
        let line = json!({ "op": "speak", "id": id, "text": text, "style": style });
        self.inner.send(&line)
    }

    pub fn cancel(&self) -> Result<(), String> {
        self.inner.send(&json!({ "op": "stop" }))
    }

    /// Local speech-to-text. `pcm16_base64` is mono 16-bit little-endian PCM at `sample_rate` Hz.
    /// Starts the worker on demand. The wait happens on a blocking thread, never on the main
    /// thread or an async executor thread.
    pub async fn transcribe(&self, pcm16_base64: &str, sample_rate: u32) -> Result<String, String> {
        let seconds = validate_pcm16(pcm16_base64, sample_rate)?;
        let inner = Arc::clone(&self.inner);
        let audio = pcm16_base64.to_owned();
        tauri::async_runtime::spawn_blocking(move || inner.transcribe_blocking(audio, sample_rate, seconds))
            .await
            .map_err(|error| format!("Speech recognition stopped unexpectedly: {error}"))?
    }

    /// Asks the worker to exit, then makes sure it did.
    pub fn shutdown(&self) {
        let Ok(mut slot) = self.inner.worker.lock() else { return };
        let Some(mut worker) = slot.take() else { return };
        let _ = writeln!(worker.stdin, "{}", json!({ "op": "shutdown" }));
        let _ = worker.stdin.flush();
        drop(worker.stdin);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(worker.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = worker.child.kill();
        let _ = worker.child.wait();
    }
}

impl Inner {
    fn refresh_installed(&self) {
        let detail = match &self.root {
            None => Some("The voice engine folder (native/voice) was not found next to this app.".to_owned()),
            Some(root) => install_problem(root),
        };
        if let Ok(mut status) = self.shared.status.lock() {
            status.installed = detail.is_none();
            status.detail = detail;
        }
    }

    /// Returns the epoch of the running worker, starting a new one if none is alive.
    fn ensure_worker(&self, root: &Path) -> Result<u64, String> {
        let mut slot = lock(&self.worker)?;
        if let Some(worker) = slot.as_mut() {
            if matches!(worker.child.try_wait(), Ok(None)) {
                return Ok(worker.epoch);
            }
            slot.take(); // the previous worker exited; start a fresh one
        }

        let mut command = Command::new(python_exe(root));
        command
            .args(["-X", "utf8", "-m", "miss_voice.worker", "--model", MODEL, "--tts", "lazy"])
            .current_dir(root)
            .env("PYTHONUNBUFFERED", "1")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        // Spawned into the app's job object so the worker ends with the app, even on a crash.
        let mut child = crate::job::spawn_in_job(&mut command)
            .map_err(|error| format!("Cannot start the voice worker: {error}"))?;
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The voice worker's pipes are unavailable.".to_owned());
        };

        let epoch = self.shared.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut status) = self.shared.status.lock() {
            status.starting = false;
            status.ready = false;
            status.transcriber = None;
        }
        let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
        spawn_stderr_drain(stderr, Arc::clone(&stderr_tail));
        spawn_reader(Arc::clone(&self.shared), epoch, stdout, stderr_tail);

        *slot = Some(Worker { child, stdin, epoch });
        Ok(epoch)
    }

    fn transcribe_blocking(&self, audio: String, sample_rate: u32, seconds: f64) -> Result<String, String> {
        let root = self
            .root
            .clone()
            .ok_or_else(|| "The voice engine folder (native/voice) was not found.".to_owned())?;
        if let Some(problem) = recognition_problem(&root) {
            return Err(problem);
        }
        let epoch = self.ensure_worker(&root)?;

        let id = format!("stt-{}", self.next_request.fetch_add(1, Ordering::Relaxed) + 1);
        let (reply, receiver) = mpsc::channel();
        lock(&self.shared.pending)?.insert(id.clone(), PendingTranscript { epoch, reply });
        let forget = || {
            if let Ok(mut pending) = self.shared.pending.lock() {
                pending.remove(&id);
            }
        };

        // Built by hand so the megabytes of audio are moved, not cloned, into the request.
        let mut request = serde_json::Map::new();
        request.insert("op".to_owned(), Value::from("transcribe"));
        request.insert("id".to_owned(), Value::from(id.as_str()));
        request.insert("sampleRate".to_owned(), Value::from(sample_rate));
        request.insert("pcm16".to_owned(), Value::String(audio));
        if let Err(error) = self.send(&Value::Object(request)) {
            forget();
            return Err(error);
        }
        match receiver.recv_timeout(TRANSCRIBE_BASE_TIMEOUT + Duration::from_secs_f64(seconds)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                forget();
                Err("Speech recognition timed out.".to_owned())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("The voice worker stopped before it finished transcribing.".to_owned())
            }
        }
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        // One write per request: a recording is megabytes of base64, and the worker reads lines.
        let mut line = serde_json::to_string(message).map_err(|error| format!("Cannot encode a voice request: {error}"))?;
        line.push('\n');
        let mut slot = lock(&self.worker)?;
        let worker = slot.as_mut().ok_or_else(|| "The voice worker is not running.".to_owned())?;
        worker
            .stdin
            .write_all(line.as_bytes())
            .and_then(|()| worker.stdin.flush())
            .map_err(|error| format!("The voice worker is not accepting requests: {error}"))
    }

    fn set_error(&self, message: &str) {
        if let Ok(mut status) = self.shared.status.lock() {
            status.last_error = Some(message.to_owned());
            status.starting = false;
            status.ready = false;
        }
        self.shared.emit_status();
    }
}

impl Shared {
    fn app(&self) -> Option<AppHandle> {
        self.app.lock().ok().and_then(|app| app.clone())
    }

    fn emit_status(&self) {
        let Some(app) = self.app() else { return };
        if let Ok(status) = self.status.lock() {
            let _ = app.emit_to("main", EVENT_STATUS, status.clone());
        }
    }

    fn emit_end(&self, label: String, id: &str, kind: &str, message: Option<String>) {
        if let Some(app) = self.app() {
            let _ = app.emit_to(label, EVENT_END, json!({ "id": id, "event": kind, "message": message }));
        }
    }

    fn handle_event(&self, epoch: u64, event: Value) {
        let kind = event.get("event").and_then(Value::as_str).unwrap_or_default();
        let id = event.get("id").and_then(Value::as_str).map(str::to_owned);

        match kind {
            "ready" => {
                if let Ok(mut status) = self.status.lock() {
                    status.starting = false;
                    status.ready = true;
                    status.last_error = None;
                    status.model = event.get("model").and_then(Value::as_str).map(str::to_owned);
                    status.voice = event.get("voice").and_then(Value::as_str).map(str::to_owned);
                    status.sample_rate = event
                        .get("sampleRate")
                        .and_then(Value::as_u64)
                        .and_then(|rate| u32::try_from(rate).ok());
                    status.load_seconds = event.get("loadSeconds").and_then(Value::as_f64);
                    status.realtime_factor = event.get("realtimeFactor").and_then(Value::as_f64);
                }
                self.emit_status();
            }
            "chunk" => {
                let label = id.as_ref().and_then(|id| self.targets.lock().ok().and_then(|map| map.get(id).cloned()));
                if let (Some(label), Some(app)) = (label, self.app()) {
                    let _ = app.emit_to(label, EVENT_CHUNK, event);
                }
            }
            "done" | "cancelled" | "error" => {
                let message = event.get("message").and_then(Value::as_str).map(str::to_owned);
                let fatal = event.get("fatal").and_then(Value::as_bool).unwrap_or(false);
                if let Some(id) = &id {
                    let label = self.targets.lock().ok().and_then(|mut map| map.remove(id));
                    if let Some(label) = label {
                        self.emit_end(label, id, kind, message.clone());
                    }
                }
                if kind == "done" && !event.get("cached").and_then(Value::as_bool).unwrap_or(false) {
                    let audio = event.get("audioSeconds").and_then(Value::as_f64).unwrap_or(0.0);
                    let synth = event.get("synthSeconds").and_then(Value::as_f64).unwrap_or(0.0);
                    if audio >= MIN_RTF_SAMPLE_SECONDS && synth > 0.0 {
                        if let Ok(mut status) = self.status.lock() {
                            status.realtime_factor = Some((audio / synth * 1000.0).round() / 1000.0);
                        }
                        self.emit_status();
                    }
                }
                if kind == "error" {
                    if let Ok(mut status) = self.status.lock() {
                        status.last_error = message;
                        if fatal {
                            status.starting = false;
                            status.ready = false;
                        }
                    }
                    self.emit_status();
                }
            }
            "transcript" => {
                let Some(id) = id else { return };
                let waiter = self.pending.lock().ok().and_then(|mut pending| pending.remove(&id));
                let result = match event.get("error").and_then(Value::as_str) {
                    Some(error) => Err(error.to_owned()),
                    None => {
                        if let Some(model) = event.get("model").and_then(Value::as_str) {
                            if let Ok(mut status) = self.status.lock() {
                                status.transcriber = Some(model.to_owned());
                            }
                        }
                        Ok(event.get("text").and_then(Value::as_str).unwrap_or_default().to_owned())
                    }
                };
                if let Some(waiter) = waiter.filter(|waiter| waiter.epoch == epoch) {
                    let _ = waiter.reply.send(result); // the requester may have timed out already
                }
            }
            _ => {}
        }
    }

    /// stdout closed: the worker exited. Report why, using the tail of its stderr, and fail
    /// everything that was waiting on it.
    fn handle_exit(&self, epoch: u64, tail: String) {
        let reason = if tail.is_empty() {
            "The voice worker stopped.".to_owned()
        } else {
            format!("The voice worker stopped: {tail}")
        };

        let orphans: Vec<PendingTranscript> = self
            .pending
            .lock()
            .map(|mut pending| {
                let ids: Vec<String> = pending
                    .iter()
                    .filter(|(_, waiter)| waiter.epoch == epoch)
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter().filter_map(|id| pending.remove(&id)).collect()
            })
            .unwrap_or_default();
        for waiter in orphans {
            let _ = waiter.reply.send(Err(reason.clone()));
        }

        if self.epoch.load(Ordering::SeqCst) != epoch {
            return; // a newer worker owns the status and the playback targets now
        }
        if let Ok(mut status) = self.status.lock() {
            let was_up = status.ready || status.starting;
            status.ready = false;
            status.starting = false;
            status.transcriber = None;
            if was_up && status.last_error.is_none() && !tail.is_empty() {
                status.last_error = Some(reason.clone());
            }
        }
        // Windows waiting for audio from this worker would otherwise wait forever.
        let jobs: Vec<(String, String)> = self
            .targets
            .lock()
            .map(|mut map| map.drain().collect())
            .unwrap_or_default();
        for (id, label) in jobs {
            self.emit_end(label, &id, "error", Some(reason.clone()));
        }
        self.emit_status();
    }
}

fn spawn_stderr_drain(stderr: std::process::ChildStderr, tail: Arc<Mutex<VecDeque<String>>>) {
    let _ = thread::Builder::new().name("voice-stderr".to_owned()).spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut tail) = tail.lock() {
                if tail.len() >= STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        }
    });
}

fn spawn_reader(shared: Arc<Shared>, epoch: u64, stdout: ChildStdout, stderr_tail: Arc<Mutex<VecDeque<String>>>) {
    let _ = thread::Builder::new().name("voice-reader".to_owned()).spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                shared.handle_event(epoch, event);
            }
        }
        let tail = stderr_tail
            .lock()
            .map(|tail| tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default();
        shared.handle_exit(epoch, tail);
    });
}

/// Checks that `audio` is base64 of whole 16-bit samples and returns its duration in seconds.
/// The worker decodes it; this only rejects malformed or oversized input before it is sent.
fn validate_pcm16(audio: &str, sample_rate: u32) -> Result<f64, String> {
    if !(8_000..=48_000).contains(&sample_rate) {
        return Err("The recording's sample rate must be between 8000 and 48000 Hz.".to_owned());
    }
    let bytes = audio.as_bytes();
    let max_len = (MAX_TRANSCRIBE_SECONDS * 48_000.0 * 2.0 / 3.0 * 4.0) as usize + 4;
    if bytes.len() > max_len {
        return Err(format!("Recordings longer than {MAX_TRANSCRIBE_SECONDS:.0} seconds are not transcribed."));
    }
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return Err("The recording is not valid base64.".to_owned());
    }
    let padding = bytes.iter().rev().take_while(|&&byte| byte == b'=').count();
    let body = &bytes[..bytes.len() - padding];
    if padding > 2 || !body.iter().all(|&byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/') {
        return Err("The recording is not valid base64.".to_owned());
    }
    let decoded = bytes.len() / 4 * 3 - padding;
    if decoded % 2 != 0 {
        return Err("The recording is not 16-bit PCM.".to_owned());
    }
    let seconds = (decoded / 2) as f64 / f64::from(sample_rate);
    if seconds < MIN_TRANSCRIBE_SECONDS {
        return Err("The recording is too short to transcribe.".to_owned());
    }
    if seconds > MAX_TRANSCRIBE_SECONDS {
        return Err(format!("Recordings longer than {MAX_TRANSCRIBE_SECONDS:.0} seconds are not transcribed."));
    }
    Ok(seconds)
}

fn python_exe(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join(".venv").join("Scripts").join("python.exe")
    } else {
        root.join(".venv").join("bin").join("python")
    }
}

/// `None` when everything speech synthesis needs is present; otherwise the next step for the owner.
fn install_problem(root: &Path) -> Option<String> {
    if !python_exe(root).is_file() {
        return Some("The voice engine is not installed. Run native/voice/setup.ps1 once.".to_owned());
    }
    if !root.join("miss_voice").join("worker.py").is_file() {
        return Some("The voice worker module is missing from native/voice.".to_owned());
    }
    if !root.join("models").join("chatterbox").join(MODEL_FILE).is_file() {
        return Some("The voice models are not downloaded yet. Run native/voice/setup.ps1.".to_owned());
    }
    None
}

/// `None` when speech recognition can run; otherwise the next step for the owner.
fn recognition_problem(root: &Path) -> Option<String> {
    if !python_exe(root).is_file() || !root.join("miss_voice").join("stt.py").is_file() {
        return Some("Voice input on the desktop needs the local voice engine. Run native/voice/setup.ps1 once.".to_owned());
    }
    if !root.join("models").join("whisper").join("base.en").join("model.bin").is_file() {
        return Some("The speech recognition model is not downloaded yet. Run native/voice/setup.ps1.".to_owned());
    }
    None
}

fn locate_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("MISS_MINUTES_VOICE_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    // Development builds: native/desktop/src-tauri -> native/voice
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("voice"));
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().skip(1).take(6) {
            candidates.push(ancestor.join("native").join("voice"));
        }
    }
    candidates
        .into_iter()
        .filter_map(|candidate| candidate.canonicalize().ok())
        .find(|candidate| candidate.join("miss_voice").is_dir())
        .map(strip_extended_prefix)
}

/// `canonicalize` yields `\\?\C:\...` on Windows, which some child tools mishandle.
fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}
