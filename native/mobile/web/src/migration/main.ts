import '../shared/registerPlatform.ts';
import { onCommand, request } from '../shared/bridge.ts';
import { ensureAndroidOwnerDataReady, inspectLegacyOwnerDatabase } from '@desktop/store/db';

let running = false;

void request('hello', { role: 'migration' }).catch(() => undefined);

onCommand((type) => {
  if (type !== 'owner.migration.run' || running) return;
  running = true;
  void migrate().finally(() => { running = false; });
});

async function migrate(): Promise<void> {
  try {
    const legacy = await inspectLegacyOwnerDatabase();
    if (legacy === 'unknown') throw new Error('The legacy browser database could not be inspected safely.');
    await ensureAndroidOwnerDataReady(progress => {
      void request('owner.migration.progress', {
        stage: progress.stage,
        store: progress.store,
        copied: progress.copied,
      }).catch(() => undefined);
    });
    await request('owner.migration.complete', {
      success: true,
      legacyFound: legacy === 'present',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Saved data could not be migrated.';
    await request('owner.migration.complete', { success: false, message }).catch(() => undefined);
  }
}
