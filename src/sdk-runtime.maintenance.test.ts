import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime, type KodaXEvents } from './sdk-runtime.js';

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-maintenance-'));
  const providerName = `maintenance-${randomUUID()}`;
  class Provider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_MAINTENANCE_TEST_KEY', model: 'offline', supportsThinking: false,
    };
    async stream(): Promise<KodaXStreamResult> {
      return { textBlocks: [{ type: 'text', text: 'finished' }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_MAINTENANCE_TEST_KEY', 'offline-test');
  const unregister = registerModelProvider(providerName, () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir: root,
    sessionsDir: path.join(root, 'sessions'), defaultProvider: providerName });
  const session = await runtime.sessions.create({ title: 'Maintenance ownership', projectPath: root });
  return { root, runtime, session,
    start: (events?: KodaXEvents) => runtime.runs.start({ sessionId: session.id, prompt: 'finish this task',
      mode: 'managed_task', options: { model: 'offline', lsp: false, events,
        // Nested-agent context omits independent memory-review background work.
        context: { repoIntelligenceMode: 'off', currentAgentId: 'maintenance-fixture' } } }),
    async close() {
      try { await runtime.close(); } finally { unregister(); }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function holdArtifactWrites(root: string, failure?: Error) {
  const entered = deferred<string>();
  const release = deferred<void>();
  const finished = deferred<void>();
  let started = false;
  const originalWrite = fs.writeFile;
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    const file = path.resolve(String(args[0]));
    const held = file.startsWith(root + path.sep) && file.endsWith(`${path.sep}result.json`);
    try {
      if (held) {
        started = true;
        entered.resolve(file);
        await release.promise;
        if (failure) throw failure;
      }
      await originalWrite(...args);
    } finally { if (held) finished.resolve(); }
  });
  syncBuiltinESMExports();
  return { entered: entered.promise, release: () => release.resolve(),
    async settleStartedWrites() {
      release.resolve();
      if (started) await finished.promise;
    },
  };
}

it('settles owned maintenance on close without delaying the completed Run or its successor', async () => {
  const f = await fixture();
  const maintenance = holdArtifactWrites(f.root);
  try {
    const first = await f.start();
    await expect(first.result).resolves.toMatchObject({ phase: 'completed' });
    const artifact = await maintenance.entered;
    const successor = await f.start();
    await expect(successor.result).resolves.toMatchObject({ phase: 'completed' });
    await expect(f.runtime.runs.abort(first.runId)).resolves.toMatchObject({
      accepted: false, state: 'confirmed', outcome: 'completed',
    });
    const closing = f.runtime.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    maintenance.release();
    await closing;
    await expect(fs.readFile(artifact, 'utf8')).resolves.toContain('finished');
  } finally {
    try { await maintenance.settleStartedWrites(); } finally { await f.close(); }
  }
});

it('isolates maintenance ownership between Runtimes and shares concurrent close attempts', async () => {
  const first = await fixture();
  const second = await fixture();
  const firstWork = holdArtifactWrites(first.root);
  const secondWork = holdArtifactWrites(second.root);
  try {
    await (await first.start()).result;
    await (await second.start()).result;
    await Promise.all([firstWork.entered, secondWork.entered]);
    const closingFirst = first.runtime.close();
    expect(first.runtime.close()).toBe(closingFirst);
    let secondClosed = false;
    const closingSecond = second.runtime.close().then(() => { secondClosed = true; });
    firstWork.release();
    await closingFirst;
    expect(secondClosed).toBe(false);
    await first.runtime.close();
    secondWork.release();
    await closingSecond;
  } finally {
    try {
      await Promise.all([firstWork.settleStartedWrites(), secondWork.settleStartedWrites()]);
    } finally { await Promise.all([first.close(), second.close()]); }
  }
});

it('does not start optional terminal maintenance admitted after close begins', async () => {
  const f = await fixture();
  const maintenance = holdArtifactWrites(f.root);
  maintenance.release();
  let writesStarted = false;
  void maintenance.entered.then(() => { writesStarted = true; });
  let closing: Promise<void> | undefined;
  try {
    const run = await f.start({ onManagedTaskStatus(status) {
      if (status.phase === 'completed') closing ??= f.runtime.close();
    } });
    await run.result;
    expect(closing).toBeDefined();
    await closing;
    expect(writesStarted).toBe(false);
  } finally { await f.close(); }
});

it('settles a failed optional projection without changing the completed Run or leaking a rejection', async () => {
  const f = await fixture();
  const failure = Object.assign(new Error('fixture artifact write denied'), { code: 'EACCES' });
  const maintenance = holdArtifactWrites(f.root, failure);
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const run = await f.start();
    await expect(run.result).resolves.toMatchObject({ phase: 'completed' });
    await maintenance.entered;
    const closing = f.runtime.close();
    maintenance.release();
    await closing;
    await f.runtime.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    try { await maintenance.settleStartedWrites(); }
    finally {
      try { await f.close(); } finally { process.off('unhandledRejection', unhandled); }
    }
  }
});
