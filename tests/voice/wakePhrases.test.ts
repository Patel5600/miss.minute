import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsWakePhrase,
  detectWakePhrase,
  stripLeadingWakePhrase,
} from '../../src/agent/wakePhrases.ts';

test('detects full and shortened wake phrases with optional greetings', () => {
  for (const phrase of [
    'Hey Miss Minutes',
    'Miss Minutes',
    'Miss Minute',
    'Hey Miss',
    'Hey Minute',
    'Hi miss',
    'Hello Miss Minutes',
    'Okay Miss Minutes',
    'OK miss minute',
    'Yo Miss',
    'Alright Miss Minutes',
  ]) {
    const match = detectWakePhrase(phrase);
    assert.equal(match.matched, true, `Expected wake phrase match for "${phrase}"`);
    assert.equal(containsWakePhrase(phrase), true);
  }
});

test('strips leading wake phrases cleanly while keeping the command remainder', () => {
  const cases: Array<[string, string]> = [
    ['Hey Miss Minutes, set a 5 minute timer', 'set a 5 minute timer'],
    ['Miss Minutes: what time is it in Tokyo?', "what time is it in Tokyo?"],
    ['Hey Miss, remind me to call Mom at 5', 'remind me to call Mom at 5'],
    ['Hey Minute! check the weather in Pune', 'check the weather in Pune'],
    ['Okay Miss Minutes,   calculate 12 * 14', 'calculate 12 * 14'],
    ['Hi miss', ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(detectWakePhrase(input).remainder, expected);
    assert.equal(stripLeadingWakePhrase(input), expected);
  }
});

test('rejects false positives in ordinary speech', () => {
  for (const phrase of [
    '',
    '   ',
    'wait a minute',
    'hey wait a minute',
    '5 minutes left',
    'hey minute left on the timer',
    'miss the bus today',
    'hey missing file',
    'just a minute ago',
  ]) {
    assert.equal(containsWakePhrase(phrase), false, `Did not expect wake match for "${phrase}"`);
    assert.equal(detectWakePhrase(phrase).phrase, null);
  }
});
