import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider } from '@kodax-ai/llm';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

const PROVIDER_NAME = 'runtime-stop-bound';
const PROVIDER_KEY_ENV = 'KODAX_RUNTIME_STOP_BOUND_KEY';

// Models an HTTP body whose cancellation was lost: the call ignores its abort
// signal and would only fail much later with a body timeout.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const pending = { started: deferred<void>(), settle: deferred<KodaXStreamResult>() };

class SignalIgnoringProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: PROVIDER_KEY_ENV,
    model: 'stop-model',
    supportsThinking: false,
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
  };

  async stream(): Promise<KodaXStreamResult> {
    pending.started.resolve();
    return pending.settle.promise;
  }
}

it('confirms a managed Stop promptly when the provider never honours its abort signal', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-stop-bound-'));
  vi.stubEnv(PROVIDER_KEY_ENV, 'local-test-only');
  registerModelProvider(PROVIDER_NAME, () => new SignalIgnoringProvider());
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
    await writeFile(path.join(homeDir, '.kodax', 'config.json'),
      JSON.stringify({ provider: PROVIDER_NAME, model: 'stop-model' }));
    runtime = await createKodaXRuntime({ homeDir });
    const session = await runtime.sessions.create({ projectPath: homeDir });
    const run = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Keep working.' });
    await pending.started.promise;

    expect((await runtime.runs.abort(run.runId)).accepted).toBe(true);
    const result = await run.result;

    expect(result.phase).toBe('interrupted');
    expect(result.failureDetail?.failureKind).not.toBe('network');
    expect(result.stop).toMatchObject({ state: 'confirmed', outcome: 'interrupted' });
  } finally {
    pending.settle.reject(Object.assign(new Error('terminated'), { code: 'UND_ERR_BODY_TIMEOUT' }));
    await runtime?.close();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 10_000);
