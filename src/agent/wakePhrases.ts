/**
 * Local wake-phrase matcher used after on-device STT or wake detection and when normalizing
 * spoken offline requests. Recognizing a wake phrase can only raise an `OwnerCandidate`
 * recognition signal on desktop/mobile; it never authenticates or grants privileges.
 */

export interface WakePhraseMatch {
  matched: boolean;
  phrase: string | null;
  remainder: string;
}

const FULL_NAME_WAKE = /\b(?:(?:hey|hi|hello|ok(?:ay)?|yo|alright)[\s,]+)?miss\s+minutes?\b/i;
const SHORT_GREETING_WAKE = /\b(?:hey|hi|hello|yo)[\s,]+(?:miss|minutes?)\b(?![\s-]+(?:left|ago|later|more|timer|to\b))/i;

const LEADING_WAKE = /^(?:(?:(?:hey|hi|hello|ok(?:ay)?|yo|alright)[\s,]+)?miss\s+minutes?|(?:hey|hi|hello|yo)[\s,]+(?:miss|minutes?))\b[\s,!.:;]*/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function detectWakePhrase(text: string): WakePhraseMatch {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) {
    return { matched: false, phrase: null, remainder: '' };
  }

  const fullMatch = FULL_NAME_WAKE.exec(cleaned);
  const shortMatch = SHORT_GREETING_WAKE.exec(cleaned);

  const chosen =
    fullMatch && shortMatch
      ? fullMatch.index <= shortMatch.index
        ? fullMatch
        : shortMatch
      : (fullMatch ?? shortMatch);

  if (!chosen) {
    return { matched: false, phrase: null, remainder: cleaned };
  }

  const remainder = cleaned
    .replace(LEADING_WAKE, '')
    .trim();

  return {
    matched: true,
    phrase: chosen[0].toLowerCase().replace(/\s+/g, ' ').trim(),
    remainder,
  };
}

export function containsWakePhrase(text: string): boolean {
  return detectWakePhrase(text).matched;
}

export function stripLeadingWakePhrase(text: string): string {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return '';
  if (LEADING_WAKE.test(cleaned)) {
    return cleaned.replace(LEADING_WAKE, '').trim();
  }
  return cleaned;
}
