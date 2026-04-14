import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  KodaXNetworkError,
  registerModelProvider,
} from '@kodax/ai';
import { runKodaX } from './agent.js';

const TEST_PROVIDER_NAME = 'feature-045-recovery-provider';
const TEST_PROVIDER_API_KEY_ENV = 'FEATURE_045_RECOVERY_PROVIDER_API_KEY';

class Feature045RecoveryProvider extends KodaXBaseProvider {
  static streamCalls = 0;
  static completeCalls = 0;
  static fallbackSignalStates: boolean[] = [];

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'recovery-model',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
    capabilityProfile: {
      transport: 'native-api',
      conversationSemantics: 'full-history',
      mcpSupport: 'none',
      contextFidelity: 'full',
      toolCallingFidelity: 'full',
      sessionSupport: 'stateless',
      longRunningSupport: 'limited',
      multimodalSupport: 'none',
      evidenceSupport: 'limited',
    },
  };

  override supportsNonStreamingFallback(): boolean {
    return true;
  }

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    Feature045RecoveryProvider.streamCalls += 1;
    throw new KodaXNetworkError('Stream stalled or delayed response (60s idle)', true);
  }

  async complete(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    Feature045RecoveryProvider.completeCalls += 1;
    Feature045RecoveryProvider.fallbackSignalStates.push(Boolean(signal?.aborted));

    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    streamOptions?.onTextDelta?.('fallback recovery');
    return {
      textBlocks: [{ type: 'text', text: 'fallback recovery' }],
      toolBlocks: [],
      thinkingBlocks: [],
    };
  }
}

describe('runKodaX provider recovery integration', () => {
  beforeEach(() => {
    Feature045RecoveryProvider.streamCalls = 0;
    Feature045RecoveryProvider.completeCalls = 0;
    Feature045RecoveryProvider.fallbackSignalStates = [];
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProvider(
      TEST_PROVIDER_NAME,
      () => new Feature045RecoveryProvider(),
    );
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
  });

  it('uses a fresh signal for non-streaming fallback and suppresses legacy retry spam when structured recovery events are available', async () => {
    const onProviderRecovery = vi.fn();
    const onRetry = vi.fn();

    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        events: {
          onProviderRecovery,
          onRetry,
        },
      },
      'Recover this response.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('fallback recovery');
    expect(Feature045RecoveryProvider.streamCalls).toBe(2);
    expect(Feature045RecoveryProvider.completeCalls).toBe(1);
    expect(Feature045RecoveryProvider.fallbackSignalStates).toEqual([false]);
    expect(onProviderRecovery).toHaveBeenCalledTimes(2);
    expect(onRetry).not.toHaveBeenCalled();
  }, 15_000);
});
