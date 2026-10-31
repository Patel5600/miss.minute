/**
 * Safe calculator: a tokenizer and recursive-descent parser over a closed grammar. There is no
 * eval or Function; only the operators, functions, constants and time units listed here exist.
 *
 *   numbers      1.5e3, 1,234,567 (thousands commas outside parentheses), 1_000
 *   operators    + - * / ^ ** mod %  (x and × multiply, ÷ divides), n! factorial
 *   percentages  15%  ·  15% of 80  ·  80 + 15% (= 92)  ·  80 - 15%  ·  80 * 15%
 *   time         2h 30m + 45 min  ·  3 days in hours  ·  17:30 - 09:15  ·  90 min to hours
 *   functions    sqrt cbrt abs round floor ceil trunc sign exp ln log log2 log10 sin cos tan asin acos atan
 *                atan2 sinh cosh tanh min max sum avg mean pow hypot deg rad
 *   constants    pi e tau phi
 */
import { ToolInputError } from './args';
import { formatDuration } from './time';

type Kind = 'num' | 'pct' | 'dur';
interface Value { v: number; k: Kind }

type Token =
  | { t: 'num'; v: number; text: string }
  | { t: 'clock'; v: number; text: string }
  | { t: 'id'; v: string; text: string }
  | { t: 'op'; v: string; text: string };

const UNITS: Record<string, number> = {
  ms: 0.001, msec: 0.001, millisecond: 0.001, milliseconds: 0.001,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86_400, day: 86_400, days: 86_400,
  w: 604_800, wk: 604_800, wks: 604_800, week: 604_800, weeks: 604_800,
};

const UNIT_LABEL: Record<number, string> = { 0.001: 'milliseconds', 1: 'seconds', 60: 'minutes', 3600: 'hours', 86_400: 'days', 604_800: 'weeks' };

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };

const KEYWORDS = new Set(['of', 'in', 'to', 'as', 'mod', 'x']);

type Fn = { arity: [number, number]; keepsDuration?: boolean; apply: (args: number[]) => number };

const FUNCTIONS: Record<string, Fn> = {
  sqrt: { arity: [1, 1], apply: ([x]) => { if (x < 0) throw new ToolInputError('sqrt of a negative number is not real.'); return Math.sqrt(x); } },
  cbrt: { arity: [1, 1], apply: ([x]) => Math.cbrt(x) },
  abs: { arity: [1, 1], keepsDuration: true, apply: ([x]) => Math.abs(x) },
  round: { arity: [1, 2], keepsDuration: true, apply: ([x, digits = 0]) => {
    const d = Math.max(0, Math.min(12, Math.trunc(digits)));
    const factor = 10 ** d;
    return Math.round((x + Number.EPSILON * Math.sign(x)) * factor) / factor;
  } },
  floor: { arity: [1, 1], keepsDuration: true, apply: ([x]) => Math.floor(x) },
  ceil: { arity: [1, 1], keepsDuration: true, apply: ([x]) => Math.ceil(x) },
  trunc: { arity: [1, 1], keepsDuration: true, apply: ([x]) => Math.trunc(x) },
  sign: { arity: [1, 1], apply: ([x]) => Math.sign(x) },
  exp: { arity: [1, 1], apply: ([x]) => Math.exp(x) },
  ln: { arity: [1, 1], apply: ([x]) => positiveLog(x, Math.log) },
  log: { arity: [1, 2], apply: ([x, base]) => (base === undefined ? positiveLog(x, Math.log10) : positiveLog(x, Math.log) / positiveLog(base, Math.log)) },
  log2: { arity: [1, 1], apply: ([x]) => positiveLog(x, Math.log2) },
  log10: { arity: [1, 1], apply: ([x]) => positiveLog(x, Math.log10) },
  sin: { arity: [1, 1], apply: ([x]) => Math.sin(x) },
  cos: { arity: [1, 1], apply: ([x]) => Math.cos(x) },
  tan: { arity: [1, 1], apply: ([x]) => Math.tan(x) },
  asin: { arity: [1, 1], apply: ([x]) => Math.asin(x) },
  acos: { arity: [1, 1], apply: ([x]) => Math.acos(x) },
  atan: { arity: [1, 1], apply: ([x]) => Math.atan(x) },
  atan2: { arity: [2, 2], apply: ([y, x]) => Math.atan2(y, x) },
  sinh: { arity: [1, 1], apply: ([x]) => Math.sinh(x) },
  cosh: { arity: [1, 1], apply: ([x]) => Math.cosh(x) },
  tanh: { arity: [1, 1], apply: ([x]) => Math.tanh(x) },
  min: { arity: [1, 50], keepsDuration: true, apply: args => Math.min(...args) },
  max: { arity: [1, 50], keepsDuration: true, apply: args => Math.max(...args) },
  sum: { arity: [1, 50], keepsDuration: true, apply: args => args.reduce((a, b) => a + b, 0) },
  avg: { arity: [1, 50], keepsDuration: true, apply: args => args.reduce((a, b) => a + b, 0) / args.length },
  mean: { arity: [1, 50], keepsDuration: true, apply: args => args.reduce((a, b) => a + b, 0) / args.length },
  pow: { arity: [2, 2], apply: ([a, b]) => a ** b },
  hypot: { arity: [1, 50], apply: args => Math.hypot(...args) },
  deg: { arity: [1, 1], apply: ([x]) => (x * 180) / Math.PI },
  rad: { arity: [1, 1], apply: ([x]) => (x * Math.PI) / 180 },
};

// Own-property lookups only: names like "constructor" or "toString" must not reach the prototype.
function unitOf(name: unknown): number | undefined {
  return typeof name === 'string' && Object.hasOwn(UNITS, name) ? UNITS[name] : undefined;
}

function constantOf(name: string): number | undefined {
  return Object.hasOwn(CONSTANTS, name) ? CONSTANTS[name] : undefined;
}

function functionOf(name: string): Fn | undefined {
  return Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
}

function positiveLog(x: number, fn: (value: number) => number): number {
  if (x <= 0) throw new ToolInputError('Logarithms need a positive number.');
  return fn(x);
}

const MAX_LENGTH = 500;
const MAX_TOKENS = 400;
const MAX_DEPTH = 60;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const symbols: Record<string, string> = { '×': '*', '·': '*', '÷': '/', '−': '-', '–': '-' };
  while (i < source.length) {
    const rest = source.slice(i);
    const char = source[i];
    if (/\s/.test(char)) { i += 1; continue; }
    const clock = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?![\d.])/.exec(rest);
    if (clock) {
      const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0);
      tokens.push({ t: 'clock', v: seconds, text: clock[0] });
      i += clock[0].length;
      continue;
    }
    const number = (depth === 0
      ? /^(?:\d{1,3}(?:,\d{3})+(?![\d])(?:\.\d+)?|\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i
      : /^(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i).exec(rest);
    if (number) {
      const value = Number(number[0].replace(/[,_]/g, ''));
      if (!Number.isFinite(value)) throw new ToolInputError(`"${number[0]}" is not a usable number.`);
      tokens.push({ t: 'num', v: value, text: number[0] });
      i += number[0].length;
      continue;
    }
    const word = /^[a-z_][a-z0-9_]*/i.exec(rest);
    if (word) {
      tokens.push({ t: 'id', v: word[0].toLowerCase(), text: word[0] });
      i += word[0].length;
      continue;
    }
    if (rest.startsWith('**')) {
      tokens.push({ t: 'op', v: '^', text: '**' });
      i += 2;
      continue;
    }
    const op = symbols[char] ?? char;
    if ('+-*/^%!(),'.includes(op)) {
      if (op === '(') depth += 1;
      if (op === ')') depth = Math.max(0, depth - 1);
      tokens.push({ t: 'op', v: op, text: char });
      i += 1;
      continue;
    }
    throw new ToolInputError(`Unexpected character "${char}" in the expression.`);
  }
  if (tokens.length > MAX_TOKENS) throw new ToolInputError('The expression is too long.');
  return tokens;
}

class Parser {
  private index = 0;
  private depth = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private isOp(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.t === 'op' && token.v === value;
  }

  private isId(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.t === 'id' && token.v === value;
  }

  private startsOperand(offset: number): boolean {
    const token = this.peek(offset);
    if (!token) return false;
    if (token.t === 'num' || token.t === 'clock') return true;
    if (token.t === 'op') return token.v === '(';
    return !KEYWORDS.has(token.v) && unitOf(token.v) === undefined
      && (constantOf(token.v) !== undefined || functionOf(token.v) !== undefined);
  }

  parse(): { value: Value; target?: number } {
    if (this.tokens.length === 0) throw new ToolInputError('The expression is empty.');
    const value = this.additive();
    let target: number | undefined;
    if (this.isId('in') || this.isId('to') || this.isId('as')) {
      this.index += 1;
      const unit = this.peek();
      const seconds = unit?.t === 'id' ? unitOf(unit.v) : undefined;
      if (seconds === undefined) throw new ToolInputError('Convert to a time unit, e.g. "in hours" or "to minutes".');
      if (value.k !== 'dur') throw new ToolInputError('Only durations can be converted, e.g. "90 min in hours".');
      target = seconds;
      this.index += 1;
    }
    const extra = this.peek();
    if (extra) throw new ToolInputError(`Unexpected "${extra.text}" in the expression.`);
    return { value, target };
  }

  private additive(): Value {
    let left = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.peek() as Token).v;
      this.index += 1;
      const right = this.multiplicative();
      left = addSub(left, right, op === '+' ? 1 : -1);
    }
    return left;
  }

  private multiplicative(): Value {
    let left = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isId('x')) {
        this.index += 1;
        left = multiply(left, this.unary());
      } else if (this.isOp('/')) {
        this.index += 1;
        left = divide(left, this.unary());
      } else if (this.isOp('%') || this.isId('mod')) {
        this.index += 1;
        left = modulo(left, this.unary());
      } else if (this.isId('of')) {
        this.index += 1;
        const right = this.unary();
        if (left.k !== 'pct') throw new ToolInputError('"of" needs a percentage before it, e.g. "15% of 80".');
        left = { v: left.v * right.v, k: right.k === 'pct' ? 'pct' : right.k };
      } else if (this.isOp('(') || this.isNamedFactor()) {
        // Implicit multiplication: 2pi, 3(4+5), (1+2)(3+4), 2sqrt(2). Two bare numbers stay an error.
        left = multiply(left, this.unary());
      } else {
        return left;
      }
    }
  }

  private isNamedFactor(): boolean {
    const token = this.peek();
    return token?.t === 'id' && !KEYWORDS.has(token.v) && (constantOf(token.v) !== undefined || functionOf(token.v) !== undefined);
  }

  private unary(): Value {
    if (this.isOp('-')) {
      this.index += 1;
      const value = this.unary();
      return { v: -value.v, k: value.k };
    }
    if (this.isOp('+')) {
      this.index += 1;
      return this.unary();
    }
    return this.power();
  }

  private power(): Value {
    const base = this.postfix();
    if (this.isOp('^')) {
      this.index += 1;
      const exponent = this.unary();
      if (base.k === 'dur' || exponent.k === 'dur') throw new ToolInputError('Durations cannot be raised to a power.');
      return { v: asNumber(base) ** asNumber(exponent), k: 'num' };
    }
    return base;
  }

  private postfix(): Value {
    let value = this.primary();
    for (;;) {
      if (this.isOp('!')) {
        this.index += 1;
        value = { v: factorial(value), k: 'num' };
      } else if (this.isOp('%') && !this.startsOperand(1)) {
        this.index += 1;
        if (value.k !== 'num') throw new ToolInputError('Only plain numbers can be percentages.');
        value = { v: value.v / 100, k: 'pct' };
      } else if (value.k === 'num' && this.peek()?.t === 'id' && unitOf(this.peek()?.v) !== undefined) {
        value = { v: value.v * (unitOf(this.peek()?.v) ?? 1), k: 'dur' };
        this.index += 1;
        // "2h 30m 10s": consecutive number+unit pairs add up.
        for (;;) {
          const amount = this.peek();
          const unit = this.peek(1);
          const seconds = unit?.t === 'id' ? unitOf(unit.v) : undefined;
          if (amount?.t !== 'num' || seconds === undefined) break;
          value = { v: value.v + amount.v * seconds, k: 'dur' };
          this.index += 2;
        }
      } else {
        return value;
      }
    }
  }

  private primary(): Value {
    const token = this.peek();
    if (!token) throw new ToolInputError('The expression ends too early.');
    if (token.t === 'num') {
      this.index += 1;
      return { v: token.v, k: 'num' };
    }
    if (token.t === 'clock') {
      this.index += 1;
      return { v: token.v, k: 'dur' };
    }
    if (token.t === 'op' && token.v === '(') {
      this.index += 1;
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new ToolInputError('Too many nested parentheses.');
      const value = this.additive();
      if (!this.isOp(')')) throw new ToolInputError('A closing parenthesis is missing.');
      this.index += 1;
      this.depth -= 1;
      return value;
    }
    if (token.t === 'id') {
      const constant = constantOf(token.v);
      if (constant !== undefined) {
        this.index += 1;
        return { v: constant, k: 'num' };
      }
      const fn = functionOf(token.v);
      if (fn) {
        this.index += 1;
        if (!this.isOp('(')) throw new ToolInputError(`${token.v} needs parentheses, e.g. ${token.v}(2).`);
        this.index += 1;
        this.depth += 1;
        if (this.depth > MAX_DEPTH) throw new ToolInputError('Too many nested parentheses.');
        const args: Value[] = [];
        if (!this.isOp(')')) {
          args.push(this.additive());
          while (this.isOp(',')) {
            this.index += 1;
            args.push(this.additive());
          }
        }
        if (!this.isOp(')')) throw new ToolInputError(`A closing parenthesis is missing after ${token.v}(...).`);
        this.index += 1;
        this.depth -= 1;
        return callFunction(token.v, fn, args);
      }
      throw new ToolInputError(
        `Unknown name "${token.text}". Use numbers, + - * / ^ %, functions like sqrt() or round(), pi/e, and time units (s, min, h, days).`,
      );
    }
    throw new ToolInputError(`Unexpected "${token.text}" in the expression.`);
  }
}

function asNumber(value: Value): number {
  return value.v;
}

function addSub(a: Value, b: Value, sign: 1 | -1): Value {
  if (b.k === 'pct' && a.k !== 'pct') return { v: a.v * (1 + sign * b.v), k: a.k };
  if (a.k === 'pct' && b.k === 'pct') return { v: a.v + sign * b.v, k: 'pct' };
  if (a.k === 'dur' || b.k === 'dur') {
    if (a.k !== b.k) throw new ToolInputError('Add a unit to the plain number (e.g. "5 min") to combine it with a duration.');
    return { v: a.v + sign * b.v, k: 'dur' };
  }
  return { v: a.v + sign * b.v, k: 'num' };
}

function multiply(a: Value, b: Value): Value {
  if (a.k === 'dur' && b.k === 'dur') throw new ToolInputError('Two durations cannot be multiplied.');
  if (a.k === 'dur' || b.k === 'dur') return { v: a.v * b.v, k: 'dur' };
  if (a.k === 'pct' && b.k === 'pct') return { v: a.v * b.v, k: 'pct' };
  return { v: a.v * b.v, k: 'num' };
}

function divide(a: Value, b: Value): Value {
  if (b.v === 0) throw new ToolInputError('Division by zero.');
  if (a.k === 'dur' && b.k === 'dur') return { v: a.v / b.v, k: 'num' };
  if (b.k === 'dur') throw new ToolInputError('A number cannot be divided by a duration.');
  if (a.k === 'dur') return { v: a.v / b.v, k: 'dur' };
  if (a.k === 'pct' && b.k !== 'pct') return { v: a.v / b.v, k: 'pct' };
  return { v: a.v / b.v, k: 'num' };
}

function modulo(a: Value, b: Value): Value {
  if (b.v === 0) throw new ToolInputError('Modulo by zero.');
  if ((a.k === 'dur') !== (b.k === 'dur')) throw new ToolInputError('Use the same kind of value on both sides of mod.');
  return { v: a.v % b.v, k: a.k === 'dur' ? 'dur' : 'num' };
}

function factorial(value: Value): number {
  if (value.k !== 'num' || !Number.isInteger(value.v) || value.v < 0) throw new ToolInputError('Factorial needs a whole number of 0 or more.');
  if (value.v > 170) throw new ToolInputError('Factorials above 170! are too large.');
  let result = 1;
  for (let n = 2; n <= value.v; n += 1) result *= n;
  return result;
}

function callFunction(name: string, fn: Fn, args: Value[]): Value {
  if (args.length < fn.arity[0] || args.length > fn.arity[1]) {
    const expected = fn.arity[0] === fn.arity[1] ? `${fn.arity[0]}` : `${fn.arity[0]} to ${fn.arity[1]}`;
    throw new ToolInputError(`${name}() takes ${expected} argument${fn.arity[1] === 1 ? '' : 's'}.`);
  }
  const durations = args.filter(arg => arg.k === 'dur').length;
  if (durations > 0) {
    if (!fn.keepsDuration) throw new ToolInputError(`${name}() works on plain numbers, not durations.`);
    // round(x, digits): only the first argument carries the unit.
    const unitArgs = name === 'round' ? args.slice(0, 1) : args;
    if (unitArgs.some(arg => arg.k !== 'dur')) throw new ToolInputError(`${name}() needs all durations or all numbers.`);
    return { v: fn.apply(args.map(asNumber)), k: 'dur' };
  }
  return { v: fn.apply(args.map(asNumber)), k: 'num' };
}

/** Trims binary floating-point noise: 0.1 + 0.2 shows as 0.3. */
export function tidy(value: number): number {
  if (value === 0) return 0;
  return Number(value.toPrecision(12));
}

function clockText(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? '-' : '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface CalcResult {
  kind: 'number' | 'percent' | 'duration';
  /** Plain number; for durations, seconds (or the target unit when converted). */
  value: number;
  /** What the owner reads. */
  display: string;
  seconds?: number;
  unit?: string;
}

export function evaluate(expression: string): CalcResult {
  const source = expression.trim().replace(/[=?]+$/, '').trim();
  if (!source) throw new ToolInputError('The expression is empty.');
  if (source.length > MAX_LENGTH) throw new ToolInputError(`The expression is too long (limit ${MAX_LENGTH} characters).`);
  const { value, target } = new Parser(tokenize(source)).parse();
  if (!Number.isFinite(value.v)) throw new ToolInputError('The result is not a finite number.');
  const locale = (n: number) => tidy(n).toLocaleString(undefined, { maximumFractionDigits: 10 });
  if (value.k === 'pct') return { kind: 'percent', value: tidy(value.v), display: `${locale(value.v * 100)}% (${locale(value.v)})` };
  if (value.k === 'dur') {
    if (target !== undefined) {
      const converted = tidy(value.v / target);
      const unit = UNIT_LABEL[target] ?? 'units';
      return { kind: 'duration', value: converted, display: `${locale(converted)} ${unit}`, seconds: tidy(value.v), unit };
    }
    const sign = value.v < 0 ? '-' : '';
    const pretty = Math.abs(value.v) >= 1 ? `${sign}${formatDuration(Math.abs(value.v) * 1000)}` : `${locale(value.v)} s`;
    return {
      kind: 'duration',
      value: tidy(value.v),
      display: `${pretty} (${clockText(value.v)}, ${locale(value.v)} s)`,
      seconds: tidy(value.v),
      unit: 'seconds',
    };
  }
  return { kind: 'number', value: tidy(value.v), display: locale(value.v) };
}
