/**
 * Arithmetic for the offline engine: spoken math turned into an expression ("15 percent of 230",
 * "12 times 7", "square root of 144", "2 to the power of 10") and a small evaluator that only
 * understands numbers, operators, parentheses and a few functions. Nothing is ever eval'd.
 */
import { wordsToDigits } from './numbers';

const LEADING = /^(?:hey\s+|ok\s+|okay\s+|so\s+)?(?:miss\s+minutes,?\s+)?(?:please\s+|can you\s+|could you\s+|would you\s+)?(?:tell me\s+)?(?:what(?:'s| is|s)|whats|calculate|calc|compute|work out|figure out|how much is|how much are|solve|evaluate|quick math:?)\s*/i;

/** Spoken math as an expression the evaluator accepts, or null when the text isn't arithmetic. */
export function extractExpression(text: string): string | null {
  let s = text.trim().replace(LEADING, '').replace(/\?+$|[.!]+$/g, '').trim();
  s = s.replace(/\s*(?:=|equals?|is equal to)\s*$/i, '');
  if (!s) return null;
  s = wordsToDigits(s.toLowerCase());
  s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  s = s
    .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)\s+of\s+/g, '($1/100)*')
    .replace(/\bhalf\s+of\s+/g, '0.5*')
    .replace(/\ba\s+third\s+of\s+/g, '(1/3)*')
    .replace(/\ba\s+quarter\s+of\s+/g, '0.25*')
    .replace(/\bdouble\s+/g, '2*')
    .replace(/\btriple\s+/g, '3*')
    .replace(/\bsquare\s+root\s+of\s+/g, 'sqrt ')
    .replace(/\bcube\s+root\s+of\s+/g, 'cbrt ')
    .replace(/\bsubtract\s+(\S+)\s+from\s+(\S+)/g, '$2-$1')
    .replace(/\bsquared\b/g, '^2')
    .replace(/\bcubed\b/g, '^3')
    .replace(/\b(?:to\s+the\s+power\s+of|raised\s+to(?:\s+the\s+power\s+of)?|to\s+the)\b/g, '^')
    .replace(/(\d)(?:st|nd|rd|th)\s+power\b/g, '$1')
    .replace(/\b(?:plus|added\s+to)\b/g, '+')
    .replace(/\b(?:minus|less|take\s+away)\b/g, '-')
    .replace(/\b(?:times|multiplied\s+by|into)\b/g, '*')
    .replace(/(\d)\s*[x×]\s*(?=[\d(])/g, '$1*')
    .replace(/\b(?:divided\s+by|over)\b/g, '/')
    .replace(/÷/g, '/')
    .replace(/\b(?:mod|modulo|modulus)\b/g, '%')
    .replace(/(\d)\s*%\s*(?=\d)/g, '$1 mod ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)/g, '($1/100)')
    .replace(/ mod /g, '%')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^[\d\s.+\-*/%^()a-z]*$/.test(s)) return null;
  const words = s.match(/[a-z]+/g) ?? [];
  if (words.some(word => !FUNCTIONS.has(word) && word !== 'pi' && word !== 'e')) return null;
  if (!/\d/.test(s)) return null;
  if (!/[+\-*/%^]|sqrt|cbrt|abs|ln|log/.test(s.replace(/^-/, ''))) return null;
  return s;
}

const FUNCTIONS = new Map<string, (x: number) => number>([
  ['sqrt', Math.sqrt], ['cbrt', Math.cbrt], ['abs', Math.abs], ['round', Math.round],
  ['floor', Math.floor], ['ceil', Math.ceil], ['ln', Math.log], ['log', Math.log10],
]);

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string } | { kind: 'name'; value: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (c === ' ') { i += 1; continue; }
    if (/[\d.]/.test(c)) {
      const m = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\.?/.exec(expression.slice(i));
      if (!m) throw new Error('Bad number.');
      tokens.push({ kind: 'num', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-z]/.test(c)) {
      const m = /^[a-z]+/.exec(expression.slice(i));
      tokens.push({ kind: 'name', value: m ? m[0] : c });
      i += m ? m[0].length : 1;
      continue;
    }
    if ('+-*/%^()'.includes(c)) {
      tokens.push({ kind: 'op', value: c });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected "${c}".`);
  }
  return tokens;
}

/** Evaluates an arithmetic expression. Throws with a short reason on bad input. */
export function evaluate(expression: string): number {
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()?.value === value;
  const startsOperand = () => {
    const t = peek();
    return !!t && (t.kind === 'num' || t.kind === 'name' || (t.kind === 'op' && t.value === '('));
  };

  function primary(): number {
    const t = peek();
    if (!t) throw new Error('The expression ended early.');
    if (t.kind === 'num') { pos += 1; return t.value; }
    if (t.kind === 'name') {
      pos += 1;
      if (t.value === 'pi') return Math.PI;
      if (t.value === 'e') return Math.E;
      const fn = FUNCTIONS.get(t.value);
      if (!fn) throw new Error(`Unknown function ${t.value}.`);
      return fn(unary());
    }
    if (isOp('(')) {
      pos += 1;
      const value = expr();
      if (!isOp(')')) throw new Error('Missing closing parenthesis.');
      pos += 1;
      return value;
    }
    throw new Error(`Unexpected "${t.value}".`);
  }
  function power(): number {
    const base = primary();
    if (isOp('^')) {
      pos += 1;
      return base ** unary();
    }
    return base;
  }
  function unary(): number {
    if (isOp('-')) { pos += 1; return -unary(); }
    if (isOp('+')) { pos += 1; return unary(); }
    return power();
  }
  function term(): number {
    let value = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%')) {
        const op = (peek() as Token).value;
        pos += 1;
        const right = unary();
        if (op === '/' && right === 0) throw new Error("can't divide by zero");
        value = op === '*' ? value * right : op === '/' ? value / right : value % right;
      } else if (startsOperand()) {
        // Implicit multiplication: "2(3+4)", "2 pi".
        value *= unary();
      } else {
        return value;
      }
    }
  }
  function expr(): number {
    let value = term();
    while (isOp('+') || isOp('-')) {
      const op = (peek() as Token).value;
      pos += 1;
      const right = term();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  const result = expr();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}".`);
  if (!Number.isFinite(result)) throw new Error('the result is not a finite number');
  return result;
}

/** "34.5", "1,234,567", "0.333333333". */
export function formatNumber(value: number): string {
  const rounded = Number(value.toPrecision(12));
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 9 });
}

/** The expression in readable form for replies ("(15/100)*230" -> "15% of 230" stays as typed). */
export function prettyExpression(expression: string): string {
  return expression.replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/\s+/g, ' ').trim();
}
