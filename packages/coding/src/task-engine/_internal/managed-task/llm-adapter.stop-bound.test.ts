import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KodaXMessage, KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider } from '@kodax-ai/llm';
import { readRunnerRecoveryTranscript, type Agent } from '@kodax-ai/agent';

import { buildRunnerLlmAdapter } from './llm-adapter.js';

const PROVIDER_NAME = 'managed-stop-bound';
const PROVIDER_KEY_ENV = 'MANAGED_STOP_BOUND_KEY';

// A provider call that never observes its abort signal, like an HTTP body
// whose cancellation was lost: it only settles when the test says so.
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

const transcript: KodaXMessage[] = [{ role: 'user', content: 'hold the stream' }];
const agent: Agent = { name: 'worker', instructions: 'work', tools: [], reasoning: { default: 'none', max: 'none' } };

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'still-pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'still-pending'>(resolve => { timer = setTimeout(() => resolve('still-pending'), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

describe('managed LLM adapter Stop bound', () => {
  beforeEach(() => {
    pending.started = deferred<void>();
    pending.settle = deferred<KodaXStreamResult>();
    process.env[PROVIDER_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new SignalIgnoringProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[PROVIDER_KEY_ENV];
  });

  it('ends a Stopped call even when the provider never honours its abort signal', async () => {
    const controller = new AbortController();
    const adapter = buildRunnerLlmAdapter({
      provider: PROVIDER_NAME, model: 'stop-model', effort: 'none', abortSignal: controller.signal,
    });
    const call = adapter([{ role: 'system', content: 'rules' }, ...transcript], agent)
      .then(() => 'resolved' as const, (error: unknown) => error);
    await pending.started.promise;

    controller.abort(new Error('runtime run aborted'));
    const failure = await settleWithin(call, 1_000);

    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(readRunnerRecoveryTranscript(failure)).toEqual(transcript);
    // The abandoned provider call failing later must not surface as an
    // unhandled rejection or change the Stopped outcome.
    pending.settle.reject(Object.assign(new Error('terminated'), { code: 'UND_ERR_BODY_TIMEOUT' }));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
});
