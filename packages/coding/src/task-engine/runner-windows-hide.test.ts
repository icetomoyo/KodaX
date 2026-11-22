import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(() => 'https://example.test/kodax/repo.git\n'),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: execSyncMock,
}));

import { setAgentConfigHome } from '@kodax-ai/agent';
import type { KodaXOptions } from '../types.js';
import { runManagedTaskViaRunner } from './runner-driven.js';

describe('ordinary query background-process regression', () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-windows-query-'));
    setAgentConfigHome(path.join(workspaceRoot, 'agent-home'));
  });

  afterAll(async () => {
    setAgentConfigHome(undefined);
    await rm(workspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it('hides the Git probe and runs it once across 20 ordinary queries', async () => {
    // Each synchronous probe blocks every session of a shared Host, so the
    // remote is read once per workspace and remembered after that.
    for (let index = 0; index < 20; index += 1) {
      const callsBeforeQuery = execSyncMock.mock.calls.length;
      const options: KodaXOptions = {
        provider: 'anthropic',
        context: {
          gitRoot: workspaceRoot,
          executionCwd: workspaceRoot,
          managedTaskWorkspaceDir: workspaceRoot,
          repoIntelligenceMode: 'off',
        },
        events: {},
      };
      await runManagedTaskViaRunner(options, `ordinary query ${index}`, async () => ({
        textBlocks: [{ text: 'done' }],
        toolBlocks: [],
      }));

      const queryCalls = execSyncMock.mock.calls.slice(callsBeforeQuery);
      expect(queryCalls.length, `ordinary query ${index}`).toBe(index === 0 ? 1 : 0);
      for (const [command, childOptions] of queryCalls) {
        expect(command).toBe('git config --get remote.origin.url');
        expect(childOptions?.windowsHide).toBe(true);
      }
    }
  }, 60_000);
});
