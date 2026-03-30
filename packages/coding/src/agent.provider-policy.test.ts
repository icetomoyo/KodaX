import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  registerModelProvider,
} from '@kodax/ai';
import { runKodaX } from './agent.js';

const TEST_PROVIDER_NAME = 'feature-029-bridge-provider';
const TEST_PROVIDER_API_KEY_ENV = 'FEATURE_029_BRIDGE_PROVIDER_API_KEY';

class Feature029BridgeProvider extends KodaXBaseProvider {
  static calls: Array<{
    messages: KodaXMessage[];
    system: string;
    streamOptions?: KodaXProviderStreamOptions;
  }> = [];

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'bridge-model',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
    capabilityProfile: {
      transport: 'cli-bridge',
      conversationSemantics: 'last-user-message',
      mcpSupport: 'none',
      contextFidelity: 'lossy',
      toolCallingFidelity: 'limited',
      sessionSupport: 'stateless',
      longRunningSupport: 'limited',
      multimodalSupport: 'none',
      evidenceSupport: 'limited',
    },
  };

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    Feature029BridgeProvider.calls.push({
      messages,
      system,
      streamOptions,
    });

    return {
      textBlocks: [{ type: 'text', text: 'provider policy test response' }],
      toolBlocks: [],
      thinkingBlocks: [],
    };
  }
}

describe('runKodaX provider policy integration', () => {
  beforeEach(() => {
    Feature029BridgeProvider.calls = [];
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProvider(
      TEST_PROVIDER_NAME,
      () => new Feature029BridgeProvider(),
    );
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
  });

  it('blocks long-running project flows before the provider stream starts', async () => {
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        context: {
          providerPolicyHints: {
            longRunning: true,
            harness: 'project',
          },
        },
      },
      'Finish the managed task and keep project mode active.',
    );

    expect(result.success).toBe(false);
    expect(result.errorMetadata?.lastError).toMatch(/\[Provider Policy\]/);
    expect(result.routingDecision?.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(Feature029BridgeProvider.calls).toEqual([]);
  });

  it('injects provider policy notes into warning-only execution flows', async () => {
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
      },
      'Please review this change for merge blockers and failing tests.',
    );

    expect(result.success).toBe(true);
    expect(Feature029BridgeProvider.calls).toHaveLength(1);
    expect(Feature029BridgeProvider.calls[0]?.system).toContain(
      `[Provider Policy] provider=${TEST_PROVIDER_NAME}; status=warn.`,
    );
    expect(Feature029BridgeProvider.calls[0]?.system).toContain(
      '[Provider Semantics] transport=cli-bridge; context=lossy',
    );
    expect(Feature029BridgeProvider.calls[0]?.system).toContain(
      '[Provider Constraint] WARN:',
    );
    expect(Feature029BridgeProvider.calls[0]?.system).toContain(
      '[Harness Profile: H1_EXECUTE_EVAL]',
    );
    expect(
      Feature029BridgeProvider.calls[0]?.system.match(
        new RegExp(`\\[Provider Policy\\] provider=${TEST_PROVIDER_NAME}; status=warn\\.`, 'g'),
      )?.length ?? 0,
    ).toBe(1);
    expect(result.routingDecision?.primaryTask).toBe('review');
    expect(result.routingDecision?.harnessProfile).toBe('H1_EXECUTE_EVAL');
  });

  it('allows benign text-only prompts that merely mention MCP, project mode, or screenshots', async () => {
    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
      },
      'Write release notes about screenshot support, project mode updates, and how MCP fits into the docs.',
    );

    expect(result.success).toBe(true);
    expect(Feature029BridgeProvider.calls).toHaveLength(1);
    expect(Feature029BridgeProvider.calls[0]?.system).not.toContain(
      '[Provider Policy]',
    );
    expect(Feature029BridgeProvider.calls[0]?.system).not.toContain(
      '[Provider Constraint]',
    );
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
  });
});
