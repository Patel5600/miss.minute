export interface NativeAgentStatus {
  enrolled: boolean;
  running: boolean;
  roots: string[];
  events: number;
  indexedFiles: number;
  decisions: number;
  lastError: string | null;
  approvedNoteRoots: string[];
  pendingActions: number;
  autoCreateNotes: boolean;
  foregroundWindowContextEnabled: boolean;
  foregroundWindowContextSupported: boolean;
  automaticActionsToday: number;
  dailyNoteLimit: number;
}

export type DesktopOperatingMode = 'owner_mode' | 'owner_candidate' | 'guest_mode';

export interface DesktopOwnerStatus {
  enrolled: boolean;
  authenticated: boolean;
  ownerCandidate: boolean;
  authState: string;
  mode: DesktopOperatingMode;
  candidateName: string | null;
  candidateConfidence: number;
  sessionId: string | null;
  platform: string;
}

export interface AgentStreamTicket {
  token: string;
  cursor: number;
  expiresAtUnixMs: number;
}

export interface AgentEventRecord {
  seq: number;
  id: string;
  source: string;
  event_type: string;
  observed_at_unix_ms: number;
  source_timestamp_unix_ms: number | null;
  timestamp_semantics: string;
  resource_path: string | null;
  payload_json: string;
}

export interface OwnerContextRecord {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface PendingAction {
  id: string;
  throughSeq: number;
  description: string;
  payloadJson: string;
  evidenceEventIdsJson: string;
  status: string;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
  resultJson: string | null;
}

export interface CreateNotePayload {
  kind: 'create_note';
  root_index: number;
  filename: string;
  content: string;
}

/** Her cloned voice as prepared on disk, known before the voice worker starts. */
export interface NativeConfiguredVoice {
  /** A prepared reference and its rights record both exist. */
  reference: boolean;
  rightsBasis: string | null;
  /** Engine the worker will load ("pocket" or "chatterbox") and its display name. */
  engine: string | null;
  engineLabel: string | null;
  /** True when the engine was chosen by the benchmark from measured numbers. */
  measured: boolean;
  /** Synthesis time / audio time; below 1 is faster than real time. */
  rtf: number | null;
  firstChunkMs: number | null;
  /** Speaker-embedding cosine against the reference, raw and normalized (0 unrelated, 1 itself). */
  similarity: number | null;
  similarityNorm: number | null;
  wer: number | null;
  /** Thresholds the chosen engine missed, if any. */
  shortfall: string[];
  chosenAt: string | null;
}

/** State of the private on-device voice engine (`native/voice`). */
export interface NativeVoiceStatus {
  installed: boolean;
  starting: boolean;
  ready: boolean;
  model: string | null;
  /** "cloned:reference" while she speaks in her cloned voice; "builtin" for the engine's own voice. */
  voice: string | null;
  /** Engine the worker loaded ("pocket" or "chatterbox") and its display name. */
  engine?: string | null;
  engineLabel?: string | null;
  /** "measured" (benchmark), "override" or "default". */
  engineChoice?: string | null;
  /** Why the engine's own voice is used instead of the cloned one. */
  voiceNote?: string | null;
  rightsBasis?: string | null;
  sampleRate: number | null;
  loadSeconds: number | null;
  /** Milliseconds from a request to its first audio, measured at warm-up. */
  firstChunkMs?: number | null;
  /** Seconds of speech per second of compute (above 1 keeps up with playback). */
  realtimeFactor?: number | null;
  lastError: string | null;
  /** When not installed: the next step, phrased for the owner. */
  detail: string | null;
  transcriber?: string | null;
  configured?: NativeConfiguredVoice;
}

/** True while the worker is speaking in the voice cloned from the prepared reference. */
export function isClonedVoice(status: NativeVoiceStatus | null | undefined): boolean {
  return !!status?.ready && typeof status.voice === 'string' && status.voice.startsWith('cloned');
}

export type NativePlaybackOwner = 'main' | 'avatar';

/** One sentence of synthesized speech relayed only to its selected playback window. */
export interface NativeVoiceChunk {
  id: string;
  index: number;
  last: boolean;
  text: string;
  sampleRate: number;
  pcm16: string;
  /** Explicit defense-in-depth routing; older hosts omit it but still use targeted events. */
  playbackOwner?: NativePlaybackOwner;
}

export interface NativeVoiceEnd {
  id: string;
  event: 'done' | 'cancelled' | 'error';
  message: string | null;
  playbackOwner?: NativePlaybackOwner;
}

/** Audio-free lifecycle metadata broadcast to both windows for subtitles and animation. */
export interface NativeVoiceActivity {
  id: string;
  event: 'chunk' | 'done' | 'cancelled' | 'error';
  playbackOwner: NativePlaybackOwner;
  index?: number;
  last?: boolean;
  text?: string;
  mouth?: 0 | 1 | 2 | 3 | 4;
  message?: string | null;
}

// ── AI provider proxy ─────────────────────────────────────────────────────────
// On desktop, provider requests are made by the Rust host so API keys and OAuth
// tokens never enter the WebView. The renderer only receives response bytes.

export interface ProviderHttpRequest {
  /** Which stored credential the host injects. The renderer never sees its value. */
  provider: 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'chatgpt' | 'ollama' | 'elevenlabs';
  url: string;
  method?: 'GET' | 'POST';
  /** Non-secret headers only. Authorization headers are rejected by the host. */
  headers?: Record<string, string>;
  body?: string;
  /** 'text' (default) streams UTF-8 text events; 'bytes' streams base64 chunks (audio). */
  responseType?: 'text' | 'bytes';
}

/** Events delivered on the Channel passed to `provider_http_stream`. */
export type ProviderStreamEvent =
  | { event: 'head'; status: number; headers: Record<string, string> }
  | { event: 'data'; text: string }
  | { event: 'bytes'; base64: string }
  | { event: 'end' }
  | { event: 'error'; message: string };

export interface ChatGptAccount {
  signedIn: boolean;
  email: string | null;
  /** True only when the granted scopes include ChatGPT plan usage. */
  planUsage: boolean;
  expiresAtUnixMs: number | null;
}

export interface OpenRouterPairing {
  /** URL the owner opens (the host also opens it in the system browser). */
  authorizeUrl: string;
}

// ── Desktop tools ─────────────────────────────────────────────────────────────

export interface DesktopPlanStep {
  /** Exact action, e.g. "Open C:\\Users\\me\\Notes\\todo.md in Notepad". */
  description: string;
}

/** A desktop action awaiting approval. Nothing runs until `desktop_approve`. */
export interface DesktopProposal {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Plain-language preview: exactly what will happen, with full paths. */
  preview: string;
  /** For writes: the exact content that would be written. */
  contentPreview: string | null;
  risk: 'low' | 'medium' | 'high';
  expiresAtUnixMs: number;
}

export interface DesktopActionResult {
  ok: boolean;
  summary: string;
  output?: string;
}

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  Channel: new <T>() => { onmessage: (message: T) => void; id: number };
}

interface TauriEventApi {
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: TauriCore;
      event?: TauriEventApi;
    };
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI__?.core?.invoke === 'function';
}

export async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    throw new Error('The native desktop bridge is available only inside the Miss Minutes desktop app.');
  }
  return invoke<T>(command, args);
}

/** Creates a Tauri IPC channel for streamed command responses. */
export function createNativeChannel<T>(onMessage: (message: T) => void) {
  const Channel = window.__TAURI__?.core?.Channel;
  if (!Channel) throw new Error('Streaming IPC channels require the Miss Minutes desktop app.');
  const channel = new Channel<T>();
  channel.onmessage = onMessage;
  return channel;
}

export async function listenNative<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const events = window.__TAURI__?.event;
  if (!events) return () => undefined;
  return events.listen<T>(event, e => handler(e.payload));
}

// ── Security, Telemetry, Wake & Mission Engine Contracts ──────────────────────

export interface AuditEntry {
  sequence: number;
  event: string;
  from_state: string;
  to_state: string;
  mode: DesktopOperatingMode;
  detail: string;
  prev_hash: string;
  entry_hash: string;
}

export interface HistogramSummary {
  count: number;
  min_us: number;
  p50_us: number;
  p95_us: number;
  p99_us: number;
  max_us: number;
}

export interface TelemetrySnapshot {
  histograms: Record<string, HistogramSummary>;
  counters: Record<string, number>;
  queue_depths: Record<string, number>;
}

export type WakeOutcome =
  | 'silent'
  | 'below_threshold'
  | 'cooldown_active'
  | { accumulating: { hits: number; required: number } }
  | { triggered: { phrase: string; confidence: number } }
  | { emergency_stop: { phrase: string } };

export interface WakeFeedResult {
  outcome: WakeOutcome;
  speechActive: boolean;
  rms: number;
  zeroCrossingRate: number;
  ownerStatus: DesktopOwnerStatus;
}

export type SideEffectTier = 'read_only' | 'local_write' | 'external' | 'destructive' | 'financial';

export interface MissionNode {
  id: string;
  title: string;
  depends_on: string[];
  action_kind: string;
  side_effect: SideEffectTier;
  max_retries: number;
}

export interface MissionDag {
  mission_id: string;
  goal: string;
  nodes: MissionNode[];
}

export interface NodeCheckpoint {
  node_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  evidence: string | null;
}

export interface MissionRunReport {
  run_id: string;
  mission_id: string;
  checkpoints: NodeCheckpoint[];
  completed: boolean;
}

export interface TrustSignals {
  verified_domain: boolean;
  requires_upfront_fee_or_wire: boolean;
  asks_off_platform_payment: boolean;
  typosquatted_or_suspicious_url: boolean;
  impossible_roi_or_urgency_pressure: boolean;
  opaque_contact_or_masked_redirect: boolean;
  transparent_terms_present: boolean;
}

export interface OfferListing {
  id: string;
  title: string;
  source_domain: string;
  fit_score: number;
  clarity_score: number;
  base_legitimacy_score: number;
  signals: TrustSignals;
}

export type ScamFlag =
  | 'upfront_fee_or_wire'
  | 'off_platform_payment'
  | 'suspicious_or_typosquatted_domain'
  | 'impossible_roi_or_urgency'
  | 'masked_redirect_or_opaque_contact';

export interface RankedOffer {
  id: string;
  title: string;
  source_domain: string;
  rejected_as_scam: boolean;
  scam_flags: ScamFlag[];
  legitimacy_component: number;
  fit_component: number;
  clarity_component: number;
  total_score: number;
}

export interface BusyInterval {
  start_epoch_min: number;
  end_epoch_min: number;
  label: string;
}

export interface FreeSlot {
  start_epoch_min: number;
  end_epoch_min: number;
  duration_minutes: number;
}

export interface AvailabilitySummary {
  free_slots: FreeSlot[];
  summary_sentence: string;
}

export type DesktopCallFact =
  | { kind: 'scheduled_window'; summary: string }
  | { kind: 'booking_name'; first_name: string }
  | { kind: 'callback_number'; e164: string }
  | { kind: 'reference_code'; code: string }
  | { kind: 'brief_topic'; topic: string };

export interface CallPolicy {
  quiet_start_min: number;
  quiet_end_min: number;
  max_calls_per_day: number;
}

export interface PreparedOutboundCall {
  call_id: string;
  destination_e164: string;
  caller_label: string;
  voice: { voice_id: 'MissMinutesTva'; display_name: string };
  disclosure_opening: string;
  allowed_facts: DesktopCallFact[];
  state: 'draft' | 'validated' | 'disclosed' | 'connected' | 'completed' | 'aborted';
}

export interface ToolManifest {
  id: string;
  name: string;
  description: string;
  trusted_builtin: boolean;
  derived_side_effect: SideEffectTier;
  owner_approved_reclassification: boolean;
}

export type CapabilityScope =
  | 'inspect_ui'
  | 'interact_ui'
  | 'type_text'
  | 'navigate'
  | 'file_read'
  | 'file_write'
  | 'app_launch'
  | 'payments_execute'
  | 'owner_profile_modify'
  | 'security_policy_modify';

export type ComputerAction =
  | { kind: 'observe_screen' }
  | { kind: 'invoke_element'; element_id: string; label: string }
  | { kind: 'set_text'; element_id: string; text: string; submit: boolean }
  | { kind: 'focus_window'; title_substring: string }
  | { kind: 'navigate_url'; url: string }
  | { kind: 'wait_ms'; ms: number };

export interface StepTrace {
  step_index: number;
  action_kind: string;
  verified: boolean;
  summary: string;
}

export interface DesktopAgentRunResult {
  runId: string;
  traces: StepTrace[];
}

export function emergencyKillSwitch(reason?: string): Promise<DesktopOwnerStatus> {
  return invokeNative<DesktopOwnerStatus>('emergency_kill_switch', { reason: reason ?? null });
}

export function verifyAuditChain(): Promise<boolean> {
  return invokeNative<boolean>('desktop_audit_verify');
}

export function listAuditEntries(limit = 100): Promise<AuditEntry[]> {
  return invokeNative<AuditEntry[]>('desktop_audit_entries', { limit });
}

export function exportRecoveryKit(passphrase: string): Promise<string> {
  return invokeNative<string>('desktop_export_recovery_kit', { passphrase });
}

export function getTelemetrySnapshot(): Promise<TelemetrySnapshot> {
  return invokeNative<TelemetrySnapshot>('telemetry_snapshot');
}

export function feedWakeScore(params: {
  confidence: number;
  transcript?: string;
  pcm16Base64?: string;
  customPhrases?: string[];
}): Promise<WakeFeedResult> {
  return invokeNative<WakeFeedResult>('wake_score_feed', {
    confidence: params.confidence,
    transcript: params.transcript ?? null,
    pcm16Base64: params.pcm16Base64 ?? null,
    customPhrases: params.customPhrases ?? null,
  });
}

export function validateMission(dag: MissionDag): Promise<string[]> {
  return invokeNative<string[]>('mission_validate', { dag });
}

export function executeMission(dag: MissionDag): Promise<MissionRunReport> {
  return invokeNative<MissionRunReport>('mission_execute', { dag });
}

export function rankOffers(listings: OfferListing[]): Promise<RankedOffer[]> {
  return invokeNative<RankedOffer[]>('offers_rank', { listings });
}

export function findAvailability(params: {
  busy: BusyInterval[];
  windowStartMin: number;
  windowEndMin: number;
  minDurationMin: number;
}): Promise<AvailabilitySummary> {
  return invokeNative<AvailabilitySummary>('availability_find', params);
}

export function prepareOutboundCall(params: {
  destinationE164: string;
  ownerFirstName: string;
  facts: DesktopCallFact[];
  localMinuteOfDay?: number;
  policy?: CallPolicy;
  dncNumbers?: string[];
  callsPlacedToday?: number;
}): Promise<PreparedOutboundCall> {
  return invokeNative<PreparedOutboundCall>('calls_prepare', {
    destinationE164: params.destinationE164,
    ownerFirstName: params.ownerFirstName,
    facts: params.facts,
    localMinuteOfDay: params.localMinuteOfDay ?? null,
    policy: params.policy ?? null,
    dncNumbers: params.dncNumbers ?? null,
    callsPlacedToday: params.callsPlacedToday ?? null,
  });
}

export function importMcpTool(serverName: string, toolJson: string): Promise<ToolManifest> {
  return invokeNative<ToolManifest>('mcp_import_tool', { serverName, toolJson });
}

export function reclassifyMcpTool(manifest: ToolManifest, requested: SideEffectTier): Promise<ToolManifest> {
  return invokeNative<ToolManifest>('mcp_reclassify_tool', { manifest, requested });
}

export function runDesktopAgent(params: {
  delegateName: string;
  allowedScopes: CapabilityScope[];
  actions: ComputerAction[];
  maxSteps?: number;
}): Promise<DesktopAgentRunResult> {
  return invokeNative<DesktopAgentRunResult>('desktop_agent_run', {
    delegateName: params.delegateName,
    allowedScopes: params.allowedScopes,
    actions: params.actions,
    maxSteps: params.maxSteps ?? null,
  });
}
