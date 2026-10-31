/**
 * Provider failures as one typed error with an owner-facing message. Messages never contain
 * credentials: anything that looks like a key or token is redacted before it is shown.
 */

export type ProviderErrorKind =
  | 'auth'           // credential missing, wrong or expired
  | 'permission'     // credential fine, request not allowed (region, policy, plan)
  | 'rate_limit'     // slow down and retry
  | 'quota'          // out of credit or quota
  | 'usage_limit'    // ChatGPT plan usage limit
  | 'not_found'      // model or endpoint does not exist
  | 'bad_request'    // the provider rejected the request body
  | 'unsupported'    // a feature in the request is not supported here
  | 'server'         // provider-side failure
  | 'unavailable'    // overloaded or temporarily unavailable
  | 'network'        // could not connect
  | 'timeout'        // no data for too long
  | 'cancelled'      // the owner stopped the turn
  | 'config'         // something the owner must set up first (key, sign-in, desktop app)
  | 'content_filter' // the provider blocked the request or reply
  | 'protocol';      // the stream was malformed or ended early

const RECOVERABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit', 'server', 'unavailable', 'network', 'timeout', 'protocol',
]);

export interface ProviderErrorOptions {
  status?: number;
  code?: string;
  param?: string;
  requestId?: string;
  /** Where the owner can fix or inspect the problem (e.g. ChatGPT usage settings). */
  link?: string;
  recoverable?: boolean;
  /** Provider's own message, redacted. Kept for diagnostics, not shown verbatim. */
  detail?: string;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly link?: string;
  readonly recoverable: boolean;
  readonly detail?: string;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(redactSecrets(message));
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.param = options.param;
    this.requestId = options.requestId;
    this.link = options.link;
    this.detail = options.detail ? redactSecrets(options.detail) : undefined;
    this.recoverable = options.recoverable ?? RECOVERABLE.has(kind);
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|or-|proj-|svcacct-|admin-)?[A-Za-z0-9_*\-]{8,}/g,
  /\bAIza[0-9A-Za-z_\-]{12,}/g,
  /\bxi-[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/\-]{12,}=*/gi,
  /([?&](?:key|api_key|access_token|token)=)[^&\s"']+/gi,
];

/** Replaces anything that looks like an API key, OAuth token or JWT with "[redacted]". */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    // Capture group 1 (when present) is a prefix worth keeping: "Bearer" or "?key=".
    out = out.replace(pattern, (_match, prefix: unknown) => {
      if (typeof prefix !== 'string') return '[redacted]';
      return /^bearer$/i.test(prefix) ? `${prefix} [redacted]` : `${prefix}[redacted]`;
    });
  }
  return out;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.kind === 'cancelled';
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';
}

export function cancelledError(): ProviderError {
  return new ProviderError('cancelled', 'Stopped.', { recoverable: true });
}

/** Turns anything thrown into a ProviderError without losing a typed one. */
export function toProviderError(error: unknown, providerLabel = 'The AI provider'): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isAbortError(error)) return cancelledError();
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new ProviderError('timeout', `${providerLabel} took too long to answer.`);
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error.';
  return new ProviderError('protocol', `${providerLabel} failed: ${message}`, { detail: message });
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'auth';
  if (status === 402) return 'quota';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 413 || status === 422 || status === 400) return 'bad_request';
  if (status === 429) return 'rate_limit';
  if (status === 503 || status === 529) return 'unavailable';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export interface ParsedErrorBody {
  message?: string;
  code?: string;
  type?: string;
  param?: string;
}

/** Reads the error shapes used by OpenAI, Anthropic, Gemini, OpenRouter, Ollama and ChatGPT direct admission. */
export function parseErrorBody(body: string): ParsedErrorBody {
  const trimmed = body.trim();
  if (!trimmed) return {};
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === 'string') return { message: err };
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const meta = e.metadata as Record<string, unknown> | undefined;
      const raw = typeof meta?.raw === 'string' ? meta.raw : undefined;
      return {
        message: typeof e.message === 'string' ? (raw && raw.length < 400 ? `${e.message} (${raw})` : e.message) : undefined,
        code: typeof e.code === 'string' ? e.code : typeof e.code === 'number' ? String(e.code) : typeof e.status === 'string' ? e.status : undefined,
        type: typeof e.type === 'string' ? e.type : undefined,
        param: typeof e.param === 'string' ? e.param : undefined,
      };
    }
    if (typeof json.detail === 'string') return { message: json.detail, code: 'detail' };
    if (json.detail && typeof json.detail === 'object') {
      const d = json.detail as Record<string, unknown>;
      return { message: typeof d.message === 'string' ? d.message : JSON.stringify(d).slice(0, 300), code: typeof d.code === 'string' ? d.code : 'detail' };
    }
    if (typeof json.message === 'string') return { message: json.message };
    return {};
  } catch {
    // Plain-text or HTML error page: keep a short, tag-free excerpt.
    return { message: trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 240) };
  }
}

/** A generic, owner-facing error for an HTTP failure. Providers refine it with their own codes. */
export function httpError(
  providerLabel: string,
  status: number,
  body: string,
  options: { requestId?: string; model?: string } = {},
): ProviderError {
  const parsed = parseErrorBody(body);
  const detail = parsed.message ? redactSecrets(parsed.message) : '';
  let kind = kindForStatus(status);
  const lowered = `${parsed.code ?? ''} ${parsed.type ?? ''} ${detail}`.toLowerCase();
  if (status === 429 && /(insufficient_quota|quota|billing|credit|exceeded your current)/.test(lowered)) kind = 'quota';
  if (status === 400 && /(api key not valid|invalid api key|api_key_invalid|invalid x-api-key|incorrect api key)/.test(lowered)) kind = 'auth';
  if (status === 400 && /(credit balance is too low|insufficient credits|billing)/.test(lowered)) kind = 'quota';
  if ((status === 400 || status === 404) && /(model.*(not found|does not exist|not available|unknown|invalid))|(no such model)|(model_not_found)/.test(lowered)) kind = 'not_found';
  if (/(safety|blocked|content policy|content_filter|moderation)/.test(lowered) && status === 400) kind = 'content_filter';

  const tail = detail ? `: ${detail.replace(/\.$/, '')}` : '';
  let message: string;
  switch (kind) {
    case 'auth':
      message = `${providerLabel} didn't accept the credential (HTTP ${status})${tail}. Check it in Settings.`;
      break;
    case 'permission':
      message = `${providerLabel} refused this request (HTTP ${status})${tail}.`;
      break;
    case 'quota':
      message = `Your ${providerLabel} account is out of credit or quota${tail}.`;
      break;
    case 'rate_limit':
      message = `${providerLabel} is rate limiting requests right now${tail}. Try again in a moment.`;
      break;
    case 'not_found':
      message = options.model
        ? `${providerLabel} couldn't find the model "${options.model}"${tail}. Pick another model in Settings.`
        : `${providerLabel} couldn't find that endpoint (HTTP ${status})${tail}.`;
      break;
    case 'content_filter':
      message = `${providerLabel} blocked this request${tail}.`;
      break;
    case 'unavailable':
      message = `${providerLabel} is overloaded or unavailable right now (HTTP ${status})${tail}.`;
      break;
    case 'server':
      message = `${providerLabel} had an internal error (HTTP ${status})${tail}.`;
      break;
    case 'timeout':
      message = `${providerLabel} timed out (HTTP ${status}).`;
      break;
    default:
      message = `${providerLabel} rejected the request (HTTP ${status})${tail}.`;
  }
  return new ProviderError(kind, message, {
    status,
    code: parsed.code,
    param: parsed.param,
    requestId: options.requestId,
    detail,
  });
}
