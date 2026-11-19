import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import { runTestLeaf as runLeafAgent } from './agent-runtime/test-leaf.js';

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

describe('runLeafAgent provider policy integration', () => {
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

  it('blocks long-running flows on lossy bridge providers before the provider stream starts', async () => {
    const result = await runLeafAgent(
      {
        provider: TEST_PROVIDER_NAME,
        context: {
          providerPolicyHints: {
            longRunning: true,
          },
          repoIntelligenceMode: 'off',
        },
      },
      'Finish the managed task and keep the session active across turns.',
    );
    expect(result.success).toBe(false);
    expect(result.errorMetadata?.lastError).toMatch(/\[Provider Policy\]/);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(Feature029BridgeProvider.calls).toEqual([]);
  });

  it('injects provider policy notes into warning-only execution flows', async () => {
    const result = await runLeafAgent(
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
    // The retired router overlay must not return; provider-policy notes still
    // flow through the separate provider-policy gate.
    expect(Feature029BridgeProvider.calls[0]?.system).not.toContain('[Harness Profile');
    expect(
      Feature029BridgeProvider.calls[0]?.system.match(
        new RegExp(`\\[Provider Policy\\] provider=${TEST_PROVIDER_NAME}; status=warn\\.`, 'g'),
      )?.length ?? 0,
    ).toBe(1);
    expect(result.routingDecision?.primaryTask).toBe('review');
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
  // 180_000 (was 90_000 → 60_000 → 30_000): runLeafAgent with mock provider
  // takes ~22-26s baseline (system prompt build + routing pipeline +
  // iteration scaffolding). Under full-suite parallel load (~4800
  // concurrent tests as of v0.7.37) the wall-clock has pushed past
  // 90s on heavily-loaded runs (observed: 90005ms timeout). Each
  // version adds tests so the headroom needs to grow with the suite.
  // 180s gives ~150s headroom against the worst observed wall-clock.
  // NOTE: Vitest's timeout aborts the it-block but does NOT cancel
  // the runLeafAgent substrate's in-flight provider.stream — a timeout
  // here therefore cascades into the next test's
  // `Feature029BridgeProvider.calls` length assertion (leaked call
  // lands in the next test's bucket). Keeping deterministic headroom
  // prevents that cascade.
  }, 180_000);

  it('allows benign text-only prompts that merely mention MCP, project mode, or screenshots', async () => {
    const result = await runLeafAgent(
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
  // 180_000: see preceding test for rationale. Bumped together so the
  // pair stays symmetric — if the warning-only test times out and leaks
  // its substrate, this test's `calls.length === 1` assertion absorbs
  // the leaked call and fails with "got 2 vs 1". Keeping both tests
  // bounded above the worst observed wall-clock prevents the cascade.
  }, 180_000);
});
