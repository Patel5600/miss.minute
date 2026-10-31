/**
 * What must never land in long-term memory. Secrets are refused even when the owner asks
 * (a password manager is the right place). Automatic extraction is stricter still: no
 * identifiers, contact details or sensitive personal categories it might have guessed at.
 */

const SECRET_WORDS = /\b(?:passwords?|passcodes?|passphrases?|pins?|pin codes?|api[\s_-]?keys?|secret keys?|access tokens?|auth tokens?|tokens?|otps?|one[\s-]time (?:code|password)|2fa|cvv|cvc|security codes?|seed phrases?|recovery (?:codes?|phrases?)|private keys?|wi-?fi (?:password|key))\b/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Long opaque strings mixing letters and digits (tokens, keys).
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{28,}\b/,
];

const IDENTIFIER_WORDS = /\b(?:ssn|social security|aadhaar|aadhar|pan (?:card|number)|passport (?:no|number)|driver'?s licen[cs]e|licen[cs]e (?:no|number)|national id|tax id|iban|routing number|account (?:no|number)|card (?:no|number)|credit card|debit card|bank account)\b/i;

const SENSITIVE_TOPICS = /\b(?:diagnos\w*|disease|illness|disorder|medication|prescri\w*|therapy|therapist|depress\w*|anxiety|pregnan\w*|hiv|cancer|diabet\w*|surgery|allerg\w*|religio\w*|muslim|christian|hindu|jewish|sikh|buddhist|atheist|church|mosque|temple|politic\w*|democrat|republican|vote[sd]? for|gay|lesbian|bisexual|transgender|sexual\w*|ethnicity|race|immigration status|visa status|salary|income|debt|loan|bank balance|net worth|arrest\w*|convict\w*|lawsuit|criminal record)\b/i;

function longDigitRun(text: string): boolean {
  // Phone, card and ID numbers: 7+ digits, allowing spaces, dots or dashes between groups.
  const compact = text.replace(/(?<=\d)[\s.-](?=\d)/g, '');
  return /\d{7,}/.test(compact);
}

/** True when the text contains a credential or secret. Never stored, even on request. */
export function containsSecret(text: string): boolean {
  if (SECRET_WORDS.test(text)) return true;
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) return true;
  if (IDENTIFIER_WORDS.test(text) && /\d{4,}/.test(text.replace(/[\s.-]/g, ''))) return true;
  // A Luhn-valid 13-19 digit number is almost certainly a payment card.
  for (const match of text.replace(/(?<=\d)[\s-](?=\d)/g, '').matchAll(/\d{13,19}/g)) {
    if (luhn(match[0])) return true;
  }
  return false;
}

/** Stricter check for facts extracted automatically from conversation. */
export function safeToAutoRemember(text: string): boolean {
  if (containsSecret(text)) return false;
  if (IDENTIFIER_WORDS.test(text)) return false;
  if (longDigitRun(text)) return false;
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return false;
  if (SENSITIVE_TOPICS.test(text)) return false;
  return true;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
