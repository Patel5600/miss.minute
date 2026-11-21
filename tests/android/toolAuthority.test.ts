import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureOwnerSessionSnapshot, isGuestToolAllowed, isOwnerSessionActive, scrubSettingsForGuest, toolPrincipalAuthorized } from '../../src/agent/brain/toolAuthority.ts';
import type { AISettings } from '../../src/types/index.ts';

test('guest tool allowlist contains only explicitly permitted generic tools', async () => {
  assert.equal(isGuestToolAllowed('calculate'), true);
  assert.equal(isGuestToolAllowed('get_time'), true);
  assert.equal(isGuestToolAllowed('web_search'), true);
  assert.equal(isGuestToolAllowed('get_weather'), true);
  assert.equal(isGuestToolAllowed('remember'), false);
  assert.equal(isGuestToolAllowed('read_note'), false);
});

test('guest tool execution does not query or acquire owner authority', async () => {
  let checked = false;
  assert.equal(await toolPrincipalAuthorized(true, async () => { checked = true; return false; }), true);
  assert.equal(checked, false);
});

test('owner tool execution requires a live platform session', async () => {
  assert.equal(await toolPrincipalAuthorized(false, async () => true), true);
  assert.equal(await toolPrincipalAuthorized(false, async () => false), false);
  assert.equal(await toolPrincipalAuthorized(false, async () => { throw new Error('bridge unavailable'); }), false);
});

test('desktop owner tools query native authority instead of assuming an owner session', async () => {
  const root = globalThis as unknown as Record<string, unknown>;
  const previous = root.window;
  try {
    root.window = { location: { hostname: 'localhost' }, __TAURI__: { core: { invoke: async (command: string) => {
      assert.equal(command, 'owner_status');
      return { enrolled: true, authenticated: true, sessionId: 'session-A', platform: 'windows-webauthn' };
    } } } };
    assert.equal(await captureOwnerSessionSnapshot(), 'session-A');
    assert.equal(await isOwnerSessionActive(), true);
    assert.equal(await isOwnerSessionActive('session-A'), true);
    root.window = { location: { hostname: 'localhost' }, __TAURI__: { core: { invoke: async () => ({ enrolled: true, authenticated: true, sessionId: 'session-B', platform: 'windows-webauthn' }) } } };
    assert.equal(await isOwnerSessionActive('session-A'), false);
    assert.equal(await isOwnerSessionActive('session-B'), true);
    root.window = { location: { hostname: 'localhost' }, __TAURI__: { core: { invoke: async () => ({ enrolled: true, authenticated: false, platform: 'windows-webauthn' }) } } };
    assert.equal(await isOwnerSessionActive(), false);
    root.window = { location: { hostname: 'localhost' }, __TAURI__: { core: { invoke: async () => { throw new Error('IPC unavailable'); } } } };
    assert.equal(await isOwnerSessionActive(), false);
  } finally {
    if (previous === undefined) delete root.window;
    else root.window = previous;
  }
});

test('an owner turn cannot adopt a newly unlocked replacement session', async () => {
  assert.equal(await toolPrincipalAuthorized(false, async () => true, null), false);
  assert.equal(await toolPrincipalAuthorized(false, async () => false, 'session-A'), false);
});

test('ordinary browser runtime cannot establish owner authority', async () => {
  const root = globalThis as unknown as Record<string, unknown>;
  const previous = root.window;
  try {
    delete root.window;
    assert.equal(await isOwnerSessionActive(), false);
  } finally {
    if (previous !== undefined) root.window = previous;
  }
});

test('scrubSettingsForGuest strips owner personal context and secrets', () => {
  const dirty: AISettings = {
    provider: 'openai',
    apiKey: 'sk-secret-key',
    model: 'gpt-4o',
    customEndpoint: 'http://localhost:11434/v1',
    systemPrompt: 'Call me by my private nickname',
    voiceEnabled: true,
    voicePitch: 1.12,
    voiceRate: 1.0,
    soundEffects: true,
    hologramMode: true,
    ambientChatter: false,
    roam: true,
    voiceEngine: 'local',
    openaiVoice: 'coral',
    elevenLabsKey: 'xi-secret',
    elevenLabsVoiceId: 'voice-1',
    useElevenLabs: false,
    localVoice: true,
    voiceEngineChosen: true,
    homeCity: 'Pune',
    memoryEnabled: true,
    strictApprovals: false,
  };
  const scrubbed = scrubSettingsForGuest(dirty);
  assert.equal(scrubbed.homeCity, '');
  assert.equal(scrubbed.systemPrompt, '');
  assert.equal(scrubbed.memoryEnabled, false);
  assert.equal(scrubbed.apiKey, '');
  assert.equal(scrubbed.elevenLabsKey, '');
  assert.equal(scrubbed.provider, 'openai');
  assert.equal(scrubbed.model, 'gpt-4o');
});

test('tool runner, weather, and orchestrator enforce guest/candidate isolation', () => {
  const runnerSrc = readFileSync(fileURLToPath(new URL('../../src/agent/brain/toolRunner.ts', import.meta.url)), 'utf8');
  const defineSrc = readFileSync(fileURLToPath(new URL('../../src/agent/tools/define.ts', import.meta.url)), 'utf8');
  const weatherSrc = readFileSync(fileURLToPath(new URL('../../src/agent/tools/weather.ts', import.meta.url)), 'utf8');
  const orchestratorSrc = readFileSync(fileURLToPath(new URL('../../src/agent/brain/orchestrator.ts', import.meta.url)), 'utf8');
  assert.match(runnerSrc, /scrubSettingsForGuest/);
  assert.match(runnerSrc, /!this\.options\.guestMode\b/);
  assert.match(defineSrc, /!ctx\.guestMode/);
  assert.match(weatherSrc, /!ctx\.guestMode/);
  assert.match(orchestratorSrc, /const restricted = Boolean\(input\.guestMode \|\| input\.ownerCandidate\)/);
});
