import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampMinute,
  describeError,
  describeKillNotice,
  describeOverlay,
  formatMinutes,
  LEVEL_DETAILS,
  MODE_DETAILS,
  parseHello,
  parseKillNotice,
  parseOverlayStatus,
  parseSettings,
  parseTimeInput,
} from '../../native/mobile/web/src/shared/nativeApi.ts';
import type { OverlayStatus } from '../../native/mobile/web/src/shared/nativeApi.ts';
import { MODES, ROAMING_LEVELS } from '../../native/mobile/web/src/shared/vocabulary.ts';

const clock = (ms: number): string => `T${ms}`;

function status(over: Partial<OverlayStatus> = {}): OverlayStatus {
  return {
    runtime: null,
    running: true,
    windowShown: true,
    dashboardForeground: false,
    pageReady: true,
    visibility: 'ACTIVE',
    overlayPermission: true,
    notificationPermission: true,
    desiredRunning: true,
    hiddenUntilMs: 0,
    killed: false,
    runtimeState: 'RUNNING',
    runtimeRevision: 3,
    runtimeEventId: '',
    runtimeServiceInstanceId: '',
    runtimeMonotonicAtMs: 0,
    runtimeFailure: '',
    roamingLevel: 'CALM',
    appliedRoamingLevel: 'CALM',
    ...over,
  };
}

test('an empty or damaged overlay status reads as "off", never as "on"', () => {
  for (const raw of [{}, null, 'x', 7, [], { running: 'yes', visibility: 'SIDEWAYS', hiddenUntilMs: -5 }]) {
    const s = parseOverlayStatus(raw);
    assert.equal(s.running, false);
    assert.equal(s.windowShown, false);
    assert.equal(s.pageReady, false);
    assert.equal(s.overlayPermission, false);
    assert.equal(s.notificationPermission, false);
    assert.equal(s.visibility, 'NONE');
    assert.equal(s.hiddenUntilMs, 0);
    assert.equal(s.runtimeState, 'STOPPED');
  }
});

test('a full overlay status is read field by field', () => {
  const s = parseOverlayStatus({
    running: true, windowShown: true, dashboardForeground: true, pageReady: true, visibility: 'DOCKED', overlayPermission: true,
    notificationPermission: false, desiredRunning: true, hiddenUntilMs: 99, killed: true,
    runtimeState: 'STOPPED', runtimeRevision: 0, runtimeEventId: '', runtimeServiceInstanceId: '', runtimeMonotonicAtMs: 0,
    runtimeFailure: '', roamingLevel: 'CALM', appliedRoamingLevel: null,
  });
  assert.deepEqual(s, {
    runtime: null,
    running: true, windowShown: true, dashboardForeground: true, pageReady: true, visibility: 'DOCKED', overlayPermission: true,
    notificationPermission: false, desiredRunning: true, hiddenUntilMs: 99, killed: true,
    runtimeState: 'STOPPED', runtimeRevision: 0, runtimeEventId: '', runtimeServiceInstanceId: '', runtimeMonotonicAtMs: 0,
    runtimeFailure: '', roamingLevel: 'CALM', appliedRoamingLevel: null,
  });
});

test('authoritative runtime state overrides a stale legacy running boolean', () => {
  const starting = parseOverlayStatus({
    running: true,
    runtime: {
      eventId: 'event-1', serviceInstanceId: 'service-1', revision: 7,
      monotonicTimestampNanos: 123456, state: 'STARTING', reason: null,
    },
    overlayPermission: true,
  });
  assert.equal(starting.running, false);
  assert.equal(starting.runtime?.state, 'STARTING');
  assert.equal(starting.runtime?.revision, 7);
  assert.equal(describeOverlay(starting, 0, clock).headline, 'Starting Miss Minutes');

  const failed = parseOverlayStatus({
    running: true,
    runtime: {
      eventId: 'event-2', serviceInstanceId: 'service-1', revision: 8,
      monotonicTimestampNanos: 123999, state: 'FAILED', reason: 'overlay_initialization_failed',
    },
    overlayPermission: true,
  });
  assert.equal(failed.running, false);
  assert.match(describeOverlay(failed, 0, clock).headline, /could not start/);
  assert.equal(describeOverlay(failed, 0, clock).detail, 'overlay_initialization_failed');

  const recovering = parseOverlayStatus({
    running: false,
    runtime: {
      eventId: 'event-3', serviceInstanceId: 'service-2', revision: 9,
      monotonicTimestampNanos: 124000, state: 'RECOVERING', reason: null,
    },
  });
  assert.equal(describeOverlay(recovering, 0, clock).headline, 'Reconnecting Miss Minutes');
});

test('permission-blocked and stopping states remain visible instead of being reported as stopped', () => {
  const blocked = parseOverlayStatus({
    runtime: {
      eventId: 'event-4', serviceInstanceId: null, revision: 10,
      monotonicTimestampNanos: 124100, state: 'PERMISSION_BLOCKED', reason: 'android.permission.SYSTEM_ALERT_WINDOW',
    },
  });
  const blockedDescription = describeOverlay(blocked, 0, clock);
  assert.equal(blockedDescription.needsOverlayPermission, true);
  assert.match(blockedDescription.detail, /SYSTEM_ALERT_WINDOW/);

  const stopping = parseOverlayStatus({
    runtime: {
      eventId: 'event-5', serviceInstanceId: 'service-2', revision: 11,
      monotonicTimestampNanos: 124200, state: 'STOPPING', reason: null,
    },
  });
  assert.equal(describeOverlay(stopping, 0, clock).headline, 'Stopping Miss Minutes');
});

test('settings fall back to the safe defaults', () => {
  const s = parseSettings({ roaming_level: 'TURBO', quiet_hours_start: 99999, quiet_hours_end: -3 });
  assert.equal(s.roaming_level, 'CALM');
  assert.equal(s.keep_after_close, false);
  assert.equal(s.hide_in_fullscreen, true);
  assert.equal(s.roaming_enabled, true);
  assert.equal(s.proactive, false);
  assert.equal(s.share_system_with_remote, false);
  assert.equal(s.quiet_hours_start, 0);
  assert.equal(s.quiet_hours_end, 0);
  assert.equal(parseSettings({ roaming_level: 'WILD' }).roaming_level, 'WILD');
});

test('hello is parsed into mode, notice, overlay and settings', () => {
  const info = parseHello({
    mode: 'OBSERVE', proactive: false, version: '0.2.0', sdk: 36,
    overlay: { running: false, overlayPermission: true },
    settings: { roaming_level: 'LIVELY', keep_after_close: true },
    killNotice: { atMs: 1234, path: 'overlay-menu' },
  });
  assert.equal(info.mode, 'OBSERVE');
  assert.equal(info.version, '0.2.0');
  assert.equal(info.sdk, 36);
  assert.equal(info.overlay.overlayPermission, true);
  assert.equal(info.settings.roaming_level, 'LIVELY');
  assert.equal(info.settings.keep_after_close, true);
  assert.deepEqual(info.killNotice, { atMs: 1234, path: 'overlay-menu' });
  assert.equal(parseHello({ mode: 'GOD' }).mode, 'OBSERVE');
  assert.equal(parseHello({ killNotice: null }).killNotice, null);
  assert.equal(parseKillNotice('nope'), null);
});

test('ownerCandidate and authState default safely when absent', () => {
  const bare = parseHello({});
  assert.equal(bare.ownerCandidate, false);
  assert.equal(bare.authState, 'locked');
  const full = parseHello({ ownerCandidate: true, authState: 'owner_candidate' });
  assert.equal(full.ownerCandidate, true);
  assert.equal(full.authState, 'owner_candidate');
  // Non-boolean ownerCandidate coerces to false
  assert.equal(parseHello({ ownerCandidate: 'yes' }).ownerCandidate, false);
  // Non-string authState coerces to 'locked'
  assert.equal(parseHello({ authState: 42 }).authState, 'locked');
});

test('without the overlay permission she says she can only live inside the app', () => {
  const d = describeOverlay(status({ running: false, overlayPermission: false, visibility: 'NONE' }), 0, clock);
  assert.equal(d.needsOverlayPermission, true);
  assert.equal(d.tone, 'warn');
  assert.match(d.headline, /only live inside the app/);
  assert.match(d.detail, /Display over other apps/);
});

test('a stopped or idle overlay is described as such', () => {
  const stopped = describeOverlay(status({ running: false, killed: true, visibility: 'NONE' }), 0, clock);
  assert.equal(stopped.headline, 'Stopped');
  assert.equal(stopped.needsOverlayPermission, false);
  const idle = describeOverlay(status({ running: false, visibility: 'NONE' }), 0, clock);
  assert.equal(idle.headline, 'She is not on your screen');
});

test('a running overlay is described by its visibility', () => {
  assert.equal(describeOverlay(status(), 0, clock).tone, 'ok');
  assert.match(describeOverlay(status(), 0, clock).headline, /on your screen/);
  assert.match(describeOverlay(status({ visibility: 'DOCKED' }), 0, clock).headline, /standing still/);
  assert.equal(describeOverlay(status({ visibility: 'PAUSED' }), 0, clock).headline, 'Paused');
  assert.equal(describeOverlay(status({ pageReady: false }), 0, clock).headline, 'Starting');
});

test('the companion steps aside while the dashboard is foregrounded', () => {
  const d = describeOverlay(status({ dashboardForeground: true, windowShown: false }), 0, clock);
  assert.equal(d.headline, 'Dashboard open');
  assert.match(d.detail, /returns when you leave/);
});

test('runtime transitions are reported distinctly and failures stay visible', () => {
  // New describeOverlay reads status.runtime?.state (the authoritative CompanionRuntime snapshot).
  const runtime = (state: string, reason?: string) => ({ eventId: 'e1', serviceInstanceId: null, revision: 1, monotonicTimestampNanos: 0, state, reason: reason ?? null });
  const starting = describeOverlay(status({ running: false, runtime: runtime('STARTING') }), 0, clock);
  assert.equal(starting.headline, 'Starting Miss Minutes');
  const failure = describeOverlay(status({ running: false, runtime: runtime('FAILED', 'WebView unavailable.') }), 0, clock);
  assert.equal(failure.headline, 'Miss Minutes could not start');
  assert.match(failure.detail, /WebView unavailable/);
  const blocked = describeOverlay(status({ running: false, runtime: runtime('PERMISSION_BLOCKED'), overlayPermission: false }), 0, clock);
  assert.equal(blocked.needsOverlayPermission, true);
});

test('hidden by the hour timer offers "Show her now"; hidden for other reasons does not', () => {
  const timer = describeOverlay(status({ visibility: 'HIDDEN', hiddenUntilMs: 5000 }), 1000, clock);
  assert.equal(timer.headline, 'Hidden until T5000');
  assert.equal(timer.hiddenByTimer, true);
  const other = describeOverlay(status({ visibility: 'HIDDEN', hiddenUntilMs: 500 }), 1000, clock);
  assert.equal(other.headline, 'Hidden for now');
  assert.equal(other.hiddenByTimer, false);
});

test('the notification note follows the notification permission', () => {
  assert.equal(describeOverlay(status({ notificationPermission: false }), 0, clock).notificationsOff, true);
  assert.equal(describeOverlay(status({ notificationPermission: true }), 0, clock).notificationsOff, false);
});

test('the kill notice names where the stop came from and omits an unknown time', () => {
  assert.match(describeKillNotice({ atMs: 10, path: 'notification' }, clock), /stopped at T10 by the Stop button in the notification\./);
  assert.match(describeKillNotice({ atMs: 10, path: 'app-button' }, clock), /by the Stop button in the app\./);
  assert.match(describeKillNotice({ atMs: 10, path: 'overlay-menu' }, clock), /from her menu\./);
  assert.match(describeKillNotice({ atMs: 0, path: 'external' }, clock), /^Miss Minutes was stopped from outside the app\./);
  assert.match(describeKillNotice({ atMs: 10, path: 'something-new' }, clock), /from outside the app\./);
  for (const path of ['notification', 'app-button', 'overlay-menu', 'external']) {
    assert.match(describeKillNotice({ atMs: 1, path }, clock), /Observe mode/);
  }
});

test('times of day round-trip and bad input is refused', () => {
  assert.equal(formatMinutes(23 * 60), '23:00');
  assert.equal(formatMinutes(7 * 60 + 5), '07:05');
  assert.equal(formatMinutes(-1), '00:00');
  assert.equal(formatMinutes(24 * 60), '00:00');
  assert.equal(parseTimeInput('23:00'), 1380);
  assert.equal(parseTimeInput('00:00'), 0);
  assert.equal(parseTimeInput('07:05'), 425);
  for (const bad of ['', '24:00', '7:05', '12:60', 'ab:cd', '12:30:00', ' 12:30']) assert.equal(parseTimeInput(bad), null);
  for (let m = 0; m < 24 * 60; m += 13) assert.equal(parseTimeInput(formatMinutes(m)), m);
  assert.equal(clampMinute(99999), 0);
});

test('errors become words, except the owner pressing Cancel', () => {
  assert.equal(describeError({ code: 'cancelled', message: 'Not changed.' }), null);
  assert.equal(describeError({ code: 'unavailable' }), 'Open this in the Miss Minutes app.');
  assert.equal(describeError(new Error('Could not save the change.')), 'Could not save the change.');
  assert.equal(describeError('weird'), 'Something went wrong.');
  assert.equal(describeError(undefined), 'Something went wrong.');
});

test('every mode and roaming level has a label and a sentence', () => {
  assert.deepEqual(Object.keys(MODE_DETAILS).sort(), [...MODES].sort());
  assert.deepEqual(Object.keys(LEVEL_DETAILS).sort(), [...ROAMING_LEVELS].sort());
  for (const m of MODES) assert.ok(MODE_DETAILS[m].label.length > 0 && MODE_DETAILS[m].text.endsWith('.'));
  for (const l of ROAMING_LEVELS) assert.ok(LEVEL_DETAILS[l].label.length > 0 && LEVEL_DETAILS[l].text.endsWith('.'));
});
