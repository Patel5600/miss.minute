/**
 * The cue protocol: the model opens each reply with `[[mood=<mood> gesture=<gesture>]]`.
 * CueStreamFilter removes the tag from streamed text however the chunks fall, reports the cue
 * the moment the tag closes, and holds back only the few characters that might still turn
 * into a tag. inferEmotion picks a mood from the words when a model forgets the tag.
 */
import { EMOTIONS, GESTURES, type CharacterCue, type Emotion, type Gesture } from '../../types';

const MOOD_SYNONYMS: Record<string, Emotion> = {
  happy: 'cheerful', joyful: 'cheerful', excited: 'cheerful', glad: 'cheerful', delighted: 'cheerful', friendly: 'cheerful', warm: 'cheerful', bright: 'cheerful', chipper: 'cheerful',
  neutral: 'talking', explaining: 'talking', informative: 'talking', calm: 'talking', speaking: 'talking',
  playful: 'winking', flirty: 'winking', mischievous: 'winking', wink: 'winking', teasing: 'winking', coy: 'winking',
  skeptical: 'suspicious', curious: 'suspicious', doubtful: 'suspicious', wary: 'suspicious', suspect: 'suspicious',
  ominous: 'scary', creepy: 'scary', menacing: 'scary', spooky: 'scary', sinister: 'scary', dark: 'scary',
  pondering: 'thinking', contemplative: 'thinking', focused: 'thinking', working: 'thinking', think: 'thinking',
  prune: 'pruning', zapping: 'pruning',
  embarrassed: 'blushing', flattered: 'blushing', shy: 'blushing', bashful: 'blushing', blush: 'blushing',
  angry: 'stern', annoyed: 'stern', serious: 'stern', strict: 'stern', firm: 'stern', disapproving: 'stern',
  shocked: 'surprised', amazed: 'surprised', astonished: 'surprised', startled: 'surprised', surprise: 'surprised',
  sarcastic: 'sassy', smug: 'sassy', cheeky: 'sassy', sass: 'sassy', snarky: 'sassy',
  sad: 'worried', concerned: 'worried', anxious: 'worried', nervous: 'worried', apologetic: 'worried', sorry: 'worried', upset: 'worried',
};

const GESTURE_SYNONYMS: Record<string, Gesture> = {
  waving: 'wave', hello: 'wave', hi: 'wave', greet: 'wave', greeting: 'wave',
  shrugging: 'shrug',
  pointing: 'point', finger: 'point',
  hands_on_hips: 'hips', handsonhips: 'hips', hip: 'hips', 'hands-on-hips': 'hips',
  presenting: 'present', ta_da: 'present', tada: 'present', show: 'present', showing: 'present',
  thinking: 'think', chin: 'think', ponder: 'think',
  knocking: 'knock', tap: 'knock', tapping: 'knock',
  clapping: 'clap', applause: 'clap', applaud: 'clap',
  idle: 'none', null: 'none', no: 'none', nothing: 'none', rest: 'none',
};

export function normalizeMood(value: string): Emotion | undefined {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((EMOTIONS as readonly string[]).includes(key)) return key as Emotion;
  return MOOD_SYNONYMS[key];
}

export function normalizeGesture(value: string): Gesture | undefined {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((GESTURES as readonly string[]).includes(key)) return key as Gesture;
  return GESTURE_SYNONYMS[key];
}

const KEYS = ['mood', 'gesture', 'emotion', 'expression'] as const;
const MAX_TAG_LENGTH = 120;
/** Characters a tag may contain between its brackets. */
const TAG_BODY = /^[A-Za-z0-9 \t=:,;"'_\-/|]*$/;

function keyPrefixOk(body: string): boolean {
  const start = body.replace(/^[\s"']+/, '');
  if (start.length === 0) return true;
  const word = /^[A-Za-z]+/.exec(start)?.[0]?.toLowerCase() ?? '';
  if (!word) return false;
  if (word.length === start.length) return KEYS.some(key => key.startsWith(word) || word === key);
  return KEYS.some(key => word === key);
}

/** Parses the inside of a tag. `recognized` is true when it names a mood or gesture key. */
export function parseCueBody(body: string): { recognized: boolean; cue: CharacterCue } {
  const cue: CharacterCue = {};
  let recognized = false;
  // "mood=x" and "mood: x" always mark a tag. "mood x" (no separator) only counts when x is
  // a real mood or gesture, so "[Gesture recognition is cool]" stays text.
  const pattern = /(mood|emotion|expression|gesture)(\s*[=:]\s*|\s+)["']?([A-Za-z_\-]+)["']?/gi;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const key = match[1].toLowerCase();
    const explicit = /[=:]/.test(match[2]);
    if (key === 'gesture') {
      const gesture = normalizeGesture(match[3]);
      if (explicit || gesture) recognized = true;
      if (gesture && cue.gesture === undefined) cue.gesture = gesture;
    } else {
      const mood = normalizeMood(match[3]);
      if (explicit || mood) recognized = true;
      if (mood && cue.emotion === undefined) cue.emotion = mood;
    }
  }
  return { recognized, cue };
}

type Verdict =
  | { kind: 'more' }
  | { kind: 'text' }
  | { kind: 'tag'; length: number; cue: CharacterCue };

/** Decides what the text starting at a '[' is: a complete tag, plain text, or undecided yet. */
function classify(rest: string, atReplyStart: boolean): Verdict {
  if (rest.length < 2) return { kind: 'more' };
  const double = rest.charCodeAt(1) === 91; /* [ */
  if (!double && !atReplyStart) return { kind: 'text' };
  const open = double ? 2 : 1;
  const closer = double ? ']]' : ']';
  const close = rest.indexOf(closer, open);
  let body = close === -1 ? rest.slice(open) : rest.slice(open, close);
  // "...wave]" may be a chunk boundary between the two closing brackets.
  if (close === -1 && double && body.endsWith(']')) body = body.slice(0, -1);
  if (body.length > MAX_TAG_LENGTH || !TAG_BODY.test(body) || !keyPrefixOk(body)) return { kind: 'text' };
  if (close === -1) return { kind: 'more' };
  const parsed = parseCueBody(body);
  if (!parsed.recognized) return { kind: 'text' };
  return { kind: 'tag', length: close + closer.length, cue: parsed.cue };
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 0xa0;
}

/**
 * Strips cue tags from a streamed reply. Call beginRound() before each model round, push()
 * every delta (emit what it returns), and end() when the round's stream finishes.
 */
export class CueStreamFilter {
  private pending = '';
  private atReplyStart = true;
  private trimLeading = true;
  private cues: CharacterCue[] = [];
  private readonly onCue: (cue: CharacterCue) => void;

  constructor(onCue: (cue: CharacterCue) => void = () => undefined) {
    this.onCue = onCue;
  }

  /** Every cue parsed so far, in order. */
  get all(): readonly CharacterCue[] {
    return this.cues;
  }

  /** Last mood and last gesture the model chose, if any. */
  get latest(): CharacterCue {
    const out: CharacterCue = {};
    for (const cue of this.cues) {
      if (cue.emotion) out.emotion = cue.emotion;
      if (cue.gesture) out.gesture = cue.gesture;
    }
    return out;
  }

  beginRound(): void {
    this.pending = '';
    this.atReplyStart = true;
    this.trimLeading = true;
  }

  push(delta: string): string {
    let input = this.pending + delta;
    this.pending = '';
    let out = '';
    while (input.length > 0) {
      if (this.trimLeading) {
        let skip = 0;
        while (skip < input.length && isSpace(input.charCodeAt(skip))) skip += 1;
        input = input.slice(skip);
        if (input.length === 0) break;
      }
      const bracket = input.indexOf('[');
      if (bracket === -1) {
        out += input;
        this.markVisible(input);
        break;
      }
      if (bracket > 0) {
        const before = input.slice(0, bracket);
        out += before;
        this.markVisible(before);
        input = input.slice(bracket);
      }
      const verdict = classify(input, this.atReplyStart);
      if (verdict.kind === 'more') {
        this.pending = input;
        break;
      }
      if (verdict.kind === 'tag') {
        this.accept(verdict.cue);
        input = input.slice(verdict.length);
        this.trimLeading = true;
        continue;
      }
      out += '[';
      this.markVisible('[');
      input = input.slice(1);
    }
    return out;
  }

  /** Flushes held-back text. An unfinished tag at the very end is dropped, not shown. */
  end(): string {
    const rest = this.pending;
    this.pending = '';
    if (!rest) return '';
    const double = rest.startsWith('[[');
    const body = rest.slice(double ? 2 : 1).replace(/\]$/, '');
    if ((double || this.atReplyStart) && TAG_BODY.test(body) && keyPrefixOk(body) && /[A-Za-z]/.test(body)) return '';
    if (this.trimLeading && rest.trim().length === 0) return '';
    this.markVisible(rest);
    return rest;
  }

  private markVisible(text: string): void {
    if (text.length === 0) return;
    this.atReplyStart = false;
    this.trimLeading = false;
  }

  private accept(cue: CharacterCue): void {
    if (cue.emotion === undefined && cue.gesture === undefined) return;
    this.cues.push(cue);
    this.onCue(cue);
  }
}

/** Removes cue tags from a complete text (titles, stored replies, non-streamed output). */
export function stripCueTags(text: string): { text: string; cue: CharacterCue } {
  const filter = new CueStreamFilter();
  const out = filter.push(text) + filter.end();
  return { text: out, cue: filter.latest };
}

// ── Mood inference ───────────────────────────────────────────────────────────

const MOOD_WORDS: Array<[Emotion, number, RegExp]> = [
  ['pruning', 3, /\b(prun(e|ed|es|ing)|reset charge|vaporiz\w*|disintegrat\w*|the void)\b/g],
  ['scary', 3, /\b(he who remains|citadel|alioth|end of time|monster|creepy|shadows?|doom|perish)\b/g],
  ['suspicious', 2, /\b(nexus|deviant|suspicious|red line|unauthori[sz]ed|sneaky|fishy|hmm+)\b/g],
  ['worried', 2, /\b(sorry|couldn'?t|can'?t reach|unable|failed|error|problem|uh[- ]oh|oh dear|trouble|unfortunately|apolog\w*|not working)\b/g],
  ['stern', 2, /\b(now listen|rules are rules|absolutely not|not allowed|against regulations?|i won'?t|i will not|don'?t you dare)\b/g],
  ['surprised', 2, /\b(wow|whoa|oh my|my stars|goodness|gracious|no way|well i'?ll be|would you look at that)\b/g],
  ['blushing', 2, /\b(aw+ shucks|flattered|you'?re (so )?sweet|blush\w*|you charmer|thank you kindly)\b/g],
  ['winking', 2, /\b(wink\w*|secret|between you and me|mischief|our little|hush now)\b/g],
  ['sassy', 1, /\b(honey|as if|oh,? really|sweetie|bless your heart|puh-?lease)\b/g],
  ['thinking', 1, /\b(let me (think|see|check)|calculat\w*|searching|checking|looking (into|that up)|one moment)\b/g],
  ['cheerful', 1, /\b(done|all set|you got it|happy to|great news|wonderful|ready|set for)\b/g],
];

/** Picks a mood from the words of a reply. Used when the model leaves out the cue tag. */
export function inferEmotion(text: string): Emotion {
  const lower = text.toLowerCase();
  let best: Emotion = 'cheerful';
  let bestScore = 0;
  for (const [mood, weight, pattern] of MOOD_WORDS) {
    pattern.lastIndex = 0;
    const hits = lower.match(pattern)?.length ?? 0;
    const score = hits * weight;
    if (score > bestScore) {
      best = mood;
      bestScore = score;
    }
  }
  if (bestScore === 0 && lower.length > 420) return 'talking';
  return best;
}
