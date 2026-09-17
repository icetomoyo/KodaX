import { afterEach, describe, expect, it, vi } from 'vitest';
import { Runner, createAgent } from '@kodax-ai/agent';
import {
  clearRuntimeModelProviders, createProviderCredentialLeaseScope,
  deriveCurrentProviderCredentialLeaseScope, getScopedProviderCredential,
  KodaXBaseProvider, registerModelProvider, runWithProviderCredentialLeaseScope,
  type KodaXProviderStreamOptions, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

const providerName = 'credential-error-regression';
const secret = 'fake-child-credential';

async function runChild(operation: () => Promise<unknown>): Promise<unknown> {
  const scope = createProviderCredentialLeaseScope({
    allowedProviders: [providerName], acquire: async () => secret,
  });
  try {
    return await runWithProviderCredentialLeaseScope(scope, async () => {
      const child = deriveCurrentProviderCredentialLeaseScope([providerName], {
        kind: 'actor_turn', actorPath: '/root/worker', turnId: 'regression-turn',
      })!;
      try { return await runWithProviderCredentialLeaseScope(child, operation); }
      finally { child.close(); }
    });
  } finally { scope.close(); }
}

function registerScriptedProvider(request: (signal?: AbortSignal) => Promise<KodaXStreamResult>): void {
  class ScriptedProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config = {
      apiKeyEnv: 'UNUSED_CREDENTIAL_REGRESSION_KEY', model: 'test-model',
      supportsThinking: false, contextWindow: 32_000, maxOutputTokens: 1_000,
    };
    async stream(
      _messages: unknown, _tools: unknown, _system: string, _reasoning?: unknown,
      _options?: KodaXProviderStreamOptions, signal?: AbortSignal,
    ): Promise<KodaXStreamResult> {
      expect(getScopedProviderCredential(providerName)).toBe(secret);
      return this.withRateLimit(() => request(signal), signal);
    }
  }
  registerModelProvider(providerName, () => new ScriptedProvider());
}

const success: KodaXStreamResult = {
  textBlocks: [{ type: 'text', text: 'recovered' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn',
};

afterEach(() => { clearRuntimeModelProviders(); vi.useRealTimers(); });

describe('child Runner credential error recovery', () => {
  it.each(['TimeoutError', 'nested timeout', 'timer abort'])('recovers after %s under a derived lease', async (kind) => {
    vi.useFakeTimers();
    const request = vi.fn(async (signal?: AbortSignal): Promise<KodaXStreamResult> => {
      if (request.mock.calls.length > 1) return success;
      if (kind === 'timer abort') {
        return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => {
          reject(new DOMException(`request aborted ${secret}`, 'AbortError'));
        }, { once: true }));
      }
      const timeout = new DOMException(`deadline exceeded ${secret}`, 'TimeoutError');
      throw kind === 'nested timeout' ? new Error('request failed', { cause: timeout }) : timeout;
    });
    registerScriptedProvider(request);
    const onProviderRecovery = vi.fn();
    const llm = buildRunnerLlmAdapter({
      provider: providerName, model: 'test-model', effort: 'none',
      timeouts: { llm: { requestTimeoutSec: 1, streamIdleTimeoutSec: 0, maxRetryDelaySec: 0.001 } },
      events: { onProviderRecovery },
    });
    const run = runChild(() => Runner.run(createAgent({ name: 'worker', instructions: 'work' }), 'hello', {
      llm, tracer: null,
    }));
    await Promise.all([
      expect(run).resolves.toMatchObject({ output: 'recovered' }),
      vi.runAllTimersAsync(),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(onProviderRecovery).toHaveBeenCalledWith(expect.objectContaining({
      errorClass: 'request_timeout', recoveryAction: 'fresh_connection_retry',
    }));
    expect(JSON.stringify(onProviderRecovery.mock.calls)).not.toContain(secret);
  });

  it('propagates user cancellation without retry or recovery', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      throw new DOMException(`user cancelled ${secret}`, 'AbortError');
    });
    registerScriptedProvider(request);
    const onProviderRecovery = vi.fn();
    const llm = buildRunnerLlmAdapter({
      provider: providerName, model: 'test-model', effort: 'none',
      abortSignal: controller.signal, events: { onProviderRecovery },
    });
    await expect(runChild(() => Runner.run(createAgent({ name: 'worker', instructions: 'work' }), 'hello', {
      llm, tracer: null, abortSignal: controller.signal,
    }))).rejects.toMatchObject({ name: 'AbortError', message: 'user cancelled [REDACTED_CREDENTIAL]' });
    expect(request).toHaveBeenCalledOnce();
    expect(onProviderRecovery).not.toHaveBeenCalled();
  });
});
