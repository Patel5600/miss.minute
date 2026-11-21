/**
 * Spoken numbers and durations for the offline engine: "twenty five", "a couple of",
 * "an hour and a half", "1h30m", "2 and a half minutes", "half an hour".
 */

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const ONES_WORD = 'one|two|three|four|five|six|seven|eight|nine';
const SMALL_WORD = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS_WORD = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';

/** Regex source for a number written in words (0 to 99). */
export const NUMBER_WORD = `(?:(?:${TENS_WORD})(?:[-\\s](?:${ONES_WORD}))?|${SMALL_WORD})`;

/** "twenty five" -> 25, "7" -> 7, "1.5" -> 1.5, "a"/"an" -> 1, "a couple of" -> 2, "a few" -> 3. */
export function parseQuantity(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === 'a' || text === 'an') return 1;
  if (/^(?:a )?couple(?: of)?$/.test(text)) return 2;
  if (/^(?:a )?few$/.test(text) || text === 'several') return 3;
  if (text in SMALL) return SMALL[text];
  const parts = text.split(/[-\s]/);
  if (parts.length >= 1 && parts[0] in TENS) {
    const tens = TENS[parts[0]];
    if (parts.length === 1) return tens;
    if (parts.length === 2 && parts[1] in SMALL && SMALL[parts[1]] < 10) return tens + SMALL[parts[1]];
  }
  return null;
}

const UNIT_SECONDS: Array<[RegExp, number]> = [
  [/^(?:s|secs?|seconds?)$/i, 1],
  [/^(?:m|mins?|minutes?)$/i, 60],
  [/^(?:h|hrs?|hours?)$/i, 3600],
  [/^(?:d|days?)$/i, 86_400],
  [/^(?:w|wks?|weeks?)$/i, 604_800],
];

function unitSeconds(unit: string): number | null {
  for (const [pattern, seconds] of UNIT_SECONDS) if (pattern.test(unit)) return seconds;
  return null;
}

const HALF = '(?:\\s+and\\s+a\\s+half)';
const LONG_UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?)';
const ANY_UNIT = `(?:${LONG_UNIT}|[smhdw])`;
const WORD_QTY = `(?:an?|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|a\\s+few|few|several|${NUMBER_WORD})`;
// Digits may touch their unit ("5m", "90s"); words need a space or hyphen ("five-minute").
const DIGIT_COMPONENT = `\\d+(?:\\.\\d+)?${HALF}?\\s*-?\\s*${ANY_UNIT}${HALF}?`;
const WORD_COMPONENT = `${WORD_QTY}${HALF}?(?:\\s+|\\s*-\\s*)${LONG_UNIT}${HALF}?`;
const COMPONENT = `(?:${DIGIT_COMPONENT}|${WORD_COMPONENT})`;
const SPECIAL = '(?:half\\s+(?:an?\\s+)?(?:hour|minute)|(?:a\\s+)?quarter\\s+(?:of\\s+an\\s+)?hour|three\\s+quarters\\s+of\\s+an\\s+hour)';
const JOINER = '(?:\\s*,\\s*|\\s+and\\s+|\\s*)';

export const DURATION_SOURCE = `(?:${SPECIAL}|${COMPONENT})(?:${JOINER}${COMPONENT})*`;
const DURATION = new RegExp(`(?<![\\w.])${DURATION_SOURCE}(?![\\w])`, 'gi');
// Same shapes as COMPONENT, with groups: quantity, "and a half", unit, "and a half".
// Digits may follow a unit letter ("1h30m"); words must start a word ("and" is not "an d").
const COMPONENT_RE = new RegExp(
  `(?:(?<![\\d.])(\\d+(?:\\.\\d+)?)(${HALF})?\\s*-?\\s*(${ANY_UNIT})|(?<![\\w.])(${WORD_QTY})(${HALF})?(?:\\s+|\\s*-\\s*)(${LONG_UNIT}))(${HALF})?(?![a-z])`,
  'gi',
);

function specialSeconds(text: string): number | null {
  const lower = text.toLowerCase().replace(/\s+/g, ' ');
  if (/^half (?:an? )?hour$/.test(lower)) return 1800;
  if (/^half (?:an? )?minute$/.test(lower)) return 30;
  if (/^three quarters of an hour$/.test(lower)) return 2700;
  if (/^(?:a )?quarter (?:of an )?hour$/.test(lower)) return 900;
  return null;
}

/** Seconds in a duration phrase such as "1 hour and 30 minutes", or null. */
export function durationSeconds(phrase: string): number | null {
  const special = specialSeconds(phrase.trim());
  if (special !== null) return special;
  let total = 0;
  let found = false;
  COMPONENT_RE.lastIndex = 0;
  for (let match = COMPONENT_RE.exec(phrase); match; match = COMPONENT_RE.exec(phrase)) {
    const quantity = parseQuantity(match[1] ?? match[4] ?? '');
    const unit = unitSeconds(match[3] ?? match[6] ?? '');
    if (quantity === null || unit === null) continue;
    const half = match[2] || match[5] || match[7] ? 0.5 : 0;
    total += (quantity + half) * unit;
    found = true;
  }
  return found ? Math.round(total) : null;
}

export interface DurationMatch {
  seconds: number;
  start: number;
  end: number;
  text: string;
}

/** The longest duration phrase in the text. */
export function findDuration(text: string): DurationMatch | null {
  let best: DurationMatch | null = null;
  DURATION.lastIndex = 0;
  for (let match = DURATION.exec(text); match; match = DURATION.exec(text)) {
    const phrase = match[0].trim();
    const seconds = durationSeconds(phrase);
    if (seconds === null || seconds <= 0) continue;
    const start = match.index + match[0].indexOf(phrase);
    if (!best || phrase.length > best.text.length) best = { seconds, start, end: start + phrase.length, text: phrase };
  }
  return best;
}

/** Number words in free text turned into digits ("five plus three" -> "5 plus 3"). */
export function wordsToDigits(text: string): string {
  return text.replace(new RegExp(`\\b${NUMBER_WORD}\\b`, 'gi'), word => {
    const value = parseQuantity(word);
    return value === null ? word : String(value);
  });
}
