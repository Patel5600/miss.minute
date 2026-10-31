import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle, Check, ChevronDown, ImagePlus, Loader2, MessageSquarePlus, Mic, MicOff, Send, ShieldAlert,
  Square, Trash2, Wrench, X,
} from 'lucide-react';
import type { Attachment, ChatMessage, ToolCallRecord } from '../types';
import type { ChatRecord } from '../store/db';
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
}

const SUGGESTIONS = [
  "What's on my schedule today?",
  'Set a 10 minute timer for tea',
  'Remind me to call Mom at 6 pm',
  "What's the weather like?",
  'Remember that I take my coffee black',
  'Look at my screen and tell me what you see',
];

const TOOL_LABEL: Record<string, string> = {
  get_time: 'Clock', set_timer: 'Timer', list_timers: 'Timers', control_timer: 'Timer', set_alarm: 'Alarm',
  add_reminder: 'Reminder', add_event: 'Calendar', list_schedule: 'Schedule', update_schedule_item: 'Schedule',
  delete_schedule_item: 'Schedule', find_conflicts: 'Schedule', add_todo: 'To-do', list_todos: 'To-dos',
  complete_todo: 'To-do', delete_todo: 'To-do', create_note: 'Note', list_notes: 'Notes', read_note: 'Note',
  append_note: 'Note', delete_note: 'Note', get_weather: 'Weather', web_search: 'Search', calculate: 'Math',
  remember: 'Memory', recall: 'Memory', forget: 'Memory', look_at_screen: 'Screen', look_through_camera: 'Camera',
  list_apps: 'Apps', system_info: 'System', open_app: 'Open app', open_url: 'Open link', open_path: 'Open',
  list_directory: 'Folder', read_text_file: 'Read file', write_text_file: 'Write file', make_directory: 'New folder',
  move_path: 'Move', copy_path: 'Copy', delete_path: 'Recycle Bin', run_command: 'Command',
};

async function fileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  // Downscale large photos so requests stay small.
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
    id: crypto.randomUUID(), kind: 'image', mime: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', 0.86),
    source: 'upload', width: canvas.width, height: canvas.height,
  };
}

export function ChatPanel(props: ChatPanelProps) {
  const { messages, chats, chatId, busy, approvals, listening, interim, onSend, onStop, onDecide, onMic } = props;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showChats, setShowChats] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const approvalIds = new Set(approvals.map(a => a.call.id));

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, approvals.length]);

  const submit = (value = text) => {
    if (!value.trim() && attachments.length === 0) return;
    onSend(value, attachments.length ? attachments : undefined);
    setText('');
    setAttachments([]);
  };

  const title = chats.find(c => c.id === chatId)?.title ?? 'New conversation';

  return (
    <div className="flex h-full min-h-[520px] flex-col overflow-hidden rounded-3xl border border-amber-700/40 bg-[#140d07]/90 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
      {/* Header: conversation picker */}
      <div className="relative flex items-center justify-between gap-2 border-b border-amber-800/40 px-4 py-3">
        <button type="button" onClick={() => setShowChats(v => !v)} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-amber-900/30">
          <span className="truncate text-sm font-semibold text-amber-100">{title}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-amber-400" />
        </button>
        <button type="button" onClick={props.onNewChat} className="flex items-center gap-1.5 rounded-lg border border-amber-700/50 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-900/40">
          <MessageSquarePlus className="h-4 w-4" /> New
        </button>
        {showChats && (
          <div className="absolute left-3 top-12 z-30 max-h-80 w-72 overflow-y-auto rounded-xl border border-amber-700/50 bg-[#1a110a] p-1 shadow-2xl">
            {chats.length === 0 && <p className="px-3 py-2 text-xs text-amber-400/70">No conversations yet.</p>}
            {chats.map(chat => (
              <div key={chat.id} className={`group flex items-center gap-1 rounded-lg ${chat.id === chatId ? 'bg-amber-800/30' : 'hover:bg-amber-900/30'}`}>
                <button type="button" onClick={() => { props.onOpenChat(chat.id); setShowChats(false); }} className="min-w-0 flex-1 truncate px-3 py-2 text-left text-xs text-amber-100">
                  {chat.title}
                </button>
                <button type="button" onClick={() => props.onDeleteChat(chat.id)} aria-label={`Delete ${chat.title}`} className="mr-1 rounded p-1 text-amber-500/60 opacity-0 hover:text-red-300 group-hover:opacity-100">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Transcript */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" onClick={() => setShowChats(false)}>
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
            <p className="max-w-sm text-sm text-amber-200/80">Ask her anything, or hand her a job. She keeps your timers, reminders, schedule, notes and to-dos, and remembers what matters to you.</p>
            <div className="flex max-w-lg flex-wrap justify-center gap-2">
              {SUGGESTIONS.map(s => (
                <button key={s} type="button" onClick={() => submit(s)} className="rounded-full border border-amber-700/50 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200 hover:border-amber-500 hover:text-amber-50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(message => (
          <MessageRow key={message.id} message={message} approvalIds={approvalIds} onDecide={onDecide} />
        ))}
        <div ref={bottom} />
      </div>

      {/* Composer */}
      <div className="border-t border-amber-800/40 p-3">
        {attachments.length > 0 && (
          <div className="mb-2 flex gap-2">
            {attachments.map(a => (
              <div key={a.id} className="relative">
                <img src={a.dataUrl} alt="" className="h-14 w-14 rounded-lg border border-amber-700/50 object-cover" />
                <button type="button" onClick={() => setAttachments(list => list.filter(x => x.id !== a.id))} className="absolute -right-1.5 -top-1.5 rounded-full bg-black p-0.5 text-amber-200" aria-label="Remove image">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={onMic}
            aria-label={listening ? 'Stop listening' : 'Talk to her'}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl border transition-colors ${listening ? 'border-red-400 bg-red-600 text-white animate-pulse' : 'border-amber-700/50 bg-amber-950/50 text-amber-300 hover:text-amber-100'}`}
          >
            {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} aria-label="Attach an image" className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-amber-700/50 bg-amber-950/50 text-amber-300 hover:text-amber-100">
            <ImagePlus className="h-5 w-5" />
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={async e => {
            const files = [...(e.target.files ?? [])].slice(0, 4);
            e.target.value = '';
            const next = await Promise.all(files.map(fileToAttachment));
            setAttachments(list => [...list, ...next].slice(0, 4));
          }} />
          <textarea
            value={listening ? interim || text : text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            rows={1}
            placeholder={listening ? 'Listening…' : 'Talk to Miss Minutes…'}
            className="max-h-36 min-h-11 flex-1 resize-none rounded-2xl border border-amber-700/50 bg-black/50 px-4 py-2.5 text-sm text-amber-50 placeholder-amber-700/70 outline-none focus:border-amber-400"
          />
          {busy ? (
            <button type="button" onClick={onStop} aria-label="Stop" className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-red-600 text-white hover:bg-red-500">
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button type="button" onClick={() => submit()} disabled={!text.trim() && attachments.length === 0} aria-label="Send" className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-500 text-neutral-950 hover:bg-amber-400 disabled:opacity-40">
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message, approvalIds, onDecide }: { message: ChatMessage; approvalIds: Set<string>; onDecide(id: string, ok: boolean): void }) {
  if (message.sender === 'system') {
    return <div className="mx-auto max-w-[90%] rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-1.5 text-center text-xs text-amber-200">{message.text}</div>;
  }
  const mine = message.sender === 'user';
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      {message.attachments?.length ? (
        <div className="mb-1 flex gap-1.5">
          {message.attachments.map(a => <img key={a.id} src={a.dataUrl} alt="" className="h-24 rounded-lg border border-amber-700/50 object-cover" />)}
        </div>
      ) : null}
      {message.toolCalls?.map(call => (
        <ToolCard key={call.id} call={call} pending={approvalIds.has(call.id)} onDecide={onDecide} />
      ))}
      {(message.text || message.streaming) && (
        <div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${mine ? 'rounded-br-md bg-amber-600/30 text-amber-50' : `rounded-bl-md border bg-black/50 text-amber-100 ${message.nexusEventDetected ? 'border-red-600/60' : 'border-amber-800/50'}`}`}>
          {mine ? (
            <p className="whitespace-pre-wrap">{message.text}</p>
          ) : (
            <div className="mm-md">
              {message.text ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown> : null}
              {message.streaming && !message.text && <span className="inline-flex items-center gap-2 text-amber-400/80"><Loader2 className="h-3.5 w-3.5 animate-spin" /> thinking…</span>}
            </div>
          )}
        </div>
      )}
      <span className="mt-1 px-1 text-[10px] text-amber-600/80">{message.timestamp}</span>
    </div>
  );
}

function ToolCard({ call, pending, onDecide }: { call: ToolCallRecord; pending: boolean; onDecide(id: string, ok: boolean): void }) {
  const label = TOOL_LABEL[call.name] ?? call.name;
  const waiting = call.status === 'awaiting-approval';
  const risk = call.risk ?? 'medium';
  const tone = waiting
    ? risk === 'high' ? 'border-red-500/70 bg-red-950/40' : 'border-amber-500/70 bg-amber-950/50'
    : call.status === 'error' || call.status === 'denied' ? 'border-red-800/50 bg-red-950/20' : 'border-amber-800/40 bg-amber-950/20';

  return (
    <div className={`mb-1.5 w-full max-w-[88%] rounded-xl border px-3 py-2 text-xs ${tone}`}>
      <div className="flex items-center gap-2 text-amber-200">
        {call.status === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />}
        {call.status === 'done' && <Check className="h-3.5 w-3.5 text-emerald-400" />}
        {waiting && <ShieldAlert className={`h-3.5 w-3.5 ${risk === 'high' ? 'text-red-400' : 'text-amber-400'}`} />}
        {(call.status === 'error' || call.status === 'denied') && <AlertTriangle className="h-3.5 w-3.5 text-red-400" />}
        {!['running', 'done', 'awaiting-approval', 'error', 'denied'].includes(call.status) && <Wrench className="h-3.5 w-3.5" />}
        <span className="font-semibold">{label}</span>
        <span className="truncate text-amber-300/80">
          {waiting ? 'wants your OK' : call.status === 'denied' ? 'declined' : call.summary ?? call.error ?? call.preview ?? ''}
        </span>
      </div>
      {waiting && (
        <div className="mt-2 space-y-2">
          <p className="whitespace-pre-wrap text-amber-50">{call.preview ?? 'She wants to run this action.'}</p>
          {call.previewContent && (
            <pre className="max-h-48 overflow-auto rounded-lg border border-amber-800/50 bg-black/60 p-2 text-[11px] text-amber-100">{call.previewContent}</pre>
          )}
          {risk === 'high' && <p className="text-red-300">This can change your computer. Read it carefully.</p>}
          {pending && (
            <div className="flex gap-2">
              <button type="button" onClick={() => onDecide(call.id, true)} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500">
                <Check className="h-3.5 w-3.5" /> Approve
              </button>
              <button type="button" onClick={() => onDecide(call.id, false)} className="flex items-center gap-1 rounded-lg border border-amber-700/60 px-3 py-1.5 text-amber-200 hover:bg-amber-900/40">
                <X className="h-3.5 w-3.5" /> Don't
              </button>
            </div>
          )}
        </div>
      )}
      {call.attachments?.length ? (
        <div className="mt-2 flex gap-1.5">{call.attachments.map(a => <img key={a.id} src={a.dataUrl} alt="" className="h-24 rounded border border-amber-800/50" />)}</div>
      ) : null}
    </div>
  );
}
