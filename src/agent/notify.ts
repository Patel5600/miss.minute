/**
 * Alert delivery in the browser: system notifications and the TVA chime. In the desktop app the
 * host fires notifications itself (schedule_sync), so this module stays quiet there.
 */
import { isDesktopRuntime } from '../desktop/bridge';
import { soundEffects } from '../utils/audioEffects';

export type NotifyPermission = NotificationPermission | 'unsupported';

export function notificationPermission(): NotifyPermission {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

let requesting: Promise<NotifyPermission> | null = null;

/**
 * Asks for notification permission the first time a timer, alarm or reminder is created. When
 * the browser refuses to prompt (no recent click) or the owner says no, alerts still arrive in
 * the app with speech and a chime.
 */
export function primeNotifications(): Promise<NotifyPermission> {
  if (isDesktopRuntime()) return Promise.resolve(notificationPermission());
  const current = notificationPermission();
  if (current !== 'default') return Promise.resolve(current);
  if (!requesting) {
    requesting = (async (): Promise<NotifyPermission> => {
      try {
        return await Notification.requestPermission();
      } catch {
        return notificationPermission();
      } finally {
        requesting = null;
      }
    })();
  }
  return requesting;
}

/** Shows a system notification when allowed. Returns false when it could not be shown. */
export function showSystemNotification(title: string, body: string, tag: string): boolean {
  if (isDesktopRuntime() || notificationPermission() !== 'granted') return false;
  try {
    const notification = new Notification(title, { body, tag, requireInteraction: false, silent: true });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    // Some platforms (Android Chrome) only allow notifications from a service worker.
    return false;
  }
}

const CHIME_REPEATS: Record<'timer' | 'alarm' | 'reminder' | 'event', number> = { timer: 2, alarm: 3, reminder: 1, event: 1 };

/** The TVA chime, repeated for alarms. Silent when sound effects are muted or audio is blocked. */
export function playAlertChime(kind: 'timer' | 'alarm' | 'reminder' | 'event'): void {
  const repeats = CHIME_REPEATS[kind];
  for (let i = 0; i < repeats; i += 1) {
    setTimeout(() => soundEffects.playTvaChime(), i * 1100);
  }
}
