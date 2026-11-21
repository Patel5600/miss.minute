import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingSourceFingerprint } from '../../src/agent/identityFingerprint.ts';

test('pairing fingerprint is stable and bound to owner, source device, and P-256 key', async () => {
  const key = new Uint8Array(65); key[0] = 4; key[64] = 7;
  const encoded = Buffer.from(key).toString('base64');
  const fingerprint = await pairingSourceFingerprint('owner-123', 'device-456', encoded);
  assert.match(fingerprint, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/);
  assert.equal(await pairingSourceFingerprint('owner-123', 'device-456', encoded), fingerprint);
  assert.notEqual(await pairingSourceFingerprint('owner-123', 'device-789', encoded), fingerprint);
  assert.notEqual(await pairingSourceFingerprint('owner-999', 'device-456', encoded), fingerprint);
});

test('pairing fingerprint rejects non-P256 keys', async () => {
  await assert.rejects(() => pairingSourceFingerprint('owner', 'device', Buffer.alloc(64).toString('base64')));
});
