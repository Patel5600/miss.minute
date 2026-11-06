import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../../native/mobile/web/src/shared/vocabulary.ts';

const json = JSON.parse(readFileSync(new URL('./vectors/vocabulary.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const pairs: [string, unknown][] = [
  ['states', V.STATES],
  ['locomotion', V.LOCOMOTION],
  ['roamingLevels', V.ROAMING_LEVELS],
  ['modes', V.MODES],
  ['emotions', V.EMOTIONS],
  ['gestures', V.GESTURES],
  ['baselineCapabilities', V.BASELINE_CAPABILITIES],
  ['capabilityNames', V.CAPABILITY_NAMES],
  ['killPaths', V.KILL_PATHS],
  ['errorCodes', V.ERROR_CODES],
  ['permissionCapabilities', V.PERMISSION_CAPABILITIES],
  ['authorities', V.AUTHORITIES],
  ['messageTypes', V.MESSAGE_TYPES],
  ['events', V.EVENT_NAMES],
];

for (const [key, ts] of pairs) {
  test(`vocabulary.json "${key}" equals the TypeScript constant`, () => {
    assert.deepEqual(json[key], ts);
  });
}

test('there are 14 states and every baseline capability is a known capability name', () => {
  assert.equal(V.STATES.length, 14);
  for (const name of V.BASELINE_CAPABILITIES) assert.ok((V.CAPABILITY_NAMES as readonly string[]).includes(name));
});

test('USER_ONLY list is non-empty and stable', () => {
  const userOnly = Object.entries(V.MESSAGE_TYPES).filter(([, a]) => a === 'USER_ONLY').map(([t]) => t).sort();
  assert.deepEqual(userOnly, [
    'approval.decide', 'kill.ackNotice', 'kill.request', 'permissions.get', 'permissions.grant',
    'permissions.revoke', 'permissions.setMode', 'provider.pair.complete', 'provider.pair.start',
    'provider.promptKey', 'provider.remove', 'system.consent.set',
  ]);
});