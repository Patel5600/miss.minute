import { useCallback, useEffect, useState } from 'react';
import { Activity, Check, FilePlus2, FileText, Monitor, Power, RefreshCw, Rocket, ShieldCheck, Square, TimerReset, X } from 'lucide-react';
import { invokeNative, isDesktopRuntime, type AgentEventRecord, type AgentStreamTicket, type CreateNotePayload, type NativeAgentStatus, type OwnerContextRecord, type PendingAction } from '../desktop/bridge';

const emptyStatus: NativeAgentStatus = {
  enrolled: false,
  running: false,
  roots: [],
  events: 0,
  indexedFiles: 0,
  decisions: 0,
  lastError: null,
  approvedNoteRoots: [],
  pendingActions: 0,
  autoCreateNotes: false,
  foregroundWindowContextEnabled: false,
  foregroundWindowContextSupported: false,
  automaticActionsToday: 0,
  dailyNoteLimit: 3,
};

function readCreateNotePayload(json: string): CreateNotePayload | null {
  try {
    const value = JSON.parse(json) as Partial<CreateNotePayload>;
    if (
      value.kind === 'create_note' &&
      Number.isInteger(value.root_index) &&
      typeof value.filename === 'string' &&
      typeof value.content === 'string'
    ) {
      return value as CreateNotePayload;
    }
  } catch {
    return null;
  }
  return null;
}

export function DesktopCompanionPanel() {
  const desktop = isDesktopRuntime();
  const [status, setStatus] = useState<NativeAgentStatus>(emptyStatus);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [rootsText, setRootsText] = useState('');
  const [consent, setConsent] = useState(false);
  const [noteRootPath, setNoteRootPath] = useState('');
  const [noteWriteConsent, setNoteWriteConsent] = useState(false);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [ownerContexts, setOwnerContexts] = useState<OwnerContextRecord[]>([]);
  const [contextTitle, setContextTitle] = useState('');
  const [contextContent, setContextContent] = useState('');
  const [agentEvents, setAgentEvents] = useState<AgentEventRecord[]>([]);
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'expired' | 'offline'>('connecting');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      const next = await invokeNative<NativeAgentStatus>('agent_status');
      setStatus(next);
      const startup = await invokeNative<boolean>('get_startup');
      setStartupEnabled(startup);
      const actions = await invokeNative<PendingAction[]>('pending_actions');
      setPendingActions(actions);
      const contexts = await invokeNative<OwnerContextRecord[]>('owner_context_list');
      setOwnerContexts(contexts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Native status is unavailable.');
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [desktop, refresh]);

  useEffect(() => {
    if (!desktop || !status.enrolled) {
      setStreamState('offline');
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let ticket: AgentStreamTicket | undefined;
    let cursor = 0;
    let polling = false;

    const closeTicket = async () => {
      const active = ticket;
      ticket = undefined;
      if (active) {
        await invokeNative('agent_stream_close', { token: active.token }).catch(() => undefined);
      }
    };

    const poll = async () => {
      if (cancelled || polling) return;
      polling = true;
      try {
        if (!ticket) {
          setStreamState(cursor > 0 ? 'connecting' : 'connecting');
          ticket = await invokeNative<AgentStreamTicket>('agent_stream_open',
            cursor > 0 ? { afterSeq: cursor } : {});
          if (cursor === 0) cursor = ticket.cursor;
        }

        const activeTicket = ticket;
        const batch = await invokeNative<AgentEventRecord[]>('agent_events_after', {
          token: activeTicket.token,
          afterSeq: cursor,
          limit: 50,
        });
        if (cancelled) return;

        let expected = cursor;
        for (const event of batch) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= expected) {
            throw new Error('Event sequence was not strictly increasing.');
          }
          expected = event.seq;
        }
        if (batch.length > 0) {
          // Hand the page to renderer state before acknowledging it. Sequence
          // deduplication makes a retry safe if the acknowledgement is lost.
          setAgentEvents(previous => {
            const bySequence = new Map(previous.map(event => [event.seq, event]));
            for (const event of batch) bySequence.set(event.seq, event);
            return [...bySequence.values()].sort((left, right) => left.seq - right.seq).slice(-12);
          });
          await invokeNative<void>('agent_stream_ack', {
            token: activeTicket.token,
            sequence: expected,
          });
          if (cancelled) return;
          cursor = expected;
        }
        setStreamState('live');
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : '';
        if (message.includes('retention gap')) {
          await closeTicket();
          cursor = 0;
          setAgentEvents([]);
          setNotice('Some older events expired under the configured retention policy. Live monitoring has resumed from the current ledger position.');
          setStreamState('expired');
        } else if (message.includes('expired') || message.includes('invalid') || message.includes('Open an event stream')) {
          await closeTicket();
          setStreamState('expired');
        } else {
          setStreamState('offline');
        }
      } finally {
        polling = false;
      }
    };

    void poll();
    timer = window.setInterval(() => void poll(), 1500);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
      void closeTicket();
    };
  }, [desktop, status.enrolled]);

  if (!desktop) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The native operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const saveOwnerContext = async () => {
    await run(async () => {
      await invokeNative<OwnerContextRecord>('owner_context_upsert', {
        id: null,
        title: contextTitle,
        content: contextContent,
        enabled: true,
      });
      setContextTitle('');
      setContextContent('');
    });
  };

  const toggleOwnerContext = async (context: OwnerContextRecord) => {
    await run(async () => {
      await invokeNative<OwnerContextRecord>('owner_context_upsert', {
        id: context.id,
        title: context.title,
        content: context.content,
        enabled: !context.enabled,
      });
    });
  };

  const deleteOwnerContext = async (id: string) => {
    await run(async () => {
      await invokeNative<boolean>('owner_context_delete', { id });
    });
  };

  const enroll = async () => {
    const roots = rootsText.split(/\r?\n/).map(root => root.trim()).filter(Boolean);
    await run(async () => {
      const next = await invokeNative<NativeAgentStatus>('agent_enroll', {
        roots,
        confirmOwnerPermission: consent,
      });
      setStatus(next);
    });
  };

  return (
    <section className="rounded-2xl border border-amber-500/30 bg-[#170F08]/90 p-4 shadow-xl backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-amber-400" />
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-200">Desktop Companion</p>
            <p className="text-[10px] text-amber-500/70">Native process • local IPC • Windows overlay</p>
          </div>
        </div>
        <span className={
          status.running
            ? 'rounded-full border border-emerald-500/40 bg-emerald-950/50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300'
            : 'rounded-full border border-amber-700/40 bg-black/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-400'
        }>
          {status.running ? 'Agent running' : status.enrolled ? 'Agent stopped' : 'Not enrolled'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-amber-800/30 bg-black/30 p-2">
          <p className="text-lg font-black tabular-nums text-amber-200">{status.events}</p>
          <p className="text-[9px] uppercase tracking-wider text-amber-500/70">Events</p>
        </div>
        <div className="rounded-xl border border-amber-800/30 bg-black/30 p-2">
          <p className="text-lg font-black tabular-nums text-amber-200">{status.indexedFiles}</p>
          <p className="text-[9px] uppercase tracking-wider text-amber-500/70">Files</p>
        </div>
        <div className="rounded-xl border border-amber-800/30 bg-black/30 p-2">
          <p className="text-lg font-black tabular-nums text-amber-200">{status.decisions}</p>
          <p className="text-[9px] uppercase tracking-wider text-amber-500/70">Decisions</p>
        </div>
      </div>

      {!status.enrolled && (
        <div className="mt-3 rounded-xl border border-amber-700/30 bg-black/25 p-3">
          <div className="mb-2 flex items-center gap-2 text-amber-200">
            <ShieldCheck className="h-4 w-4 text-amber-400" />
            <p className="text-[11px] font-bold">Authorize folders explicitly</p>
          </div>
          <textarea
            value={rootsText}
            onChange={event => setRootsText(event.target.value)}
            rows={3}
            placeholder={'One existing absolute folder path per line\nC:\\Users\\You\\Projects'}
            className="w-full resize-y rounded-lg border border-amber-700/40 bg-[#0D0906] px-3 py-2 text-[11px] text-amber-100 outline-none placeholder:text-amber-800 focus:border-amber-400"
          />
          <label className="mt-2 flex cursor-pointer items-start gap-2 text-[10px] leading-relaxed text-amber-400/80">
            <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-0.5 accent-amber-500" />
            I reviewed these exact paths and authorize metadata-only monitoring. File contents, screenshots, clipboard and keystrokes are not collected.
          </label>
          <button
            type="button"
            disabled={busy || !consent || !rootsText.trim()}
            onClick={() => void enroll()}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-[11px] font-black uppercase tracking-wider text-neutral-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Rocket className="h-3.5 w-3.5" /> Enroll and start
          </button>
        </div>
      )}

      {status.enrolled && (
        <>
          <div className="mt-3 space-y-1 rounded-xl border border-amber-800/30 bg-black/25 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-amber-400">Authorized roots</p>
            {status.roots.map(root => <p key={root} className="break-all text-[10px] text-amber-200/75">{root}</p>)}
          </div>
          <div className="mt-3 rounded-xl border border-amber-700/30 bg-black/25 p-3">
            <div className="mb-2 flex items-center gap-2 text-amber-200">
              <FilePlus2 className="h-4 w-4 text-amber-400" />
              <p className="text-[11px] font-bold">Separate note-write permission</p>
            </div>
            <p className="mb-2 text-[10px] leading-relaxed text-amber-500/80">
              Metadata access does not grant write access. Choose an existing subfolder inside an authorized root. Miss Minutes may create new Markdown notes only there.
            </p>
            <input
              value={noteRootPath}
              onChange={event => setNoteRootPath(event.target.value)}
              placeholder="Exact existing folder path"
              className="w-full rounded-lg border border-amber-700/40 bg-[#0D0906] px-3 py-2 text-[11px] text-amber-100 outline-none placeholder:text-amber-800 focus:border-amber-400"
            />
            <label className="mt-2 flex cursor-pointer items-start gap-2 text-[10px] leading-relaxed text-amber-400/80">
              <input type="checkbox" checked={noteWriteConsent} onChange={event => setNoteWriteConsent(event.target.checked)} className="mt-0.5 accent-amber-500" />
              I separately authorize creation of new .md files in this exact folder. Existing files must never be overwritten.
            </label>
            <button
              type="button"
              disabled={busy || !noteWriteConsent || !noteRootPath.trim()}
              onClick={() => void run(async () => {
                await invokeNative('authorize_note_root', {
                  path: noteRootPath.trim(),
                  confirmWritePermission: noteWriteConsent,
                });
                setNoteRootPath('');
                setNoteWriteConsent(false);
              })}
              className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/40 bg-amber-950/50 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-amber-200 disabled:opacity-40"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Authorize note output folder
            </button>
            {status.approvedNoteRoots.map(root => (
              <div key={root} className="mt-2 flex items-center justify-between gap-2 border-t border-amber-800/30 pt-2">
                <p className="break-all text-[10px] text-amber-200/75">{root}</p>
                <button
                  type="button"
                  title="Revoke note-write permission"
                  disabled={busy}
                  onClick={() => void run(async () => { await invokeNative('revoke_note_root', { path: root }); })}
                  className="shrink-0 rounded border border-red-700/40 p-1 text-red-300 hover:bg-red-950/40 disabled:opacity-40"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={busy || status.running} onClick={() => void run(async () => { await invokeNative('agent_start'); })} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-600/40 bg-emerald-950/35 px-2 py-2 text-[10px] font-bold text-emerald-200 disabled:opacity-40">
              <Power className="h-3.5 w-3.5" /> Start agent
            </button>
            <button type="button" disabled={busy || !status.running} onClick={() => void run(async () => { await invokeNative('agent_stop'); })} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-700/40 bg-black/30 px-2 py-2 text-[10px] font-bold text-amber-200 disabled:opacity-40">
              <Square className="h-3.5 w-3.5" /> Stop agent
            </button>
            <button type="button" disabled={busy} onClick={() => void run(async () => { await invokeNative('toggle_avatar'); })} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-700/40 bg-black/30 px-2 py-2 text-[10px] font-bold text-amber-200 disabled:opacity-40">
              <Activity className="h-3.5 w-3.5" /> Toggle avatar
            </button>
            <button type="button" disabled={busy} onClick={() => void refresh()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-700/40 bg-black/30 px-2 py-2 text-[10px] font-bold text-amber-200 disabled:opacity-40">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => {
              const next = await invokeNative<boolean>('set_startup', { enabled: !startupEnabled });
              setStartupEnabled(next);
            })}
            className="mt-2 inline-flex w-full items-center justify-between rounded-lg border border-amber-700/30 bg-black/25 px-3 py-2 text-left text-[10px] text-amber-200"
          >
            <span className="flex items-center gap-2"><TimerReset className="h-3.5 w-3.5 text-amber-400" /> Launch Miss Minutes at login</span>
            <span className={startupEnabled ? 'font-bold text-emerald-300' : 'text-amber-500'}>{startupEnabled ? 'Enabled' : 'Disabled'}</span>
          </button>
          <div className="mt-3 rounded-xl border border-amber-700/30 bg-black/25 p-3">
            <label className="flex cursor-pointer items-start justify-between gap-3">
              <span>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-amber-200">Foreground window title context</span>
                <span className="mt-1 block text-[10px] leading-relaxed text-amber-500/80">
                  Windows only. When enabled, record the title of the current foreground window every 10 seconds, only when it changes. Titles can reveal document or conversation names. No window contents, screenshots, keystrokes, clipboard, browser history or background-app enumeration are collected.
                </span>
              </span>
              <input
                type="checkbox"
                checked={status.foregroundWindowContextEnabled}
                disabled={busy || !status.foregroundWindowContextSupported}
                onChange={event => {
                  const enabled = event.target.checked;
                  void run(async () => {
                    const next = await invokeNative<NativeAgentStatus>('set_foreground_window_context', { enabled });
                    setStatus(next);
                  });
                }}
                className="mt-1 h-4 w-4 shrink-0 accent-amber-500 disabled:opacity-40"
                aria-label="Enable foreground window title context"
              />
            </label>
            {!status.foregroundWindowContextSupported && (
              <p className="mt-2 border-t border-amber-800/30 pt-2 text-[9px] text-amber-600/80">
                This source is available only in the Windows desktop build.
              </p>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-amber-700/30 bg-black/25 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-amber-200">Owner-pinned context</p>
            <p className="mt-1 text-[9px] leading-relaxed text-amber-500/80">
              Add background notes or preferences Miss Minutes may use when evaluating events. These are encrypted in the local evidence database, never treated as observed activity, and remain editable or removable here. Maximum 20 notes and 64 KiB total.
            </p>
            <input
              value={contextTitle}
              onChange={event => setContextTitle(event.target.value)}
              maxLength={80}
              placeholder="Short title"
              className="mt-2 w-full rounded-lg border border-amber-700/40 bg-[#0D0906] px-3 py-2 text-[10px] text-amber-100 outline-none placeholder:text-amber-800 focus:border-amber-400"
            />
            <textarea
              value={contextContent}
              onChange={event => setContextContent(event.target.value)}
              maxLength={16384}
              rows={3}
              placeholder="Owner-written background context, constraints or preferences"
              className="mt-2 w-full resize-y rounded-lg border border-amber-700/40 bg-[#0D0906] px-3 py-2 text-[10px] text-amber-100 outline-none placeholder:text-amber-800 focus:border-amber-400"
            />
            <button
              type="button"
              disabled={busy || !contextTitle.trim() || !contextContent.trim()}
              onClick={() => void saveOwnerContext()}
              className="mt-2 w-full rounded-lg border border-amber-500/40 bg-amber-600/20 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-amber-200 disabled:opacity-40"
            >
              Save owner context
            </button>
            <div className="mt-2 space-y-2">
              {ownerContexts.map(context => (
                <div key={context.id} className="rounded-lg border border-amber-900/40 bg-black/30 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold text-amber-100">{context.title}</span>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-[9px] text-amber-400">
                        <input type="checkbox" checked={context.enabled} disabled={busy} onChange={() => void toggleOwnerContext(context)} />
                        Use
                      </label>
                      <button type="button" disabled={busy} onClick={() => void deleteOwnerContext(context.id)} className="text-[9px] text-red-300 disabled:opacity-40">Delete</button>
                    </div>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[9px] leading-relaxed text-amber-500/80">{context.content}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-amber-700/30 bg-black/25 p-3">
            <label className="flex cursor-pointer items-start justify-between gap-3">
              <span>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-amber-200">Automatic note creation</span>
                <span className="mt-1 block text-[10px] leading-relaxed text-amber-500/80">
                  Explicit opt-in for create_note only. It may create new Markdown notes in approved folders without asking each time. No overwrites, no other file actions, maximum {status.dailyNoteLimit} per UTC day.
                </span>
              </span>
              <input
                type="checkbox"
                checked={status.autoCreateNotes}
                disabled={busy || status.approvedNoteRoots.length === 0}
                onChange={event => void run(async () => {
                  const next = await invokeNative<NativeAgentStatus>('set_auto_note_creation', { enabled: event.target.checked });
                  setStatus(next);
                })}
                className="mt-1 h-4 w-4 shrink-0 accent-amber-500 disabled:opacity-40"
                aria-label="Enable automatic Markdown note creation"
              />
            </label>
            <p className="mt-2 border-t border-amber-800/30 pt-2 text-[9px] text-amber-500/70">
              Automatically created today: {status.automaticActionsToday} / {status.dailyNoteLimit} (UTC)
            </p>
          </div>

          <div className="mt-3 rounded-xl border border-amber-700/30 bg-black/25 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-200">Live local event feed</p>
              <span className={streamState === 'live' ? 'text-[9px] text-emerald-300' : 'text-[9px] text-amber-500'}>{streamState}</span>
            </div>
            {agentEvents.length === 0 ? (
              <p className="mt-2 text-[10px] text-amber-500/70">No new events since this dashboard session opened.</p>
            ) : (
              <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
                {agentEvents.slice().reverse().map(event => (
                  <div key={event.seq} className="border-t border-amber-900/30 pt-2">
                    <p className="text-[10px] text-amber-200">{event.event_type.replaceAll('_', ' ')}</p>
                    <p className="break-all text-[9px] text-amber-500/70">{event.resource_path ?? event.source}</p>
                    <p className="text-[9px] text-amber-700">{new Date(event.observed_at_unix_ms).toLocaleTimeString()}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-amber-700/30 bg-black/25 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-amber-400" />
                <p className="text-[10px] font-bold uppercase tracking-wider text-amber-200">Action approvals</p>
              </div>
              <span className="rounded-full border border-amber-600/30 px-2 py-0.5 text-[10px] text-amber-300">{pendingActions.length} pending</span>
            </div>
            {pendingActions.length === 0 ? (
              <p className="mt-2 text-[10px] text-amber-500/70">No actions waiting for approval.</p>
            ) : (
              <div className="mt-2 space-y-3">
                {pendingActions.map(action => {
                  const payload = readCreateNotePayload(action.payloadJson);
                  const outputRoot = payload ? status.approvedNoteRoots[payload.root_index] : undefined;
                  const target = payload && outputRoot ? `${outputRoot.replace(/[\\/]$/, '')}/${payload.filename}` : 'Invalid or revoked output scope';
                  return (
                    <article key={action.id} className="rounded-xl border border-amber-700/30 bg-[#100B07] p-3">
                      <p className="text-[11px] font-semibold text-amber-100">{action.description}</p>
                      <p className="mt-1 break-all font-mono text-[9px] text-amber-500/80">{target}</p>
                      {payload ? (
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-amber-900/40 bg-black/40 p-2 text-[10px] leading-relaxed text-amber-200">{payload.content}</pre>
                      ) : (
                        <p className="mt-2 text-[10px] text-red-300">Payload validation failed. Do not approve.</p>
                      )}
                      <p className="mt-2 text-[9px] text-amber-600/80">Expires {new Date(action.expiresAtUnixMs).toLocaleString()} • existing files are never replaced</p>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={busy || !payload || !outputRoot}
                          onClick={() => void run(async () => {
                            const result = await invokeNative<{ createdPath?: string; bytesWritten: number }>('approve_action', { actionId: action.id });
                            setNotice(`Created ${result.createdPath ?? 'note'} (${result.bytesWritten} bytes).`);
                          })}
                          className="inline-flex items-center justify-center gap-1 rounded-lg bg-amber-500 px-2 py-2 text-[10px] font-bold text-neutral-950 disabled:opacity-40"
                        >
                          <Check className="h-3 w-3" /> Approve and create
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(async () => { await invokeNative('reject_action', { actionId: action.id }); })}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-red-700/40 bg-red-950/20 px-2 py-2 text-[10px] font-bold text-red-200 disabled:opacity-40"
                        >
                          <X className="h-3 w-3" /> Reject
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {notice && <p className="mt-2 rounded-lg border border-emerald-700/40 bg-emerald-950/30 p-2 text-[10px] text-emerald-200">{notice}</p>}
      {status.lastError && <p className="mt-2 rounded-lg border border-red-700/40 bg-red-950/35 p-2 text-[10px] text-red-300">{status.lastError}</p>}
      {error && <p className="mt-2 rounded-lg border border-red-700/40 bg-red-950/35 p-2 text-[10px] text-red-300">{error}</p>}
      <p className="mt-3 text-[9px] leading-relaxed text-amber-600/80">
        Closing the dashboard leaves the native process and avatar active. The tray menu controls visibility and shutdown. Activity coverage is limited to the folders above.
      </p>
    </section>
  );
}

export default DesktopCompanionPanel;
