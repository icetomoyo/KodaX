import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverWindowsTestFiles } from './windows-test-files.mjs';

test('new platform-gated and Windows-named source tests enter the Windows gate without a workflow edit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-windows-gate-'));
  try {
    const files = {
      'packages/fixture/src/new-recovery.test.ts': "describe.runIf(process.platform === 'win32')('recovery', () => {});",
      'src/new-credentials.test.ts': "const windows = process.platform === 'win32'; it.skipIf(!windows)('credentials', () => {});",
      'src/new-owner.windows.test.ts': "it('owner', () => {});",
      'src/early-return.test.ts': "it('credential ACL', () => { if (process.platform !== 'win32') return; });",
      'tests/portable.test.ts': "it('portable', () => {});",
      'packages/fixture/dist/stale.windows.test.ts': "it('stale', () => {});",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    assert.deepEqual(discoverWindowsTestFiles(root), [
      'packages/fixture/src/new-recovery.test.ts',
      'src/early-return.test.ts',
      'src/new-credentials.test.ts',
      'src/new-owner.windows.test.ts',
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the real selection includes recovery, path-alias and credential regressions omitted by the old file list', () => {
  const files = discoverWindowsTestFiles(path.resolve(import.meta.dirname, '..'));
  for (const file of [
    'packages/agent/src/runtime/managed-child-processes.cache.test.ts',
    'packages/coding/src/guardrails/auto-mode/permission-analyzer.test.ts',
    'src/sandbox-runtime.test.ts',
    'src/oauth-session-store.test.ts',
    'src/provider-oauth-store.test.ts',
    'packages/llm/src/auth-file.test.ts',
    'packages/repl/src/common/core-config-lock.test.ts',
    'packages/repl/src/interactive/session-migration.test.ts',
    'packages/repl/src/ui/utils/transcript-input-policy.test.ts',
    'src/execution-facts.test.ts',
    'src/cli-provider-credentials.test.ts',
  ]) assert.ok(files.includes(file), `Windows gate omitted ${file}`);
});
