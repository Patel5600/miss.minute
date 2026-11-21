/**
 * Strict argument parsing for model-facing tools. Error messages are written for the model:
 * they name the argument, say what was wrong and show a valid value, so the next call can
 * fix itself without the owner having to step in.
 */

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export type RawArgs = Record<string, unknown>;

/** Control characters other than tab/newline never belong in titles, labels or paths. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function quoteList(keys: string[]): string {
  return keys.map(key => `'${key}'`).join(', ');
}

/**
 * Accepts a plain object (or a JSON string of one), drops null/undefined values because some
 * models send them for omitted optional arguments, and rejects keys the tool does not know.
 */
export function objectArgs(raw: unknown, allowed: readonly string[]): RawArgs {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      throw new ToolInputError('Arguments must be a JSON object.');
    }
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError('Arguments must be a JSON object.');
  }
  const out: RawArgs = {};
  const unknown: string[] = [];
  for (const [key, entry] of Object.entries(value as RawArgs)) {
    if (entry === null || entry === undefined) continue;
    if (allowed.includes(key)) out[key] = entry;
    else unknown.push(key);
  }
  if (unknown.length > 0) {
    const accepted = allowed.length > 0 ? `This tool accepts only ${quoteList([...allowed])}.` : 'This tool takes no arguments.';
    throw new ToolInputError(`Unknown argument${unknown.length > 1 ? 's' : ''} ${quoteList(unknown)}. ${accepted}`);
  }
  return out;
}

interface TextOptions {
  /** Maximum length after trimming. */
  max: number;
  /** Keep line breaks (note bodies, file content). Single-line fields collapse whitespace. */
  multiline?: boolean;
  /** Keep leading/trailing whitespace and inner spacing exactly (file content, commands). */
  raw?: boolean;
}

function readText(args: RawArgs, key: string, options: TextOptions): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return readText({ [key]: String(value) }, key, options);
    throw new ToolInputError(`'${key}' must be a string.`);
  }
  let text = value;
  if (!options.raw) {
    text = options.multiline
      ? text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
      : text.replace(/\s+/g, ' ').trim();
  }
  if (!text) return undefined;
  if (CONTROL_CHARS.test(text)) throw new ToolInputError(`'${key}' contains control characters.`);
  if (!options.multiline && !options.raw && text.includes('\n')) throw new ToolInputError(`'${key}' must be a single line.`);
  if (text.length > options.max) {
    throw new ToolInputError(`'${key}' is too long (${text.length} characters; the limit is ${options.max}).`);
  }
  return text;
}

export function optionalText(args: RawArgs, key: string, max: number, options: Omit<TextOptions, 'max'> = {}): string | undefined {
  return readText(args, key, { ...options, max });
}

export function requiredText(args: RawArgs, key: string, max: number, options: Omit<TextOptions, 'max'> = {}): string {
  const text = readText(args, key, { ...options, max });
  if (text === undefined) throw new ToolInputError(`'${key}' is required and cannot be empty.`);
  return text;
}

interface NumberOptions {
  min: number;
  max: number;
  /** Round fractional input instead of rejecting it. */
  round?: boolean;
  integer?: boolean;
  unit?: string;
}

function readNumber(args: RawArgs, key: string, options: NumberOptions): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  let number: number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) number = Number(value.trim());
  else throw new ToolInputError(`'${key}' must be a number${options.unit ? ` of ${options.unit}` : ''}.`);
  if (!Number.isFinite(number)) throw new ToolInputError(`'${key}' must be a finite number.`);
  if (options.integer || options.round) {
    if (!Number.isInteger(number)) {
      if (!options.round) throw new ToolInputError(`'${key}' must be a whole number.`);
      number = Math.round(number);
    }
  }
  if (number < options.min || number > options.max) {
    const unit = options.unit ? ` ${options.unit}` : '';
    throw new ToolInputError(`'${key}' must be between ${options.min} and ${options.max}${unit} (got ${number}).`);
  }
  return number;
}

export function optionalNumber(args: RawArgs, key: string, options: NumberOptions): number | undefined {
  return readNumber(args, key, options);
}

export function requiredNumber(args: RawArgs, key: string, options: NumberOptions): number {
  const number = readNumber(args, key, options);
  if (number === undefined) throw new ToolInputError(`'${key}' is required.`);
  return number;
}

export function optionalBoolean(args: RawArgs, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new ToolInputError(`'${key}' must be true or false.`);
}

export function optionalEnum<T extends string>(args: RawArgs, key: string, values: readonly T[]): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`'${key}' must be one of: ${values.join(', ')}.`);
  const wanted = value.trim().toLowerCase();
  if (!wanted) return undefined;
  const match = values.find(option => option.toLowerCase() === wanted);
  if (!match) throw new ToolInputError(`'${key}' must be one of: ${values.join(', ')} (got "${value}").`);
  return match;
}

export function requiredEnum<T extends string>(args: RawArgs, key: string, values: readonly T[]): T {
  const value = optionalEnum(args, key, values);
  if (value === undefined) throw new ToolInputError(`'${key}' is required: one of ${values.join(', ')}.`);
  return value;
}

/** Cuts long strings for activity-log details and compact model data. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Human-readable reason for any thrown value, without stack traces or internals. */
export function errorMessage(error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'AbortError') return 'The request was cancelled.';
    if (error.name === 'TimeoutError') return 'The request timed out.';
    return error.message || error.name;
  }
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error.';
  }
}
