/**
 * Turns model output into speakable sentences while it is still streaming.
 *
 * Skips code blocks, URLs, markdown markup, emoji, HTML and any [[mood=... gesture=...]] cue tag,
 * keeps link labels and short inline code, and splits at sentence ends so speech can start on
 * the first sentence while the rest of the reply is still arriving. Text that could still turn
 * into something unspeakable (an unclosed `code`, a half-received URL or tag) is held back until
 * it resolves, never spoken early.
 */

/** Words whose trailing period does not end a sentence. Compared lower-case, without the dot. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
  'no', 'inc', 'ltd', 'co', 'prof', 'gen', 'sgt', 'capt', 'lt', 'mt', 'ft', 'approx', 'dept', 'est',
  'fig', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/** A held-back construct longer than this is spoken as plain text instead of waiting forever. */
const MAX_HOLD = 240;
/** HTML tags are short; a "<" followed by more than this is a comparison, not a tag. */
const MAX_TAG_HOLD = 60;
/** Inline code longer than this is skipped: it is almost certainly not meant to be read aloud. */
const MAX_SPOKEN_CODE = 40;
/** Bracketed text up to this length without a following "(url)" is a stage direction, e.g. [laughs]. */
const MAX_BRACKET_TAG = 24;
/** A sentence shorter than this is joined to the next one so it is not voiced on its own. */
const MIN_SENTENCE = 12;
/** Sentences longer than this are split at a comma or similar so each request stays short. */
const MAX_SENTENCE = 260;

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u200D\uFE0E\uFE0F\u20E3]/gu;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const QUOTE = /^\s{0,3}(?:>\s?)+/;
const TASK_BOX = /^\[[ xX]\]\s+/;
const URL_START = /^(?:https?:\/\/|www\.)/i;
const URL_PREFIXES = ['https://', 'http://', 'www.'];

interface InlineResult {
  text: string;
  /** Characters of the input that were converted; the rest must wait for more input. */
  consumed: number;
}

/** True when `text` could still grow into the start of a URL. */
function couldStartUrl(text: string): boolean {
  const lower = text.toLowerCase();
  return URL_PREFIXES.some(prefix => prefix.startsWith(lower) && lower.length < prefix.length);
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}]/u.test(char);
}

/**
 * Converts inline markdown to speech. With `final` false it stops before any construct that is
 * not closed yet and reports how far it got.
 */
function convertInline(input: string, final: boolean, before = ''): InlineResult {
  let out = '';
  let i = 0;
  const hold = (at: number): InlineResult => ({ text: out, consumed: at });
  // Earlier pushes already consumed the start of the line; `before` keeps lookbehind correct.
  const previous = (at: number): string | undefined => (at > 0 ? input[at - 1] : before[before.length - 1]);

  while (i < input.length) {
    const char = input[i];
    const rest = input.length - i;
    if (!final && rest === 1 && (char === '*' || char === '_' || char === '\\')) return hold(i); // meaning depends on the next character

    if (char === '`') {
      let ticks = 1;
      while (input[i + ticks] === '`') ticks += 1;
      const fence = '`'.repeat(ticks);
      const close = input.indexOf(fence, i + ticks);
      if (close === -1) {
        if (!final && rest < MAX_HOLD) return hold(i);
        i += ticks; // never closed: drop the backticks, keep the words
        continue;
      }
      const code = input.slice(i + ticks, close).trim();
      if (code && code.length <= MAX_SPOKEN_CODE && !/[{};=<>\\]/.test(code)) out += code;
      i = close + ticks;
      continue;
    }

    if (char === '[') {
      if (input[i + 1] === '[') {
        const close = input.indexOf(']]', i + 2);
        if (close === -1) {
          if (!final && rest < MAX_HOLD) return hold(i);
          i += 2;
          continue;
        }
        i = close + 2; // cue tag, e.g. [[mood=winking gesture=wave]]
        continue;
      }
      if (!final && rest === 1) return hold(i); // could become "[["
      const close = input.indexOf(']', i + 1);
      if (close === -1) {
        if (!final && rest < MAX_HOLD) return hold(i);
        i += 1;
        continue;
      }
      const label = input.slice(i + 1, close);
      if (TASK_BOX.test(input.slice(i))) { // "[ ] item" / "[x] item"
        i = close + 1;
        continue;
      }
      if (input[close + 1] === '(') {
        const end = input.indexOf(')', close + 2);
        if (end === -1) {
          if (!final && rest < MAX_HOLD) return hold(i);
          out += convertInline(label, true).text;
          i = close + 1;
          continue;
        }
        out += convertInline(label, true).text; // [label](url): say the label only
        i = end + 1;
        continue;
      }
      if (close === input.length - 1 && !final) return hold(i); // "(url)" may still follow
      if (label.length <= MAX_BRACKET_TAG) {
        i = close + 1; // [laughs], [1], [citation]
        continue;
      }
      out += convertInline(label, true).text;
      i = close + 1;
      continue;
    }

    if ((char === 'h' || char === 'H' || char === 'w' || char === 'W') && !isWordChar(previous(i))) {
      const tail = input.slice(i);
      if (URL_START.test(tail)) {
        const space = tail.search(/[\s<>"]/);
        if (space === -1) {
          if (!final && rest < MAX_HOLD) return hold(i);
          i = input.length;
          continue;
        }
        let end = i + space;
        // Sentence punctuation right after a URL belongs to the sentence, not the URL.
        while (end > i && /[.,;:!?)\]]/.test(input[end - 1])) end -= 1;
        i = end;
        continue;
      }
      if (!final && couldStartUrl(tail) && rest <= 8) return hold(i);
    }

    if (char === '<') {
      const tail = input.slice(i);
      const tag = /^<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i.exec(tail);
      if (tag) {
        i += tag[0].length;
        continue;
      }
      const maybeTag = tail === '<' || tail === '</' || /^<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?$/i.test(tail);
      if (!final && maybeTag && rest < MAX_TAG_HOLD) return hold(i);
      out += ' ';
      i += 1;
      continue;
    }

    if (char === '*') {
      // Emphasis markers vanish; between two numbers it is multiplication.
      const prev = /(\d)\s*$/.test(before + input.slice(0, i));
      const next = /^\s*\d/.test(input.slice(i + 1));
      out += prev && next ? ' times ' : '';
      i += 1;
      continue;
    }

    if (char === '~' || char === '|') {
      i += 1; // strikethrough, stray table pipes
      continue;
    }

    if (char === '_') {
      // __bold__ and _italic_ markers sit at word edges; snake_case reads better as spaces.
      out += isWordChar(previous(i)) && isWordChar(input[i + 1]) ? ' ' : '';
      i += 1;
      continue;
    }

    if (char === '\\' && i + 1 < input.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(input[i + 1])) {
      out += input[i + 1]; // markdown escape
      i += 2;
      continue;
    }

    out += char;
    i += 1;
  }
  return { text: out, consumed: input.length };
}

/** Line-level markdown: the spoken content of one complete line, or null to skip it. */
function convertLine(line: string): string | null {
  if (HORIZONTAL_RULE.test(line) || TABLE_RULE.test(line)) return null;
  let body = line;
  if (/^\s*\|/.test(body)) {
    const cells = body.split('|').map(cell => cell.trim()).filter(Boolean);
    body = cells.join(', ');
  } else {
    body = body.replace(HEADING, '').replace(QUOTE, '').replace(LIST_ITEM, '');
  }
  return convertInline(body, true).text;
}

function tidy(text: string): string {
  return text
    .replace(EMOJI, '')
    .replace(/\(\s*(?:(?:source|sources|via|see|from|link)\s*:?\s*)?\)/gi, '') // "(source: <url>)" minus the URL
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=[^\s\d])/g, '$1 ')
    .replace(/^[\s,;:.]+/, '');
}

/** A heading, list item or other line without closing punctuation still ends a sentence. */
function terminate(line: string): string {
  if (/[.!?…]["'”’)\]]*$/.test(line)) return line;
  return line.replace(/[,;:\-–—]+$/, '') + '.';
}

/** Index just past a sentence end inside `text`, or -1. `final` allows a split at the very end. */
function findBoundary(text: string, final: boolean): number {
  const pattern = /([.!?…]+)(["'”’)\]]*)(\s+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const after = text.slice(end);
    const punct = match[1];
    if (punct.includes('!') || punct.includes('?')) return end;
    if (punct.includes('…') || punct.length > 1) {
      if (after.length === 0 && !final) return -1; // "Well..." may trail into the same thought
      return end;
    }
    // A period: look at the word before it and the character after it.
    const before = text.slice(0, match.index);
    const word = /([\p{L}.]+)$/u.exec(before)?.[1] ?? '';
    const lower = word.toLowerCase();
    if (ABBREVIATIONS.has(lower) || /^\p{Lu}$/u.test(word)) continue; // "Mr." or an initial
    if (after.length === 0) {
      if (final) return end;
      return -1; // need the next character to be sure
    }
    if (/^["'“‘(\[]?[\p{Lu}\p{N}]/u.test(after)) return end;
  }
  return -1;
}

/** Splits an over-long sentence at the last comma-like pause before the limit. */
function splitLong(sentence: string): string[] {
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' - '));
    if (cut < 60) cut = window.lastIndexOf(' ');
    if (cut < 30) cut = MAX_SENTENCE;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Streaming converter. Feed raw model text with push(); each call returns the sentences that
 * became complete. end() returns whatever is left.
 */
export class SpeakableStream {
  private raw = '';
  private lineDone = 0;
  private lineKind: 'unknown' | 'text' = 'unknown';
  private inFence = false;
  private spoken = '';
  private carry = '';

  push(delta: string): string[] {
    if (!delta) return [];
    this.raw += delta.replace(/\r\n?/g, '\n');
    return this.process(false);
  }

  end(): string[] {
    const out = this.process(true);
    this.raw = '';
    return out;
  }

  private process(final: boolean): string[] {
    const sentences: string[] = [];
    let newline: number;
    while ((newline = this.raw.indexOf('\n')) !== -1) {
      const line = this.raw.slice(0, newline);
      this.raw = this.raw.slice(newline + 1);
      this.finishLine(line);
      this.flushSpoken(sentences, true);
    }
    this.partialLine(final);
    this.flushSpoken(sentences, final);
    if (final) {
      const rest = tidy(this.carry + ' ' + this.spoken).trim();
      this.carry = '';
      this.spoken = '';
      if (/[\p{L}\p{N}]/u.test(rest)) sentences.push(...splitLong(rest));
    }
    return sentences;
  }

  /** A complete line arrived: convert what was not converted yet, then mark a hard break. */
  private finishLine(line: string): void {
    const done = this.lineDone;
    const kind = this.lineKind;
    this.lineDone = 0;
    this.lineKind = 'unknown';
    if (FENCE.test(line)) {
      this.inFence = !this.inFence;
      this.spoken += '\n';
      return;
    }
    if (this.inFence) return;
    if (kind === 'text') {
      this.spoken += convertInline(line.slice(done), true, line.slice(Math.max(0, done - 8), done)).text;
    } else {
      const converted = convertLine(line);
      if (converted !== null) this.spoken += converted;
    }
    this.spoken += '\n';
  }

  /** Converts the safe part of the line still being received. */
  private partialLine(final: boolean): void {
    if (this.inFence || !this.raw) return;
    const line = this.raw;
    if (this.lineKind === 'unknown') {
      const head = line.trimStart();
      const mayBeFence = /^[`~]{1,2}$/.test(head) || FENCE.test(line);
      const needsWholeLine = mayBeFence || head.startsWith('|') || /^[-*_\s]+$/.test(head);
      if (needsWholeLine && !final) return;
      if (final) {
        this.raw = '';
        this.finishLine(line);
        return;
      }
      // Markers are only known once the first word has arrived.
      if (!/\S\s/.test(line) && head.length < 8) return;
      this.lineKind = 'text';
      const marker = /^(?:\s{0,3}#{1,6}\s+|\s{0,3}(?:>\s?)+|\s*(?:[-*+•]|\d{1,3}[.)])\s+)*/.exec(line)?.[0] ?? '';
      this.lineDone = marker.length;
    }
    if (final) {
      this.raw = '';
      this.finishLine(line);
      return;
    }
    const before = line.slice(Math.max(0, this.lineDone - 8), this.lineDone);
    const { text, consumed } = convertInline(line.slice(this.lineDone), false, before);
    this.spoken += text;
    this.lineDone += consumed;
  }

  /** Moves complete sentences from the spoken buffer into `out`. */
  private flushSpoken(out: string[], hardBreaks: boolean): void {
    for (;;) {
      const newline = hardBreaks ? this.spoken.indexOf('\n') : -1;
      const text = newline === -1 ? this.spoken : this.spoken.slice(0, newline);
      const boundary = findBoundary(text, false);
      if (boundary !== -1) {
        this.emit(text.slice(0, boundary), out);
        this.spoken = this.spoken.slice(boundary);
        continue;
      }
      if (newline !== -1) {
        const line = tidy(text).trim();
        this.spoken = this.spoken.slice(newline + 1);
        if (/[\p{L}\p{N}]/u.test(line)) this.emit(terminate(line), out);
        continue;
      }
      if (this.spoken.length > MAX_SENTENCE) {
        const parts = splitLong(tidy(this.spoken).trim());
        const keep = parts.pop() ?? '';
        parts.forEach(part => this.emit(part, out));
        this.spoken = keep;
      }
      return;
    }
  }

  private emit(sentence: string, out: string[]): void {
    const text = tidy(this.carry ? this.carry + ' ' + sentence : sentence).trim();
    this.carry = '';
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    if (text.length < MIN_SENTENCE) {
      this.carry = text; // "Hey!" waits to be voiced together with what follows
      return;
    }
    out.push(...splitLong(text));
  }
}

/** Speakable text of a complete reply. */
export function speakableText(text: string): string {
  return speakableSentences(text).join(' ');
}

/** Speakable sentences of a complete reply. */
export function speakableSentences(text: string): string[] {
  const stream = new SpeakableStream();
  return [...stream.push(text), ...stream.end()];
}
