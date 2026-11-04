import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('theme exposes stable VoiceKit custom properties and state hooks', async () => {
  const css = await readFile(new URL('../src/theme.css', import.meta.url), 'utf8');
  assert.match(css, /--vk-color-accent:/);
  assert.match(css, /\[data-state="speaking"\]/);
  assert.doesNotMatch(css, /tailwind/i);
});
