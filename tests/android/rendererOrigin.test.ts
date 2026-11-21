import test from 'node:test';
import assert from 'node:assert/strict';
import { isAndroidApp } from '../../native/mobile/web/src/shared/bridge.ts';

test('Android renderer detection covers each role-specific virtual origin', () => {
  const root = globalThis as unknown as Record<string, unknown>;
  const previous = root.window;
  try {
    for (const hostname of [
      'dashboard.missminutes.local',
      'overlay.missminutes.local',
      'appassets.androidplatform.net',
    ]) {
      root.window = { location: { hostname } };
      assert.equal(isAndroidApp(), true, `${hostname} should be recognized as Android`);
    }
    root.window = { location: { hostname: 'untrusted.example' } };
    assert.equal(isAndroidApp(), false);
  } finally {
    if (previous === undefined) delete root.window;
    else root.window = previous;
  }
});
