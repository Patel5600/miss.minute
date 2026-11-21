import { useCallback, useEffect, useRef, useState } from 'react';
import type { AISettings, Emotion, Gesture, MouthFrame } from '@desktop/types';
import { defaultSettings, initializeSettings, loadSettings, onSettingsChange } from '@desktop/agent/settings';
import { useConversation, type Conversation } from '@desktop/app/useConversation';
import { ChatPanel } from '@desktop/app/ChatPanel';
import { voiceService } from '@desktop/services/voiceService';
import { speaker } from '@desktop/app/speaker';
import { authenticateOwner, describeError } from '../../shared/nativeApi.ts';
import { useNativeState } from '../useNative.ts';

export interface MobileChatProps {
  ownerDataReady?: boolean;
  ownerAuthenticated?: boolean;
  ownerCandidate?: boolean;
  settings?: AISettings;
  conversation?: Conversation;
  listening?: boolean;
  interim?: string;
  onMic?: () => void;
  onVerifyOwner?: () => void;
  authorityNotice?: string;
  emotion?: Emotion;
  gesture?: { g: Gesture; k: number };
  speaking?: boolean;
  mouth?: MouthFrame;
  onPoke?: () => void;
  onSpeakReply?: (text: string) => void;
}

export function Chat(props: MobileChatProps = {}) {
  if (props.conversation && props.settings) {
    return <BoundChat {...props} conversation={props.conversation} settings={props.settings} />;
  }
  return <StandaloneChat ownerDataReady={props.ownerDataReady} />;
}

function BoundChat({
  ownerDataReady = true,
  ownerAuthenticated = false,
  ownerCandidate = false,
  settings,
  conversation,
  listening = false,
  interim = '',
  onMic,
  onVerifyOwner,
  authorityNotice,
  emotion = 'cheerful',
  gesture = { g: 'none', k: 0 },
  speaking = false,
  mouth = 0,
  onPoke,
  onSpeakReply,
}: MobileChatProps & { conversation: Conversation; settings: AISettings }) {
  const { busy, approvals, messages, chats, chatId } = conversation;
  const resolvedNotice =
    authorityNotice
    ?? (!ownerAuthenticated && ownerCandidate
      ? 'Owner candidate detected · Verify on this device to unlock private memory and tools.'
      : !ownerAuthenticated
        ? 'Guest Mode · Temporary chat & public tools only.'
        : !ownerDataReady
          ? 'Preparing encrypted owner history…'
          : undefined);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
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
        onMic={onMic ?? (() => undefined)}
        onNewChat={() => void conversation.newChat()}
        onOpenChat={conversation.openChat}
        onDeleteChat={id => void conversation.removeChat(id)}
        ownerAuthenticated={ownerAuthenticated}
        ownerCandidate={ownerCandidate}
        onVerifyOwner={onVerifyOwner}
        authorityNotice={resolvedNotice}
        rigState={{
          emotion,
          gesture: gesture.g,
          gestureKey: gesture.k,
          speaking,
          mouth,
          skin: settings.hologramMode ? 'hologram' : 'classic',
          onPoke,
        }}
        onSpeakReply={onSpeakReply}
      />
    </div>
  );
}

function StandaloneChat({ ownerDataReady = true }: { ownerDataReady?: boolean }) {
  const native = useNativeState();
  const ownerAuthenticated = native.phase === 'ready' && native.info?.ownerAuthenticated === true;
  const ownerCandidate =
    !ownerAuthenticated
    && native.phase === 'ready'
    && (native.info?.operatingMode === 'OWNER_CANDIDATE' || native.info?.ownerCandidate === true);
  const guestMode = !ownerAuthenticated;
  const settingsUnlocked = ownerAuthenticated && ownerDataReady;

  const [settings, setSettings] = useState<AISettings>(() => defaultSettings());
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const stopListening = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!settingsUnlocked) {
      setSettings(defaultSettings());
      return;
    }
    let active = true;
    void initializeSettings()
      .then((settled) => { if (active) setSettings(settled); })
      .catch(() => { if (active) setSettings(loadSettings()); });
    const stopListener = onSettingsChange((next) => { if (active) setSettings(next); });
    return () => { active = false; stopListener(); };
  }, [settingsUnlocked]);

  const conversation = useConversation(settings, () => undefined, guestMode || !ownerDataReady, ownerCandidate);

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
    if (listening) { stopListening.current?.(); return; }
    speaker.stop();
    setInterim('');
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
        if (error === 'no-speech' || error === 'aborted') { setListening(false); return; }
        micFailed(`Microphone: ${error}`);
      },
      () => setListening(false),
    );
    if (handle) { setListening(true); stopListening.current = () => handle.stop(); }
  }, [listening, conversation]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {authError && (
        <div role="alert" className="mx-3 mt-2 rounded-xl border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {authError}
        </div>
      )}
      <BoundChat
        ownerDataReady={ownerDataReady}
        ownerAuthenticated={ownerAuthenticated}
        ownerCandidate={ownerCandidate}
        settings={settings}
        conversation={conversation}
        listening={listening}
        interim={interim}
        onMic={toggleMic}
        onVerifyOwner={() => void handleVerify()}
        onSpeakReply={text => speaker.say(text, { ...settings, voiceEnabled: true })}
      />
    </div>
  );
}
