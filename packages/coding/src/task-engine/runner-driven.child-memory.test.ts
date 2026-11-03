import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => vi.fn(() => undefined));
vi.mock('@kodax-ai/agent', async importOriginal => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(), tryGitRemote: remote,
}));
import { runManagedTaskViaRunner } from './runner-driven.js';

it.each([{ currentAgentId: '/root/child' }, { parentAgentId: '/root' }])(
  'does not probe a new root Memory identity for child context %j', async child => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-child-memory-'));
    remote.mockClear();
    try {
      const result = await runManagedTaskViaRunner({ provider: 'anthropic', effort: 'none', lsp: false,
        context: { ...child, configHome: path.join(root, 'home'), gitRoot: root, executionCwd: root, repoIntelligenceMode: 'off' },
      }, 'Reply briefly.', async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }));
      expect(result.success).toBe(true);
      expect(remote).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  },
);
