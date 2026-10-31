import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BookUser, CalendarClock, Settings as SettingsIcon, Timer, Volume2, VolumeX, X } from 'lucide-react';
import type { AISettings, CharacterCue, Emotion, Gesture } from './types';
import { initializeSettings, loadSettings, onSettingsChange, PROVIDER_LABELS, saveSettings } from './agent/settings';
import { startScheduler, type SchedulerAlert } from './agent/scheduler';
import { onCue } from './character/cues';
import { MissMinutesRig } from './character/MissMinutesRig';
import { ActivityLog, Dossier, SacredTimeline, Toolbelt } from './panels';
import { RANDOM_CLICK_QUOTES } from './data/tvaLore';
import { voiceService } from './services/voiceService';
import { soundEffects } from './utils/audioEffects';
import { invokeNative, isDesktopRuntime } from './desktop/bridge';
import { recordUtterance, pcm16ToBase64, CAPTURE_RATE } from './agent/realtime/micCapture';
import { Stage, type StageStatus } from './app/Stage';
import { ChatPanel } from './app/ChatPanel';
import { Settings } from './app/Settings';
import { speaker, type SpeakerState } from './app/speaker';
import { useConversation } from './app/useConversation';

type Tab = 'timeline' | 'toolbelt' | 'dossier' | 'activity';

const TABS: Array<{ id: Tab; label: string; icon: typeof Timer }> = [
  { id: 'timeline', label: 'Sacred Timeline', icon: CalendarClock },
  { id: 'toolbelt', label: 'Timers, to-dos & notes', icon: Timer },
  { id: 'dossier', label: 'What she knows', icon: BookUser },
  { id: 'activity', label: 'Activity', icon: Activity },
];

const GREETING = "Hey y'all! I'm Miss Minutes. Ask me anything, or hand me a job: timers, reminders, your schedule, notes, the weather. For all time. Always!";

const IDLE_LINES = [
  "Yoo-hoo! Still there, sugar? Your timeline's awful quiet.",
  "Just checkin' in. Anything you need me to keep track of?",
  "Tick-tock! If there's a reminder rattlin' around in your head, hand it to me.",
  "I've been standin' here so long my hands went numb. Well, more numb.",
  "Don't mind me, darlin'. Just keepin' an eye on the Sacred Timeline.",
];

interface Toast { id: string; title: string; body: string }

export function App() {
  const desktop = isDesktopRuntime();
  const [settings, setSettingsState] = useState<AISettings>(() => loadSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('timeline');

  const [emotion, setEmotion] = useState<Emotion>('cheerful');
  const [gesture, setGesture] = useState<{ g: Gesture; k: number }>({ g: 'wave', k: 1 });
  const [voice, setVoice] = useState<SpeakerState>(speaker.current);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [line, setLine] = useState(GREETING);
  const [handsFree, setHandsFree] = useState(false);
  const stopListening = useRef<(() => void) | null>(null);
  const lastActivity = useRef(Date.now());

  const setSettings = useCallback((next: AISettings) => {
    setSettingsState(saveSettings(next));
  }, []);

  // Settings: migrate legacy keys, load remembered secrets, follow changes from other windows.
  useEffect(() => {
    void initializeSettings().then(setSettingsState).catch(() => undefined);
    return onSettingsChange(setSettingsState);
  }, []);

  useEffect(() => { soundEffects.setMuted(!settings.soundEffects); }, [settings.soundEffects]);

  // Voice output state drives her mouth and subtitles.
  useEffect(() => speaker.subscribe(state => {
    setVoice(state);
    if (state.line) setLine(state.line);
  }), []);

  // Character cues from the brain, scheduler and tools.
  const applyCue = useCallback((cue: CharacterCue) => {
    if (cue.emotion) setEmotion(cue.emotion);
    if (cue.gesture && cue.gesture !== 'none') setGesture(previous => ({ g: cue.gesture as Gesture, k: previous.k + 1 }));
  }, []);
  useEffect(() => onCue(applyCue), [applyCue]);

  const conversation = useConversation(settings, () => undefined);
  const { busy, approvals, messages } = conversation;

  // Relax back to her resting mood a little after she finishes.
  useEffect(() => {
    if (busy || voice.speaking) return;
    const id = window.setTimeout(() => { setEmotion('cheerful'); setGesture(g => ({ g: 'none', k: g.k })); }, 3500);
    return () => window.clearTimeout(id);
  }, [busy, voice.speaking]);

  // While thinking (before any words arrive) she looks thoughtful.
  const lastReply = messages[messages.length - 1];
  const waitingForWords = busy && lastReply?.sender === 'miss_minute' && !lastReply.text;
  useEffect(() => {
    if (waitingForWords) applyCue({ emotion: 'thinking', gesture: 'think' });
  }, [waitingForWords, applyCue]);

  // Show the reply text as subtitles if she is not speaking it.
  useEffect(() => {
    if (!settings.voiceEnabled && lastReply?.sender === 'miss_minute' && lastReply.text) setLine(lastReply.text);
  }, [lastReply, settings.voiceEnabled]);

  // Alarms, timers and reminders.
  useEffect(() => {
    const stop = startScheduler({
      speak: (text, cue) => {
        applyCue(cue);
        speaker.say(text, settingsRef.current);
        setLine(text);
      },
      onAlert: (alert: SchedulerAlert) => {
        if (alert.missed) return;
        setToasts(list => [...list.slice(-3), { id: alert.id, title: alert.title, body: alert.body }]);
        window.setTimeout(() => setToasts(list => list.filter(t => t.id !== alert.id)), 15000);
      },
    });
    return stop;
  }, [applyCue]);

  // Voice input: Web Speech in Chrome/Edge; on desktop, local Whisper through the host.
  const toggleMic = useCallback(() => {
    if (listening) { stopListening.current?.(); return; }
    lastActivity.current = Date.now();
    speaker.stop();
    setInterim('');
    applyCue({ emotion: 'surprised' });
    const micFailed = (message: string) => {
      setListening(false);
      setHandsFree(false);
      stopListening.current = null;
      conversation.note(message, 'system');
    };
    if (desktop) {
      const session = recordUtterance({ silenceMs: 1100, noSpeechMs: 8000, maxSeconds: 45 });
      setListening(true);
      stopListening.current = () => session.stop();
      void session.result.then(async recording => {
        setListening(false);
        stopListening.current = null;
        if (!recording.speech) return;
        setInterim('Transcribing…');
        try {
          const text = await invokeNative<string>('voice_transcribe', { audio: pcm16ToBase64(recording.pcm), sampleRate: CAPTURE_RATE });
          setInterim('');
          if (text.trim()) void conversation.send(text);
        } catch (error) {
          setInterim('');
          micFailed(`I couldn't hear that properly: ${String(error)}`);
        }
      }).catch((error: unknown) => micFailed(`Microphone unavailable: ${String(error)}`));
      return;
    }
    const handle = voiceService.startListening(
      (text, isFinal) => {
        setInterim(text);
        if (isFinal) {
          setListening(false);
          setInterim('');
          if (text.trim()) void conversation.send(text);
        }
      },
      error => {
        // Silence just ends the turn in hands-free mode; real failures stop it.
        if (error === 'no-speech' || error === 'aborted') { setListening(false); return; }
        micFailed(`Microphone: ${error}`);
      },
      () => setListening(false),
    );
    if (handle) { setListening(true); stopListening.current = () => handle.stop(); }
    else setHandsFree(false);
  }, [listening, desktop, conversation, applyCue]);

  // Hands-free: whenever she is done talking (and not working), listen again.
  const toggleMicRef = useRef(toggleMic);
  toggleMicRef.current = toggleMic;
  useEffect(() => {
    if (!handsFree || busy || voice.speaking || listening || approvals.length) return;
    const id = window.setTimeout(() => toggleMicRef.current(), 700);
    return () => window.clearTimeout(id);
  }, [handsFree, busy, voice.speaking, listening, approvals.length]);

  const toggleHandsFree = useCallback(() => {
    setHandsFree(on => {
      if (on) { stopListening.current?.(); speaker.stop(); }
      else applyCue({ emotion: 'cheerful', gesture: 'wave' });
      return !on;
    });
  }, [applyCue]);

  // Idle chatter: after a long quiet spell she says something, at most every few minutes.
  useEffect(() => {
    const mark = () => { lastActivity.current = Date.now(); };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
    const id = window.setInterval(() => {
      const s = settingsRef.current;
      if (s.ambientChatter === false || document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity.current < 6 * 60_000 || speaker.current.speaking) return;
      lastActivity.current = Date.now();
      const quiet = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)];
      applyCue({ emotion: 'sassy', gesture: Math.random() < 0.5 ? 'knock' : 'hips' });
      setLine(quiet);
      speaker.say(quiet, s);
    }, 30_000);
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
      window.clearInterval(id);
    };
  }, [applyCue]);

  const poke = useCallback(() => {
    const quote = RANDOM_CLICK_QUOTES[Math.floor(Math.random() * RANDOM_CLICK_QUOTES.length)];
    soundEffects.playClockTick(false);
    applyCue({ emotion: 'winking', gesture: 'wave' });
    setLine(quote);
    speaker.say(quote, settingsRef.current);
  }, [applyCue]);

  const status: StageStatus = approvals.length ? 'approval'
    : listening ? 'listening'
      : waitingForWords ? 'thinking'
        : busy ? 'working' : 'idle';

  const providerLabel = useMemo(() => PROVIDER_LABELS[settings.provider], [settings.provider]);

  return (
    <div className="min-h-screen bg-[#0d0905] text-amber-50">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_70%_45%_at_30%_0%,rgba(245,130,30,0.14),transparent)]" />

      {/* Top bar */}
      <header className="relative z-20 flex items-center justify-between gap-3 border-b border-amber-900/50 bg-black/40 px-4 py-2.5 backdrop-blur sm:px-6">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11">
            <MissMinutesRig emotion="cheerful" snapshot={{ time: 0, gaze: { x: 0, y: 0 } }} gaze="none" skin="classic" title="Miss Minutes" />
          </div>
          <div>
            <h1 className="text-lg font-black uppercase tracking-[0.18em] text-amber-400">Miss Minutes</h1>
            <p className="text-[10px] uppercase tracking-[0.25em] text-amber-500/70">Time Variance Authority</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setSettingsOpen(true)} className="hidden rounded-full border border-amber-800/60 px-3 py-1 text-xs text-amber-300 hover:border-amber-500 sm:block">
            {providerLabel}{settings.model ? ` · ${settings.model}` : ''}
          </button>
          <button type="button" onClick={() => { if (settings.voiceEnabled) speaker.stop(); setSettings({ ...settings, voiceEnabled: !settings.voiceEnabled }); }}
            aria-label={settings.voiceEnabled ? 'Mute her voice' : 'Unmute her voice'}
            className="grid h-9 w-9 place-items-center rounded-xl border border-amber-800/60 text-amber-300 hover:text-amber-100">
            {settings.voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Settings" className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500 text-neutral-950 hover:bg-amber-400">
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid max-w-[1500px] grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-12">
        <section className="lg:col-span-5">
          <Stage
            emotion={emotion}
            gesture={gesture.g}
            gestureKey={gesture.k}
            speaking={voice.speaking}
            mouth={voice.mouth}
            status={status}
            line={voice.speaking || !settings.voiceEnabled || line === GREETING ? line : ''}
            skin={settings.hologramMode ? 'hologram' : 'classic'}
            onPoke={() => { if (voice.speaking && handsFree) speaker.stop(); else poke(); }}
            handsFree={handsFree}
            onToggleHandsFree={toggleHandsFree}
          />
        </section>

        <section className="lg:col-span-7 lg:h-[min(62vh,560px)] lg:min-h-[380px]">
          <ChatPanel
            messages={conversation.messages}
            chats={conversation.chats}
            chatId={conversation.chatId}
            busy={busy}
            approvals={approvals}
            listening={listening}
            interim={interim}
            onSend={(text, attachments) => void conversation.send(text, attachments)}
            onStop={conversation.stop}
            onDecide={conversation.decide}
            onMic={toggleMic}
            onNewChat={() => void conversation.newChat()}
            onOpenChat={conversation.openChat}
            onDeleteChat={id => void conversation.removeChat(id)}
          />
        </section>

        <section className="lg:col-span-12">
          <nav className="mb-3 flex flex-wrap gap-2" aria-label="Panels">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" onClick={() => setTab(id)}
                className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm ${tab === id ? 'border-amber-400 bg-amber-500/20 text-amber-50' : 'border-amber-900/60 bg-black/30 text-amber-300 hover:border-amber-600'}`}>
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </nav>
          {tab === 'timeline' && <SacredTimeline />}
          {tab === 'toolbelt' && <Toolbelt />}
          {tab === 'dossier' && <Dossier homeCity={settings.homeCity} onHomeCityChange={city => setSettings({ ...settings, homeCity: city })} />}
          {tab === 'activity' && <ActivityLog />}
        </section>
      </main>

      {/* Alarm / reminder toasts */}
      <div className="fixed right-4 top-16 z-[10030] flex w-80 flex-col gap-2">
        {toasts.map(toast => (
          <div key={toast.id} className="rounded-2xl border border-amber-500/70 bg-[#1d130a] p-3 shadow-2xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-amber-200">{toast.title}</p>
                {toast.body && <p className="text-xs text-amber-300/80">{toast.body}</p>}
              </div>
              <button type="button" onClick={() => setToasts(list => list.filter(t => t.id !== toast.id))} aria-label="Dismiss" className="text-amber-400 hover:text-amber-100"><X className="h-4 w-4" /></button>
            </div>
          </div>
        ))}
      </div>

      <Settings open={settingsOpen} settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
