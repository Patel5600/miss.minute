import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, frameForSegment, INITIAL_VIEW, probeCapabilities, rigLocomotion, STATE_TO_RIG } from '../../native/mobile/web/src/shared/rigAdapter.ts';
import { BASELINE_CAPABILITIES, STATES } from '../../native/mobile/web/src/shared/vocabulary.ts';

test('a handle without supports() reports exactly the baseline', () => {
  assert.deepEqual(probeCapabilities({}), [...BASELINE_CAPABILITIES]);
  assert.deepEqual(probeCapabilities(null), [...BASELINE_CAPABILITIES]);
});

test('supports(name) true turns exactly that capability on', () => {
  const caps = probeCapabilities({ supports: (name: string) => name === 'hang' });
  assert.ok(caps.includes('hang'));
  assert.ok(!caps.includes('run'));
  assert.ok(!caps.includes('jump'));
  for (const b of BASELINE_CAPABILITIES) assert.ok(caps.includes(b));
});

test('a throwing supports() leaves the capability off', () => {
  const caps = probeCapabilities({ supports: () => { throw new Error('boom'); } });
  assert.deepEqual(caps, [...BASELINE_CAPABILITIES]);
});

test('walk speed converts px/s to rig units/s', () => {
  const view = applyCommand(INITIAL_VIEW, { type: 'rig.pose', payload: { locomotion: 'WALK', facing: -1, speed: 34 } }, 0.34);
  assert.equal(view.locomotion, 'walk');
  assert.equal(view.facing, -1);
  assert.ok(Math.abs(view.walkSpeed - 100) < 1e-9);
  const still = applyCommand(view, { type: 'rig.pose', payload: { locomotion: 'STAND', speed: 34 } }, 0.34);
  assert.equal(still.locomotion, 'idle');
  assert.equal(still.walkSpeed, 0);
});

test('native locomotion maps onto the four rig motions', () => {
  assert.equal(rigLocomotion('DRAGGED'), 'drag');
  assert.equal(rigLocomotion('THROWN'), 'fall');
  assert.equal(rigLocomotion('FALL'), 'fall');
  assert.equal(rigLocomotion('RUN'), 'walk');
  assert.equal(rigLocomotion('HANG'), 'idle');
});

test('frameForSegment follows the voiceService vowel rule', () => {
  assert.equal(frameForSegment('wow'), 4);
  assert.equal(frameForSegment('Up'), 4);
  assert.equal(frameForSegment('yes'), 4);
  assert.equal(frameForSegment('go'), 2);
  assert.equal(frameForSegment('cat'), 3);
  assert.equal(frameForSegment('bee'), 1);
  assert.equal(frameForSegment('hi'), 1);
  assert.equal(frameForSegment('sh'), 0);
  assert.equal(frameForSegment(''), 0);
});

test('STATE_TO_RIG covers all 14 states', () => {
  assert.equal(STATES.length, 14);
  assert.deepEqual(Object.keys(STATE_TO_RIG).sort(), [...STATES].sort());
});

test('rig.cue maps a state and bumps the gesture key so a gesture can repeat', () => {
  const a = applyCommand(INITIAL_VIEW, { type: 'rig.cue', payload: { state: 'HAPPY' } }, 1);
  assert.equal(a.emotion, 'cheerful');
  assert.equal(a.gesture, 'wave');
  const b = applyCommand(a, { type: 'rig.cue', payload: { gesture: 'wave' } }, 1);
  assert.equal(b.gestureKey, a.gestureKey + 1);
  const ignored = applyCommand(a, { type: 'rig.cue', payload: { emotion: 'not-an-emotion', gesture: 'moonwalk' } }, 1);
  assert.equal(ignored.emotion, a.emotion);
  assert.equal(ignored.gesture, a.gesture);
});

test('rig.speech sets lip-sync frames from a segment or an explicit frame', () => {
  const on = applyCommand(INITIAL_VIEW, { type: 'rig.speech', payload: { speaking: true, segment: 'go' } }, 1);
  assert.equal(on.isSpeaking, true);
  assert.equal(on.mouthFrame, 2);
  const frame = applyCommand(INITIAL_VIEW, { type: 'rig.speech', payload: { speaking: true, frame: 3 } }, 1);
  assert.equal(frame.mouthFrame, 3);
  const off = applyCommand(on, { type: 'rig.speech', payload: { speaking: false } }, 1);
  assert.equal(off.isSpeaking, false);
  assert.equal(off.mouthFrame, 0);
});