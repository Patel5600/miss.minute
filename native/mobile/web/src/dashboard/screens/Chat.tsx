import { useCallback, useEffect, useRef, useState } from 'react';
import type { AISettings } from '@desktop/types';
import { loadSettings, onSettingsChange } from '@desktop/agent/settings';
import { useConversation } from '@desktop/app/useConversation';
import { ChatPanel } from '@desktop/app/ChatPanel';
import { voiceService } from '@desktop/services/voiceService';
import { speaker } from '@desktop/app/speaker';

export function Chat() {
  const [settings, setSettings] = useState<AISettings>(() => loadSettings());
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const stopListening = useRef<(() => void) | null>(null);

  useEffect(() => {
    return onSettingsChange(setSettings);
  }, []);

  const conversation = useConversation(settings, () => undefined);
  const { busy, approvals, messages, chats, chatId } = conversation;

  const toggleMic = useCallback(() => {
    if (listening) {
      stopListening.current?.();
      return;
    }
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
  }, [listening, conversation]);

  return (
    <div className="flex min-h-0 h-[calc(100dvh-7rem)] max-h-full flex-col mx-auto w-full min-w-0 max-w-2xl">
      <ChatPanel
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
      />
    </div>
  );
}
