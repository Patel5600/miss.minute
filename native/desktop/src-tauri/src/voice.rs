//! Supervisor for the private local voice worker (`native/voice`): speech synthesis in her cloned
//! voice (Kyutai Pocket TTS or Chatterbox, whichever `miss_voice.benchmark` measured as the live
//! engine) and faster-whisper speech recognition, all on the CPU.
//!
//! The worker is a child process that speaks JSON lines over stdio. There is no TCP
//! listener, and the worker starts with Hugging Face in offline mode, so it cannot reach
//! the network at run time. Audio is relayed to exactly one window as Tauri events; no
//! credentials are involved anywhere on this path.
//!
//! The worker starts on demand and loads the synthesis models only when speech is wanted, so a
//! worker launched just to transcribe the microphone answers within a few seconds. A reply can be
//! spoken while the model is still writing it: `speak_stream` appends sentences to one utterance,
//! which plays as a single continuous stream and ends with `speak_end`.

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

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const EVENT_STATUS: &str = "miss-minutes:voice-status";
pub const EVENT_CHUNK: &str = "miss-minutes:voice-chunk";
pub const EVENT_END: &str = "miss-minutes:voice-end";
pub const EVENT_ACTIVITY: &str = "miss-minutes:voice-activity";

/// Chatterbox variant passed to the worker; the released chatterbox-tts package ships only Turbo.
pub const MODEL: &str = "turbo";
const CHATTERBOX_FILE: &str = "t3_turbo_v1.safetensors";
/// Pocket TTS checkpoint in `models/pocket` (see `native/voice/download_models.ps1`).
const POCKET_CHECKPOINT: &str = "english_2026-04";
const POCKET_FILES: [&str; 2] = ["model.safetensors", "tokenizer.json"];
const MAX_TEXT_BYTES: usize = 6000;
/// Utterance ids chosen by the dashboard are short ASCII tokens (the worker caps ids at 64).
const MAX_ID_LEN: usize = 64;
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
    /// "cloned:reference" while the worker speaks in the voice cloned from the prepared
    /// reference, "builtin" for the engine's own voice. Reported by the worker once it is ready.
    pub voice: Option<String>,
    /// Speech engine the worker loaded ("pocket" or "chatterbox") and its display name.
    pub engine: Option<String>,
    pub engine_label: Option<String>,
    /// How the engine was chosen: "measured" (the benchmark), "override" or "default".
    pub engine_choice: Option<String>,
    /// Why the engine's own voice is used instead of the cloned one, when it is.
    pub voice_note: Option<String>,
    /// The recorded reason the reference may be cloned (`work/reference/rights.json`).
    pub rights_basis: Option<String>,
    pub sample_rate: Option<u32>,
    pub load_seconds: Option<f64>,
    /// Milliseconds from a request to its first audio, measured at warm-up.
    pub first_chunk_ms: Option<f64>,
    pub last_error: Option<String>,
    /// Why the engine is not installed, phrased as the next step to take.
    pub detail: Option<String>,
    /// Seconds of speech rendered per second of compute, from warm-up and later renders.
    /// Below 1.0 the engine cannot keep up with a live reply on this PC.
    pub realtime_factor: Option<f64>,
    /// The speech recognition model, once the worker has loaded it.
    pub transcriber: Option<String>,
    /// What is prepared on disk, known before the worker starts.
    pub configured: ConfiguredVoice,
}

/// The cloned voice as prepared on disk: the reference, its rights record and the benchmark's
/// choice of live engine. The worker re-checks that the rights record matches the reference.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredVoice {
    /// A prepared reference and its rights record both exist.
    pub reference: bool,
    pub rights_basis: Option<String>,
    /// Engine the worker will load: the benchmark's choice, else Pocket TTS when installed.
    pub engine: Option<String>,
    pub engine_label: Option<String>,
    /// True when `engine` comes from a benchmark run (`work/voice-config.json`).
    pub measured: bool,
    /// Benchmark numbers for that engine. RTF is synthesis time divided by audio time (below 1 is
    /// faster than real time); similarity is the speaker-embedding cosine against the reference,
    /// normalized between an unrelated voice (0) and the reference itself (1).
    pub rtf: Option<f64>,
    pub first_chunk_ms: Option<f64>,
    pub similarity: Option<f64>,
    pub similarity_norm: Option<f64>,
    pub wer: Option<f64>,
    /// Thresholds the chosen engine missed, if any.
    pub shortfall: Vec<String>,
    pub chosen_at: Option<String>,
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
        inner.refresh_installed();
        let problem = inner.shared.status.lock().ok().and_then(|status| status.detail.clone());
        if let Some(problem) = problem {
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
                // Until the worker reports what it loaded, show what it is about to load.
                status.engine = status.configured.engine.clone();
                status.engine_label = status.configured.engine_label.clone();
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
        self.send_speech(id, text, style, target, false)
    }

    /// Adds a sentence to the streamed utterance `id`, starting it (and replacing anything else
    /// being spoken) on first use. The audio plays as one continuous stream until `speak_end`.
    pub fn speak_stream(&self, id: &str, text: &str, style: &str, target: &str) -> Result<(), String> {
        self.send_speech(id, text, style, target, true)
    }

    /// Closes the streamed utterance `id`; its `done` follows once the last sentence is rendered.
    pub fn speak_end(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let registered = self.inner.shared.targets.lock().map(|targets| targets.contains_key(id)).unwrap_or(false);
        if !registered {
            return Ok(()); // already finished, cancelled or replaced
        }
        self.inner.send(&json!({ "op": "speak_end", "id": id }))
    }

    fn send_speech(&self, id: &str, text: &str, style: &str, target: &str, stream: bool) -> Result<(), String> {
        validate_id(id)?;
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
        let mut line = json!({ "op": "speak", "id": id, "text": text, "style": style });
        if stream {
            line["stream"] = Value::Bool(true);
        }
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
        let (detail, configured) = match &self.root {
            None => (
                Some("The voice engine folder (native/voice) was not found next to this app.".to_owned()),
                ConfiguredVoice::default(),
            ),
            Some(root) => {
                let configured = configured_voice(root);
                (install_problem(root, configured.engine.as_deref()), configured)
            }
        };
        if let Ok(mut status) = self.shared.status.lock() {
            status.installed = detail.is_none();
            status.detail = detail;
            status.configured = configured;
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

fn mouth_frame_for_pcm(encoded: Option<&str>) -> Option<u8> {
    let bytes = BASE64.decode(encoded?).ok()?;
    let samples = bytes.chunks_exact(2);
    let count = samples.len();
    if count == 0 {
        return Some(0);
    }
    let energy = samples
        .map(|pair| {
            let value = f64::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0;
            value * value
        })
        .sum::<f64>();
    let rms = (energy / count as f64).sqrt();
    Some(if rms < 0.014 {
        0
    } else if rms < 0.045 {
        1
    } else if rms < 0.095 {
        2
    } else if rms < 0.17 {
        3
    } else {
        4
    })
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

    fn emit_activity(&self, label: &str, event: &Value) {
        let Some(app) = self.app() else { return };
        let kind = event.get("event").and_then(Value::as_str).unwrap_or_default();
        let payload = json!({
            "id": event.get("id").and_then(Value::as_str),
            "event": kind,
            "playbackOwner": label,
            "index": event.get("index").and_then(Value::as_u64),
            "last": event.get("last").and_then(Value::as_bool),
            "text": event.get("text").and_then(Value::as_str),
            "mouth": mouth_frame_for_pcm(event.get("pcm16").and_then(Value::as_str)),
            "message": event.get("message").and_then(Value::as_str),
        });
        // No PCM is broadcast. Both windows get only the lifecycle, subtitle and mouth frame.
        let _ = app.emit(EVENT_ACTIVITY, payload);
    }

    fn emit_end(&self, label: String, id: &str, kind: &str, message: Option<String>) {
        if let Some(app) = self.app() {
            let payload = json!({
                "id": id,
                "event": kind,
                "message": message,
                "playbackOwner": label.as_str(),
            });
            let _ = app.emit_to(&label, EVENT_END, payload.clone());
            self.emit_activity(&label, &payload);
        }
    }

    fn handle_event(&self, epoch: u64, mut event: Value) {
        let kind = event.get("event").and_then(Value::as_str).unwrap_or_default().to_owned();
        let id = event.get("id").and_then(Value::as_str).map(str::to_owned);

        match kind.as_str() {
            "ready" => {
                if let Ok(mut status) = self.status.lock() {
                    status.starting = false;
                    status.ready = true;
                    status.last_error = None;
                    let text = |key: &str| event.get(key).and_then(Value::as_str).map(str::to_owned);
                    status.model = text("model");
                    status.voice = text("voice");
                    status.engine = text("engine");
                    status.engine_label = text("engineLabel");
                    status.engine_choice = text("engineChoice");
                    status.voice_note = text("voiceNote");
                    status.rights_basis = text("rightsBasis");
                    status.first_chunk_ms = event.get("firstChunkMs").and_then(Value::as_f64);
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
                    if let Some(fields) = event.as_object_mut() {
                        fields.insert("playbackOwner".to_owned(), Value::String(label.clone()));
                    }
                    self.emit_activity(&label, &event);
                    // PCM goes to one named WebView only. The owner field makes the JS side reject
                    // a duplicated or accidentally broadcast event as a second line of defense.
                    let _ = app.emit_to(&label, EVENT_CHUNK, event);
                }
            }
            "done" | "cancelled" | "error" => {
                let message = event.get("message").and_then(Value::as_str).map(str::to_owned);
                let fatal = event.get("fatal").and_then(Value::as_bool).unwrap_or(false);
                if let Some(id) = &id {
                    let label = self.targets.lock().ok().and_then(|mut map| map.remove(id));
                    if let Some(label) = label {
                        self.emit_end(label, id, kind.as_str(), message.clone());
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

fn pocket_installed(root: &Path) -> bool {
    let dir = root.join("models").join("pocket").join(POCKET_CHECKPOINT);
    POCKET_FILES.iter().all(|file| dir.join(file).is_file())
}

fn engine_label(engine: &str) -> &'static str {
    match engine {
        "pocket" => "Pocket TTS",
        _ => "Chatterbox Turbo",
    }
}

fn read_json(path: &Path) -> Option<Value> {
    // Both files are a few hundred bytes; anything larger is not ours.
    let bytes = std::fs::read(path).ok().filter(|bytes| bytes.len() <= 64 * 1024)?;
    serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object)
}

/// The cloned voice as prepared on disk, mirroring how the worker chooses its engine: the
/// benchmark's measured choice (`work/voice-config.json`), else Pocket TTS when it is installed,
/// else Chatterbox.
fn configured_voice(root: &Path) -> ConfiguredVoice {
    let work = root.join("work");
    let reference_dir = work.join("reference");
    let rights = read_json(&reference_dir.join("rights.json"));
    let rights_basis = rights
        .as_ref()
        .and_then(|record| record.get("basis"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let reference = reference_dir.join("reference.wav").is_file() && rights_basis.is_some();

    let config = read_json(&work.join("voice-config.json"));
    let measured_engine = config
        .as_ref()
        .and_then(|config| config.get("engine"))
        .and_then(Value::as_str)
        .filter(|engine| matches!(*engine, "pocket" | "chatterbox"))
        .map(str::to_owned);
    let measured = measured_engine.is_some();
    let engine = measured_engine
        .unwrap_or_else(|| (if pocket_installed(root) { "pocket" } else { "chatterbox" }).to_owned());
    let summary = config.as_ref().filter(|_| measured).and_then(|config| config.get("summary"));
    let number = |key: &str| summary.and_then(|summary| summary.get(key)).and_then(Value::as_f64);
    let shortfall: Vec<String> = config
        .as_ref()
        .filter(|_| measured)
        .and_then(|config| config.get("shortfall"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).take(8).map(str::to_owned).collect())
        .unwrap_or_default();
    ConfiguredVoice {
        reference,
        rights_basis,
        engine_label: Some(engine_label(&engine).to_owned()),
        engine: Some(engine),
        measured,
        rtf: number("rtf"),
        first_chunk_ms: number("first_chunk_ms_max"),
        similarity: number("similarity"),
        similarity_norm: number("similarity_norm"),
        wer: number("wer"),
        shortfall,
        chosen_at: config
            .as_ref()
            .filter(|_| measured)
            .and_then(|config| config.get("chosen_at"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

/// `None` when everything speech synthesis needs is present; otherwise the next step for the owner.
fn install_problem(root: &Path, engine: Option<&str>) -> Option<String> {
    if !python_exe(root).is_file() {
        return Some("The voice engine is not installed. Run native/voice/setup.ps1 once.".to_owned());
    }
    if !root.join("miss_voice").join("worker.py").is_file() {
        return Some("The voice worker module is missing from native/voice.".to_owned());
    }
    let models = match engine {
        Some("pocket") => pocket_installed(root),
        _ => root.join("models").join("chatterbox").join(CHATTERBOX_FILE).is_file(),
    };
    if !models {
        return Some("The voice models are not downloaded yet. Run native/voice/setup.ps1.".to_owned());
    }
    None
}

/// Utterance ids come from the dashboard; keep them to short ASCII tokens.
fn validate_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(format!("A speech id must be 1 to {MAX_ID_LEN} letters, digits, '-' or '_'."))
    }
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
