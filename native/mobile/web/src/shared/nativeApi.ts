/**
 * Typed calls to the native side for the dashboard, plus the pure helpers that turn native answers
 * into text. Everything a screen shows about her overlay, the kill notice and the settings comes from
 * native; nothing here pretends. A missing field falls back to the safe reading ("off", "no").
 */
import { onEvent, request } from './bridge.ts';
import type { Payload } from './protocol.ts';
import { MODES, ROAMING_LEVELS } from './vocabulary.ts';
import type { Mode, RoamingLevel } from './vocabulary.ts';

export type OverlayVisibility = 'ACTIVE' | 'DOCKED' | 'PAUSED' | 'HIDDEN' | 'NONE';
export type CompanionRuntimeState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED' | 'PERMISSION_BLOCKED' | 'RECOVERING';
export type AndroidOperatingMode = 'OWNER_MODE' | 'OWNER_CANDIDATE' | 'GUEST_MODE';
const VISIBILITIES: readonly OverlayVisibility[] = ['ACTIVE', 'DOCKED', 'PAUSED', 'HIDDEN', 'NONE'];
const RUNTIME_STATES: readonly CompanionRuntimeState[] = ['STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'FAILED', 'PERMISSION_BLOCKED', 'RECOVERING'];
const OPERATING_MODES: readonly AndroidOperatingMode[] = ['OWNER_MODE', 'OWNER_CANDIDATE', 'GUEST_MODE'];

export type RuntimeState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED' | 'PERMISSION_BLOCKED' | 'RECOVERING';

export interface RuntimeStatus {
  eventId: string;
  serviceInstanceId: string | null;
  revision: number;
  monotonicTimestampNanos: number;
  state: RuntimeState;
  reason: string | null;
}


export interface OverlayStatus {
  runtime: RuntimeStatus | null;
  running: boolean;
  windowShown: boolean;
  dashboardForeground: boolean;
  pageReady: boolean;
  visibility: OverlayVisibility;
  overlayPermission: boolean;
  notificationPermission: boolean;
  desiredRunning: boolean;
  hiddenUntilMs: number;
  killed: boolean;
  runtimeState: CompanionRuntimeState;
  runtimeRevision: number;
  runtimeEventId: string;
  runtimeServiceInstanceId: string;
  runtimeMonotonicAtMs: number;
  runtimeFailure: string;
  roamingLevel: RoamingLevel;
  appliedRoamingLevel: RoamingLevel | null;
}

export interface SettingsValues {
  roaming_level: RoamingLevel;
  keep_after_close: boolean;
  hide_in_fullscreen: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  roaming_enabled: boolean;
  hidden_until_ms: number;
  proactive: boolean;
  share_system_with_remote: boolean;
}

export interface KillNotice {
  atMs: number;
  path: string;
}

export interface HelloInfo {
  mode: Mode;
  proactive: boolean;
  version: string;
  sdk: number;
  overlay: OverlayStatus;
  settings: SettingsValues;
  killNotice: KillNotice | null;
  ownerEnrolled: boolean;
  ownerAuthenticated: boolean;
  /** True when a face/speaker recognition signal has been observed but no authenticated session is active yet. */
  ownerCandidate: boolean;
  /** Raw Rust AuthState string: unenrolled | locked | owner_candidate | authentication_pending |
   *  owner_authenticated | step_up_required | guest_active | revoked | device_untrusted */
  authState: string;
  /** Authoritative 3-mode state projected from the native Rust authority engine. */
  operatingMode: AndroidOperatingMode;
  faceProfileEnrolled: boolean;
  faceProfilePending: boolean;
  speakerProfileEnrolled: boolean;
  speakerProfilePending: boolean;
  sensorConsentGiven: boolean;
  ownerClaimPending: boolean;
  wakeListening: boolean;
  micPermission: boolean;
  activeCalls: number;
  auditChainStatus: string;
}

export interface ChatGptAccount {
  signedIn: boolean;
  email: string | null;
  planUsage: boolean;
  expiresAtUnixMs: number | null;
}

export interface ChatGptModel {
  slug: string;
  displayName: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseRuntimeStatus(raw: unknown): RuntimeStatus | null {
  if (!isObject(raw) || !(RUNTIME_STATES as readonly unknown[]).includes(raw.state)) return null;
  return {
    eventId: typeof raw.eventId === 'string' ? raw.eventId : '',
    serviceInstanceId: typeof raw.serviceInstanceId === 'string' ? raw.serviceInstanceId : null,
    revision: Math.max(0, num(raw.revision, 0)),
    monotonicTimestampNanos: Math.max(0, num(raw.monotonicTimestampNanos, 0)),
    state: raw.state as RuntimeState,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
  };
}

export function parseOverlayStatus(raw: unknown): OverlayStatus {
  const p: Record<string, unknown> = isObject(raw) ? raw : {};
  const runtime = parseRuntimeStatus(p.runtime);
  const visibility = (VISIBILITIES as readonly unknown[]).includes(p.visibility) ? (p.visibility as OverlayVisibility) : 'NONE';
  const running = runtime ? runtime.state === 'RUNNING' : bool(p.running, false);
  // runtimeState: prefer the authoritative runtime snapshot; fall back to the legacy flat field.
  const runtimeState: CompanionRuntimeState = runtime
    ? (runtime.state as CompanionRuntimeState)
    : ((RUNTIME_STATES as readonly unknown[]).includes(p.runtimeState) ? (p.runtimeState as CompanionRuntimeState) : 'STOPPED');
  return {
    runtime,
    running,
    windowShown: bool(p.windowShown, false),
    dashboardForeground: bool(p.dashboardForeground, false),
    pageReady: bool(p.pageReady, false),
    visibility,
    overlayPermission: bool(p.overlayPermission, false),
    notificationPermission: bool(p.notificationPermission, false),
    desiredRunning: bool(p.desiredRunning, false),
    hiddenUntilMs: Math.max(0, num(p.hiddenUntilMs, 0)),
    killed: bool(p.killed, false),
    runtimeState,
    runtimeRevision: Math.max(0, num(p.runtimeRevision, 0)),
    runtimeEventId: typeof p.runtimeEventId === 'string' ? p.runtimeEventId : '',
    runtimeServiceInstanceId: typeof p.runtimeServiceInstanceId === 'string' ? p.runtimeServiceInstanceId : '',
    runtimeMonotonicAtMs: Math.max(0, num(p.runtimeMonotonicAtMs, 0)),
    runtimeFailure: typeof p.runtimeFailure === 'string' ? p.runtimeFailure : '',
    roamingLevel: (ROAMING_LEVELS as readonly unknown[]).includes(p.roamingLevel) ? p.roamingLevel as RoamingLevel : 'CALM',
    appliedRoamingLevel: (ROAMING_LEVELS as readonly unknown[]).includes(p.appliedRoamingLevel)
      ? p.appliedRoamingLevel as RoamingLevel : null,
  };
}

export function parseSettings(raw: unknown): SettingsValues {
  const p: Record<string, unknown> = isObject(raw) ? raw : {};
  const level = (ROAMING_LEVELS as readonly unknown[]).includes(p.roaming_level) ? (p.roaming_level as RoamingLevel) : 'CALM';
  return {
    roaming_level: level,
    keep_after_close: bool(p.keep_after_close, false),
    hide_in_fullscreen: bool(p.hide_in_fullscreen, true),
    quiet_hours_enabled: bool(p.quiet_hours_enabled, false),
    quiet_hours_start: clampMinute(num(p.quiet_hours_start, 23 * 60)),
    quiet_hours_end: clampMinute(num(p.quiet_hours_end, 7 * 60)),
    roaming_enabled: bool(p.roaming_enabled, true),
    hidden_until_ms: Math.max(0, num(p.hidden_until_ms, 0)),
    proactive: bool(p.proactive, false),
    share_system_with_remote: bool(p.share_system_with_remote, false),
  };
}

export function parseKillNotice(raw: unknown): KillNotice | null {
  if (!isObject(raw)) return null;
  return { atMs: Math.max(0, num(raw.atMs, 0)), path: typeof raw.path === 'string' ? raw.path : 'external' };
}

export function parseHello(raw: Payload): HelloInfo {
  const mode = (MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as Mode) : 'OBSERVE';
  const ownerAuthenticated = bool(raw.ownerAuthenticated, false);
  const ownerCandidate = bool(raw.ownerCandidate, false);
  const parsedOperatingMode: AndroidOperatingMode =
    (OPERATING_MODES as readonly unknown[]).includes(raw.operatingMode)
      ? (raw.operatingMode as AndroidOperatingMode)
      : 'GUEST_MODE';
  const operatingMode: AndroidOperatingMode =
    parsedOperatingMode === 'OWNER_MODE' && !ownerAuthenticated
      ? (ownerCandidate ? 'OWNER_CANDIDATE' : 'GUEST_MODE')
      : parsedOperatingMode;
  return {
    mode,
    proactive: bool(raw.proactive, false),
    version: typeof raw.version === 'string' ? raw.version : '',
    sdk: num(raw.sdk, 0),
    overlay: parseOverlayStatus(raw.overlay),
    settings: parseSettings(raw.settings),
    killNotice: parseKillNotice(raw.killNotice),
    ownerEnrolled: bool(raw.ownerEnrolled, false),
    ownerAuthenticated,
    ownerCandidate,
    authState: typeof raw.authState === 'string' ? raw.authState : 'locked',
    operatingMode,
    faceProfileEnrolled: bool(raw.faceProfileEnrolled, false),
    faceProfilePending: bool(raw.faceProfilePending, false),
    speakerProfileEnrolled: bool(raw.speakerProfileEnrolled, false),
    speakerProfilePending: bool(raw.speakerProfilePending, false),
    sensorConsentGiven: bool(raw.sensorConsentGiven, false),
    ownerClaimPending: bool(raw.ownerClaimPending, false),
    wakeListening: bool(raw.wakeListening, false),
    micPermission: bool(raw.micPermission, false),
    activeCalls: Math.max(0, Math.floor(num(raw.activeCalls, 0))),
    auditChainStatus: typeof raw.auditChainStatus === 'string' && raw.auditChainStatus ? raw.auditChainStatus : 'unknown',
  };
}

// ---- calls ---------------------------------------------------------------------------------

/** The dashboard's hello. The answer carries the whole current state, so screens use it to refresh. */
export async function getHello(): Promise<HelloInfo> {
  return parseHello(await request('hello', { role: 'dashboard' }));
}

/** Opens the platform biometric prompt after a direct user action in the dashboard. */
export async function authenticateOwner(): Promise<void> {
  const payload = await request('owner.authenticate', {}, 120_000);
  if (payload.authenticated !== true) throw new Error('The device did not establish an owner session.');
}

/** Begin first-device enrollment, or request platform verification for an existing owner device. */
export async function setupOwnerDevice(): Promise<void> {
  const payload = await request('owner.setup.enroll', {}, 120_000);
  if (payload.authenticated !== true) throw new Error('Android did not confirm the owner device session.');
}

/** Show Android's sensor disclosure and persist the user's explicit consent choice. */
export async function consentToLocalSensors(): Promise<void> {
  const payload = await request('owner.setup.consent', {}, 120_000);
  if (payload.consented !== true) throw new Error('Android did not record sensor consent.');
}

/** Open local face presence/enrollment after the native owner capability check. */
export async function setupFaceProfile(): Promise<void> {
  const payload = await request('owner.setup.face');
  if (payload.opened !== 'face') throw new Error('Android did not open face profile setup.');
}

/** Open local speaker enrollment after the native owner capability check. */
export async function setupSpeakerProfile(): Promise<void> {
  const payload = await request('owner.setup.voice');
  if (payload.opened !== 'voice') throw new Error('Android did not open voice profile setup.');
}

/** Open foreground gaze/presence controls; these signals never authorize owner access. */
export async function setupPresenceCalibration(): Promise<void> {
  const payload = await request('owner.setup.presence');
  if (payload.opened !== 'face') throw new Error('Android did not open presence calibration.');
}

export interface StartResult {
  started: boolean;
  needsOverlayPermission: boolean;
  status: OverlayStatus;
}

export async function startOverlay(): Promise<StartResult> {
  const p = await request('overlay.start');
  return { started: p.started === true, needsOverlayPermission: p.needs === 'overlay_permission', status: parseOverlayStatus(p) };
}

export async function stopOverlay(): Promise<OverlayStatus> {
  return parseOverlayStatus(await request('overlay.stop'));
}

export async function requestOverlayPermission(): Promise<void> {
  await request('overlay.requestPermission');
}

export async function setSetting(key: keyof SettingsValues, value: boolean | number | string): Promise<SettingsValues> {
  const p = await request('settings.set', { key, value });
  return parseSettings(p.settings);
}

export async function setMode(mode: Mode): Promise<Mode> {
  const p = await request('permissions.setMode', { mode });
  return (MODES as readonly unknown[]).includes(p.mode) ? (p.mode as Mode) : 'OBSERVE';
}

export async function requestKill(): Promise<void> {
  await request('kill.request');
}

export async function ackKillNotice(): Promise<void> {
  await request('kill.ackNotice');
}

export async function openMetadataWatcher(): Promise<void> {
  await request('app.openMetadataWatcher');
}

export async function chatGptAccount(): Promise<ChatGptAccount> {
  return await request('provider.chatgpt.account') as unknown as ChatGptAccount;
}

export async function chatGptSignIn(): Promise<ChatGptAccount> {
  return await request('provider.chatgpt.signIn', {}, 360_000) as unknown as ChatGptAccount;
}

export async function chatGptSignOut(): Promise<void> {
  await request('provider.chatgpt.signOut', {}, 30_000);
}

export async function chatGptModels(): Promise<ChatGptModel[]> {
  const payload = await request('provider.chatgpt.models', {}, 30_000);
  return Array.isArray(payload.models) ? payload.models as ChatGptModel[] : [];
}

export async function chatGptRequest(url: string, method: string, body: string, requestId?: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const payload = await request('provider.chatgpt.request', { url, method, body }, 150_000, requestId);
  return {
    status: typeof payload.status === 'number' ? payload.status : 0,
    headers: payload.headers && typeof payload.headers === 'object' ? payload.headers as Record<string, string> : {},
    body: typeof payload.body === 'string' ? payload.body : '',
  };
}

export async function cancelChatGptRequest(requestId: string): Promise<void> {
  await request('provider.chatgpt.cancel', { requestId }, 5_000);
}

export type StreamProviderId = 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'ollama' | 'elevenlabs';

export async function providerSecretStatus(provider: StreamProviderId): Promise<{ present: boolean; remembered: boolean }> {
  const p = await request('provider.secret.status', { provider }, 10_000);
  return { present: bool(p.present, false), remembered: bool(p.remembered, false) };
}

export async function providerSecretSet(
  provider: StreamProviderId,
  value: string,
  remember = true,
): Promise<{ present: boolean }> {
  const p = await request('provider.secret.set', { provider, value, remember }, 10_000);
  return { present: bool(p.present, false) };
}

export async function providerSecretRemember(
  provider: StreamProviderId,
  remember: boolean,
): Promise<{ present: boolean; remembered: boolean }> {
  const p = await request('provider.secret.remember', { provider, remember }, 10_000);
  return { present: bool(p.present, false), remembered: bool(p.remembered, false) };
}

export async function providerSecretRemove(provider: StreamProviderId): Promise<{ present: boolean }> {
  const p = await request('provider.secret.remove', { provider }, 10_000);
  return { present: bool(p.present, false) };
}

export async function providerHttpRequest(params: {
  provider: StreamProviderId;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  binary?: boolean;
  requestId?: string;
}): Promise<{ status: number; headers: Record<string, string>; body?: string; bodyBase64?: string }> {
  const p = await request(
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
    status: typeof p.status === 'number' ? p.status : 0,
    headers: isObject(p.headers) ? (p.headers as Record<string, string>) : {},
    ...(typeof p.body === 'string' ? { body: p.body } : {}),
    ...(typeof p.bodyBase64 === 'string' ? { bodyBase64: p.bodyBase64 } : {}),
  };
}

export async function openRouterExchange(
  code: string,
  verifier: string,
  remember = false,
): Promise<{ present: boolean; remembered: boolean }> {
  const p = await request('provider.openrouter.exchange', { code, verifier, remember }, 30_000);
  return { present: bool(p.present, false), remembered: bool(p.remembered, false) };
}

export async function createOwnerRecovery(passphrase: string): Promise<{ material: string }> {
  const p = await request('owner.recovery.create', { passphrase }, 120_000);
  return { material: typeof p.material === 'string' ? p.material : '' };
}

export interface ProviderStreamEvent {
  requestId: string;
  event: 'start' | 'chunk' | 'done' | 'error';
  status?: number;
  headers?: Record<string, string>;
  data?: string;
  cancelled?: boolean;
  code?: string;
  message?: string;
}

export interface StreamHandle {
  requestId: string;
  cancel: () => Promise<void>;
  dispose: () => void;
}

function nextStreamId(): string {
  return `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseProviderStreamEvent(raw: Payload): ProviderStreamEvent | null {
  const requestId = typeof raw.requestId === 'string' ? raw.requestId : '';
  const ev = raw.event;
  if (!requestId || (ev !== 'start' && ev !== 'chunk' && ev !== 'done' && ev !== 'error')) return null;
  return {
    requestId,
    event: ev,
    status: typeof raw.status === 'number' ? raw.status : undefined,
    headers: isObject(raw.headers) ? (raw.headers as Record<string, string>) : undefined,
    data: typeof raw.data === 'string' ? raw.data : undefined,
    cancelled: typeof raw.cancelled === 'boolean' ? raw.cancelled : undefined,
    code: typeof raw.code === 'string' ? raw.code : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  };
}

export function onProviderEvent(listener: (ev: ProviderStreamEvent) => void): () => void {
  return onEvent('provider.event', (raw) => {
    const parsed = parseProviderStreamEvent(raw);
    if (parsed) listener(parsed);
  });
}

export async function startProviderHttpStream(
  params: {
    provider: StreamProviderId;
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    requestId?: string;
  },
  onChunkEvent: (ev: ProviderStreamEvent) => void,
): Promise<StreamHandle> {
  const requestId = params.requestId ?? nextStreamId();
  const unsubscribe = onProviderEvent((ev) => {
    if (ev.requestId !== requestId) return;
    onChunkEvent(ev);
    if (ev.event === 'done' || ev.event === 'error') unsubscribe();
  });
  try {
    await request('provider.http.stream', {
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
      try { await request('provider.http.cancel', { requestId }, 5_000); }
      finally { unsubscribe(); }
    },
    dispose: unsubscribe,
  };
}

export async function startChatGptStream(
  params: { url: string; method?: 'POST'; body: string; requestId?: string },
  onChunkEvent: (ev: ProviderStreamEvent) => void,
): Promise<StreamHandle> {
  const requestId = params.requestId ?? nextStreamId();
  const unsubscribe = onProviderEvent((ev) => {
    if (ev.requestId !== requestId) return;
    onChunkEvent(ev);
    if (ev.event === 'done' || ev.event === 'error') unsubscribe();
  });
  try {
    await request('provider.chatgpt.request', {
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
      try { await request('provider.chatgpt.cancel', { requestId }, 5_000); }
      finally { unsubscribe(); }
    },
    dispose: unsubscribe,
  };
}

export interface WakeStatus {
  listening: boolean;
  micPermission: boolean;
  mode: AndroidOperatingMode;
  phrases: string[];
  emergencyStops: string[];
}

export interface WakeFeedResult {
  status: string;
  phrase?: string;
  confidence?: number;
  mode?: AndroidOperatingMode;
  hits?: number;
  required?: number;
}

export interface WakeStateEvent {
  event: string;
  listening: boolean;
  mode: AndroidOperatingMode;
  phrase?: string;
  confidence?: number;
}

function parseOperatingMode(raw: unknown): AndroidOperatingMode {
  return (OPERATING_MODES as readonly unknown[]).includes(raw) ? (raw as AndroidOperatingMode) : 'GUEST_MODE';
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

export async function wakeStart(): Promise<{ listening: boolean }> {
  const p = await request('wake.start', {}, 15_000);
  return { listening: bool(p.listening, false) };
}

export async function wakeStop(): Promise<{ listening: boolean }> {
  const p = await request('wake.stop', {}, 10_000);
  return { listening: bool(p.listening, false) };
}

export async function wakeStatus(): Promise<WakeStatus> {
  const p = await request('wake.status', {}, 10_000);
  return {
    listening: bool(p.listening, false),
    micPermission: bool(p.micPermission, false),
    mode: parseOperatingMode(p.mode),
    phrases: stringArray(p.phrases),
    emergencyStops: stringArray(p.emergencyStops),
  };
}

export async function wakeFeed(transcript: string, confidence: number): Promise<WakeFeedResult> {
  const p = await request('wake.feed', { transcript, confidence }, 10_000);
  return {
    status: typeof p.status === 'string' ? p.status : 'error',
    phrase: typeof p.phrase === 'string' ? p.phrase : undefined,
    confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
    mode: p.mode !== undefined ? parseOperatingMode(p.mode) : undefined,
    hits: typeof p.hits === 'number' ? p.hits : undefined,
    required: typeof p.required === 'number' ? p.required : undefined,
  };
}

export function onWakeState(listener: (ev: WakeStateEvent) => void): () => void {
  return onEvent('wake.state', (raw) => {
    listener({
      event: typeof raw.event === 'string' ? raw.event : 'unknown',
      listening: bool(raw.listening, false),
      mode: parseOperatingMode(raw.mode),
      phrase: typeof raw.phrase === 'string' ? raw.phrase : undefined,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    });
  });
}

export type CallFactKind = 'scheduled_window' | 'booking_name' | 'callback_number' | 'reference_code' | 'brief_topic';

export interface CallFact {
  kind: CallFactKind;
  value: string;
}

export interface PreparedCallView {
  callId: string;
  destinationE164: string;
  callerLabel: string;
  voice: string;
  disclosureOpening: string;
  allowedFacts: CallFact[];
  state: string;
  dryRun: boolean;
  dailyRemaining: number;
}

export interface CallStateEvent {
  callId: string;
  destinationE164: string;
  state: string;
  voice: string;
  disclosureOpening: string;
}

function parsePreparedCall(raw: Payload): PreparedCallView {
  const facts: CallFact[] = [];
  if (Array.isArray(raw.allowedFacts)) {
    for (const item of raw.allowedFacts) {
      if (isObject(item) && typeof item.kind === 'string' && typeof item.value === 'string') {
        facts.push({ kind: item.kind as CallFactKind, value: item.value });
      }
    }
  }
  return {
    callId: typeof raw.callId === 'string' ? raw.callId : '',
    destinationE164: typeof raw.destinationE164 === 'string' ? raw.destinationE164 : '',
    callerLabel: typeof raw.callerLabel === 'string' ? raw.callerLabel : 'Miss Minutes',
    voice: typeof raw.voice === 'string' ? raw.voice : 'MISS_MINUTES_TVA',
    disclosureOpening: typeof raw.disclosureOpening === 'string' ? raw.disclosureOpening : '',
    allowedFacts: facts,
    state: typeof raw.state === 'string' ? raw.state : 'draft',
    dryRun: bool(raw.dryRun, true),
    dailyRemaining: Math.max(0, Math.floor(num(raw.dailyRemaining, 0))),
  };
}

export async function callsPrepare(params: {
  destinationE164: string;
  ownerFirstName?: string;
  facts: CallFact[];
  dncNumbers?: string[];
}): Promise<PreparedCallView> {
  return parsePreparedCall(await request('calls.prepare', params as unknown as Payload, 15_000));
}

export async function callsStart(params: {
  destinationE164: string;
  ownerFirstName?: string;
  facts: CallFact[];
  dncNumbers?: string[];
}): Promise<PreparedCallView> {
  return parsePreparedCall(await request('calls.start', params as unknown as Payload, 120_000));
}

export async function callsHangup(): Promise<{ hungUp: boolean; activeCalls: number }> {
  const p = await request('calls.hangup', {}, 10_000);
  return { hungUp: bool(p.hungUp, false), activeCalls: Math.max(0, Math.floor(num(p.activeCalls, 0))) };
}

export function onCallsState(listener: (ev: CallStateEvent) => void): () => void {
  return onEvent('calls.state', (raw) => {
    listener({
      callId: typeof raw.callId === 'string' ? raw.callId : '',
      destinationE164: typeof raw.destinationE164 === 'string' ? raw.destinationE164 : '',
      state: typeof raw.state === 'string' ? raw.state : 'aborted',
      voice: typeof raw.voice === 'string' ? raw.voice : 'MISS_MINUTES_TVA',
      disclosureOpening: typeof raw.disclosureOpening === 'string' ? raw.disclosureOpening : '',
    });
  });
}

export interface OwnerAuditVerifyResult {
  valid: boolean;
  count: number;
  status: string;
}

export interface OwnerAuditListResult {
  verified: boolean;
  verifiedStatus: string;
  entries: Array<Record<string, unknown>>;
}

export async function verifyAuditChain(): Promise<OwnerAuditVerifyResult> {
  const p = await request('owner.audit.verify', {}, 10_000);
  return {
    valid: bool(p.valid, false),
    count: Math.max(0, Math.floor(num(p.count, 0))),
    status: typeof p.status === 'string' ? p.status : 'unknown',
  };
}

export async function listOwnerAudit(limit = 50): Promise<OwnerAuditListResult> {
  const p = await request('owner.audit.list', { limit }, 10_000);
  const entries = Array.isArray(p.entries) ? p.entries.filter((e): e is Record<string, unknown> => isObject(e)) : [];
  return {
    verified: bool(p.verified, false),
    verifiedStatus: typeof p.verifiedStatus === 'string' ? p.verifiedStatus : 'unknown',
    entries,
  };
}

export async function emergencyKillOwner(): Promise<{ killed: boolean; mode: AndroidOperatingMode }> {
  const p = await request('owner.kill', {}, 10_000);
  return { killed: bool(p.killed, false), mode: parseOperatingMode(p.mode) };
}

// ---- text helpers (pure) -------------------------------------------------------------------

/**
 * Words for a failed native call, or null when nothing should be shown: "cancelled" means the owner
 * tapped Cancel in a native dialog, which is an answer and not an error.
 */
export function describeError(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'cancelled') return null;
  if (code === 'unavailable') return 'Open this in the Miss Minutes app.';
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}

export function clampMinute(minute: number): number {
  const whole = Math.round(minute);
  return whole >= 0 && whole < 24 * 60 ? whole : 0;
}

/** 1380 becomes "23:00". */
export function formatMinutes(minute: number): string {
  const m = clampMinute(minute);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "23:00" becomes 1380; null when the text is not a time of day. */
export function parseTimeInput(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const defaultClock = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

export type Tone = 'ok' | 'warn' | 'idle';

export interface OverlayDescription {
  headline: string;
  detail: string;
  tone: Tone;
  /** Show the "Allow Display over other apps" button. */
  needsOverlayPermission: boolean;
  /** Show a "Show her now" button: she is hidden by "hide for an hour". */
  hiddenByTimer: boolean;
  /** Tell the owner the notification Stop button is not visible. */
  notificationsOff: boolean;
}

/** What Home says about her overlay, from native facts only. `now` and `clock` are injectable for tests. */
export function describeOverlay(status: OverlayStatus, now: number = Date.now(), clock: (ms: number) => string = defaultClock): OverlayDescription {
  const base = {
    needsOverlayPermission: false,
    hiddenByTimer: false,
    notificationsOff: !status.notificationPermission,
  };
  switch (status.runtime?.state) {
    case 'STARTING':
      return { ...base, headline: 'Starting Miss Minutes', detail: 'Android accepted the start request. Waiting for the foreground service and overlay to become ready.', tone: 'idle' };
    case 'STOPPING':
      return { ...base, headline: 'Stopping Miss Minutes', detail: 'The foreground service is shutting down.', tone: 'idle' };
    case 'RECOVERING':
      return { ...base, headline: 'Reconnecting Miss Minutes', detail: 'The companion service is recovering after process interruption.', tone: 'idle' };
    case 'FAILED':
      return { ...base, headline: 'Miss Minutes could not start', detail: status.runtime.reason ?? 'The Android service reported a startup failure.', tone: 'warn' };
    case 'PERMISSION_BLOCKED':
      return {
        ...base,
        headline: 'Display permission required',
        detail: status.runtime.reason ?? 'Android blocked the overlay service because a required permission is missing.',
        tone: 'warn',
        needsOverlayPermission: true,
      };
    default:
      break;
  }
  if (!status.running) {
    if (!status.overlayPermission) {
      return {
        ...base,
        headline: 'She can only live inside the app',
        detail: 'Allow Display over other apps and she can walk around your screen.',
        tone: 'warn',
        needsOverlayPermission: true,
      };
    }
    if (status.killed) {
      return { ...base, headline: 'Stopped', detail: 'She stays off until you turn her on.', tone: 'idle' };
    }
    return { ...base, headline: 'She is not on your screen', detail: 'Turn her on to let her roam.', tone: 'idle' };
  }
  if (!status.pageReady) {
    return { ...base, headline: 'Starting', detail: 'Loading her picture.', tone: 'idle' };
  }
  if (status.dashboardForeground) {
    return { ...base, headline: 'Dashboard open', detail: 'She steps aside while you use the app and returns when you leave.', tone: 'ok' };
  }
  switch (status.visibility) {
    case 'DOCKED':
      return { ...base, headline: 'She is standing still on your screen', detail: 'Roaming is off or set to Docked.', tone: 'ok' };
    case 'PAUSED':
      return { ...base, headline: 'Paused', detail: 'She rests while the screen is off or locked.', tone: 'idle' };
    case 'HIDDEN': {
      if (status.hiddenUntilMs > now) {
        return { ...base, headline: `Hidden until ${clock(status.hiddenUntilMs)}`, detail: 'You asked her to step aside for a while.', tone: 'idle', hiddenByTimer: true };
      }
      return { ...base, headline: 'Hidden for now', detail: 'Quiet hours or a very low battery keep her off the screen.', tone: 'idle' };
    }
    case 'ACTIVE':
      return { ...base, headline: 'She is on your screen', detail: 'Touch and hold her for a menu with a Stop button.', tone: 'ok' };
    default:
      return { ...base, headline: 'Starting', detail: 'Getting ready.', tone: 'idle' };
  }
}

const NOTICE_SOURCE: Readonly<Record<string, string>> = {
  'notification': 'by the Stop button in the notification',
  'app-button': 'by the Stop button in the app',
  'overlay-menu': 'from her menu',
  'external': 'from outside the app',
};

/** The banner shown after a kill, until the owner acknowledges it. */
export function describeKillNotice(notice: KillNotice, clock: (ms: number) => string = defaultClock): string {
  const source = NOTICE_SOURCE[notice.path] ?? NOTICE_SOURCE.external;
  const when = notice.atMs > 0 ? ` at ${clock(notice.atMs)}` : '';
  return `Miss Minutes was stopped${when} ${source}. She is in Observe mode with her own reactions off, and nothing runs until you say so.`;
}

export const MODE_DETAILS: Readonly<Record<Mode, { label: string; text: string }>> = {
  OBSERVE: { label: 'Observe', text: 'She watches and answers. Nothing runs unless you tap it.' },
  SUGGEST: { label: 'Suggest', text: 'Low-risk helpers such as timers and notes run by themselves. Anything else asks first.' },
  AUTHORIZED: { label: 'Authorized', text: 'She may use what you have granted without asking each time, up to 20 automatic actions an hour.' },
};

export const LEVEL_DETAILS: Readonly<Record<RoamingLevel, { label: string; text: string }>> = {
  DOCKED: { label: 'Docked', text: 'Stays in one spot and does small gestures.' },
  CALM: { label: 'Calm', text: 'Walks along the bottom of the screen and hops now and then.' },
  LIVELY: { label: 'Lively', text: 'Adds running, sitting on edges, hanging and climbing once her body can draw them.' },
  WILD: { label: 'Wild', text: 'Adds jumps and peeking, with shorter pauses between moves.' },
};
