import { memo, useCallback, useEffect, useMemo, useRef, useState, isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  AudioLines,
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CloudSun,
  Copy,
  FileText,
  Fingerprint,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  Mic,
  MicOff,
  PhoneOff,
  ShieldAlert,
  Sparkles,
  Square,
  Timer,
  Trash2,
  Volume2,
  Wrench,
  X,
} from 'lucide-react';
import type { Attachment, ChatMessage, Emotion, Gesture, MouthFrame, ToolCallRecord } from '../types';
import type { ChatRecord } from '../store/db';
import { MissMinutesRig, type RigSkin } from '../character/MissMinutesRig';
import type { PendingApproval } from './useConversation';

export interface ChatPanelProps {
  messages: ChatMessage[];
  chats: ChatRecord[];
  chatId: string | null;
  busy: boolean;
  approvals: PendingApproval[];
  listening: boolean;
  interim: string;
  onSend(text: string, attachments?: Attachment[]): void;
  onStop(): void;
  onDecide(callId: string, approved: boolean): void;
  onMic(): void;
  onNewChat(): void;
  onOpenChat(id: string): void;
  onDeleteChat(id: string): void;
  ownerAuthenticated?: boolean;
  ownerCandidate?: boolean;
  onVerifyOwner?: () => void;
  hideHeader?: boolean;
  borderless?: boolean;
  rigState?: {
    emotion: Emotion;
    gesture: Gesture;
    gestureKey: number;
    speaking: boolean;
    mouth: MouthFrame;
    skin: RigSkin;
    onPoke?: () => void;
  };
  onSpeakReply?(text: string): void;
  handsFree?: boolean;
  onToggleHandsFree?: () => void;
  authorityNotice?: string;
}

interface StarterPrompt {
  title: string;
  subtitle: string;
  prompt: string;
  icon: typeof Timer;
}

const OWNER_SUGGESTIONS: readonly StarterPrompt[] = [
  {
    title: "Today's schedule",
    subtitle: 'Events, reminders & timeline load',
    prompt: "What's on my schedule today?",
    icon: CalendarClock,
  },
  {
    title: 'Tea timer',
    subtitle: 'Track a 10 minute countdown',
    prompt: 'Set a 10 minute timer for tea',
    icon: Timer,
  },
  {
    title: 'Evening reminder',
    subtitle: 'Call Mom at 6:00 PM',
    prompt: 'Remind me to call Mom at 6 pm',
    icon: Bell,
  },
  {
    title: 'Remember preference',
    subtitle: 'Save coffee preference to Dossier',
    prompt: 'Remember that I take my coffee black',
    icon: Sparkles,
  },
];

const PUBLIC_SUGGESTIONS: readonly StarterPrompt[] = [
  {
    title: 'Quick timer',
    subtitle: 'Set a 5 minute countdown',
    prompt: 'Set a 5 minute timer',
    icon: Timer,
  },
  {
    title: 'Local forecast',
    subtitle: "Check today's public weather",
    prompt: "What's the weather like today?",
    icon: CloudSun,
  },
  {
    title: 'Sacred Timeline',
    subtitle: 'Ask about the TVA & branches',
    prompt: 'Tell me about the Sacred Timeline and how it works',
    icon: Sparkles,
  },
  {
    title: 'Draft a checklist',
    subtitle: 'Organize tasks for a short sprint',
    prompt: 'Help me draft a concise 5-step focus checklist',
    icon: FileText,
  },
];

const TOOL_LABEL: Record<string, string> = {
  get_time: 'Clock',
  set_timer: 'Timer',
  list_timers: 'Timers',
  control_timer: 'Timer',
  set_alarm: 'Alarm',
  add_reminder: 'Reminder',
  add_event: 'Calendar',
  list_schedule: 'Schedule',
  update_schedule_item: 'Schedule',
  delete_schedule_item: 'Schedule',
  find_conflicts: 'Schedule',
  add_todo: 'To-do',
  list_todos: 'To-dos',
  complete_todo: 'To-do',
  delete_todo: 'To-do',
  create_note: 'Note',
  list_notes: 'Notes',
  read_note: 'Note',
  append_note: 'Note',
  delete_note: 'Note',
  get_weather: 'Weather',
  web_search: 'Search',
  calculate: 'Math',
  remember: 'Memory',
  recall: 'Memory',
  forget: 'Memory',
  look_at_screen: 'Screen',
  look_through_camera: 'Camera',
  list_apps: 'Apps',
  system_info: 'System',
  open_app: 'Open app',
  open_url: 'Open link',
  open_path: 'Open',
  list_directory: 'Folder',
  read_text_file: 'Read file',
  write_text_file: 'Write file',
  make_directory: 'New folder',
  move_path: 'Move',
  copy_path: 'Copy',
  delete_path: 'Recycle Bin',
  inspect_foreground_ui: 'Inspect UI',
  find_availability: 'Availability',
  rank_offers: 'Offers',
  run_mission: 'Mission',
  prepare_outbound_call: 'Outbound call',
  import_mcp_connector: 'MCP connector',
  reclassify_mcp_connector: 'MCP trust',
};

async function fileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const max = 1600;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return {
    id: crypto.randomUUID(),
    kind: 'image',
    mime: 'image/jpeg',
    dataUrl: canvas.toDataURL('image/jpeg', 0.86),
    source: 'upload',
    width: canvas.width,
    height: canvas.height,
  };
}

function extractNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractNodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return extractNodeText(node.props.children);
  return '';
}

function MarkdownCodePre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  let lang = '';
  if (isValidElement<{ className?: string }>(children)) {
    const match = /language-([\w-]+)/.exec(children.props.className ?? '');
    if (match) lang = match[1];
  }
  const codeText = useMemo(() => extractNodeText(children).replace(/\n$/, ''), [children]);

  const copy = () => {
    if (!codeText) return;
    void navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => undefined);
  };

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0B0907]">
      <div className="flex items-center justify-between border-b border-white/[0.07] bg-white/[0.03] px-3.5 py-2 text-[11px] text-[#9D9082]">
        <span className="font-mono lowercase tracking-wide">{lang || 'code'}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[#CBBEB0] transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 text-[13px] leading-relaxed text-[#F5EFE6]">{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <MarkdownCodePre>{children}</MarkdownCodePre>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export function ChatPanel(props: ChatPanelProps) {
  const {
    messages,
    chats,
    chatId,
    busy,
    approvals,
    listening,
    interim,
    onSend,
    onStop,
    onDecide,
    onMic,
    ownerAuthenticated = false,
    ownerCandidate = false,
    onVerifyOwner,
    hideHeader = false,
    borderless = false,
    rigState,
    onSpeakReply,
    handsFree = false,
    onToggleHandsFree,
    authorityNotice,
  } = props;

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showChats, setShowChats] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const forceScrollRef = useRef(true);

  const approvalIds = useMemo(() => new Set(approvals.map(a => a.call.id)), [approvals]);
  const title = chats.find(c => c.id === chatId)?.title ?? 'New conversation';

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  useEffect(() => {
    if (forceScrollRef.current || nearBottom) {
      forceScrollRef.current = false;
      scrollToBottom(messages.length <= 2 ? 'auto' : 'smooth');
    }
  }, [messages, approvals.length, nearBottom, scrollToBottom]);

  useEffect(() => {
    forceScrollRef.current = true;
  }, [chatId]);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setNearBottom(distance < 130);
  }, []);

  const displayValue = listening ? interim || text : text;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 160);
    el.style.height = `${Math.max(24, next)}px`;
  }, [displayValue]);

  const submit = useCallback((value = text) => {
    const clean = value.trim();
    if (!clean && attachments.length === 0) return;
    forceScrollRef.current = true;
    onSend(value, attachments.length ? attachments : undefined);
    setText('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = '24px';
    }
  }, [text, attachments, onSend]);

  const suggestions = ownerAuthenticated ? OWNER_SUGGESTIONS : PUBLIC_SUGGESTIONS;
  const heroTitle = ownerAuthenticated
    ? "Good to see you, Boss. What's next?"
    : ownerCandidate
      ? 'Good to see you. Verify to unlock your workspace.'
      : 'How can I help you today?';
  const heroSubtitle = ownerAuthenticated
    ? 'Manage your Sacred Timeline, timers, reminders, notes, and local tools.'
    : ownerCandidate
      ? 'Local recognition suggests you are nearby, but private tools stay sealed until device verification.'
      : 'Ask general questions or run safe public helpers. Verify as Owner for private memory and controls.';

  const shellClass = borderless
    ? 'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-transparent'
    : 'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0F0C09]/95 shadow-[0_20px_60px_rgba(0,0,0,0.55)]';

  return (
    <div className={shellClass}>
      {/* Optional internal conversation header when not rendered inside sidebar layout */}
      {!hideHeader && (
        <div className="relative flex items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-3">
          <button
            type="button"
            onClick={() => setShowChats(v => !v)}
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
          >
            <span className="truncate text-sm font-semibold text-[#F5EFE6]">{title}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[#9D9082]" />
          </button>
          <button
            type="button"
            onClick={props.onNewChat}
            className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-[#F5EFE6] transition-colors hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
          >
            <MessageSquarePlus className="h-4 w-4 text-[#FF7A1A]" /> New chat
          </button>
          {showChats && (
            <div className="absolute left-3 top-14 z-30 max-h-80 w-72 overflow-y-auto rounded-2xl border border-white/[0.1] bg-[#16120E] p-1.5 shadow-2xl">
              {chats.length === 0 && <p className="px-3 py-2 text-xs text-[#9D9082]">No saved conversations yet.</p>}
              {chats.map(chat => (
                <div
                  key={chat.id}
                  className={`group flex items-center gap-1 rounded-xl ${chat.id === chatId ? 'bg-[#FF7A1A]/15' : 'hover:bg-white/[0.06]'}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      props.onOpenChat(chat.id);
                      setShowChats(false);
                    }}
                    className="min-w-0 flex-1 cursor-pointer truncate px-3 py-2 text-left text-xs font-medium text-[#F5EFE6]"
                  >
                    {chat.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => props.onDeleteChat(chat.id)}
                    aria-label={`Delete ${chat.title}`}
                    className="mr-1 cursor-pointer rounded-lg p-1.5 text-[#9D9082] opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Transcript Stream */}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        onClick={() => { if (showChats) setShowChats(false); }}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-4 sm:px-6"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col pb-4">
          {messages.length === 0 ? (
            <div className="my-auto flex flex-col items-center justify-center py-6 text-center sm:py-10">
              <div className="relative mb-5">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-6 rounded-full bg-[radial-gradient(circle,rgba(255,122,26,0.22),transparent_68%)]"
                />
                <button
                  type="button"
                  onClick={rigState?.onPoke}
                  aria-label="Miss Minutes avatar"
                  className="relative grid h-28 w-28 cursor-pointer place-items-center rounded-full border border-[#FF7A1A]/25 bg-[#16120E]/90 p-2 shadow-[0_12px_40px_rgba(255,122,26,0.12)] transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] sm:h-32 sm:w-32"
                >
                  <MissMinutesRig
                    emotion={rigState?.emotion ?? 'cheerful'}
                    gesture={rigState?.gesture ?? 'none'}
                    gestureKey={rigState?.gestureKey ?? 0}
                    isSpeaking={rigState?.speaking ?? false}
                    mouthFrame={rigState?.mouth ?? 0}
                    skin={rigState?.skin ?? 'hologram'}
                    gaze="pointer"
                    className="h-full w-full"
                    title="Miss Minutes"
                  />
                </button>
              </div>

              <h2 className="max-w-lg text-balance text-2xl font-semibold tracking-tight text-[#FFF8EE] sm:text-[28px] sm:leading-tight">
                {heroTitle}
              </h2>
              <p className="mt-2 max-w-md text-pretty text-sm leading-relaxed text-[#9D9082]">
                {heroSubtitle}
              </p>

              {!ownerAuthenticated && ownerCandidate && onVerifyOwner && (
                <button
                  type="button"
                  onClick={onVerifyOwner}
                  className="mt-4 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-[#FF7A1A] px-5 py-2 text-sm font-semibold text-[#110C07] transition-colors hover:bg-[#FF903B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0908]"
                >
                  <Fingerprint className="h-4 w-4" /> Verify Identity
                </button>
              )}

              <div className="mt-7 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
                {suggestions.map(item => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.prompt}
                      type="button"
                      onClick={() => submit(item.prompt)}
                      className="group flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border border-white/[0.08] bg-[#16120E]/90 p-3.5 text-left transition-colors hover:border-[#FF7A1A]/35 hover:bg-[#1E1812] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
                    >
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#FF7A1A]/12 text-[#FF9240] transition-colors group-hover:bg-[#FF7A1A]/20">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[#F5EFE6]">{item.title}</span>
                        <span className="mt-0.5 block truncate text-xs text-[#9D9082]">{item.subtitle}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-6 py-2">
              {messages.map((message, index) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  isLastAssistant={
                    index === messages.length - 1 && message.sender === 'miss_minute'
                  }
                  approvalIds={approvalIds}
                  onDecide={onDecide}
                  onSpeakReply={onSpeakReply}
                  rigState={rigState}
                />
              ))}
            </div>
          )}
          <div ref={bottomRef} className="h-2 shrink-0" />
        </div>
      </div>

      {/* Scroll-to-bottom Floating Action */}
      {!nearBottom && messages.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center sm:bottom-32">
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            aria-label="Scroll to latest message"
            className="pointer-events-auto grid h-10 w-10 cursor-pointer place-items-center rounded-full border border-white/[0.12] bg-[#1A1510]/95 text-[#F5EFE6] shadow-xl backdrop-blur transition-colors hover:bg-[#241D16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Sticky Floating Pill Composer */}
      <div className="shrink-0 bg-gradient-to-t from-[#0B0908] via-[#0B0908]/95 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6 sm:pb-4">
        <div className="mx-auto w-full max-w-3xl">
          <div className="rounded-[26px] border border-white/[0.11] bg-[#16120E] shadow-[0_14px_40px_rgba(0,0,0,0.45)] transition-colors focus-within:border-[#FF7A1A]/55 focus-within:ring-1 focus-within:ring-[#FF7A1A]/20">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-4 pt-3">
                {attachments.map(a => (
                  <div key={a.id} className="relative">
                    <img src={a.dataUrl} alt="Attached preview" className="h-14 w-14 rounded-xl border border-white/[0.1] object-cover" />
                    <button
                      type="button"
                      onClick={() => setAttachments(list => list.filter(x => x.id !== a.id))}
                      className="absolute -right-1.5 -top-1.5 grid h-6 w-6 cursor-pointer place-items-center rounded-full border border-white/15 bg-[#100D0A] text-[#F5EFE6] hover:bg-black"
                      aria-label="Remove image"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {listening && (
              <div className="flex items-center gap-2 px-4 pt-2.5 text-xs font-medium text-[#FF9240]">
                <AudioLines className="h-3.5 w-3.5 animate-pulse" />
                <span>Listening… speak naturally</span>
              </div>
            )}

            <div className="px-4 pt-3 pb-1.5">
              <textarea
                ref={textareaRef}
                value={displayValue}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                placeholder={listening ? 'Listening…' : 'Message Miss Minutes…'}
                className="max-h-40 min-h-6 w-full resize-none bg-transparent text-[15px] leading-relaxed text-[#F5EFE6] placeholder-[#8C7F70] outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach an image"
                  title="Attach image"
                  className="grid h-11 w-11 cursor-pointer place-items-center rounded-full text-[#9D9082] transition-colors hover:bg-white/[0.07] hover:text-[#F5EFE6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] sm:h-9 sm:w-9"
                >
                  <ImagePlus className="h-4 w-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async e => {
                    const files = [...(e.target.files ?? [])].slice(0, 4);
                    e.target.value = '';
                    const next = await Promise.all(files.map(fileToAttachment));
                    setAttachments(list => [...list, ...next].slice(0, 4));
                  }}
                />
                <button
                  type="button"
                  onClick={onMic}
                  aria-label={listening ? 'Stop listening' : 'Voice dictation'}
                  title={listening ? 'Stop listening' : 'Voice dictation'}
                  className={`grid h-11 w-11 cursor-pointer place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] sm:h-9 sm:w-9 ${
                    listening
                      ? 'bg-[#D93025] text-white animate-pulse'
                      : 'text-[#9D9082] hover:bg-white/[0.07] hover:text-[#F5EFE6]'
                  }`}
                >
                  {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
                {onToggleHandsFree && (
                  <button
                    type="button"
                    onClick={onToggleHandsFree}
                    aria-pressed={handsFree}
                    aria-label={handsFree ? 'End hands-free live voice' : 'Start hands-free live voice'}
                    title={handsFree ? 'End hands-free voice loop' : 'Talk hands-free'}
                    className={`inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] sm:h-9 ${
                      handsFree
                        ? 'bg-[#FF7A1A]/20 text-[#FF9A48] ring-1 ring-[#FF7A1A]/40'
                        : 'text-[#9D9082] hover:bg-white/[0.07] hover:text-[#F5EFE6]'
                    }`}
                  >
                    {handsFree ? <PhoneOff className="h-3.5 w-3.5" /> : <AudioLines className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">{handsFree ? 'Live on' : 'Live'}</span>
                  </button>
                )}
              </div>

              {busy ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop response"
                  className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-[#D93025] text-white transition-colors hover:bg-[#EA4335] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 sm:h-9 sm:w-9"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => submit()}
                  disabled={!text.trim() && attachments.length === 0}
                  aria-label="Send message"
                  className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-[#FF7A1A] text-[#110C07] transition-colors hover:bg-[#FF903B] disabled:cursor-not-allowed disabled:bg-white/[0.08] disabled:text-[#6B6258] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A] sm:h-9 sm:w-9"
                >
                  <ArrowUp className="h-4 w-4 stroke-[2.5]" />
                </button>
              )}
            </div>
          </div>
          {authorityNotice && (
            <p className="mt-2 truncate px-2 text-center text-[11px] text-[#8E8172]">
              {authorityNotice}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const SNAPSHOT_REST = { time: 0, gaze: { x: 0, y: 0 } } as const;

const MessageRow = memo(function MessageRow({
  message,
  isLastAssistant,
  approvalIds,
  onDecide,
  onSpeakReply,
  rigState,
}: {
  message: ChatMessage;
  isLastAssistant: boolean;
  approvalIds: Set<string>;
  onDecide(id: string, ok: boolean): void;
  onSpeakReply?(text: string): void;
  rigState?: ChatPanelProps['rigState'];
}) {
  const [copied, setCopied] = useState(false);

  if (message.sender === 'system') {
    return (
      <div className="mx-auto max-w-[92%] rounded-2xl border border-white/[0.08] bg-[#16120E] px-3.5 py-2 text-center text-xs text-[#CBBEB0]">
        {message.text}
      </div>
    );
  }

  const mine = message.sender === 'user';

  if (mine) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.attachments?.length ? (
          <div className="flex flex-wrap justify-end gap-2">
            {message.attachments.map(a => (
              <img
                key={a.id}
                src={a.dataUrl}
                alt="Uploaded attachment"
                className="max-h-48 rounded-2xl border border-white/[0.1] object-cover"
              />
            ))}
          </div>
        ) : null}
        {message.text && (
          <div className="min-w-0 max-w-[88%] break-words [overflow-wrap:anywhere] rounded-3xl border border-[#FF7A1A]/15 bg-[#241C14] px-4 py-2.5 text-[15px] leading-relaxed text-[#F7F2EA] shadow-sm sm:max-w-[78%]">
            <p className="whitespace-pre-wrap">{message.text}</p>
          </div>
        )}
      </div>
    );
  }

  const liveAvatar = isLastAssistant && (Boolean(message.streaming) || Boolean(rigState?.speaking));

  const copyMessage = () => {
    if (!message.text) return;
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => undefined);
  };

  return (
    <div className="group flex items-start gap-3 sm:gap-3.5">
      <div
        aria-hidden="true"
        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full border border-[#FF7A1A]/30 bg-[#16120E] p-0.5 sm:h-9 sm:w-9"
      >
        <MissMinutesRig
          emotion={liveAvatar ? (rigState?.emotion ?? message.emotion ?? 'cheerful') : (message.emotion ?? 'cheerful')}
          gesture={liveAvatar ? (rigState?.gesture ?? 'none') : 'none'}
          gestureKey={liveAvatar ? (rigState?.gestureKey ?? 0) : 0}
          isSpeaking={liveAvatar && Boolean(rigState?.speaking)}
          mouthFrame={liveAvatar ? (rigState?.mouth ?? 0) : 0}
          skin={rigState?.skin ?? 'classic'}
          snapshot={liveAvatar ? undefined : SNAPSHOT_REST}
          gaze="none"
          className="h-full w-full"
          title="Miss Minutes"
        />
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        {message.attachments?.length ? (
          <div className="flex flex-wrap gap-2">
            {message.attachments.map(a => (
              <img
                key={a.id}
                src={a.dataUrl}
                alt="Attachment"
                className="max-h-48 rounded-2xl border border-white/[0.1] object-cover"
              />
            ))}
          </div>
        ) : null}

        {message.toolCalls?.map(call => (
          <ToolCard key={call.id} call={call} pending={approvalIds.has(call.id)} onDecide={onDecide} />
        ))}

        {(message.text || message.streaming) && (
          <div
            className={`min-w-0 break-words [overflow-wrap:anywhere] ${
              message.nexusEventDetected
                ? 'rounded-2xl border border-red-500/40 bg-red-950/20 px-4 py-3'
                : ''
            }`}
          >
            {message.text ? (
              <div className="mm-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                  {message.text}
                </ReactMarkdown>
              </div>
            ) : null}
            {message.streaming && !message.text && (
              <div className="inline-flex items-center gap-2 py-1 text-sm text-[#CBBEB0]">
                <span className="flex items-center gap-1" aria-hidden="true">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#FF7A1A] animate-bounce [animation-delay:-0.24s]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#FF7A1A] animate-bounce [animation-delay:-0.12s]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#FF7A1A] animate-bounce" />
                </span>
                <span>Thinking…</span>
              </div>
            )}
          </div>
        )}

        {!message.streaming && message.text && (
          <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[11px] text-[#8E8172] opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <button
              type="button"
              onClick={copyMessage}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-white/[0.06] hover:text-[#F5EFE6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            {onSpeakReply && (
              <button
                type="button"
                onClick={() => onSpeakReply(message.text)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-white/[0.06] hover:text-[#F5EFE6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
              >
                <Volume2 className="h-3.5 w-3.5" />
                <span>Speak</span>
              </button>
            )}
            <span className="ml-1 text-[#786B5E]">
              {message.timestamp}
              {message.model ? ` · ${message.model}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

function ToolCard({
  call,
  pending,
  onDecide,
}: {
  call: ToolCallRecord;
  pending: boolean;
  onDecide(id: string, ok: boolean): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABEL[call.name] ?? call.name;
  const waiting = call.status === 'awaiting-approval';
  const risk = call.risk ?? 'medium';

  if (waiting) {
    return (
      <div
        className={`w-full rounded-2xl border p-3.5 text-xs ${
          risk === 'high'
            ? 'border-red-500/50 bg-red-950/25'
            : 'border-[#FF7A1A]/50 bg-[#1C140C]'
        }`}
      >
        <div className="flex items-center gap-2 font-semibold text-[#FFF4E4]">
          <ShieldAlert className={`h-4 w-4 shrink-0 ${risk === 'high' ? 'text-red-400' : 'text-[#FF9240]'}`} />
          <span>{label} requires your approval</span>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#F5EFE6]">
          {call.preview ?? 'Miss Minutes requests permission to run this action.'}
        </p>
        {call.previewContent && (
          <pre className="mt-2.5 max-h-48 overflow-auto rounded-xl border border-white/[0.08] bg-[#0B0907] p-2.5 font-mono text-[11px] text-[#CBBEB0]">
            {call.previewContent}
          </pre>
        )}
        {risk === 'high' && (
          <p className="mt-2 text-xs font-medium text-red-300">
            High-impact action: review carefully before approving.
          </p>
        )}
        {pending && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onDecide(call.id, true)}
              className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 transition-colors hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              <Check className="h-3.5 w-3.5" /> Approve
            </button>
            <button
              type="button"
              onClick={() => onDecide(call.id, false)}
              className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-2 text-xs font-medium text-[#F5EFE6] transition-colors hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A1A]"
            >
              <X className="h-3.5 w-3.5" /> Decline
            </button>
          </div>
        )}
      </div>
    );
  }

  const hasDetail = Boolean(call.preview || call.error || call.attachments?.length);
  const summaryText =
    call.status === 'denied'
      ? 'Declined'
      : call.summary ?? call.error ?? call.preview ?? '';

  return (
    <div className="w-full rounded-2xl border border-white/[0.08] bg-[#14100C]/90 text-xs">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded(v => !v)}
        disabled={!hasDetail}
        className={`flex w-full items-center gap-2 px-3.5 py-2 text-left ${hasDetail ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}
      >
        {call.status === 'running' && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#FF7A1A]" />}
        {call.status === 'done' && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
        {(call.status === 'error' || call.status === 'denied') && (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
        )}
        {!['running', 'done', 'error', 'denied'].includes(call.status) && (
          <Wrench className="h-3.5 w-3.5 shrink-0 text-[#9D9082]" />
        )}
        <span className="font-semibold text-[#F5EFE6]">{label}</span>
        {summaryText && <span className="min-w-0 flex-1 truncate text-[#9D9082]">{summaryText}</span>}
        {hasDetail && (
          expanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#8E8172]" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#8E8172]" />
        )}
      </button>
      {expanded && hasDetail && (
        <div className="space-y-2 border-t border-white/[0.06] px-3.5 py-2.5 text-[11px] text-[#CBBEB0]">
          {call.preview && <p className="whitespace-pre-wrap">{call.preview}</p>}
          {call.error && <p className="text-red-300">{call.error}</p>}
          {call.attachments?.length ? (
            <div className="flex flex-wrap gap-2">
              {call.attachments.map(a => (
                <img
                  key={a.id}
                  src={a.dataUrl}
                  alt="Tool output"
                  className="max-h-36 rounded-xl border border-white/[0.1]"
                />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
