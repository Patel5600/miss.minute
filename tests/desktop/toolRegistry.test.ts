import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('desktop model schema exposes typed actions and no arbitrary shell capability', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/agent/tools/desktop.ts', import.meta.url)), 'utf8');
  assert.match(source, /name: 'open_app'/);
  assert.match(source, /name: 'read_text_file'/);
  assert.match(source, /name: 'write_text_file'/);
  assert.match(source, /name: 'inspect_foreground_ui'/);
  assert.doesNotMatch(source, /name: 'run_command'/);
  assert.doesNotMatch(source, /name: 'powershell'/);
  assert.doesNotMatch(source, /name: 'execute_shell'/);
});
