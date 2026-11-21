import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFromPage, error, event, MAX_MESSAGE_BYTES, ProtocolError, reply, TYPE_PATTERN_SOURCE } from '../../native/mobile/web/src/shared/protocol.ts';
import { MESSAGE_TYPES } from '../../native/mobile/web/src/shared/vocabulary.ts';

interface ValidVector { name: string; text: string; type: string; id: string; authority: string; userOnly: boolean }
interface InvalidVector {
  name: string;
  text?: string;
  generate?: { payloadFillBytes: number; type: string; id: string };
  code: string;
}
interface Vectors {
  limits: { maxBytes: number; maxIdLength: number; typePattern: string };
  valid: ValidVector[];
  invalid: InvalidVector[];
}

const vectors = JSON.parse(readFileSync(new URL('./vectors/protocol.json', import.meta.url), 'utf8')) as Vectors;

test('limits match the code', () => {
  assert.equal(vectors.limits.maxBytes, MAX_MESSAGE_BYTES);
  assert.equal(vectors.limits.typePattern, TYPE_PATTERN_SOURCE);
});

test('every type in the message table can be sent (a pattern that rejected one would make it unreachable)', () => {
  const pattern = new RegExp(TYPE_PATTERN_SOURCE);
  for (const key of Object.keys(MESSAGE_TYPES)) {
    const sample = key.endsWith('.*') ? `${key.slice(0, -1)}x` : key;
    assert.ok(pattern.test(sample), `${sample} must match ${TYPE_PATTERN_SOURCE}`);
  }
});

for (const v of vectors.valid) {
  test(`valid: ${v.name}`, () => {
    const m = decodeFromPage(v.text);
    assert.equal(m.type, v.type);
    assert.equal(m.id, v.id);
    assert.equal(m.authority, v.authority);
    assert.equal(m.userOnly, v.userOnly);
  });
}

for (const v of vectors.invalid) {
  test(`invalid: ${v.name} -> ${v.code}`, () => {
    const text = v.generate
      ? JSON.stringify({ v: 1, id: v.generate.id, type: v.generate.type, payload: { fill: 'x'.repeat(v.generate.payloadFillBytes) } })
      : (v.text ?? '');
    assert.throws(() => decodeFromPage(text), (e: unknown) => e instanceof ProtocolError && e.code === v.code);
  });
}

test('reply, error and event builders produce envelopes the decoder accepts', () => {
  const r = JSON.parse(reply('id1', { a: 1 }));
  assert.deepEqual(r, { v: 1, id: 'id1', type: 'reply', ok: true, payload: { a: 1 } });
  const e = JSON.parse(error('id2', 'forbidden', 'no'));
  assert.deepEqual(e, { v: 1, id: 'id2', type: 'reply', ok: false, error: { code: 'forbidden', message: 'no' } });
  const ev = JSON.parse(event('kill.happened', { path: 'app-button' }));
  assert.deepEqual(ev, { v: 1, type: 'event', name: 'kill.happened', payload: { path: 'app-button' } });
});