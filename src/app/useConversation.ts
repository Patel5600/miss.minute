/**
 * Conversation state: persisted chats, the streaming reply, tool calls and approvals.
 * The brain does the thinking and memory; this hook owns what the owner sees and saves it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AISettings, Attachment, ChatMessage, CharacterCue, ToolCallRecord } from '../types';
import { brain, autoTitleChat } from '../agent/brain';
import { createChat, deleteChat, listChats, messagesForChat, newId, onDbChange, saveMessage, type ChatRecord, type StoredMessage } from '../store/db';
import { emitCue } from '../character/cues';
import { speaker } from './speaker';
import { isAndroidApp } from '../../native/mobile/web/src/shared/bridge';
import { isDesktopRuntime } from '../desktop/bridge';

const ACTIVE_CHAT_KEY = 'mm-active-chat';

function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface PendingApproval {
  call: ToolCallRecord;
  messageId: string;
}

export interface Conversation {
  chats: ChatRecord[];
  chatId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  approvals: PendingApproval[];
  send(text: string, attachments?: Attachment[]): Promise<void>;
  stop(): void;
  decide(callId: string, approved: boolean): void;
  newChat(): Promise<void>;
  openChat(id: string): void;
  removeChat(id: string): Promise<void>;
  /** Adds a line from her that did not come from a turn (clicks, alarms). Not saved. */
  note(text: string, sender?: 'miss_minute' | 'system'): void;
}

function readBrowserActiveChat(): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(ACTIVE_CHAT_KEY); }
  catch { return null; }
}

function clearBrowserActiveChat(): void {
  try { localStorage.removeItem(ACTIVE_CHAT_KEY); } catch { /* Restricted storage is already unavailable. */ }
}

export function useConversation(settings: AISettings, onCueReceived: (cue: CharacterCue) => void, guestMode = false, ownerCandidate = false): Conversation {
  const [chats, setChats] = useState<ChatRecord[]>([]);
  // Native owner stores own conversation metadata; never persist private chat selection
  // in WebView/Tauri localStorage, which is available before platform authentication.
  const nativeOwnerStore = isAndroidApp() || isDesktopRuntime();
  const [chatId, setChatId] = useState<string | null>(() => nativeOwnerStore ? null : readBrowserActiveChat());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const cueRef = useRef(onCueReceived);
  cueRef.current = onCueReceived;
  const abortRef = useRef<AbortController | null>(null);
  const resolvers = useRef(new Map<string, (approved: boolean) => void>());
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const guestChatId = useRef<string | null>(null);
  const previousGuestMode = useRef(guestMode);

  // Chat list, live across windows.
  useEffect(() => {
    let active = true;
    const load = () => { if (guestMode) { setChats([]); return; } void listChats().then(list => { if (active) setChats(list); }); };
    load();
    const stop = onDbChange('chats', load);
    return () => { active = false; stop(); };
  }, [guestMode]);

  // Messages of the open chat.
  useEffect(() => {
    if (nativeOwnerStore) clearBrowserActiveChat();
    if (guestMode) { if (!nativeOwnerStore) clearBrowserActiveChat(); setMessages([]); return; }
    if (!nativeOwnerStore) {
      try {
        if (chatId) localStorage.setItem(ACTIVE_CHAT_KEY, chatId);
        else clearBrowserActiveChat();
      } catch { /* Keep the active chat for this session when browser storage is restricted. */ }
    }
    if (!chatId) { setMessages([]); return; }
    let active = true;
    void messagesForChat(chatId).then(rows => {
      if (!active) return;
      // Keep an in-flight reply if the stored list does not have it yet.
      setMessages(current => {
        const streaming = current.filter(m => m.streaming && m.chatId === chatId);
        const ids = new Set(rows.map(r => r.id));
        return [...rows, ...streaming.filter(m => !ids.has(m.id))];
      });
    });
    return () => { active = false; };
  }, [chatId, guestMode, nativeOwnerStore]);

  const patchMessage = useCallback((id: string, patch: (m: ChatMessage) => ChatMessage) => {
    setMessages(current => current.map(m => (m.id === id ? patch(m) : m)));
  }, []);

  const decide = useCallback((callId: string, approved: boolean) => {
    const resolve = resolvers.current.get(callId);
    resolvers.current.delete(callId);
    setApprovals(current => current.filter(a => a.call.id !== callId));
    resolve?.(approved);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    resolvers.current.forEach(resolve => resolve(false));
    resolvers.current.clear();
    setApprovals([]);
    speaker.stop();
  }, []);

  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    if (previousGuestMode.current !== guestMode) {
      previousGuestMode.current = guestMode;
      stop();
      guestChatId.current = null;
      setMessages([]);
      setChatId(null);
    }
  }, [guestMode, stop]);

  const send = useCallback(async (raw: string, attachments?: Attachment[]) => {
    const text = raw.trim();
    if (!text && !attachments?.length) return;
    if (abortRef.current) stop();

    let id = guestMode ? guestChatId.current : chatId;
    let isNewChat = false;
    if (guestMode && !id) {
      id = newId();
      isNewChat = true;
      guestChatId.current = id;
    } else if (!guestMode && (!id || !chats.some(c => c.id === id))) {
      const chat = await createChat();
      id = chat.id;
      isNewChat = true;
      setChatId(id);
    }
    if (!id) return;
    const chat = id;
    const history = isNewChat ? [] : messagesRef.current.filter(m => m.chatId === chat && !m.streaming);

    const now = Date.now();
    const user: StoredMessage = {
      id: newId(), chatId: chat, sender: 'user', text, createdAt: now, timestamp: clock(now),
      ...(attachments?.length ? { attachments } : {}),
    };
    const replyId = newId();
    const reply: StoredMessage = {
      id: replyId, chatId: chat, sender: 'miss_minute', text: '', createdAt: now + 1, timestamp: clock(now + 1),
      streaming: true, toolCalls: [],
    };
    setMessages(current => [...current.filter(m => m.chatId === chat), user, reply]);
    if (!guestMode) await saveMessage(user);

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    const utterance = speaker.begin(settingsRef.current);
    let final: StoredMessage = reply;
    const update = (patch: Partial<StoredMessage>) => {
      final = { ...final, ...patch };
      patchMessage(replyId, () => final);
    };

    try {
      await brain.runTurn({
        chatId: chat,
        history,
        user: { text, attachments },
        settings: settingsRef.current,
        guestMode,
        ownerCandidate,
        signal: controller.signal,
        requestApproval: call => new Promise<boolean>(resolve => {
          if (controller.signal.aborted) { resolve(false); return; }
          resolvers.current.set(call.id, resolve);
          setApprovals(current => [...current.filter(a => a.call.id !== call.id), { call, messageId: replyId }]);
          emitCue({ emotion: 'thinking', gesture: 'point' });
        }),
        onEvent: event => {
          if (controller.signal.aborted) return;
          switch (event.type) {
            case 'text-delta':
              update({ text: final.text + event.text });
              utterance.push(event.text);
              break;
            case 'cue':
              emitCue(event.cue);
              cueRef.current(event.cue);
              update({ emotion: event.cue.emotion ?? final.emotion, gesture: event.cue.gesture ?? final.gesture });
              break;
            case 'tool': {
              const calls = [...(final.toolCalls ?? [])];
              const at = calls.findIndex(c => c.id === event.call.id);
              if (at >= 0) calls[at] = event.call; else calls.push(event.call);
              update({ toolCalls: calls });
              break;
            }
            case 'done':
              update({ text: event.text, emotion: event.emotion, gesture: event.gesture, model: event.model, streaming: false });
              utterance.end();
              break;
            case 'error':
              update({ text: final.text || event.message, nexusEventDetected: true });
              break;
          }
        },
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      utterance.end();
      final = { ...final, streaming: false };
      patchMessage(replyId, () => final);
      setBusy(false);
      if (!guestMode && (final.text.trim() || final.toolCalls?.length)) {
        await saveMessage(final);
        if (isNewChat) {
          void autoTitleChat(chat, { userText: text, replyText: final.text, settings: settingsRef.current }).catch(() => undefined);
        }
      }
    }
  }, [chatId, chats, guestMode, patchMessage, stop]);

  const newChat = useCallback(async () => {
    stop();
    if (guestMode) { guestChatId.current = null; setMessages([]); return; }
    const chat = await createChat();
    setChatId(chat.id);
  }, [guestMode, stop]);

  const openChat = useCallback((id: string) => {
    stop();
    setChatId(id);
  }, [stop]);

  const removeChat = useCallback(async (id: string) => {
    if (id === chatId) stop();
    if (!guestMode) await deleteChat(id);
    if (id === chatId) setChatId(null);
  }, [chatId, guestMode, stop]);

  const note = useCallback((text: string, sender: 'miss_minute' | 'system' = 'miss_minute') => {
    const at = Date.now();
    setMessages(current => [...current, { id: newId(), chatId: chatId ?? undefined, sender, text, createdAt: at, timestamp: clock(at) }]);
  }, [chatId]);

  return { chats, chatId, messages, busy, approvals, send, stop, decide, newChat, openChat, removeChat, note };
}
