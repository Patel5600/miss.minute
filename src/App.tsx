import { useState, useEffect } from 'react';
import type { AISettings, ChatMessage, Emotion, MouthFrame, TimelineBranch } from './types';
import { AIService } from './services/aiService';
import { voiceService } from './services/voiceService';
import { soundEffects } from './utils/audioEffects';
import { MissMinutesFloating } from './components/MissMinutesFloating';
import { ChatInterface } from './components/ChatInterface';
import { TimelineMonitor } from './components/TimelineMonitor';
import { VariantCard } from './components/VariantCard';
import { SettingsModal } from './components/SettingsModal';
import { TvaHeader } from './components/TvaHeader';
import { DesktopCompanionPanel } from './components/DesktopCompanionPanel';
import { invokeNative, isDesktopRuntime } from './desktop/bridge';
import confetti from 'canvas-confetti';

export function App() {
  const isNativeDesktop = isDesktopRuntime();
  const [settings,       setSettings]       = useState<AISettings>(() => AIService.getStoredSettings());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [soundMuted,     setSoundMuted]     = useState(false);
  const [emotion,        setEmotion]        = useState<Emotion>('cheerful');
  const [isSpeaking,     setIsSpeaking]     = useState(false);
  const [mouthFrame,     setMouthFrame]     = useState<MouthFrame>(0);
  const [isLoading,      setIsLoading]      = useState(false);
  const [timeDoorActive, setTimeDoorActive] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-1',
      sender: 'miss_minute',
      text: "Hey y'all! Welcome to the Time Variance Authority! I'm Miss Minutes, your friendly TVA guide! I'm just walkin' the perimeter to make sure no unauthorized variants slip through. Ask me anything, sugar! For all time. Always.",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      emotion: 'cheerful',
    },
  ]);

  // ── Sync speaking state → face animation ──────────────────────────────────
  useEffect(() => {
    const unsubscribeSpeaking = voiceService.onSpeakingChange(speaking => {
      setIsSpeaking(speaking);
      if (!speaking) setEmotion('cheerful');
    });
    const unsubscribeViseme = voiceService.onVisemeChange(setMouthFrame);
    return () => {
      unsubscribeSpeaking();
      unsubscribeViseme();
      voiceService.stop();
    };
  }, []);

  // ── Boot chime on first interaction ───────────────────────────────────────
  useEffect(() => {
    const h = () => soundEffects.playTvaChime();
    window.addEventListener('click', h, { once: true });
  }, []);

  // Build voice config from current settings
  const buildVoiceConfig = () => ({
    pitch:              settings.voicePitch,
    rate:               settings.voiceRate,
    elevenLabsKey:      settings.useElevenLabs ? settings.elevenLabsKey      : undefined,
    elevenLabsVoiceId:  settings.useElevenLabs ? settings.elevenLabsVoiceId : undefined,
  });

  // ── Message sending ───────────────────────────────────────────────────────
  const handleSendMessage = async (text: string) => {
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setEmotion('thinking');

    try {
      const response = await AIService.generateResponse(text, messages, settings);
      setIsLoading(false);

      const aiMsg: ChatMessage = {
        id: `msg-${Date.now() + 1}`,
        sender: 'miss_minute',
        text: response.text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        emotion: response.emotion,
        nexusEventDetected: response.isNexusAlert,
      };
      setMessages(prev => [...prev, aiMsg]);
      setEmotion(response.emotion);

      if (response.isNexusAlert) soundEffects.playNexusAlert();
      if (settings.voiceEnabled) {
        const voice = buildVoiceConfig();
        if (isNativeDesktop) {
          void invokeNative<void>('avatar_speak', {
            text: response.text,
            emotion: response.emotion,
            pitch: voice.pitch,
            rate: voice.rate,
            elevenLabsKey: voice.elevenLabsKey,
            elevenLabsVoiceId: voice.elevenLabsVoiceId,
          }).catch(error => console.error('[Miss Minutes] Native speech bridge failed:', error));
        } else {
          void voiceService.speak(response.text, voice);
        }
      }
    } catch {
      setIsLoading(false);
      setEmotion('suspicious');
    }
  };

  // ── Avatar click → quote ──────────────────────────────────────────────────
  const handleAvatarClick = (quote: string) => {
    setEmotion('winking');
    if (settings.voiceEnabled) voiceService.speak(quote, buildVoiceConfig());
    setMessages(prev => [
      ...prev,
      {
        id: `quote-${Date.now()}`,
        sender: 'miss_minute',
        text: quote,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        emotion: 'winking',
      },
    ]);
  };

  // ── Branch pruned notice ───────────────────────────────────────────────────
  const handleBranchPruned = (branch: TimelineBranch) => {
    setEmotion('pruning');
    setMessages(prev => [
      ...prev,
      {
        id: `notice-${Date.now()}`,
        sender: 'system',
        text: `RESET CHARGE DEPLOYED: "${branch.name}" has been pruned and dispatched to the Void!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    setTimeout(() => setEmotion('cheerful'), 2500);
  };

  // ── Nexus event notice ────────────────────────────────────────────────────
  const handleNexusTriggered = () => {
    setEmotion('suspicious');
    setMessages(prev => [
      ...prev,
      {
        id: `notice-${Date.now()}`,
        sender: 'system',
        text: 'CRITICAL ALERT: Spontaneous Nexus Event detected! Branch approaching red line threshold!',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        nexusEventDetected: true,
      },
    ]);
  };

  // ── TemPad Time Door warp ─────────────────────────────────────────────────
  const handleTimeDoorJump = () => {
    setTimeDoorActive(true);
    soundEffects.playHologramGlitch();
    confetti({
      particleCount: 85,
      spread: 110,
      origin: { y: 0.5 },
      colors: ['#F97316', '#FBBF24', '#EA580C', '#FDE68A'],
    });
    setTimeout(() => { setTimeDoorActive(false); soundEffects.playTvaChime(); }, 1400);
  };

  const handleToggleSound = () => {
    const next = !soundMuted;
    setSoundMuted(next);
    soundEffects.setMuted(next);
  };

  return (
    <div className="min-h-screen bg-[#120D08] text-amber-100 flex flex-col relative overflow-x-hidden crt-flicker selection:bg-amber-600 selection:text-white">

      {/* Ambient radial glow */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,rgba(245,158,11,0.12),transparent)]" />
      {/* Retro grid lines */}
      <div className="fixed inset-0 pointer-events-none opacity-10 bg-[linear-gradient(to_right,#F59E0B09_1px,transparent_1px),linear-gradient(to_bottom,#F59E0B09_1px,transparent_1px)] bg-[size:28px_28px]" />

      {/* TemPad Time Door flash overlay */}
      {timeDoorActive && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center bg-gradient-to-r from-orange-700/35 via-amber-400/50 to-orange-700/35 backdrop-blur-[2px]">
          <div className="w-[420px] h-[420px] rounded-full border-[10px] border-orange-300 shadow-[0_0_140px_rgba(249,115,22,0.95)] animate-ping" />
        </div>
      )}

      {/* ── TVA Header ──────────────────────────────────────────────────────── */}
      <TvaHeader
        settings={settings}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onToggleSound={handleToggleSound}
        soundMuted={soundMuted}
        onTimeDoorJump={handleTimeDoorJump}
      />

      {/* ── Floating Walking Miss Minutes (fixed, border-patrol) ────────────── */}
      {!isNativeDesktop && (
        <MissMinutesFloating
          emotion={emotion}
          isSpeaking={isSpeaking}
          mouthFrame={mouthFrame}
          autonomousChatter={settings.ambientChatter ?? true}
          isBusy={isLoading}
          hologramMode={settings.hologramMode}
          onAvatarClick={handleAvatarClick}
        />
      )}

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-12 gap-5 items-start z-10">

        {/* LEFT: mood picker + variant dossier */}
        <section className="lg:col-span-4 flex flex-col gap-4">
          <DesktopCompanionPanel />
          {/* Mood Selector */}
          <div className="bg-amber-950/40 border border-amber-600/28 rounded-2xl p-4 backdrop-blur-md shadow-xl">
            <p className="text-[10px] uppercase font-bold text-amber-400/80 tracking-[0.2em] mb-2.5">
              Miss Minutes — Current Mood
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(['cheerful','talking','winking','suspicious','scary','pruning','thinking'] as Emotion[]).map(emo => (
                <button
                  key={emo}
                  onClick={() => { setEmotion(emo); soundEffects.playKeyClick(); }}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-mono uppercase border transition-all ${
                    emotion === emo
                      ? 'bg-amber-500 text-neutral-950 border-amber-400 font-bold shadow-md'
                      : 'bg-amber-950/50 text-amber-300/70 border-amber-700/30 hover:border-amber-500/60 hover:text-amber-200'
                  }`}
                >
                  {emo}
                </button>
              ))}
            </div>

            {/* Live status strip */}
            <div className="mt-3 pt-2.5 border-t border-amber-700/20 flex items-center gap-2 text-[10px] text-amber-400/70 font-mono">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isSpeaking ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'}`}/>
              <span className="truncate">
                {isSpeaking
                  ? 'VOICE TX — Miss Minutes speaking…'
                  : '👟 Patrolling screen border • Click her to interact'}
              </span>
            </div>
          </div>

          {/* TVA Variant Dossier */}
          <VariantCard />
        </section>

        {/* RIGHT: timeline monitor + chat */}
        <section className="lg:col-span-8 flex flex-col gap-4">
          <TimelineMonitor
            onBranchPruned={handleBranchPruned}
            onNexusTriggered={handleNexusTriggered}
          />
          <ChatInterface
            messages={messages}
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
            settings={settings}
            onQuickPrompt={handleSendMessage}
            onClearChat={() => setMessages([])}
          />
        </section>
      </main>

      {/* AI Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSave={s => setSettings(s)}
      />
    </div>
  );
}

export default App;
