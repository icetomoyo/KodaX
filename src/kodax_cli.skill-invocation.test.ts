import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import * as coding from '@kodax-ai/coding';
import { resetSkillRegistry } from '@kodax-ai/agent';

import { createRequestId } from './host-protocol/host-client.js';
import { runOneShotClientTask } from './one-shot-task.js';
import { disposeReplHosts, MODEL, replHost } from '../tests/repl-v2-host.js';

afterEach(async () => {
  vi.restoreAllMocks();
  resetSkillRegistry();
  await disposeReplHosts();
});

it('keeps a raw one-shot Skill and its cancellable preparation inside the Host Run lifecycle', async () => {
  const { client, homeDir } = await replHost('answer');
  vi.spyOn(process, 'cwd').mockReturnValue(homeDir);
  const skillDir = path.join(homeDir, '.kodax', 'skills', 'cli-helper');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'),
    '---\nname: cli-helper\ndescription: Explicit CLI helper\ndisable-model-invocation: true\n---\n!`pwd`\nHandle $ARGUMENTS.\n');
  let preparationSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const shell = vi.spyOn(coding, 'toolBash').mockImplementation(async (_input, context) => {
    preparationSignal = context.abortSignal;
    if (!preparationSignal) throw new Error('Preparation requires the Host Run signal');
    await cleanup;
    preparationSignal.throwIfAborted();
    return 'prepared';
  });
  let pending: Promise<unknown> | undefined;
  try {
    const { session } = await client.call('session.create', { requestId: createRequestId(), projectRoot: homeDir, title: 'Raw Skill' });
    await client.call('session.settings.update', { requestId: createRequestId(), sessionId: session.id, patch: { permissionMode: 'full-access' } });
    const controller = new AbortController();
    pending = runOneShotClientTask({
      client, leases: async () => undefined, options: { provider: MODEL, session: { id: session.id } },
      prompt: 'please use /cli-helper inspect src', abortSignal: controller.signal,
    });
    await expect.poll(() => shell.mock.calls.length).toBe(1);
    controller.abort();
    await expect.poll(() => preparationSignal?.aborted).toBe(true);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await expect(pending).resolves.toMatchObject({ interrupted: true });
    expect(shell).toHaveBeenCalledOnce();
  } finally {
    release?.();
    await Promise.allSettled(pending ? [pending] : []);
  }
}, 60_000);
