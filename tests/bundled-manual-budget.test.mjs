import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { execSync } from 'node:child_process';

test('npm package includes the required manual data', () => {
  const packed = JSON.parse(execSync('npm pack --dry-run --ignore-scripts --json', {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  }));
  assert.ok(packed[0].files.some(file => file.path === 'dist/manual-topics.json'));
  assert.ok(packed[0].files.some(file => file.path === 'dist/static-text.json'));
  assert.ok(packed[0].files.some(file => file.path === 'dist/windows-native-scripts.json'));
  assert.ok(packed[0].files.some(file => file.path === 'dist/windows-effect-job-programs.json'));
  assert.ok(packed[0].files.some(file => file.path === 'dist/generated-config-templates.json'));
});

test('CLI retains room for native Responses within the existing 5 MiB limit', () => {
  assert.ok(statSync(new URL('../dist/kodax_cli.js', import.meta.url)).size <= 5 * 1024 * 1024 - 49 * 1024);
});

test('published root and standalone Agent retain byte-identical audited Windows programs', () => {
  const bundled = JSON.parse(readFileSync(new URL('../dist/windows-effect-job-programs.json', import.meta.url), 'utf8'));
  const standalone = JSON.parse(readFileSync(new URL('../packages/agent/dist/runtime/windows-effect-job-programs.json', import.meta.url), 'utf8'));
  assert.deepEqual(bundled, standalone);
  assert.deepEqual(Object.fromEntries(Object.entries(bundled).map(([key, text]) =>
    [key, createHash('sha256').update(text, 'utf8').digest('hex')])), {
    effectJob: 'c9696ac7595a83d47d40f8e714f76ae6d1991836c39b163251a97a1b4097fe61',
    sidProbe: '02307259d2398a467692c41e5673fccd141f7ad08d4862601e99f6fae63f05ce',
  });
  const packed = JSON.parse(execSync('npm pack --dry-run --ignore-scripts --json', {
    cwd: new URL('../packages/agent/', import.meta.url), encoding: 'utf8',
  }));
  assert.ok(packed[0].files.some(file => file.path === 'dist/runtime/windows-effect-job-programs.json'));
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
  assert.equal(bundled.KODAX_TOOLS.length, 81);
  for (const name of ['visual_history', 'visual_inspect', 'visual_read_pixels']) {
    assert.ok(bundled.KODAX_TOOLS.some(tool => tool.name === name));
  }
});
