export type LegacyOwnerDatabaseState = 'present' | 'absent' | 'unknown';

/** A detected or uninspectable WebView database may contain plaintext owner records. */
export function requiresOwnerAuthenticationForLegacyDatabase(state: LegacyOwnerDatabaseState): boolean {
  return state !== 'absent';
}

/** Native app persistence must never silently fall back to renderer-owned IndexedDB. */
export function mayOpenLegacyOwnerDatabase(nativeOwnerStore: boolean, authenticatedMigration: boolean): boolean {
  return !nativeOwnerStore || authenticatedMigration;
}

/**
 * The one-time Android migration renderer has its own WebView origin. Checking only a pathname
 * is unsafe because dashboard script can change its own path with history.pushState().
 */
export function isAndroidMigrationRenderer(location: Pick<Location, 'origin' | 'pathname'>): boolean {
  return location.origin === 'https://appassets.androidplatform.net'
    && location.pathname === '/assets/web/migration.html';
}
