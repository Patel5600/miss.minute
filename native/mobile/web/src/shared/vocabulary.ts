/**
 * Shared vocabulary. Every list here must equal tests/android/vectors/vocabulary.json, which the
 * Java side reads too (`VocabularyTest`, `vocabulary.test.ts`). Change both together.
 */
export const STATES = [
  'IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'HAPPY', 'EXCITED', 'CURIOUS',
  'CONFUSED', 'ANNOYED', 'SLEEPING', 'SURPRISED', 'ALERT', 'ERROR', 'HIDDEN',
] as const;
export type OverlayState = (typeof STATES)[number];

export const LOCOMOTION = [
  'STAND', 'WALK', 'RUN', 'SIT_EDGE', 'HANG', 'CLIMB', 'JUMP', 'FALL', 'PEEK', 'NAP', 'DRAGGED', 'THROWN', 'TELEPORT', 'THINK',
] as const;
export type LocomotionName = (typeof LOCOMOTION)[number];

export const ROAMING_LEVELS = ['DOCKED', 'CALM', 'LIVELY', 'WILD'] as const;
export type RoamingLevel = (typeof ROAMING_LEVELS)[number];

export const MODES = ['OBSERVE', 'SUGGEST', 'AUTHORIZED'] as const;
export type Mode = (typeof MODES)[number];

export const EMOTIONS = [
  'cheerful', 'talking', 'winking', 'suspicious', 'scary', 'thinking', 'pruning',
  'blushing', 'stern', 'surprised', 'sassy', 'worried',
] as const;

export const GESTURES = ['wave', 'shrug', 'point', 'hips', 'present', 'think', 'knock', 'clap'] as const;

/** What the rig can draw today. Everything else needs the handle to report `supports(name)`. */
export const BASELINE_CAPABILITIES = [
  'idle', 'walk', 'drag', 'fall', 'hop', 'squash',
  'gesture:wave', 'gesture:shrug', 'gesture:point', 'gesture:hips',
  'gesture:present', 'gesture:think', 'gesture:knock', 'gesture:clap',
] as const;

export const CAPABILITY_NAMES = [
  'idle', 'walk', 'drag', 'fall', 'hop', 'squash', 'run', 'hang', 'sit-edge', 'climb', 'jump', 'peek', 'nap',
  'gesture:wave', 'gesture:shrug', 'gesture:point', 'gesture:hips', 'gesture:present', 'gesture:think',
  'gesture:knock', 'gesture:clap',
  'stand:look-around', 'stand:stretch', 'stand:foot-tap', 'stand:glance-clock', 'stand:wave-cursor', 'stand:yawn',
] as const;

export const KILL_PATHS = ['notification', 'app-button', 'overlay-menu', 'external'] as const;

export const ERROR_CODES = [
  'bad_json', 'bad_version', 'bad_type', 'too_large', 'bad_payload',
  'forbidden', 'unknown_type', 'unavailable', 'cancelled', 'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const PERMISSION_CAPABILITIES = [
  'timer.create', 'reminder.create', 'note.create', 'todo.update', 'memory.propose', 'system.read',
  'app.open', 'note.delete', 'todo.delete', 'mic.capture',
  'search.web', 'presence.observe', 'file.read', 'file.write', 'file.delete', 'command.run',
  'screen.capture', 'message.send', 'credential.access', 'purchase',
] as const;

export const AUTHORITIES = ['PAGE', 'OVERLAY', 'DASHBOARD', 'USER_ONLY', 'NATIVE_ONLY'] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** Who may send each message type. A `family.*` key covers every type with that prefix. */
export const MESSAGE_TYPES: Readonly<Record<string, Authority>> = {
  'hello': 'PAGE',
  'reply': 'NATIVE_ONLY',
  'event': 'NATIVE_ONLY',
  'rig.pose': 'NATIVE_ONLY',
  'rig.cue': 'NATIVE_ONLY',
  'rig.speech': 'NATIVE_ONLY',
  'rig.hop': 'NATIVE_ONLY',
  'rig.squash': 'NATIVE_ONLY',
  'rig.power': 'NATIVE_ONLY',
  'rig.visible': 'NATIVE_ONLY',
  'rig.error': 'OVERLAY',
  'overlay.status': 'DASHBOARD',
  'overlay.start': 'DASHBOARD',
  'overlay.stop': 'DASHBOARD',
  'overlay.requestPermission': 'DASHBOARD',
  'settings.get': 'DASHBOARD',
  'settings.set': 'DASHBOARD',
  'app.openMetadataWatcher': 'DASHBOARD',
  'kill.request': 'USER_ONLY',
  'kill.ackNotice': 'USER_ONLY',
  'permissions.get': 'USER_ONLY',
  'permissions.setMode': 'USER_ONLY',
  'permissions.grant': 'USER_ONLY',
  'permissions.revoke': 'USER_ONLY',
  'system.consent.get': 'DASHBOARD',
  'system.consent.set': 'USER_ONLY',
  'system.snapshot': 'DASHBOARD',
  'system.forget': 'DASHBOARD',
  'reminders.*': 'DASHBOARD',
  'todos.*': 'DASHBOARD',
  'notes.*': 'DASHBOARD',
  'provider.status': 'DASHBOARD',
  'provider.promptKey': 'USER_ONLY',
  'provider.remove': 'USER_ONLY',
  'provider.pair.start': 'USER_ONLY',
  'provider.pair.complete': 'USER_ONLY',
  'provider.stream': 'DASHBOARD',
  'provider.cancel': 'DASHBOARD',
  'tool.execute': 'DASHBOARD',
  'approval.list': 'DASHBOARD',
  'approval.decide': 'USER_ONLY',
  'memory.*': 'DASHBOARD',
  'audit.list': 'DASHBOARD',
  'cue.set': 'DASHBOARD',
  'voice.status': 'DASHBOARD',
  'voice.listen.start': 'DASHBOARD',
  'voice.listen.stop': 'DASHBOARD',
  'voice.speak': 'DASHBOARD',
  'voice.stop': 'DASHBOARD',
};

export const EVENT_NAMES = [
  'state.changed', 'kill.happened', 'provider.event', 'approval.requested', 'reminder.fired',
  'voice.state', 'voice.partial', 'voice.final', 'voice.range',
] as const;
