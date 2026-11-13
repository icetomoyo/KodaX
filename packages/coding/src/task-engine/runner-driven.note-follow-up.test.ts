import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { KodaXMessage } from '@kodax-ai/llm';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../memory/note-reflection-job.js', () => ({ scheduleNoteRunFinish: vi.fn(async () => undefined) }));

import { scheduleNoteRunFinish } from '../memory/note-reflection-job.js';
import { runManagedTaskViaRunner } from './runner-driven.js';

const scheduled = scheduleNoteRunFinish as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.unstubAllEnvs();
  scheduled.mockClear();
});

async function runAma(context: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-ama-notes-'));
  try {
    const result = await runManagedTaskViaRunner({ provider: 'anthropic', effort: 'none', lsp: false,
      context: { configHome: path.join(root, 'home'), gitRoot: root, executionCwd: root, repoIntelligenceMode: 'off', ...context },
    }, 'please remember that tests run with make check-fast', async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }));
    return { root, result };
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}

it('hands the finished AMA session to the note follow-up', async () => {
  vi.stubEnv('KODAX_MEMORY_NOTES', '1');
  const { root, result } = await runAma();
  expect(scheduled).toHaveBeenCalledTimes(1);
  const call = scheduled.mock.calls[0]![0] as { sessionId: string; cwd: string; messages: KodaXMessage[]; earlierCalls: ReadonlySet<string> };
  expect(call.sessionId).toBe(result.sessionId);
  expect(call.cwd).toBe(root);
  expect(call.earlierCalls.size).toBe(0);
  expect(JSON.stringify(call.messages)).toContain('make check-fast');
});

it('does nothing when the note memory is off', async () => {
  await runAma();
  expect(scheduled).not.toHaveBeenCalled();
});

it('does nothing for a child agent, whose notes belong to its parent run', async () => {
  vi.stubEnv('KODAX_MEMORY_NOTES', '1');
  await runAma({ parentAgentId: '/root' });
  expect(scheduled).not.toHaveBeenCalled();
});
