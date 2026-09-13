import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runToolInvocation } from './tool-invocation.js';

it('executes an explicit host tool without an LLM request and retains tool permission checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-direct-tool-'));
  await writeFile(path.join(root, 'read.txt'), 'direct tool content');
  try {
    const beforeToolExecute = vi.fn(async (name: string) => name === 'write' ? '[Blocked] explicit user policy' : undefined);
    const options = { provider: 'unconfigured-provider', context: { executionCwd: root }, events: { beforeToolExecute } };
    await expect(runToolInvocation(options, { name: 'read', input: { path: 'read.txt' } }))
      .resolves.toMatchObject({ success: true, lastText: expect.stringContaining('direct tool content') });
    await expect(runToolInvocation(options, { name: 'write', input: { path: 'denied.txt', content: 'x' } }))
      .resolves.toMatchObject({ success: false, lastText: '[Blocked] explicit user policy' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['node -e "process.exit(7)"', 'kodax_nonexistent_command_299'])('fails closed without an admitted Shell boundary: %s', async (command) => {
  const result = await runToolInvocation({ provider: 'unconfigured-provider' }, { name: 'bash', input: { command } });
  expect(result.success).toBe(false);
});

it.each([0, 7])('preserves natural Shell exit %i when abort arrives after execution ends', async (exitCode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-completion-'));
  vi.stubEnv('KODAX_HOME', root);
  const controller = new AbortController();
  try {
    const result = await runToolInvocation({ provider: 'unconfigured-provider',
      abortSignal: controller.signal,
      context: { executionCwd: root, resolveShellPermissionMode: () => 'full-access',
        authorizeShellHostExecution: async () => true },
      events: { onToolExecutionEnd: () => controller.abort(new Error('late stop')) },
    }, { name: 'bash', input: { command: `node -e "process.exit(${exitCode})"` } });
    expect(controller.signal.aborted).toBe(true);
    expect(result.lastText).toContain(`Exit: ${exitCode}`);
    expect(result).toMatchObject({ interrupted: false, success: exitCode === 0 });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it('keeps a Shell cancellation interrupted when no natural outcome was reported', async () => {
  const controller = new AbortController();
  const result = await runToolInvocation({ provider: 'unconfigured-provider', abortSignal: controller.signal,
    events: { beforeToolExecute: () => { controller.abort(new Error('stop before execution')); return false; } },
  }, { name: 'bash', input: { command: 'node -e "process.exit(0)"' } });
  expect(result).toMatchObject({ interrupted: true, success: false, lastText: expect.stringContaining('[Cancelled]') });
});
