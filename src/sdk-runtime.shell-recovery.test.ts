import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ pending: false, verified: false, retries: 0,
  launchGate: undefined as Promise<void> | undefined,
  recover: vi.fn(), release: undefined as (() => void) | undefined }));
vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  cleanupManagedRunChildProcess: control.recover,
}));
vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return { ...actual, runToolInvocation: async (options: import('@kodax-ai/coding').KodaXOptions) => {
    if (control.launchGate) {
      options.events?.onToolExecutionStart?.({ id: 'shell', name: 'bash' });
      await control.launchGate;
    }
    try {
      if (control.pending) {
        control.release = options.events?.registerShellCleanup?.({
          runtimeRunId: options.context!.runtimeRunId!, pid: 12345,
          registrationId: '11111111-1111-4111-8111-111111111111',
        }, async () => { control.retries++; if (control.verified) control.release?.(); });
      }
    } finally {
      if (control.launchGate) options.events?.onToolExecutionEnd?.({ id: 'shell', name: 'bash' });
    }
    return { success: true, lastText: '', messages: [], sessionId: options.session!.id };
  } };
});

it('keeps owner liveness when Shell launch has not registered its child yet', async () => {
  let releaseLaunch!: () => void;
  control.launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  control.pending = true; control.verified = false;
  const f = await fixture();
  try {
    await expect(f.runtime.close()).rejects.toMatchObject({ code: 'conflict', retryable: true });
    releaseLaunch();
    await vi.waitFor(() => expect(control.release).toBeTypeOf('function'));
    control.verified = true;
    await f.runtime.close();
  } finally {
    control.verified = true; releaseLaunch(); control.release?.(); await f.runtime.close();
    control.pending = false; control.launchGate = undefined; control.release = undefined;
    vi.unstubAllEnvs(); await rm(f.root, { recursive: true, force: true });
  }
});
import { createKodaXRuntime } from './sdk-runtime.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-recovery-'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const options = { homeDir: root, sessionsDir: path.join(root, 'sessions'), sharedDaemonHost: true,
    defaultProvider: 'unconfigured-provider' };
  const runtime = await createKodaXRuntime(options);
  const session = await runtime.sessions.create({ projectPath: root });
  const run = await runtime.runs.start({ sessionId: session.id, prompt: 'cleanup fixture', options: {
    lsp: false, toolInvocation: { name: 'bash', input: { command: 'fixture' } },
  } });
  const file = path.join(root, '.kodax', 'runtime', 'profiles', 'default', 'runs', run.runId, 'status.json');
  return { root, options, runtime, session, run, file };
}

it('keeps executor completion pending and makes owner close retry Shell cleanup', async () => {
  control.pending = true; control.verified = false; control.retries = 0;
  const f = await fixture();
  try {
    await vi.waitFor(async () => expect(await f.runtime.runs.get(f.run.runId)).toMatchObject({ phase: 'unknown' }));
    await expect(f.runtime.close()).rejects.toMatchObject({ code: 'conflict', retryable: true });
    expect(control.retries).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(f.file, 'utf8'))._runtime.shellCleanups).toHaveLength(1);
    control.verified = true;
    await f.runtime.close();
    await expect(f.run.result).resolves.toMatchObject({ phase: 'completed' });
    expect(JSON.parse(await readFile(f.file, 'utf8'))._runtime.shellCleanups).toEqual([]);
  } finally {
    control.verified = true; control.release?.(); await f.runtime.close();
    control.pending = false; control.release = undefined; vi.unstubAllEnvs();
    await rm(f.root, { recursive: true, force: true });
  }
});

it.each(['unknown', 'verified', 'invalid', 'error'])('verifies dead-owner Shell references before recovery (%s)', async (outcome) => {
  const verified = outcome === 'verified';
  control.pending = false;
  const f = await fixture();
  await f.run.result; await f.runtime.close();
  const value = JSON.parse(await readFile(f.file, 'utf8'));
  const reference = { runtimeRunId: f.run.runId, pid: 12345, registrationId: randomUUID() };
  value.phase = 'unknown'; value.stage = 'unknown'; delete value.terminal; delete value.endedAt;
  value.stop = { requestedAt: new Date().toISOString(), state: 'unknown', outcome: 'unknown', reason: 'stop' };
  value._runtime.shellCleanups = [outcome === 'invalid' ? { ...reference, runtimeRunId: 'another-run' } : reference];
  await writeFile(f.file, JSON.stringify(value));
  // A terminal event must not bypass pending process cleanup during restart.
  control.recover.mockReset();
  const released = vi.fn(() => expect(JSON.parse(readFileSync(f.file, 'utf8'))._runtime.shellCleanups).toEqual([]));
  if (outcome === 'error') control.recover.mockRejectedValue(new Error('cleanup unavailable'));
  else control.recover.mockResolvedValue(verified ? { status: 'verified', release: released } : { status: 'unknown' });
  const recovered = await createKodaXRuntime(f.options);
  try {
    if (outcome === 'invalid') expect(control.recover).not.toHaveBeenCalled();
    else expect(control.recover).toHaveBeenCalledWith(reference);
    const status = await recovered.runs.get(f.run.runId);
    if (verified) { expect(status?.phase).not.toBe('unknown'); expect(released).toHaveBeenCalledOnce(); }
    else { expect(status).toMatchObject({ phase: 'unknown', stop: { state: 'unknown' } }); expect(released).not.toHaveBeenCalled(); }
  } finally {
    await recovered.close(); vi.unstubAllEnvs(); await rm(f.root, { recursive: true, force: true });
  }
});

it('retains the local cleanup binding when durable registration fails before returning release', async () => {
  let releaseLaunch!: () => void;
  control.launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  control.pending = true; control.verified = false; control.release = undefined;
  const f = await fixture();
  const lock = `${f.file}.lock`;
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'shell-admission-lock' }), { flag: 'wx' });
    releaseLaunch();
    await vi.waitFor(async () => expect(await f.runtime.runs.get(f.run.runId)).toMatchObject({ phase: 'unknown' }), { timeout: 10_000 });
    await rm(lock);
    expect(control.release).toBeUndefined();
    control.recover.mockResolvedValue({ status: 'unknown' });
    await expect(f.runtime.close()).rejects.toMatchObject({ retryable: true });
    const released = vi.fn();
    control.recover.mockResolvedValue({ status: 'verified', release: released });
    await f.runtime.close();
    expect(released).toHaveBeenCalledOnce();
    await expect(f.run.result).resolves.toMatchObject({ phase: 'failed' });
    expect(JSON.parse(await readFile(f.file, 'utf8'))._runtime.shellCleanups).toEqual([]);
  } finally {
    await rm(lock, { force: true }); releaseLaunch(); control.verified = true;
    control.recover.mockResolvedValue({ status: 'verified', release: () => undefined });
    await f.runtime.close(); control.pending = false; control.launchGate = undefined;
    vi.unstubAllEnvs(); await rm(f.root, { recursive: true, force: true });
  }
});
