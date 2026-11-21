import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildInstructions } from '../../src/agent/brain/persona.ts';
import type { AISettings } from '../../src/types/index.ts';

function sampleSettings(over: Partial<AISettings> = {}): AISettings {
  return {
    provider: 'openai',
    apiKey: '',
    model: 'gpt-test',
    customEndpoint: 'http://localhost:11434/v1',
    systemPrompt: 'Secret owner style instructions',
    voiceEnabled: true,
    voicePitch: 1.12,
    voiceRate: 1.0,
    soundEffects: true,
    hologramMode: true,
    ambientChatter: true,
    roam: true,
    voiceEngine: 'system',
    openaiVoice: 'coral',
    elevenLabsKey: '',
    elevenLabsVoiceId: '',
    useElevenLabs: false,
    localVoice: false,
    voiceEngineChosen: false,
    homeCity: 'Pune',
    memoryEnabled: true,
    strictApprovals: false,
    ...over,
  };
}

test('owner mode receives style notes, home city, and memories', () => {
  const result = buildInstructions({
    settings: sampleSettings(),
    tools: [{ name: 'get_time', policy: 'auto' }],
    desktop: true,
    vision: true,
    providerLabel: 'OpenAI',
    model: 'gpt-test',
    context: 'Local time: Tuesday 10:00.',
    memories: '- Prefers dark roast coffee.',
    guestMode: false,
    ownerCandidate: false,
  });
  assert.match(result.stable, /Secret owner style instructions/);
  assert.match(result.dynamic, /home city is Pune/i);
  assert.match(result.dynamic, /Prefers dark roast coffee/);
  assert.match(result.stable, /Umar is trusted by Boss as a person, but is not the owner/);
});

test('ownerCandidate takes precedence over guestMode and never leaks owner data or addresses user as Boss', () => {
  const result = buildInstructions({
    settings: sampleSettings(),
    tools: [{ name: 'get_time', policy: 'auto' }],
    desktop: true,
    vision: false,
    providerLabel: 'OpenAI',
    model: 'gpt-test',
    context: 'Local time: Tuesday 10:00.',
    memories: '- Private owner secret note.',
    guestMode: true,
    ownerCandidate: true,
  });
  assert.doesNotMatch(result.stable, /Secret owner style instructions/);
  assert.doesNotMatch(result.dynamic, /Pune/);
  assert.doesNotMatch(result.dynamic, /Private owner secret note/);
  assert.match(result.stable, /Verify Identity/i);
  // Must not address an unauthenticated candidate as Boss.
  const candidateSection = result.stable.split('Miss Minutes has observed')[1]?.split('\n\n')[0] ?? '';
  assert.ok(candidateSection.length > 0, 'Expected OwnerCandidate instruction section');
  assert.doesNotMatch(candidateSection, /\bBoss\b/i);
  assert.match(candidateSection, /without addressing the unauthenticated user/i);
});

test('guest mode blocks owner style notes, home city, memories, and calling user Boss', () => {
  const result = buildInstructions({
    settings: sampleSettings(),
    tools: [{ name: 'get_time', policy: 'auto' }],
    desktop: false,
    vision: false,
    providerLabel: 'OpenAI',
    model: 'gpt-test',
    context: 'Local time: Tuesday 10:00.',
    memories: '- Secret dossier fact.',
    guestMode: true,
    ownerCandidate: false,
  });
  assert.doesNotMatch(result.stable, /Secret owner style instructions/);
  assert.doesNotMatch(result.dynamic, /Pune/);
  assert.doesNotMatch(result.dynamic, /Secret dossier fact/);
  assert.match(result.stable, /restricted guest session/i);
  assert.match(result.stable, /Do not call an unauthenticated user "Boss"/i);
});

test('zero sugar or darlin endearments appear across persona, offline, voice, lore, scheduler, Android, and UI sources', () => {
  const paths = [
    '../../src/agent/brain/persona.ts',
    '../../src/agent/brain/offline/voice.ts',
    '../../src/agent/brain/offline/engine.ts',
    '../../src/agent/platform.ts',
    '../../src/agent/scheduler.ts',
    '../../src/agent/realtime/cloudTts.ts',
    '../../src/data/tvaLore.ts',
    '../../src/panels/SacredTimeline.tsx',
    '../../src/app/Settings.tsx',
    '../../src/App.tsx',
    '../../native/desktop/src-tauri/src/loopback.rs',
    '../../native/voice/scenarios.json',
    '../../native/voice/generate_character_clips.py',
    '../../native/mobile/android/app/src/main/java/com/patel5600/missminute/mobile/app_world/spatial/AppRegistry.java',
    '../../native/mobile/android/app/src/main/java/com/patel5600/missminute/mobile/overlay/CompanionLoop.java',
    '../../native/mobile/android/app/src/main/java/com/patel5600/missminute/mobile/overlay/OverlayService.java',
  ];
  for (const rel of paths) {
    const content = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.doesNotMatch(content, /\bsugar\b|darlin'?/i, `Found forbidden endearment in ${rel}`);
  }
});
