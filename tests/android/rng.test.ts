import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRandom } from '../../src/character/rig/math.ts';

interface RngVectors {
  algorithm: string;
  cases: { seed: number; values: number[] }[];
}

const vectors = JSON.parse(readFileSync(new URL('./vectors/rng.json', import.meta.url), 'utf8')) as RngVectors;

test('rng.json is mulberry32 with three seeds', () => {
  assert.equal(vectors.algorithm, 'mulberry32');
  assert.deepEqual(vectors.cases.map((c) => c.seed), [19789, 1234, 3735928559]);
});

for (const c of vectors.cases) {
  test(`createRandom(${c.seed}) matches the golden values exactly`, () => {
    const next = createRandom(c.seed);
    assert.equal(c.values.length, 16);
    for (const expected of c.values) assert.equal(next(), expected);
  });
}