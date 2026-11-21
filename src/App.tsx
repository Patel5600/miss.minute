import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AudioLines,
  BookUser,
  CalendarClock,
  Check,
  ChevronDown,
  Fingerprint,
  GitBranch,
  Lock,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  Pencil,
  PhoneCall,
  PhoneOff,
  Plug,
  Radar,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Timer,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { AISettings, CharacterCue, Emotion, Gesture } from './types';
import { defaultSettings, initializeSettings, loadSettings, onSettingsChange, PROVIDER_LABELS, saveSettings } from './agent/settings';
import { startScheduler, type SchedulerAlert } from './agent/scheduler';
import { containsWakePhrase } from './agent/wakePhrases';
import { onCue } from './character/cues';
import { MissMinutesRig } from './character/MissMinutesRig';
import {
  ActivityLog,
  CallingPanel,
  ConnectorsPanel,
  Dossier,
  MissionsPanel,
  OffersPanel,
  SacredTimeline,
  SecurityConsolePanel,
  Toolbelt,
} from './panels';
import { RANDOM_CLICK_QUOTES } from './data/tvaLore';
import { voiceService } from './services/voiceService';
import { soundEffects } from './utils/audioEffects';
import { invokeNative, isDesktopRuntime, listenNative, type DesktopOwnerStatus } from './desktop/bridge';
import { ensureDesktopOwnerDataReady, type ChatRecord } from './store/db';
import { recordUtterance, pcm16ToBase64, CAPTURE_RATE } from './agent/realtime/micCapture';
import { Stage, type StageStatus } from './app/Stage';
import { ChatPanel } from './app/ChatPanel';
import { Settings, type SettingsTab } from './app/Settings';
import { speaker, type SpeakerState } from './app/speaker';
import { useConversation } from './app/useConversation';

type AppView =
  | 'chat'
  | 'timeline'
  | 'toolbelt'
  | 'dossier'
  | 'missions'
  | 'offers'
  | 'calling'
  | 'connectors'
  | 'security'
  | 'activity';

const WORKSPACE_VIEWS: Array<{ id: AppView; label: string; icon: typeof Timer; privateView?: boolean }> = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'timeline', label: 'Sacred Timeline', icon: CalendarClock, privateView: true },
  { id: 'toolbelt', label: 'Timers & Notes', icon: Timer, privateView: true },
  { id: 'dossier', label: 'Dossier', icon: BookUser, privateView: true },
  { id: 'missions', label: 'Mission DAGs', icon: GitBranch, privateView: true },
  { id: 'offers', label: 'Offers Radar', icon: Radar, privateView: true },
  { id: 'calling', label: 'Calling Guard', icon: PhoneCall, privateView: true },
  { id: 'connectors', label: 'MCP Connectors', icon: Plug, privateView: true },
  { id: 'security', label: 'Security & Wake', icon: ShieldCheck, privateView: true },
  { id: 'activity', label: 'Activity', icon: Activity, privateView: true },
];

const GREETING = "Hey y'all! I'm Miss Minutes. Ask me anything, or hand me a job: timers, reminders, your schedule, notes, the weather. For all time. Always!";

const IDLE_LINES = [
  "Yoo-hoo! Still there? Your timeline's awful quiet.",
  "Just checkin' in. Anything you need me to keep track of?",
  "Tick-tock! If there's a reminder rattlin' around in your head, hand it to me.",
  "I've been standin' here so long my hands went numb. Well, more numb.",
  "Don't mind me. Just keepin' an eye on the Sacred Timeline.",
];

interface Toast { id: string; title: string; body: string }

function groupChatsByDate(chats: ChatRecord[]): Array<{ label: string; items: ChatRecord[] }> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const yesterdayMs = todayMs - 86_400_000;
  const weekMs = todayMs - 7 * 86_400_000;
  const buckets: Record<string, ChatRecord[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Earlier: [],
  };
  for (const chat of chats) {
    if (chat.updatedAt >= todayMs) buckets.Today.push(chat);
    else if (chat.updatedAt >= yesterdayMs) buckets.Yesterday.push(chat);
    else if (chat.updatedAt >= weekMs) buckets['Previous 7 days'].push(chat);
    else buckets.Earlier.push(chat);
  }
  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

export function App() {
  const desktop = isDesktopRuntime();
  const [ownerStatus, setOwnerStatus] = useState<DesktopOwnerStatus | null>(null);
  const ownerStatusRef = useRef<DesktopOwnerStatus | null>(ownerStatus);
  ownerStatusRef.current = ownerStatus;
  const [ownerDataReady, setOwnerDataReady] = useState(() => !desktop);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationRetryNonce, setMigrationRetryNonce] = useState(0);
  const [authBusy, setAuthBusy] = useState(false);

  const ownerAuthenticated = !desktop || ownerStatus?.authenticated === true;
  const ownerCandidate = desktop ? ownerStatus?.mode === 'owner_candidate' : false;
  const guestMode = desktop ? !ownerAuthenticated : false;
  const desktopReady = !desktop || (ownerAuthenticated && ownerDataReady);
  const ownerAuthRef = useRef(ownerAuthenticated);
  ownerAuthRef.current = ownerAuthenticated;

  const [settings, setSettingsState] = useState<AISettings>(() => (desktop ? defaultSettings() : loadSettings()));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);

  const [view, setView] = useState<AppView>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 900 : true));
  const [stageOpen, setStageOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1220 : false));

  const [chatFilter, setChatFilter] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
    if (desktop && !ownerAuthRef.current) {
      setSettingsState(next);
      return;
    }
    setSettingsState(saveSettings(next));
  }, [desktop]);

  // Poll desktop owner authority and follow live host transitions.
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const poll = () => {
      void invokeNative<DesktopOwnerStatus>('owner_status')
        .then(next => { if (active) setOwnerStatus(next); })
        .catch(() => { if (active) setOwnerStatus(null); });
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    let stopListener: (() => void) | undefined;
    void listenNative<DesktopOwnerStatus>('miss-minutes:owner-state', payload => {
      if (active) setOwnerStatus(payload);
    }).then(unlisten => {
      if (active) stopListener = unlisten;
      else unlisten();
    }).catch(() => undefined);
    return () => {
      active = false;
      window.clearInterval(timer);
      stopListener?.();
    };
  }, [desktop]);

  // Settings & encrypted SQLCipher migration on owner authentication.
  useEffect(() => {
    if (!desktop) {
      void initializeSettings().then(setSettingsState).catch(() => undefined);
      return onSettingsChange(setSettingsState);
    }
    if (!ownerAuthenticated) {
      setOwnerDataReady(false);
      setMigrationError(null);
      setSettingsState(defaultSettings());
      return;
    }
    let cancelled = false;
    let stopSettingsListener: (() => void) | undefined;
    setMigrationError(null);
    void (async () => {
      try {
        await ensureDesktopOwnerDataReady();
        if (cancelled) return;
        setOwnerDataReady(true);
        const loaded = await initializeSettings();
        if (cancelled) return;
        setSettingsState(loaded);
        stopSettingsListener = onSettingsChange(setSettingsState);
      } catch (error) {
        if (cancelled) return;
        setOwnerDataReady(false);
        setMigrationError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
      stopSettingsListener?.();
    };
  }, [desktop, ownerAuthenticated, migrationRetryNonce]);

  const handleVerifyOwner = useCallback(async () => {
    if (!desktop || authBusy) return;
    setAuthBusy(true);
    try {
      const next = await invokeNative<DesktopOwnerStatus>('owner_authenticate');
      setOwnerStatus(next);
    } catch {
      try {
        const refreshed = await invokeNative<DesktopOwnerStatus>('owner_status');
        setOwnerStatus(refreshed);
      } catch {
        // Leave current locked state unchanged.
      }
    } finally {
      setAuthBusy(false);
    }
  }, [desktop, authBusy]);

  const handleLockOwner = useCallback(async () => {
    if (!desktop || authBusy) return;
    setAuthBusy(true);
    try {
      const next = await invokeNative<DesktopOwnerStatus>('owner_lock');
      setOwnerStatus(next);
    } finally {
      setAuthBusy(false);
    }
  }, [desktop, authBusy]);

  const openSettingsTab = useCallback((desired?: SettingsTab) => {
    setSettingsInitialTab(desired);
    setSettingsOpen(true);
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

  const conversation = useConversation(settings, () => undefined, guestMode || !desktopReady, ownerCandidate);
  const { busy, approvals, messages, chats, chatId } = conversation;

  // Desktop emergency kill switch and local wake engine events.
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let stopKill: (() => void) | undefined;
    let stopWake: (() => void) | undefined;
    void listenNative<{ reason?: string; at?: number }>('miss-minutes:killed', () => {
      if (!active) return;
      speaker.stop();
      stopListening.current?.();
      setListening(false);
      setHandsFree(false);
      void invokeNative<DesktopOwnerStatus>('owner_status').then(next => { if (active) setOwnerStatus(next); }).catch(() => undefined);
      conversation.note('Emergency kill switch engaged — owner session locked and audio stopped.', 'system');
    }).then(unlisten => {
      if (active) stopKill = unlisten;
      else unlisten();
    }).catch(() => undefined);
    void listenNative<{ phrase?: string; confidence?: number }>('miss-minutes:wake', () => {
      if (!active) return;
      applyCue({ emotion: 'cheerful', gesture: 'wave' });
      void invokeNative<DesktopOwnerStatus>('owner_status').then(next => { if (active) setOwnerStatus(next); }).catch(() => undefined);
    }).then(unlisten => {
      if (active) stopWake = unlisten;
      else unlisten();
    }).catch(() => undefined);
    return () => {
      active = false;
      stopKill?.();
      stopWake?.();
    };
    // conversation.note only depends on store functions; omit `conversation` object churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, applyCue]);

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
    if (desktop && !desktopReady) return;
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
  }, [applyCue, desktop, desktopReady]);

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
          if (text.trim()) {
            const currentOwner = ownerStatusRef.current;
            if (currentOwner?.enrolled && !currentOwner.authenticated && containsWakePhrase(text)) {
              try {
                const updated = await invokeNative<DesktopOwnerStatus>('owner_candidate_signal', {
                  signal: 'wake',
                  confidence: 0.85,
                  livenessPassed: false,
                  engaged: true,
                });
                setOwnerStatus(updated);
              } catch {
                // Keep fail-closed state if candidate update fails.
              }
            }
            void conversation.send(text);
          }
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
      if (on) {
        stopListening.current?.();
        speaker.stop();
      } else {
        applyCue({ emotion: 'cheerful', gesture: 'wave' });
        if (typeof window !== 'undefined' && window.innerWidth >= 1024) setStageOpen(true);
      }
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

  // Escape closes slide-over drawers on compact viewports or settings edit state.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editingChatId) {
        setEditingChatId(null);
        return;
      }
      if (confirmDeleteId) {
        setConfirmDeleteId(null);
        return;
      }
      if (typeof window !== 'undefined' && window.innerWidth < 768 && sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingChatId, confirmDeleteId, sidebarOpen]);

  const status: StageStatus = approvals.length ? 'approval'
    : listening ? 'listening'
      : waitingForWords ? 'thinking'
        : busy ? 'working' : 'idle';

  const providerLabel = useMemo(() => PROVIDER_LABELS[settings.provider], [settings.provider]);

  const filteredChats = useMemo(() => {
    const query = chatFilter.trim().toLowerCase();
    if (!query) return chats;
    return chats.filter(c => (c.title || 'New chat').toLowerCase().includes(query));
  }, [chats, chatFilter]);

  const groupedChats = useMemo(() => groupChatsByDate(filteredChats), [filteredChats]);

  const authorityNotice = useMemo(() => {
    if (!desktop) return undefined;
    if (ownerCandidate) {
      return 'Owner candidate signal detected · Verify with Windows Hello to unlock private memory and controls.';
    }
    if (!ownerAuthenticated) {
      return 'Guest Mode · Temporary conversation with generic public tools only.';
    }
    if (!ownerDataReady) {
      return 'Unlocking encrypted local owner vault…';
    }
    return undefined;
  }, [desktop, ownerCandidate, ownerAuthenticated, ownerDataReady]);

  const activeWorkspace = WORKSPACE_VIEWS.find(v => v.id === view) ?? WORKSPACE_VIEWS[0];

  const closeSidebarOnNarrow = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  const commitRename = async (id: string) => {
    const next = editingTitle.trim();
    setEditingChatId(null);
    if (!next) return;
    await conversation.renameChat(id, next);
  };

  return (
    <div className="relative flex h-dvh w-screen overflow-hidden bg-[#0B0908] text-[#F5EFE6]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_65%_40%_at_55%_0%,rgba(255,122,26,0.08),transparent)]" />

      {/* Mobile / narrow backdrop for slide-over sidebar */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-[10020] bg-black/65 backdrop-blur-xs md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Sidebar (ChatGPT / Gemini rail) */}
      {sidebarOpen && (
        <aside
          aria-label="Conversation navigation"
          className="fixed inset-y-0 left-0 z-[10025] flex w-[272px] shrink-0 flex-col border-r border-white/[0.07] bg-[#100D0A] md:static md:z-20"
        >
          {/* Sidebar Brand + Collapse */}
          <div className="flex h-14 shrink-0 items-center justify-between px-3">
            <button
              type="button"
              onClick={() => { setView('chat'); closeSidebarOnNarrow(); }}
              className="flex cursor-pointer items-center gap-2.5 rounded-xl px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              <div className="h-8 w-8 shrink-0">
                <MissMinutesRig
                  emotion="cheerful"
                  snapshot={{ time: 0, gaze: { x: 0, y: 0 } }}
                  gaze="none"
                  skin={settings.hologramMode ? 'hologram' : 'classic'}
                  title="Miss Minutes"
                />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-tight text-[#FFF8EE]">Miss Minutes</p>
                <p className="truncate text-[10px] font-medium text-[#9D9082]">Time Variance Authority</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-xl text-[#9D9082] transition-colors hover:bg-white/[0.06] hover:text-[#F5EFE6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          {/* Primary CTA: New Chat */}
          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => {
                setView('chat');
                void conversation.newChat();
                closeSidebarOnNarrow();
              }}
              className="flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-xl border border-white/[0.08] bg-[#16120E] px-3 text-sm font-medium text-[#FFF8EE] transition-colors hover:border-[#FF7A1A]/40 hover:bg-[#1E1812] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              <SquarePen className="h-4 w-4 text-[#FF9240]" />
              <span>New chat</span>
            </button>
          </div>

          {/* Workspace Views */}
          <nav aria-label="Workspace sections" className="space-y-0.5 px-2 pb-3">
            {WORKSPACE_VIEWS.map(({ id, label, icon: Icon, privateView }) => {
              const selected = view === id;
              const locked = Boolean(privateView && desktop && !desktopReady);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setView(id);
                    closeSidebarOnNarrow();
                  }}
                  className={`flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] ${
                    selected
                      ? 'bg-white/[0.09] text-[#FFF8EE]'
                      : 'text-[#CBBEB0] hover:bg-white/[0.04] hover:text-[#FFF8EE]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Icon className={`h-4 w-4 shrink-0 ${selected ? 'text-[#FF9240]' : 'text-[#9D9082]'}`} />
                    <span className="truncate">{label}</span>
                  </span>
                  {locked && <Lock className="h-3.5 w-3.5 shrink-0 text-[#786B5E]" aria-label="Locked" />}
                </button>
              );
            })}
          </nav>

          {/* Search + Conversation History */}
          <div className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06] px-2 pt-3">
            {desktop && !desktopReady ? (
              <div className="mx-1 rounded-2xl border border-white/[0.07] bg-[#14100C] p-3.5 text-center space-y-2.5">
                <div className="mx-auto grid h-8 w-8 place-items-center rounded-full bg-[#FF7A1A]/15 text-[#FF9240]">
                  <Lock className="h-4 w-4" />
                </div>
                <p className="text-xs font-medium text-[#F5EFE6]">
                  {ownerAuthenticated
                    ? 'Unlocking saved conversations…'
                    : ownerStatus?.enrolled
                      ? 'Verify Owner to access saved conversations'
                      : 'Enroll Owner identity to save conversation history'}
                </p>
                {!ownerAuthenticated && (
                  ownerStatus?.enrolled ? (
                    <button
                      type="button"
                      disabled={authBusy}
                      onClick={() => void handleVerifyOwner()}
                      className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-[#FF7A1A] px-3 text-xs font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:opacity-50"
                    >
                      <Fingerprint className="h-3.5 w-3.5" />
                      {authBusy ? 'Verifying…' : 'Verify Owner'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openSettingsTab('security')}
                      className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.04] px-3 text-xs font-medium text-[#F5EFE6] transition-colors hover:bg-white/[0.08]"
                    >
                      <Fingerprint className="h-3.5 w-3.5 text-[#FF9240]" />
                      Set up Owner
                    </button>
                  )
                )}
              </div>
            ) : (
              <>
                <div className="relative mb-2 px-1">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#786B5E]" />
                  <input
                    type="search"
                    value={chatFilter}
                    onChange={e => setChatFilter(e.target.value)}
                    placeholder="Search chats…"
                    aria-label="Search conversations"
                    className="h-8 w-full rounded-xl border border-white/[0.07] bg-[#16120E] pl-8 pr-3 text-xs text-[#F5EFE6] placeholder:text-[#786B5E] outline-none transition-colors focus:border-[#FF7A1A]/50"
                  />
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-2">
                  {groupedChats.length === 0 ? (
                    <p className="px-2 py-4 text-center text-xs text-[#786B5E]">
                      {chatFilter.trim() ? 'No matching chats' : 'No saved conversations yet'}
                    </p>
                  ) : (
                    groupedChats.map(group => (
                      <div key={group.label} className="space-y-0.5">
                        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[#786B5E]">
                          {group.label}
                        </p>
                        {group.items.map(chat => {
                          const isActive = view === 'chat' && chat.id === chatId;
                          const isEditing = editingChatId === chat.id;
                          const isConfirmingDelete = confirmDeleteId === chat.id;

                          if (isEditing) {
                            return (
                              <form
                                key={chat.id}
                                onSubmit={e => {
                                  e.preventDefault();
                                  void commitRename(chat.id);
                                }}
                                className="flex items-center gap-1 rounded-xl border border-[#FF7A1A]/50 bg-[#16120E] px-2 py-1"
                              >
                                <input
                                  type="text"
                                  autoFocus
                                  value={editingTitle}
                                  onChange={e => setEditingTitle(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Escape') setEditingChatId(null);
                                  }}
                                  className="min-w-0 flex-1 bg-transparent text-xs text-[#FFF8EE] outline-none"
                                  aria-label="Rename conversation"
                                />
                                <button
                                  type="submit"
                                  aria-label="Save title"
                                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-lg text-emerald-400 hover:bg-white/[0.06]"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingChatId(null)}
                                  aria-label="Cancel rename"
                                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-lg text-[#9D9082] hover:bg-white/[0.06]"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </form>
                            );
                          }

                          return (
                            <div
                              key={chat.id}
                              className={`group flex items-center gap-1 rounded-xl px-2 py-1.5 text-xs transition-colors ${
                                isActive
                                  ? 'bg-white/[0.09] text-[#FFF8EE]'
                                  : 'text-[#CBBEB0] hover:bg-white/[0.04] hover:text-[#FFF8EE]'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirmDeleteId(null);
                                  setView('chat');
                                  conversation.openChat(chat.id);
                                  closeSidebarOnNarrow();
                                }}
                                className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
                                title={chat.title || 'New chat'}
                              >
                                {chat.title || 'New chat'}
                              </button>

                              {isConfirmingDelete ? (
                                <div className="flex shrink-0 items-center gap-0.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setConfirmDeleteId(null);
                                      void conversation.removeChat(chat.id);
                                    }}
                                    aria-label="Confirm delete conversation"
                                    className="grid h-6 w-6 cursor-pointer place-items-center rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/35"
                                  >
                                    <Check className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    aria-label="Cancel delete"
                                    className="grid h-6 w-6 cursor-pointer place-items-center rounded-lg text-[#9D9082] hover:bg-white/[0.06]"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              ) : (
                                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                  <button
                                    type="button"
                                    onClick={e => {
                                      e.stopPropagation();
                                      setConfirmDeleteId(null);
                                      setEditingChatId(chat.id);
                                      setEditingTitle(chat.title || 'New chat');
                                    }}
                                    aria-label={`Rename ${chat.title || 'chat'}`}
                                    className="grid h-6 w-6 cursor-pointer place-items-center rounded-lg text-[#9D9082] hover:bg-white/[0.08] hover:text-[#FFF8EE]"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={e => {
                                      e.stopPropagation();
                                      setConfirmDeleteId(chat.id);
                                    }}
                                    aria-label={`Delete ${chat.title || 'chat'}`}
                                    className="grid h-6 w-6 cursor-pointer place-items-center rounded-lg text-[#9D9082] hover:bg-red-500/15 hover:text-red-300"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* Sidebar Footer: Authority + Settings */}
          <div className="shrink-0 space-y-2 border-t border-white/[0.06] p-3">
            {desktop && (
              <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/[0.07] bg-[#14100C] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  {ownerAuthenticated ? (
                    <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                  ) : ownerCandidate ? (
                    <ShieldAlert className="h-4 w-4 shrink-0 text-[#FF9240]" />
                  ) : (
                    <Lock className="h-4 w-4 shrink-0 text-[#9D9082]" />
                  )}
                  <span className="truncate text-xs font-medium text-[#F5EFE6]">
                    {ownerAuthenticated ? 'Owner Mode' : ownerCandidate ? 'Owner Candidate' : 'Guest Mode'}
                  </span>
                </div>
                {ownerAuthenticated ? (
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={() => void handleLockOwner()}
                    className="cursor-pointer rounded-lg border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-[#CBBEB0] transition-colors hover:bg-white/[0.09] hover:text-[#FFF8EE] disabled:opacity-50"
                  >
                    Lock
                  </button>
                ) : ownerStatus?.enrolled ? (
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={() => void handleVerifyOwner()}
                    className="cursor-pointer rounded-lg bg-[#FF7A1A] px-2.5 py-1 text-[11px] font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:opacity-50"
                  >
                    {authBusy ? '…' : 'Verify'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openSettingsTab('security')}
                    className="cursor-pointer rounded-lg border border-[#FF7A1A]/40 bg-[#FF7A1A]/15 px-2.5 py-1 text-[11px] font-medium text-[#FFD9B3] transition-colors hover:bg-[#FF7A1A]/25"
                  >
                    Set up
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => openSettingsTab()}
              className="flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 text-xs font-medium text-[#CBBEB0] transition-colors hover:bg-white/[0.05] hover:text-[#FFF8EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              <span className="flex items-center gap-2.5">
                <SettingsIcon className="h-4 w-4 text-[#9D9082]" />
                <span>Settings</span>
              </span>
              <span className="truncate text-[11px] text-[#786B5E]">{providerLabel}</span>
            </button>
          </div>
        </aside>
      )}

      {/* Main Content Area */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top Minimal Header */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-[#0B0908]/90 px-3 backdrop-blur sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            {(!sidebarOpen) && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
                title="Open sidebar"
                className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-[#CBBEB0] transition-colors hover:bg-white/[0.08] hover:text-[#FFF8EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            )}
            {sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation menu"
                className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-[#CBBEB0] md:hidden"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            )}

            {view === 'chat' ? (
              <button
                type="button"
                onClick={() => openSettingsTab('brain')}
                className="flex min-w-0 cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
                title="Switch AI provider or model"
              >
                <span className="truncate text-sm font-semibold text-[#FFF8EE]">Miss Minutes</span>
                <span className="hidden truncate text-xs text-[#9D9082] sm:inline">
                  {providerLabel}{settings.model ? ` · ${settings.model}` : ''}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#786B5E]" />
              </button>
            ) : (
              <div className="flex min-w-0 items-center gap-2.5">
                <activeWorkspace.icon className="h-4 w-4 shrink-0 text-[#FF9240]" />
                <h1 className="truncate text-sm font-semibold text-[#FFF8EE]">{activeWorkspace.label}</h1>
                <button
                  type="button"
                  onClick={() => setView('chat')}
                  className="hidden cursor-pointer items-center gap-1 rounded-full border border-white/[0.09] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-[#CBBEB0] transition-colors hover:bg-white/[0.08] hover:text-[#FFF8EE] sm:inline-flex"
                >
                  <MessageSquare className="h-3 w-3" /> Back to chat
                </button>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {desktop && !ownerAuthenticated && (
              ownerStatus?.enrolled ? (
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => void handleVerifyOwner()}
                  className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition-colors disabled:opacity-50 ${
                    ownerCandidate
                      ? 'bg-[#FF7A1A] text-[#110C07] hover:bg-[#FF903B]'
                      : 'border border-white/[0.1] bg-white/[0.04] text-[#F5EFE6] hover:bg-white/[0.09]'
                  }`}
                >
                  <Fingerprint className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{authBusy ? 'Verifying…' : 'Verify Owner'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => openSettingsTab('security')}
                  className="hidden h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-[#FF7A1A]/35 bg-[#FF7A1A]/15 px-3 text-xs font-medium text-[#FFD9B3] transition-colors hover:bg-[#FF7A1A]/25 sm:inline-flex"
                >
                  <Fingerprint className="h-3.5 w-3.5" />
                  <span>Set up Owner</span>
                </button>
              )
            )}

            <button
              type="button"
              onClick={toggleHandsFree}
              aria-pressed={handsFree}
              title={handsFree ? 'Stop hands-free voice session' : 'Start hands-free live voice'}
              className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] ${
                handsFree
                  ? 'border-[#FF7A1A]/60 bg-[#FF7A1A]/20 text-[#FFD9B3]'
                  : 'border-white/[0.08] bg-white/[0.03] text-[#CBBEB0] hover:bg-white/[0.08] hover:text-[#FFF8EE]'
              }`}
            >
              {handsFree ? <PhoneOff className="h-3.5 w-3.5" /> : <AudioLines className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{handsFree ? 'End live' : 'Live'}</span>
            </button>

            <button
              type="button"
              onClick={() => { if (settings.voiceEnabled) speaker.stop(); setSettings({ ...settings, voiceEnabled: !settings.voiceEnabled }); }}
              aria-label={settings.voiceEnabled ? 'Mute her voice' : 'Unmute her voice'}
              title={settings.voiceEnabled ? 'Mute voice replies' : 'Unmute voice replies'}
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-[#CBBEB0] transition-colors hover:bg-white/[0.08] hover:text-[#FFF8EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              {settings.voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>

            {view === 'chat' && (
              <button
                type="button"
                onClick={() => setStageOpen(v => !v)}
                aria-pressed={stageOpen}
                aria-label={stageOpen ? 'Hide companion stage' : 'Show companion stage'}
                title={stageOpen ? 'Hide companion stage' : 'Show companion stage'}
                className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] ${
                  stageOpen
                    ? 'border-[#FF7A1A]/45 bg-[#FF7A1A]/15 text-[#FFD9B3]'
                    : 'border-white/[0.08] bg-white/[0.03] text-[#CBBEB0] hover:bg-white/[0.08] hover:text-[#FFF8EE]'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">Stage</span>
                <PanelRight className="hidden h-3.5 w-3.5 sm:inline xl:hidden" />
              </button>
            )}

            <button
              type="button"
              onClick={() => openSettingsTab()}
              aria-label="Settings"
              title="Settings"
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-[#CBBEB0] transition-colors hover:bg-white/[0.08] hover:text-[#FFF8EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Body */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {view === 'chat' ? (
            <>
              <div className="min-w-0 flex-1 overflow-hidden">
                <ChatPanel
                  hideHeader
                  borderless
                  messages={messages}
                  chats={chats}
                  chatId={chatId}
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
                  ownerAuthenticated={ownerAuthenticated}
                  ownerCandidate={ownerCandidate}
                  onVerifyOwner={() => void handleVerifyOwner()}
                  rigState={{
                    emotion,
                    gesture: gesture.g,
                    gestureKey: gesture.k,
                    speaking: voice.speaking,
                    mouth: voice.mouth,
                    skin: settings.hologramMode ? 'hologram' : 'classic',
                    onPoke: () => { if (voice.speaking && handsFree) speaker.stop(); else poke(); },
                  }}
                  onSpeakReply={text => {
                    applyCue({ emotion: 'cheerful', gesture: 'point' });
                    speaker.say(text, { ...settings, voiceEnabled: true });
                  }}
                  handsFree={handsFree}
                  onToggleHandsFree={toggleHandsFree}
                  authorityNotice={authorityNotice}
                />
              </div>

              {/* Dockable Right Companion Stage Drawer (lg+) */}
              {stageOpen && (
                <aside
                  aria-label="Miss Minutes companion stage"
                  className="hidden w-[348px] shrink-0 flex-col border-l border-white/[0.06] bg-[#0D0A08] p-3 lg:flex xl:w-[384px]"
                >
                  <Stage
                    compact
                    className="h-full"
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
                </aside>
              )}

              {/* Narrow-viewport Companion Stage Slide-Over */}
              {stageOpen && (
                <div className="fixed inset-0 z-[10025] flex justify-end bg-black/65 backdrop-blur-xs lg:hidden" onClick={() => setStageOpen(false)}>
                  <aside
                    aria-label="Miss Minutes companion stage"
                    className="flex h-full w-[min(92vw,360px)] flex-col border-l border-white/[0.08] bg-[#0D0A08] p-3 shadow-2xl"
                    onClick={e => e.stopPropagation()}
                  >
                    <div className="mb-2 flex items-center justify-between px-1">
                      <span className="text-xs font-semibold uppercase tracking-wider text-[#9D9082]">Companion Stage</span>
                      <button
                        type="button"
                        onClick={() => setStageOpen(false)}
                        aria-label="Close stage"
                        className="grid h-8 w-8 cursor-pointer place-items-center rounded-xl text-[#9D9082] hover:bg-white/[0.06] hover:text-[#FFF8EE]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <Stage
                      compact
                      className="min-h-0 flex-1"
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
                  </aside>
                </div>
              )}
            </>
          ) : (
            <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
              <div className="mx-auto max-w-5xl">
                {desktop && !desktopReady ? (
                  <div className="mx-auto mt-8 max-w-lg space-y-4 rounded-3xl border border-white/[0.08] bg-[#14100C] p-8 text-center shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
                    <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#FF7A1A]/15 text-[#FF9240]">
                      <Lock className="h-5 w-5" />
                    </div>
                    {migrationError ? (
                      <>
                        <h2 className="text-base font-semibold text-red-200">Could not unlock encrypted owner storage</h2>
                        <p className="text-xs leading-relaxed text-red-300/80">{migrationError}</p>
                        <button
                          type="button"
                          onClick={() => setMigrationRetryNonce(n => n + 1)}
                          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-[#FF7A1A] px-5 text-xs font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B]"
                        >
                          Retry migration
                        </button>
                      </>
                    ) : ownerAuthenticated ? (
                      <>
                        <h2 className="text-base font-semibold text-[#FFF8EE]">Preparing encrypted owner storage…</h2>
                        <p className="text-xs leading-relaxed text-[#9D9082]">
                          Decrypting and migrating local owner records into SQLCipher before loading your timeline and dossier.
                        </p>
                      </>
                    ) : (
                      <>
                        <h2 className="text-base font-semibold text-[#FFF8EE]">
                          {ownerCandidate
                            ? 'Owner candidate recognized — verification needed'
                            : ownerStatus?.enrolled
                              ? 'Private owner panels are locked'
                              : 'Enroll desktop owner identity to unlock private panels'}
                        </h2>
                        <p className="text-xs leading-relaxed text-[#9D9082]">
                          {ownerCandidate
                            ? 'Local recognition signals suggest the owner may be present. Verify with Windows Hello to unlock Sacred Timeline, reminders, notes, memory dossier, and activity logs.'
                            : ownerStatus?.enrolled
                              ? 'In Guest Mode only generic chat and harmless public tools are enabled. Verify identity with Windows Hello to open your private panels.'
                              : 'Set up Windows Hello in Owner security to protect your local database and owner tools.'}
                        </p>
                        <div className="flex flex-wrap justify-center gap-2 pt-1">
                          {ownerStatus?.enrolled ? (
                            <button
                              type="button"
                              disabled={authBusy}
                              onClick={() => void handleVerifyOwner()}
                              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-[#FF7A1A] px-5 text-xs font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:opacity-50"
                            >
                              <Fingerprint className="h-4 w-4" />
                              {authBusy ? 'Waiting for Windows Hello…' : 'Verify Identity'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openSettingsTab('security')}
                              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-[#FF7A1A] px-5 text-xs font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B]"
                            >
                              <Fingerprint className="h-4 w-4" />
                              Open Owner security
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    {view === 'timeline' && <SacredTimeline />}
                    {view === 'toolbelt' && <Toolbelt />}
                    {view === 'dossier' && (
                      <Dossier homeCity={settings.homeCity} onHomeCityChange={city => setSettings({ ...settings, homeCity: city })} />
                    )}
                    {view === 'missions' && <MissionsPanel />}
                    {view === 'offers' && <OffersPanel />}
                    {view === 'calling' && (
                      <CallingPanel settings={settings} onUpdateCallingSettings={patch => setSettings({ ...settings, ...patch })} />
                    )}
                    {view === 'connectors' && <ConnectorsPanel />}
                    {view === 'security' && (
                      <SecurityConsolePanel
                        settings={settings}
                        onUpdateWakeSettings={patch => setSettings({ ...settings, ...patch })}
                        onStateChanged={() => invokeNative<DesktopOwnerStatus>('owner_status').then(setOwnerStatus).catch(() => undefined)}
                      />
                    )}
                    {view === 'activity' && <ActivityLog />}
                  </>
                )}
              </div>
            </main>
          )}
        </div>
      </div>

      {/* Alarm / reminder toasts */}
      <div className="fixed right-4 top-16 z-[10030] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map(toast => (
          <div key={toast.id} className="rounded-2xl border border-[#FF7A1A]/50 bg-[#1B130B] p-3.5 shadow-[0_14px_40px_rgba(0,0,0,0.65)]">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[#FFF4E4]">{toast.title}</p>
                {toast.body && <p className="mt-0.5 text-xs text-[#CBBEB0]">{toast.body}</p>}
              </div>
              <button
                type="button"
                onClick={() => setToasts(list => list.filter(t => t.id !== toast.id))}
                aria-label="Dismiss"
                className="cursor-pointer rounded-lg p-1 text-[#9D9082] hover:bg-white/[0.06] hover:text-[#FFF8EE]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <Settings
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => { setSettingsOpen(false); setSettingsInitialTab(undefined); }}
        ownerStatus={ownerStatus}
        onOwnerStatusChange={setOwnerStatus}
        ownerDataReady={ownerDataReady}
        initialTab={settingsInitialTab}
      />
    </div>
  );
}

export default App;
