import test from 'node:test';
import assert from 'node:assert/strict';
import { isAndroidMigrationRenderer, mayOpenLegacyOwnerDatabase, requiresOwnerAuthenticationForLegacyDatabase } from '../../native/mobile/web/src/dashboard/legacyDatabaseGate.ts';

test('legacy WebView records block guest entry until owner-authenticated migration', () => {
  assert.equal(requiresOwnerAuthenticationForLegacyDatabase('present'), true);
  assert.equal(requiresOwnerAuthenticationForLegacyDatabase('unknown'), true);
  assert.equal(requiresOwnerAuthenticationForLegacyDatabase('absent'), false);
});

test('native CRUD cannot open WebView IndexedDB; only the authorized migration path can', () => {
  assert.equal(mayOpenLegacyOwnerDatabase(true, false), false);
  assert.equal(mayOpenLegacyOwnerDatabase(true, true), true);
  assert.equal(mayOpenLegacyOwnerDatabase(false, false), true);
});

test('migration renderer is bound to the exact isolated origin and page', () => {
  assert.equal(isAndroidMigrationRenderer({ origin: 'https://appassets.androidplatform.net', pathname: '/assets/web/migration.html' }), true);
  assert.equal(isAndroidMigrationRenderer({ origin: 'https://dashboard.missminutes.local', pathname: '/assets/web/migration.html' }), false);
  assert.equal(isAndroidMigrationRenderer({ origin: 'https://overlay.missminutes.local', pathname: '/assets/web/migration.html' }), false);
  assert.equal(isAndroidMigrationRenderer({ origin: 'https://appassets.androidplatform.net', pathname: '/assets/web/dashboard.html' }), false);
  assert.equal(isAndroidMigrationRenderer({ origin: 'https://appassets.androidplatform.net', pathname: '/assets/web/not-migration.html' }), false);
});
