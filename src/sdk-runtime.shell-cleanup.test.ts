import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const cleanup = vi.hoisted(() => ({ blocked: false, calls: 0,
  child: undefined as Parameters<typeof import('@kodax-ai/agent').killChildProcessTree>[0] | undefined }));
vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, killChildProcessTree: async (...args: Parameters<typeof actual.killChildProcessTree>) => {
    cleanup.child = args[0];
    cleanup.calls++;
    return cleanup.blocked ? { status: 'unknown' as const } : actual.killChildProcessTree(...args);
  } };
});

import { createKodaXRuntime } from './sdk-runtime.js';

it.each(['automatic', 'same-request'] as const)(
  'keeps unknown Shell cleanup fenced and recovers through %s retry', async (recovery) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-cleanup-'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir: path.join(root, 'sessions'),
    sharedDaemonHost: true, defaultProvider: 'unconfigured-provider' });
  cleanup.blocked = true;
  cleanup.calls = 0;
  try {
    const session = await runtime.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const pidFile = path.join(root, 'child.pid');
    await writeFile(path.join(root, 'read.txt'), 'later input');
    const command = `node -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" "${pidFile}"`;
    const run = await runtime.runs.start({ sessionId: session.id, prompt: '!wait', options: {
      lsp: false, toolInvocation: { name: 'bash', input: { command } },
    } });
    await vi.waitFor(async () => expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0), { timeout: 15_000 });
    const request = { sessionId: session.id, expectedRunId: run.runId, requestId: 'retry-cleanup' };
    await expect(runtime.sessions.cancel(request)).resolves.toMatchObject({
      receipts: [expect.objectContaining({ accepted: true, state: 'unknown' })],
    });
    const later = await runtime.runs.start({ sessionId: session.id, prompt: 'later input', options: {
      lsp: false, toolInvocation: { name: 'read', input: { path: path.join(root, 'read.txt') } },
    } });
    const premature = await Promise.race([run.result.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000))]);
    expect(premature).toBe(false);
    await expect(runtime.runs.get(later.runId)).resolves.toMatchObject({ phase: 'queued' });
    if (recovery === 'same-request') {
      await vi.waitFor(() => expect(cleanup.calls).toBeGreaterThanOrEqual(4), { timeout: 15_000 });
      const exhausted = cleanup.calls;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(cleanup.calls).toBe(exhausted);
    }
    cleanup.blocked = false;
    if (recovery === 'same-request') {
      const repeated = await Promise.all([
        runtime.sessions.cancel(request), runtime.sessions.cancel(request),
      ]);
      for (const receipt of repeated) {
        expect(receipt.receipts.map((entry) => entry.runId)).toEqual([run.runId]);
      }
    }
    await expect(run.result).resolves.toMatchObject({ phase: 'interrupted', stop: { state: 'confirmed' } });
    await expect(later.result).resolves.toMatchObject({ phase: 'completed' });
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    cleanup.blocked = false;
    if (cleanup.child) {
      const actual = await vi.importActual<typeof import('@kodax-ai/agent')>('@kodax-ai/agent');
      await actual.killChildProcessTree(cleanup.child);
    }
    await runtime.close();
    cleanup.child = undefined;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
