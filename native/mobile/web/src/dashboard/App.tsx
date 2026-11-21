import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  Fingerprint,
  Lock,
  Menu,
  MessageSquare,
  Pencil,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { Chat } from './screens/Chat.tsx';
import { Home } from './screens/Home.tsx';
import { Panels } from './screens/Panels.tsx';
import { Settings, type SettingsTab as MobileSettingsTab } from './screens/Settings.tsx';
import type { AISettings, CharacterCue, Emotion, Gesture } from '@desktop/types';
import { defaultSettings, initializeSettings, onSettingsChange, PROVIDER_LABELS } from '@desktop/agent/settings';
import { startScheduler } from '@desktop/agent/scheduler';
import { onCue } from '@desktop/character/cues';
import { MissMinutesRig } from '@desktop/character/MissMinutesRig';
import { RANDOM_CLICK_QUOTES } from '@desktop/data/tvaLore';
import { useConversation } from '@desktop/app/useConversation';
import { speaker, type SpeakerState } from '@desktop/app/speaker';
import { voiceService } from '@desktop/services/voiceService';
import type { ChatRecord } from '@desktop/store/db';
import { BridgeError, onEvent, request } from '../shared/bridge.ts';
import { authenticateOwner, describeError, onWakeState } from '../shared/nativeApi.ts';
import { useNativeState } from './useNative.ts';

type ScreenId = 'chat' | 'home' | 'panels' | 'settings';

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
  const native = useNativeState();
  const ownerAuthenticated = native.phase === 'ready' && native.info?.ownerAuthenticated === true;
  const ownerCandidate =
    !ownerAuthenticated
    && native.phase === 'ready'
    && (native.info?.operatingMode === 'OWNER_CANDIDATE' || native.info?.ownerCandidate === true);
  const guestMode = !ownerAuthenticated;

  const [active, setActive] = useState<ScreenId>('chat');
  const [settingsTab, setSettingsTab] = useState<MobileSettingsTab>('brain');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [ownerDataReady, setOwnerDataReady] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationRetryNonce, setMigrationRetryNonce] = useState(0);
  const ownerUnlocked = ownerDataReady && ownerAuthenticated;

  const [aiSettings, setAiSettings] = useState<AISettings>(() => defaultSettings());
  const settingsRef = useRef<AISettings>(aiSettings);
  settingsRef.current = aiSettings;

  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const stopListening = useRef<(() => void) | null>(null);

  const [chatFilter, setChatFilter] = useState('');
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [emotion, setEmotion] = useState<Emotion>('cheerful');
  const [gesture, setGesture] = useState<{ g: Gesture; k: number }>({ g: 'none', k: 0 });
  const [voice, setVoice] = useState<SpeakerState>(speaker.current);

  useEffect(() => {
    if (!ownerAuthenticated) {
      setOwnerDataReady(false);
      setMigrating(false);
      setMigrationError(null);
      setAiSettings(defaultSettings());
      return;
    }

    let cancelled = false;
    let stopSettingsListener: (() => void) | undefined;
    setMigrationError(null);

    void (async () => {
      try {
        let needsMigration = false;
        try {
          await request('owner.store', { op: 'get', store: 'kv', key: '__migration_probe' });
        } catch (error) {
          if (
            error instanceof BridgeError
            && error.code === 'unavailable'
            && error.message.toLowerCase().includes('migration')
          ) {
            needsMigration = true;
          } else {
            throw error;
          }
        }
        if (cancelled) return;
        if (needsMigration) {
          setMigrating(true);
          await request('owner.migration.start', {}, 180_000);
        }
        if (cancelled) return;
        setMigrating(false);
        setOwnerDataReady(true);
        const loaded = await initializeSettings();
        if (cancelled) return;
        setAiSettings(loaded);
        stopSettingsListener = onSettingsChange((next) => {
          setAiSettings(next);
        });
      } catch (error) {
        if (cancelled) return;
        setMigrating(false);
        setOwnerDataReady(false);
        setMigrationError(error instanceof Error ? error.message : 'Could not unlock encrypted owner storage.');
      }
    })();

    return () => {
      cancelled = true;
      stopSettingsListener?.();
    };
  }, [ownerAuthenticated, migrationRetryNonce]);

  useEffect(() => {
    if (!ownerAuthenticated || !ownerDataReady) return;

    const stopScheduler = startScheduler({
      speak: (text, cue) => {
        if (cue.emotion) setEmotion(cue.emotion);
        if (cue.gesture && cue.gesture !== 'none') {
          setGesture(prev => ({ g: cue.gesture as Gesture, k: prev.k + 1 }));
        }
        speaker.say(text, settingsRef.current);
      },
      onAlert: (alert) => {
        if (!alert.missed) {
          speaker.say(`Alert: ${alert.title}. ${alert.body || ''}`, settingsRef.current);
        }
      },
    });

    return () => {
      stopScheduler();
    };
  }, [ownerAuthenticated, ownerDataReady]);

  useEffect(() => speaker.subscribe(setVoice), []);

  const applyCue = useCallback((cue: CharacterCue) => {
    if (cue.emotion) setEmotion(cue.emotion);
    if (cue.gesture && cue.gesture !== 'none') {
      setGesture(prev => ({ g: cue.gesture as Gesture, k: prev.k + 1 }));
    }
  }, []);
  useEffect(() => onCue(applyCue), [applyCue]);

  const conversation = useConversation(aiSettings, () => undefined, guestMode || !ownerDataReady, ownerCandidate);

  useEffect(() => {
    const offKill = onEvent('kill.happened', () => {
      speaker.stop();
      stopListening.current?.();
      setListening(false);
      setInterim('');
      void native.refresh();
      conversation.note('Emergency kill switch engaged — owner session locked and audio halted.', 'system');
    });
    const offWake = onWakeState(ev => {
      if (ev.event === 'triggered' || ev.mode === 'OWNER_CANDIDATE' || ev.phrase) {
        applyCue({ emotion: 'cheerful', gesture: 'wave' });
        void native.refresh();
      }
    });
    return () => {
      offKill();
      offWake();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyCue, native.refresh]);

  useEffect(() => {
    if (conversation.busy || voice.speaking) return;
    const id = window.setTimeout(() => {
      setEmotion('cheerful');
      setGesture(g => ({ g: 'none', k: g.k }));
    }, 3200);
    return () => window.clearTimeout(id);
  }, [conversation.busy, voice.speaking]);

  const handleVerify = useCallback(async () => {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await authenticateOwner();
      await native.refresh();
    } catch (error) {
      const msg = describeError(error);
      if (msg) setAuthError(msg);
    } finally {
      setAuthBusy(false);
    }
  }, [authBusy, native]);

  const toggleMic = useCallback(() => {
    if (listening) {
      stopListening.current?.();
      return;
    }
    speaker.stop();
    setInterim('');
    applyCue({ emotion: 'surprised' });
    const micFailed = (message: string) => {
      setListening(false);
      stopListening.current = null;
      conversation.note(message, 'system');
    };
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
        if (error === 'no-speech' || error === 'aborted') {
          setListening(false);
          return;
        }
        micFailed(`Microphone: ${error}`);
      },
      () => setListening(false),
    );
    if (handle) {
      setListening(true);
      stopListening.current = () => handle.stop();
    }
  }, [listening, conversation, applyCue]);

  const poke = useCallback(() => {
    const quote = RANDOM_CLICK_QUOTES[Math.floor(Math.random() * RANDOM_CLICK_QUOTES.length)];
    applyCue({ emotion: 'winking', gesture: 'wave' });
    speaker.say(quote, settingsRef.current);
  }, [applyCue]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (editingChatId) setEditingChatId(null);
        else if (confirmDeleteId) setConfirmDeleteId(null);
        else setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, editingChatId, confirmDeleteId]);

  const providerLabel = PROVIDER_LABELS[aiSettings.provider];
  const needsAttention =
    Boolean(native.info?.killNotice)
    || Boolean(native.info && (!native.info.ownerEnrolled || !native.info.sensorConsentGiven));

  const filteredChats = useMemo(() => {
    const query = chatFilter.trim().toLowerCase();
    if (!query) return conversation.chats;
    return conversation.chats.filter(c => (c.title || 'New chat').toLowerCase().includes(query));
  }, [conversation.chats, chatFilter]);

  const groupedChats = useMemo(() => groupChatsByDate(filteredChats), [filteredChats]);

  const commitRename = async (id: string) => {
    const next = editingTitle.trim();
    setEditingChatId(null);
    if (!next) return;
    await conversation.renameChat(id, next);
  };

  const navigate = (screen: ScreenId, desiredSettingsTab?: MobileSettingsTab) => {
    if (desiredSettingsTab) setSettingsTab(desiredSettingsTab);
    setActive(screen);
    setDrawerOpen(false);
  };

  const authorityNotice =
    !ownerAuthenticated && ownerCandidate
      ? 'Owner candidate detected · Verify on this device to unlock private memory and tools.'
      : !ownerAuthenticated
        ? 'Guest Mode · Temporary chat & public tools only.'
        : !ownerDataReady
          ? 'Preparing encrypted owner history…'
          : undefined;

  return (
    <div className="safe-x flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-base text-cream">
      {/* Slim Mobile Top App Bar (48px+ touch targets) */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-1 border-b border-white/[0.07] bg-[#0B0908]/95 px-1.5 backdrop-blur">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          className="grid h-12 w-12 shrink-0 cursor-pointer place-items-center rounded-2xl text-cream transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face"
        >
          <Menu className="h-5 w-5" />
        </button>

        {active === 'chat' ? (
          <button
            type="button"
            onClick={() => navigate('settings', 'brain')}
            className="flex min-h-11 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face"
          >
            <span className="truncate text-sm font-semibold text-[#FFF8EE]">Miss Minutes</span>
            <span className="truncate text-xs text-muted">
              · {aiSettings.provider !== 'tva-offline' && aiSettings.model ? aiSettings.model : providerLabel}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-2 px-1">
            <span className="truncate text-sm font-semibold text-[#FFF8EE]">
              {active === 'home' ? 'Companion Hub' : active === 'panels' ? 'Timeline & Tools' : 'Settings'}
            </span>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => {
              setActive('chat');
              void conversation.newChat();
              setDrawerOpen(false);
            }}
            aria-label="New chat"
            className="grid h-12 w-12 cursor-pointer place-items-center rounded-2xl text-cream transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face"
          >
            <SquarePen className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={() => setActive(current => (current === 'home' ? 'chat' : 'home'))}
            aria-label={active === 'home' ? 'Back to chat' : 'Open Companion Hub'}
            aria-pressed={active === 'home'}
            className={`relative grid h-12 w-12 cursor-pointer place-items-center rounded-2xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-face ${
              active === 'home'
                ? 'bg-face/15 text-face'
                : 'text-cream hover:bg-white/[0.06]'
            }`}
          >
            <Sparkles className="h-5 w-5" />
            {needsAttention && active !== 'home' && (
              <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-face ring-2 ring-[#0B0908]" aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {/* Non-blocking status banners */}
      {ownerAuthenticated && migrating && (
        <div role="status" className="mx-3 mt-2 shrink-0 rounded-2xl border border-face/40 bg-face/10 px-4 py-2.5 text-xs text-cream">
          Preparing your encrypted owner storage…
        </div>
      )}
      {ownerAuthenticated && migrationError && (
        <div role="alert" className="mx-3 mt-2 flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-2xl border border-red-500/45 bg-red-950/30 px-4 py-2.5 text-xs text-red-200">
          <span className="min-w-0 flex-1">{migrationError}</span>
          <button
            type="button"
            onClick={() => setMigrationRetryNonce((n) => n + 1)}
            className="min-h-11 cursor-pointer rounded-xl bg-face px-3.5 text-xs font-semibold text-[#110C07]"
          >
            Retry migration
          </button>
        </div>
      )}
      {authError && (
        <div role="alert" className="mx-3 mt-2 shrink-0 rounded-2xl border border-red-500/45 bg-red-950/30 px-4 py-2.5 text-xs text-red-200">
          {authError}
        </div>
      )}
      {active === 'chat' && !ownerAuthenticated && ownerCandidate && (
        <div className="mx-3 mt-2 flex shrink-0 items-center justify-between gap-2 rounded-2xl border border-face/40 bg-[#1B130B] px-3.5 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-2 font-medium text-[#FFD9B3]">
            <ShieldAlert className="h-4 w-4 shrink-0 text-face" />
            <span className="truncate">Owner candidate recognized</span>
          </span>
          <button
            type="button"
            disabled={authBusy}
            onClick={() => void handleVerify()}
            className="min-h-11 shrink-0 cursor-pointer rounded-xl bg-face px-3.5 text-xs font-semibold text-[#110C07] disabled:opacity-50"
          >
            {authBusy ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      )}

      {/* Main Content */}
      {active === 'chat' ? (
        <main className="min-h-0 flex-1 overflow-hidden">
          <Chat
            ownerDataReady={ownerDataReady}
            ownerAuthenticated={ownerAuthenticated}
            ownerCandidate={ownerCandidate}
            settings={aiSettings}
            conversation={conversation}
            listening={listening}
            interim={interim}
            onMic={toggleMic}
            onVerifyOwner={() => void handleVerify()}
            authorityNotice={authorityNotice}
            emotion={emotion}
            gesture={gesture}
            speaking={voice.speaking}
            mouth={voice.mouth}
            onPoke={poke}
            onSpeakReply={text => {
              applyCue({ emotion: 'cheerful', gesture: 'point' });
              speaker.say(text, { ...aiSettings, voiceEnabled: true });
            }}
          />
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-8 pt-3">
          {active === 'home' && (
            <Home
              onSetupComplete={() => navigate('settings', 'brain')}
              onOpenChat={() => setActive('chat')}
              onPoke={poke}
              rigEmotion={emotion}
              rigGesture={gesture}
              rigSpeaking={voice.speaking}
              rigMouth={voice.mouth}
              hologramMode={aiSettings.hologramMode}
            />
          )}
          {active === 'panels' && (
            <Panels ownerDataReady={ownerDataReady} onOpenSetup={() => setActive('home')} />
          )}
          {active === 'settings' && (
            <Settings ownerDataReady={ownerDataReady} initialTab={settingsTab} />
          )}
        </main>
      )}

      {/* Slide-Over Navigation Drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-[70] flex bg-black/70 backdrop-blur-xs"
          onClick={() => setDrawerOpen(false)}
        >
          <aside
            aria-label="App navigation"
            onClick={e => e.stopPropagation()}
            className="safe-bottom flex h-full w-[min(86vw,320px)] flex-col border-r border-white/[0.08] bg-[#100D0A] shadow-2xl"
          >
            {/* Brand Header */}
            <div className="flex h-14 shrink-0 items-center justify-between px-3">
              <button
                type="button"
                onClick={() => navigate('chat')}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-1.5 text-left"
              >
                <div className="h-8 w-8 shrink-0">
                  <MissMinutesRig
                    emotion="cheerful"
                    snapshot={{ time: 0, gaze: { x: 0, y: 0 } }}
                    gaze="none"
                    skin={aiSettings.hologramMode ? 'hologram' : 'classic'}
                    title="Miss Minutes"
                  />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#FFF8EE]">Miss Minutes</p>
                  <p className="truncate text-[10px] text-muted">Time Variance Authority</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="grid h-12 w-12 cursor-pointer place-items-center rounded-2xl text-muted hover:bg-white/[0.06] hover:text-cream"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* New Chat Button */}
            <div className="px-3 pb-2">
              <button
                type="button"
                onClick={() => {
                  setActive('chat');
                  void conversation.newChat();
                  setDrawerOpen(false);
                }}
                className="flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-2xl border border-white/[0.1] bg-[#16120E] px-3.5 text-sm font-medium text-[#FFF8EE] transition-colors hover:border-face/50"
              >
                <SquarePen className="h-4 w-4 text-face" />
                <span>New chat</span>
              </button>
            </div>

            {/* Primary Sections */}
            <nav aria-label="Sections" className="space-y-0.5 px-2 pb-3">
              {(
                [
                  { id: 'chat', label: 'Chat', icon: MessageSquare },
                  { id: 'home', label: 'Companion Hub', icon: Sparkles, dot: needsAttention },
                  { id: 'panels', label: 'Timeline & Tools', icon: CalendarClock, locked: !ownerUnlocked },
                  { id: 'settings', label: 'Settings', icon: SettingsIcon },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                const isSelected = active === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => navigate(item.id)}
                    className={`flex min-h-12 w-full cursor-pointer items-center justify-between gap-2 rounded-2xl px-3 text-sm font-medium transition-colors ${
                      isSelected
                        ? 'bg-white/[0.09] text-[#FFF8EE]'
                        : 'text-[#CBBEB0] hover:bg-white/[0.04] hover:text-[#FFF8EE]'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Icon className={`h-4 w-4 shrink-0 ${isSelected ? 'text-face' : 'text-muted'}`} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {'locked' in item && item.locked && <Lock className="h-3.5 w-3.5 shrink-0 text-muted" />}
                    {'dot' in item && item.dot && <span className="h-2 w-2 shrink-0 rounded-full bg-face" />}
                  </button>
                );
              })}
            </nav>

            {/* Saved Conversations (Fail-Closed behind Owner Verification) */}
            <div className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06] px-2 pt-3">
              {!ownerUnlocked ? (
                <div className="mx-1 space-y-2.5 rounded-2xl border border-white/[0.08] bg-[#14100C] p-3.5 text-center">
                  <div className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-face/15 text-face">
                    <Lock className="h-4 w-4" />
                  </div>
                  <p className="text-xs font-medium text-cream">
                    {ownerAuthenticated
                      ? 'Unlocking saved conversations…'
                      : native.info?.ownerEnrolled
                        ? 'Verify Identity to unlock saved chats'
                        : 'Set up Owner in Companion Hub to save chats'}
                  </p>
                  {!ownerAuthenticated && (
                    native.info?.ownerEnrolled ? (
                      <button
                        type="button"
                        disabled={authBusy}
                        onClick={() => void handleVerify()}
                        className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-face px-3 text-xs font-semibold text-[#110C07] disabled:opacity-50"
                      >
                        <Fingerprint className="h-4 w-4" />
                        {authBusy ? 'Verifying…' : 'Verify Identity'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigate('home')}
                        className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.05] px-3 text-xs font-medium text-cream"
                      >
                        <Sparkles className="h-4 w-4 text-face" />
                        Open Companion Hub
                      </button>
                    )
                  )}
                </div>
              ) : (
                <>
                  <div className="relative mb-2 px-1">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#786B5E]" />
                    <input
                      type="search"
                      value={chatFilter}
                      onChange={e => setChatFilter(e.target.value)}
                      placeholder="Search chats…"
                      aria-label="Search conversations"
                      className="min-h-10 w-full rounded-xl border border-white/[0.08] bg-[#16120E] pl-9 pr-3 text-xs text-cream placeholder:text-[#786B5E] outline-none focus:border-face/50"
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
                            const isActiveChat = active === 'chat' && chat.id === conversation.chatId;
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
                                  className="flex min-h-11 items-center gap-1 rounded-xl border border-face/50 bg-[#16120E] px-2.5"
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
                                  <button type="submit" aria-label="Save title" className="grid h-9 w-9 place-items-center rounded-lg text-emerald-400">
                                    <Check className="h-4 w-4" />
                                  </button>
                                  <button type="button" onClick={() => setEditingChatId(null)} aria-label="Cancel rename" className="grid h-9 w-9 place-items-center rounded-lg text-muted">
                                    <X className="h-4 w-4" />
                                  </button>
                                </form>
                              );
                            }

                            return (
                              <div
                                key={chat.id}
                                className={`flex min-h-11 items-center gap-1 rounded-xl px-2.5 text-xs transition-colors ${
                                  isActiveChat
                                    ? 'bg-white/[0.09] text-[#FFF8EE]'
                                    : 'text-[#CBBEB0] hover:bg-white/[0.04]'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConfirmDeleteId(null);
                                    setActive('chat');
                                    conversation.openChat(chat.id);
                                    setDrawerOpen(false);
                                  }}
                                  className="min-h-11 min-w-0 flex-1 cursor-pointer truncate text-left font-medium"
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
                                      className="grid h-9 w-9 place-items-center rounded-lg bg-red-500/20 text-red-300"
                                    >
                                      <Check className="h-4 w-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteId(null)}
                                      aria-label="Cancel delete"
                                      className="grid h-9 w-9 place-items-center rounded-lg text-muted"
                                    >
                                      <X className="h-4 w-4" />
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex shrink-0 items-center gap-0.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setConfirmDeleteId(null);
                                        setEditingChatId(chat.id);
                                        setEditingTitle(chat.title || 'New chat');
                                      }}
                                      aria-label={`Rename ${chat.title || 'chat'}`}
                                      className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-muted hover:text-cream"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteId(chat.id)}
                                      aria-label={`Delete ${chat.title || 'chat'}`}
                                      className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-muted hover:text-red-300"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
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

            {/* Drawer Footer: Authority Status */}
            <div className="shrink-0 border-t border-white/[0.06] p-3">
              <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/[0.08] bg-[#14100C] px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  {ownerAuthenticated ? (
                    <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                  ) : ownerCandidate ? (
                    <ShieldAlert className="h-4 w-4 shrink-0 text-face" />
                  ) : (
                    <Lock className="h-4 w-4 shrink-0 text-muted" />
                  )}
                  <span className="truncate text-xs font-medium text-cream">
                    {ownerAuthenticated
                      ? 'Owner Mode'
                      : ownerCandidate
                        ? 'Owner Candidate'
                        : native.info?.ownerEnrolled
                          ? 'Guest Mode'
                          : 'Owner not set up'}
                  </span>
                </div>
                {!ownerAuthenticated && native.info?.ownerEnrolled && (
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={() => void handleVerify()}
                    className="min-h-10 cursor-pointer rounded-xl bg-face px-3 text-xs font-semibold text-[#110C07] disabled:opacity-50"
                  >
                    {authBusy ? '…' : 'Verify'}
                  </button>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
