/**
 * Platform bridge abstraction for `src/`:
 * - Desktop runtime uses Tauri IPC (`window.__TAURI__`).
 * - Android WebViews register the full mobile bridge/gate/nativeApi adapter via `registerMobilePlatform`
 *   so there is zero upward coupling from `src/` into `native/mobile/`.
 * - When running isolated Node tests (e.g. dbRouting / toolAuthority) with a `window.missNative` stub,
 *   a minimal protocol-v1 fallback talks to `window.missNative` directly.
 */

export interface PlatformChatGptAccount {
  signedIn: boolean;
  email: string | null;
  planUsage: boolean;
  expiresAtUnixMs: number | null;
}

export interface PlatformChatGptModel {
  slug: string;
  displayName: string;
}

export type PlatformProviderId = 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'ollama' | 'elevenlabs';

export interface PlatformProviderStreamEvent {
  requestId: string;
  event: 'start' | 'chunk' | 'done' | 'error';
  status?: number;
  headers?: Record<string, string>;
  data?: string;
  cancelled?: boolean;
  code?: string;
  message?: string;
}

export type PlatformOperatingMode = 'OWNER_MODE' | 'OWNER_CANDIDATE' | 'GUEST_MODE';
export type PlatformCallFactKind = 'scheduled_window' | 'booking_name' | 'callback_number' | 'reference_code' | 'brief_topic';

export interface PlatformCallFact {
  kind: PlatformCallFactKind;
  value: string;
}

export interface PlatformPreparedCall {
  callId: string;
  destinationE164: string;
  callerLabel: string;
  voice: string;
  disclosureOpening: string;
  allowedFacts: PlatformCallFact[];
  state: string;
  dryRun: boolean;
  dailyRemaining: number;
}

export interface PlatformWakeStatus {
  listening: boolean;
  micPermission: boolean;
  mode: PlatformOperatingMode;
  phrases: string[];
  emergencyStops: string[];
}

export interface PlatformWakeFeedResult {
  status: string;
  phrase?: string;
  confidence?: number;
  mode?: PlatformOperatingMode;
  hits?: number;
  required?: number;
}

export interface PlatformAuditVerifyResult {
  valid: boolean;
  count: number;
  status: string;
}

export interface PlatformAuditListResult {
  verified: boolean;
  verifiedStatus: string;
  entries: Array<Record<string, unknown>>;
}

export interface PlatformStreamHandle {
  requestId: string;
  cancel: () => Promise<void>;
  dispose: () => void;
}

export interface MobilePlatformAdapter {
  isAndroidApp: () => boolean;
  request: (
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    requestId?: string,
  ) => Promise<Record<string, unknown>>;
  onEvent?: (name: string, listener: (payload: Record<string, unknown>) => void) => () => void;
  encodeRequest: (id: string, type: string, payload?: Record<string, unknown>) => string;
  isAndroidMigrationRenderer: (location: Pick<Location, 'origin' | 'pathname'>) => boolean;
  mayOpenLegacyOwnerDatabase: (nativeOwnerStore: boolean, authenticatedMigration: boolean) => boolean;
  chatGptAccount?: () => Promise<PlatformChatGptAccount>;
  chatGptModels?: () => Promise<PlatformChatGptModel[]>;
  chatGptRequest?: (
    url: string,
    method: string,
    body: string,
    requestId?: string,
  ) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  cancelChatGptRequest?: (requestId: string) => Promise<void>;
  providerSecretStatus?: (provider: PlatformProviderId) => Promise<{ present: boolean; remembered: boolean }>;
  providerSecretSet?: (provider: PlatformProviderId, value: string, remember?: boolean) => Promise<{ present: boolean }>;
  providerSecretRemember?: (provider: PlatformProviderId, remember: boolean) => Promise<{ present: boolean; remembered: boolean }>;
  providerSecretRemove?: (provider: PlatformProviderId) => Promise<{ present: boolean }>;
  providerHttpRequest?: (params: {
    provider: PlatformProviderId;
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    binary?: boolean;
    requestId?: string;
  }) => Promise<{ status: number; headers: Record<string, string>; body?: string; bodyBase64?: string }>;
  openRouterExchange?: (code: string, verifier: string, remember?: boolean) => Promise<{ present: boolean; remembered: boolean }>;
  createOwnerRecovery?: (passphrase: string) => Promise<{ material: string }>;
  startProviderHttpStream?: (
    params: {
      provider: PlatformProviderId;
      url: string;
      method?: 'GET' | 'POST';
      headers?: Record<string, string>;
      body?: string;
      requestId?: string;
    },
    onChunkEvent: (ev: PlatformProviderStreamEvent) => void,
  ) => Promise<PlatformStreamHandle>;
  startChatGptStream?: (
    params: { url: string; method?: 'POST'; body: string; requestId?: string },
    onChunkEvent: (ev: PlatformProviderStreamEvent) => void,
  ) => Promise<PlatformStreamHandle>;
  callsPrepare?: (params: {
    destinationE164: string;
    ownerFirstName?: string;
    facts: PlatformCallFact[];
    dncNumbers?: string[];
  }) => Promise<PlatformPreparedCall>;
  callsStart?: (params: {
    destinationE164: string;
    ownerFirstName?: string;
    facts: PlatformCallFact[];
    dncNumbers?: string[];
  }) => Promise<PlatformPreparedCall>;
  callsHangup?: () => Promise<{ hungUp: boolean; activeCalls: number }>;
  verifyAuditChain?: () => Promise<PlatformAuditVerifyResult>;
  listOwnerAudit?: (limit?: number) => Promise<PlatformAuditListResult>;
  emergencyKillOwner?: () => Promise<{ killed: boolean; mode: PlatformOperatingMode }>;
  wakeStart?: () => Promise<{ listening: boolean }>;
  wakeStop?: () => Promise<{ listening: boolean }>;
  wakeStatus?: () => Promise<PlatformWakeStatus>;
  wakeFeed?: (transcript: string, confidence: number) => Promise<PlatformWakeFeedResult>;
}

interface FallbackPort {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface FallbackPending {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15_000;
const fallbackPending = new Map<string, FallbackPending>();
const fallbackEventListeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
let fallbackCounter = 0;
let fallbackAttached: FallbackPort | null = null;

let registeredAdapter: MobilePlatformAdapter | null = null;

export function registerMobilePlatform(adapter: MobilePlatformAdapter): void {
  registeredAdapter = adapter;
}

function attachFallbackPort(): FallbackPort | null {
  if (typeof window === 'undefined') return null;
  const port = (window as unknown as { missNative?: FallbackPort }).missNative;
  if (!port) return null;
  if (fallbackAttached !== port) {
    fallbackAttached = port;
    port.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(event.data) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === 'reply' && typeof msg.id === 'string') {
        const entry = fallbackPending.get(msg.id);
        if (!entry) return;
        fallbackPending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok === true) {
          const payload = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)
            ? (msg.payload as Record<string, unknown>)
            : {};
          entry.resolve(payload);
        } else {
          const err = msg.error && typeof msg.error === 'object' ? (msg.error as { message?: unknown }) : {};
          entry.reject(new Error(typeof err.message === 'string' && err.message ? err.message : 'request failed'));
        }
        return;
      }
      if (msg.type === 'event' && typeof msg.name === 'string') {
        const payload = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)
          ? (msg.payload as Record<string, unknown>)
          : {};
        fallbackEventListeners.get(msg.name)?.forEach(fn => fn(payload));
      }
    };
  }
  return port;
}

export function isAndroidApp(): boolean {
  if (registeredAdapter) return registeredAdapter.isAndroidApp();
  if (typeof window === 'undefined') return false;
  const hostname = window.location?.hostname ?? '';
  return (
    hostname === 'dashboard.missminutes.local' ||
    hostname === 'overlay.missminutes.local' ||
    hostname === 'appassets.androidplatform.net' ||
    hostname.endsWith('.missminutes.local')
  );
}

export function encodeBridgeRequest(
  id: string,
  type: string,
  payload: Record<string, unknown> = {},
): string {
  if (registeredAdapter) return registeredAdapter.encodeRequest(id, type, payload);
  return JSON.stringify({ v: PROTOCOL_VERSION, id, type, payload });
}

export function isAndroidMigrationRenderer(location: Pick<Location, 'origin' | 'pathname'>): boolean {
  if (registeredAdapter) return registeredAdapter.isAndroidMigrationRenderer(location);
  return location.origin === 'https://appassets.androidplatform.net'
    && location.pathname === '/assets/web/migration.html';
}

export function mayOpenLegacyOwnerDatabase(nativeOwnerStore: boolean, authenticatedMigration: boolean): boolean {
  if (registeredAdapter) return registeredAdapter.mayOpenLegacyOwnerDatabase(nativeOwnerStore, authenticatedMigration);
  return !nativeOwnerStore || authenticatedMigration;
}

export function androidRequest(
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  requestId?: string,
): Promise<Record<string, unknown>> {
  if (registeredAdapter) return registeredAdapter.request(type, payload, timeoutMs, requestId);
  const port = attachFallbackPort();
  if (!port) return Promise.reject(new Error('Not running inside the Miss Minutes app'));
  fallbackCounter += 1;
  const id = requestId ?? `w${fallbackCounter.toString(36)}-${Date.now().toString(36)}`;
  if (fallbackPending.has(id)) return Promise.reject(new Error('A request with this identifier is already running'));
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      fallbackPending.delete(id);
      reject(new Error(`No answer to ${type} within ${REQUEST_TIMEOUT_MS / 1000} seconds`));
    }, Math.max(1_000, Math.min(180_000, timeoutMs)));
    fallbackPending.set(id, { resolve, reject, timer });
    try {
      port.postMessage(encodeBridgeRequest(id, type, payload));
    } catch (e) {
      fallbackPending.delete(id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error('post failed'));
    }
  });
}

export function onAndroidEvent(
  name: string,
  listener: (payload: Record<string, unknown>) => void,
): () => void {
  if (registeredAdapter?.onEvent) return registeredAdapter.onEvent(name, listener);
  attachFallbackPort();
  let set = fallbackEventListeners.get(name);
  if (!set) {
    set = new Set();
    fallbackEventListeners.set(name, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

export async function androidChatGptAccount(): Promise<PlatformChatGptAccount> {
  if (registeredAdapter?.chatGptAccount) return registeredAdapter.chatGptAccount();
  return (await androidRequest('provider.chatgpt.account')) as unknown as PlatformChatGptAccount;
}

export async function androidChatGptModels(): Promise<PlatformChatGptModel[]> {
  if (registeredAdapter?.chatGptModels) return registeredAdapter.chatGptModels();
  const payload = await androidRequest('provider.chatgpt.models', {}, 30_000);
  return Array.isArray(payload.models) ? (payload.models as PlatformChatGptModel[]) : [];
}

export async function androidChatGptRequest(
  url: string,
  method: string,
  body: string,
  requestId?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (registeredAdapter?.chatGptRequest) return registeredAdapter.chatGptRequest(url, method, body, requestId);
  const payload = await androidRequest('provider.chatgpt.request', { url, method, body }, 150_000, requestId);
  return {
    status: typeof payload.status === 'number' ? payload.status : 0,
    headers: payload.headers && typeof payload.headers === 'object' ? (payload.headers as Record<string, string>) : {},
    body: typeof payload.body === 'string' ? payload.body : '',
  };
}

export async function cancelAndroidChatGptRequest(requestId: string): Promise<void> {
  if (registeredAdapter?.cancelChatGptRequest) {
    await registeredAdapter.cancelChatGptRequest(requestId);
    return;
  }
  await androidRequest('provider.chatgpt.cancel', { requestId }, 5_000);
}

export async function androidProviderSecretStatus(
  provider: PlatformProviderId,
): Promise<{ present: boolean; remembered: boolean }> {
  if (registeredAdapter?.providerSecretStatus) {
    return registeredAdapter.providerSecretStatus(provider);
  }
  const p = await androidRequest('provider.secret.status', { provider }, 10_000);
  return { present: p.present === true, remembered: p.remembered === true };
}

export async function androidProviderSecretSet(
  provider: PlatformProviderId,
  value: string,
  remember = true,
): Promise<{ present: boolean }> {
  if (registeredAdapter?.providerSecretSet) {
    return registeredAdapter.providerSecretSet(provider, value, remember);
  }
  const p = await androidRequest('provider.secret.set', { provider, value, remember }, 10_000);
  return { present: p.present === true };
}

export async function androidProviderSecretRemember(
  provider: PlatformProviderId,
  remember: boolean,
): Promise<{ present: boolean; remembered: boolean }> {
  if (registeredAdapter?.providerSecretRemember) {
    return registeredAdapter.providerSecretRemember(provider, remember);
  }
  const p = await androidRequest('provider.secret.remember', { provider, remember }, 10_000);
  return { present: p.present === true, remembered: p.remembered === true };
}

export async function androidProviderSecretRemove(
  provider: PlatformProviderId,
): Promise<{ present: boolean }> {
  if (registeredAdapter?.providerSecretRemove) {
    return registeredAdapter.providerSecretRemove(provider);
  }
  const p = await androidRequest('provider.secret.remove', { provider }, 10_000);
  return { present: p.present === true };
}

export async function androidProviderHttpRequest(params: {
  provider: PlatformProviderId;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  binary?: boolean;
  requestId?: string;
}): Promise<{ status: number; headers: Record<string, string>; body?: string; bodyBase64?: string }> {
  if (registeredAdapter?.providerHttpRequest) {
    return registeredAdapter.providerHttpRequest(params);
  }
  const payload = await androidRequest(
    'provider.http.request',
    {
      provider: params.provider,
      url: params.url,
      method: params.method ?? 'POST',
      headers: params.headers ?? {},
      body: params.body ?? '',
      binary: Boolean(params.binary),
    },
    150_000,
    params.requestId,
  );
  return {
    status: typeof payload.status === 'number' ? payload.status : 0,
    headers: payload.headers && typeof payload.headers === 'object' ? (payload.headers as Record<string, string>) : {},
    ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
    ...(typeof payload.bodyBase64 === 'string' ? { bodyBase64: payload.bodyBase64 } : {}),
  };
}

export async function androidOpenRouterExchange(
  code: string,
  verifier: string,
  remember = false,
): Promise<{ present: boolean; remembered: boolean }> {
  if (registeredAdapter?.openRouterExchange) {
    return registeredAdapter.openRouterExchange(code, verifier, remember);
  }
  const p = await androidRequest('provider.openrouter.exchange', { code, verifier, remember }, 30_000);
  return { present: p.present === true, remembered: p.remembered === true };
}

export async function androidCreateOwnerRecovery(
  passphrase: string,
): Promise<{ material: string }> {
  if (registeredAdapter?.createOwnerRecovery) {
    return registeredAdapter.createOwnerRecovery(passphrase);
  }
  const p = await androidRequest('owner.recovery.create', { passphrase }, 120_000);
  return { material: typeof p.material === 'string' ? p.material : '' };
}

function parseFallbackStreamEvent(raw: Record<string, unknown>): PlatformProviderStreamEvent | null {
  const requestId = typeof raw.requestId === 'string' ? raw.requestId : '';
  const ev = raw.event;
  if (!requestId || (ev !== 'start' && ev !== 'chunk' && ev !== 'done' && ev !== 'error')) return null;
  return {
    requestId,
    event: ev,
    status: typeof raw.status === 'number' ? raw.status : undefined,
    headers: raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
      ? (raw.headers as Record<string, string>) : undefined,
    data: typeof raw.data === 'string' ? raw.data : undefined,
    cancelled: typeof raw.cancelled === 'boolean' ? raw.cancelled : undefined,
    code: typeof raw.code === 'string' ? raw.code : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  };
}

export async function startAndroidProviderHttpStream(
  params: {
    provider: PlatformProviderId;
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    requestId?: string;
  },
  onChunkEvent: (ev: PlatformProviderStreamEvent) => void,
): Promise<PlatformStreamHandle> {
  if (registeredAdapter?.startProviderHttpStream) {
    return registeredAdapter.startProviderHttpStream(params, onChunkEvent);
  }
  const requestId = params.requestId ?? `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const unsubscribe = onAndroidEvent('provider.event', (raw) => {
    const parsed = parseFallbackStreamEvent(raw);
    if (!parsed || parsed.requestId !== requestId) return;
    onChunkEvent(parsed);
    if (parsed.event === 'done' || parsed.event === 'error') unsubscribe();
  });
  try {
    await androidRequest('provider.http.stream', {
      requestId,
      provider: params.provider,
      url: params.url,
      method: params.method ?? 'POST',
      headers: params.headers ?? {},
      body: params.body ?? '',
    }, 30_000, requestId);
  } catch (err) {
    unsubscribe();
    throw err;
  }
  return {
    requestId,
    cancel: async () => {
      try { await androidRequest('provider.http.cancel', { requestId }, 5_000); }
      finally { unsubscribe(); }
    },
    dispose: unsubscribe,
  };
}

export async function startAndroidChatGptStream(
  params: { url: string; method?: 'POST'; body: string; requestId?: string },
  onChunkEvent: (ev: PlatformProviderStreamEvent) => void,
): Promise<PlatformStreamHandle> {
  if (registeredAdapter?.startChatGptStream) {
    return registeredAdapter.startChatGptStream(params, onChunkEvent);
  }
  const requestId = params.requestId ?? `cgpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const unsubscribe = onAndroidEvent('provider.event', (raw) => {
    const parsed = parseFallbackStreamEvent(raw);
    if (!parsed || parsed.requestId !== requestId) return;
    onChunkEvent(parsed);
    if (parsed.event === 'done' || parsed.event === 'error') unsubscribe();
  });
  try {
    await androidRequest('provider.chatgpt.request', {
      requestId,
      url: params.url,
      method: params.method ?? 'POST',
      body: params.body,
      stream: true,
    }, 30_000, requestId);
  } catch (err) {
    unsubscribe();
    throw err;
  }
  return {
    requestId,
    cancel: async () => {
      try { await androidRequest('provider.chatgpt.cancel', { requestId }, 5_000); }
      finally { unsubscribe(); }
    },
    dispose: unsubscribe,
  };
}

function parsePreparedCallFallback(p: Record<string, unknown>): PlatformPreparedCall {
  const facts: PlatformCallFact[] = Array.isArray(p.allowedFacts)
    ? p.allowedFacts.filter((item): item is PlatformCallFact => (
      !!item && typeof item === 'object' && typeof (item as PlatformCallFact).kind === 'string' && typeof (item as PlatformCallFact).value === 'string'
    ))
    : [];
  return {
    callId: typeof p.callId === 'string' ? p.callId : '',
    destinationE164: typeof p.destinationE164 === 'string' ? p.destinationE164 : '',
    callerLabel: typeof p.callerLabel === 'string' ? p.callerLabel : 'Miss Minutes',
    voice: typeof p.voice === 'string' ? p.voice : 'MISS_MINUTES_TVA',
    disclosureOpening: typeof p.disclosureOpening === 'string' ? p.disclosureOpening : '',
    allowedFacts: facts,
    state: typeof p.state === 'string' ? p.state : 'draft',
    dryRun: p.dryRun !== false,
    dailyRemaining: typeof p.dailyRemaining === 'number' && Number.isFinite(p.dailyRemaining) ? Math.max(0, Math.floor(p.dailyRemaining)) : 0,
  };
}

export async function androidCallsPrepare(params: {
  destinationE164: string;
  ownerFirstName?: string;
  facts: PlatformCallFact[];
  dncNumbers?: string[];
}): Promise<PlatformPreparedCall> {
  if (registeredAdapter?.callsPrepare) return registeredAdapter.callsPrepare(params);
  return parsePreparedCallFallback(await androidRequest('calls.prepare', params as unknown as Record<string, unknown>, 15_000));
}

export async function androidCallsStart(params: {
  destinationE164: string;
  ownerFirstName?: string;
  facts: PlatformCallFact[];
  dncNumbers?: string[];
}): Promise<PlatformPreparedCall> {
  if (registeredAdapter?.callsStart) return registeredAdapter.callsStart(params);
  return parsePreparedCallFallback(await androidRequest('calls.start', params as unknown as Record<string, unknown>, 120_000));
}

export async function androidCallsHangup(): Promise<{ hungUp: boolean; activeCalls: number }> {
  if (registeredAdapter?.callsHangup) return registeredAdapter.callsHangup();
  const p = await androidRequest('calls.hangup', {}, 10_000);
  return {
    hungUp: p.hungUp === true,
    activeCalls: typeof p.activeCalls === 'number' && Number.isFinite(p.activeCalls) ? Math.max(0, Math.floor(p.activeCalls)) : 0,
  };
}

export async function androidVerifyAuditChain(): Promise<PlatformAuditVerifyResult> {
  if (registeredAdapter?.verifyAuditChain) return registeredAdapter.verifyAuditChain();
  const p = await androidRequest('owner.audit.verify', {}, 10_000);
  return {
    valid: p.valid === true,
    count: typeof p.count === 'number' && Number.isFinite(p.count) ? Math.max(0, Math.floor(p.count)) : 0,
    status: typeof p.status === 'string' ? p.status : 'unknown',
  };
}

export async function androidListOwnerAudit(limit = 50): Promise<PlatformAuditListResult> {
  if (registeredAdapter?.listOwnerAudit) return registeredAdapter.listOwnerAudit(limit);
  const p = await androidRequest('owner.audit.list', { limit }, 10_000);
  const entries = Array.isArray(p.entries)
    ? p.entries.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
    : [];
  return {
    verified: p.verified === true,
    verifiedStatus: typeof p.verifiedStatus === 'string' ? p.verifiedStatus : 'unknown',
    entries,
  };
}

export async function androidEmergencyKillOwner(): Promise<{ killed: boolean; mode: PlatformOperatingMode }> {
  if (registeredAdapter?.emergencyKillOwner) return registeredAdapter.emergencyKillOwner();
  const p = await androidRequest('owner.kill', {}, 10_000);
  const mode = p.mode === 'OWNER_MODE' || p.mode === 'OWNER_CANDIDATE' || p.mode === 'GUEST_MODE' ? p.mode : 'GUEST_MODE';
  return { killed: p.killed === true, mode };
}

export async function androidWakeStart(): Promise<{ listening: boolean }> {
  if (registeredAdapter?.wakeStart) return registeredAdapter.wakeStart();
  const p = await androidRequest('wake.start', {}, 15_000);
  return { listening: p.listening === true };
}

export async function androidWakeStop(): Promise<{ listening: boolean }> {
  if (registeredAdapter?.wakeStop) return registeredAdapter.wakeStop();
  const p = await androidRequest('wake.stop', {}, 10_000);
  return { listening: p.listening === true };
}

export async function androidWakeStatus(): Promise<PlatformWakeStatus> {
  if (registeredAdapter?.wakeStatus) return registeredAdapter.wakeStatus();
  const p = await androidRequest('wake.status', {}, 10_000);
  const mode = p.mode === 'OWNER_MODE' || p.mode === 'OWNER_CANDIDATE' || p.mode === 'GUEST_MODE' ? p.mode : 'GUEST_MODE';
  return {
    listening: p.listening === true,
    micPermission: p.micPermission === true,
    mode,
    phrases: Array.isArray(p.phrases) ? p.phrases.filter((v): v is string => typeof v === 'string') : [],
    emergencyStops: Array.isArray(p.emergencyStops) ? p.emergencyStops.filter((v): v is string => typeof v === 'string') : [],
  };
}

export async function androidWakeFeed(transcript: string, confidence: number): Promise<PlatformWakeFeedResult> {
  if (registeredAdapter?.wakeFeed) return registeredAdapter.wakeFeed(transcript, confidence);
  const p = await androidRequest('wake.feed', { transcript, confidence }, 10_000);
  const mode = p.mode === 'OWNER_MODE' || p.mode === 'OWNER_CANDIDATE' || p.mode === 'GUEST_MODE' ? p.mode : undefined;
  return {
    status: typeof p.status === 'string' ? p.status : 'error',
    phrase: typeof p.phrase === 'string' ? p.phrase : undefined,
    confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
    mode,
    hits: typeof p.hits === 'number' ? p.hits : undefined,
    required: typeof p.required === 'number' ? p.required : undefined,
  };
}
