import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const maintenanceMocks = vi.hoisted(() => ({
  attachRepoIntelligence: vi.fn(() => new Promise<never>(() => undefined)),
}));

vi.mock('./_internal/managed-task/repo-intelligence.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./_internal/managed-task/repo-intelligence.js')
  >();
  return {
    ...actual,
    attachManagedTaskRepoIntelligence: maintenanceMocks.attachRepoIntelligence,
  };
});

import { runManagedTaskViaRunner } from './runner-driven.js';
import type { KodaXSessionData } from '@kodax-ai/agent';

const tempRoots: string[] = [];

it('does not overwrite unknown history when session loading fails before execution', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-maintenance-'));
  tempRoots.push(workspaceRoot);
  const original = new Error('fixture storage load failed');
  const save = vi.fn(), execute = vi.fn();
  await expect(runManagedTaskViaRunner({ provider: 'anthropic', reasoningMode: 'off', lsp: false,
    context: { executionCwd: workspaceRoot, configHome: path.join(workspaceRoot, '.kodax'), repoIntelligenceMode: 'off' },
    session: { id: 'unreadable-history', storage: { load: async () => { throw original; }, save } },
  }, 'Preserve this unreadable conversation.', execute)).rejects.toBe(original);
  expect(save).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it('awaits clean error snapshots and accumulates errors without losing the resumed title or completed tools', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-maintenance-'));
  tempRoots.push(workspaceRoot);
  let saved: KodaXSessionData = { title: 'Original title', gitRoot: workspaceRoot, messages: [
    { role: 'user', content: 'Original intent' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'done', name: 'read', input: { path: 'prior.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'done', content: 'Completed evidence' }] },
  ], errorMetadata: { consecutiveErrors: 2, lastError: 'previous', lastErrorTime: 1 },
  extensionState: { fixture: { visits: 7 } },
  extensionRecords: [{ id: 'r1', extensionId: 'fixture', type: 'saved', ts: 1, data: 42 }] };
  const original = new Error('fixture provider failure');
  for (const count of [3, 4]) {
    await expect(runManagedTaskViaRunner({ provider: 'anthropic', reasoningMode: 'off', lsp: false,
      context: { executionCwd: workspaceRoot, gitRoot: workspaceRoot, configHome: path.join(workspaceRoot, '.kodax'), repoIntelligenceMode: 'off' },
      session: { id: 'crash-snapshot', storage: { load: async () => structuredClone(saved),
        save: async (_id, data) => { await new Promise(resolve => setTimeout(resolve, 30)); saved = structuredClone(data); } } },
    }, 'Continue the saved task.', async () => { throw original; })).rejects.toBe(original);
    expect(saved.errorMetadata?.consecutiveErrors).toBe(count);
    expect(saved.title).toBe('Original title');
    expect(JSON.stringify(saved.messages)).toContain('Completed evidence');
    expect(saved.extensionState).toEqual({ fixture: { visits: 7 } });
    expect(saved.extensionRecords?.[0]?.id).toBe('r1');
  }
});

afterEach(async () => {
  maintenanceMocks.attachRepoIntelligence.mockClear();
  await Promise.all(tempRoots.splice(0).map((root) => (
    (async () => {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-runner-maintenance-')) {
        throw new Error('Unsafe Runner fixture cleanup');
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    })()
  )));
});

it('does not keep the managed terminal Promise open for stuck repo maintenance', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-maintenance-'));
  tempRoots.push(workspaceRoot);

  const run = runManagedTaskViaRunner(
    {
      provider: 'anthropic',
      context: {
        executionCwd: workspaceRoot,
        gitRoot: workspaceRoot,
        managedTaskWorkspaceDir: workspaceRoot,
        repoIntelligenceMode: 'off',
      },
      events: {},
    },
    'Return a direct answer.',
    async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
  );

  await expect(Promise.race([
    run,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('managed terminal timed out')), 2_000);
      timer.unref();
    }),
  ])).resolves.toMatchObject({ success: true, lastText: 'done' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(maintenanceMocks.attachRepoIntelligence).toHaveBeenCalledOnce();
});
