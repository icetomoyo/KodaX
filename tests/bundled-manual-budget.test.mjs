import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import { execSync } from 'node:child_process';

test('npm package includes the required manual data', () => {
  const packed = JSON.parse(execSync('npm pack --dry-run --ignore-scripts --json', {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  }));
  assert.ok(packed[0].files.some(file => file.path === 'dist/manual-topics.json'));
  assert.ok(packed[0].files.some(file => file.path === 'dist/static-text.json'));
  assert.ok(packed[0].files.some(file => file.path === 'dist/windows-native-scripts.json'));
  assert.ok(packed[0].files.some(file => file.path === 'dist/generated-config-templates.json'));
});

test('CLI retains room for native Responses within the existing 5 MiB limit', () => {
  assert.ok(statSync(new URL('../dist/kodax_cli.js', import.meta.url)).size <= 5 * 1024 * 1024 - 56 * 1024);
});

test('published SDK and standalone coding package expose identical complete manuals', async () => {
  const standalone = await import('../packages/coding/dist/self-knowledge/registry.js');
  const bundled = await import('../dist/sdk-coding.js');
  assert.deepEqual(bundled.MANUAL_TOPIC_IDS, standalone.MANUAL_TOPIC_IDS);
  assert.deepEqual(bundled.MANUAL_REGISTRY, standalone.MANUAL_REGISTRY);
  assert.equal(bundled.MANUAL_TOPIC_IDS.length, 23);
});

test('published SDK preserves standalone built-in tool definitions after prompt asset extraction', async () => {
  const standalone = await import('../packages/coding/dist/index.js');
  const bundled = await import('../dist/sdk-coding.js');
  assert.deepEqual(JSON.parse(JSON.stringify(bundled.KODAX_TOOLS)), JSON.parse(JSON.stringify(standalone.KODAX_TOOLS)));
  assert.equal(bundled.KODAX_TOOLS.length, 78);
});
