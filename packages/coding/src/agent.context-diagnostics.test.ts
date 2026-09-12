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
import { ContextCapacityError } from '@kodax-ai/agent';
import { runKodaX } from './agent.js';
import type { RuntimeContextBudgetSnapshot } from './agent-runtime/context-budget.js';
import type { RuntimeToolExposurePlan } from './agent-runtime/tool-exposure-planner.js';
import type { KodaXPromptCacheDiagnosticEvent } from './types.js';

const TEST_PROVIDER_NAME = 'context-diagnostics-provider';
const TEST_PROVIDER_API_KEY_ENV = 'CONTEXT_DIAGNOSTICS_PROVIDER_API_KEY';

class ContextDiagnosticsProvider extends KodaXBaseProvider {
  static calls: Array<{
    messages: KodaXMessage[];
    tools: KodaXToolDefinition[];
    streamOptions?: KodaXProviderStreamOptions;
  }> = [];

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'diagnostic-model',
    supportsThinking: false,
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    ContextDiagnosticsProvider.calls.push({ messages, tools, streamOptions });
    streamOptions?.onTextDelta?.('diagnostics ok');
    return {
      textBlocks: [{ type: 'text', text: 'diagnostics ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: {
        inputTokens: 42,
        outputTokens: 3,
        totalTokens: 45,
        cachedReadTokens: 21,
      },
    };
  }
}

describe('runKodaX context diagnostics', () => {
  beforeEach(() => {
    ContextDiagnosticsProvider.calls = [];
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProvider(TEST_PROVIDER_NAME, () => new ContextDiagnosticsProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
  });

  it('reports execution budget without enabling optional exposure diagnostics', async () => {
    const budgets: RuntimeContextBudgetSnapshot[] = [];
    const exposures: RuntimeToolExposurePlan[] = [];

    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        maxIter: 1,
        context: { repoIntelligenceMode: 'off' },
        events: {
          onContextBudgetSnapshot: (event) => budgets.push(event),
          onToolExposurePlanned: (event) => exposures.push(event),
        },
      },
      'hello',
    );

    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.compactionBudget).toMatchObject({ reservedMemoryTokens: 3200 });
    expect(exposures).toEqual([]);
  });

  it('emits bounded budget events and applies small-window bridge exposure when enabled', async () => {
    const budgets: RuntimeContextBudgetSnapshot[] = [];
    const exposures: RuntimeToolExposurePlan[] = [];
    const cacheDiagnostics: KodaXPromptCacheDiagnosticEvent[] = [];

    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        maxIter: 1,
        context: {
          contextDiagnostics: true,
          repoIntelligenceMode: 'off',
          currentAgentId: '/root/first-tier-child',
        },
        events: {
          onContextBudgetSnapshot: (event) => budgets.push(event),
          onToolExposurePlanned: (event) => exposures.push(event),
          onPromptCacheDiagnostics: (event) => cacheDiagnostics.push(event),
        },
      },
      'inspect this repository',
    );

    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.sessionId).toBeDefined();
    expect(budgets[0]?.turnId).toBeDefined();
    expect(budgets[0]?.contextWindow).toBe(32_000);
    expect(budgets[0]?.profile).toBe('small_window');
    expect(budgets[0]).toMatchObject({
      contextId: `${budgets[0]?.sessionId}/agent/${encodeURIComponent('/root/first-tier-child')}`,
      contextKind: 'child',
      parentContextId: budgets[0]?.sessionId,
      agentId: '/root/first-tier-child',
    });
    expect(budgets[0]?.tokenBreakdown.toolSchemas).toBeGreaterThan(0);
    expect(JSON.stringify(budgets[0])).not.toContain('inspect this repository');

    expect(exposures).toHaveLength(1);
    expect(exposures[0]?.profile).toBe('small_window');
    expect(exposures[0]).toMatchObject({
      contextId: budgets[0]?.contextId,
      contextKind: 'child',
      parentContextId: budgets[0]?.parentContextId,
      agentId: '/root/first-tier-child',
    });
    expect(exposures[0]?.reportOnly).toBe(false);
    expect(exposures[0]?.modelVisibleToolNames).toContain('read');
    expect(exposures[0]?.modelVisibleToolNames).toContain('tool_search');
    expect(exposures[0]?.modelVisibleToolNames).toContain('tool_call');
    expect(exposures[0]?.modelVisibleToolNames).not.toContain('web_fetch');
    expect(ContextDiagnosticsProvider.calls[0]?.tools.map((tool) => tool.name)).not.toContain('web_fetch');
    expect(exposures[0]?.estimatedTokensSaved).toBeGreaterThan(0);

    expect(cacheDiagnostics).toHaveLength(2);
    expect(cacheDiagnostics.map((event) => event.phase)).toEqual(['request', 'response']);
    expect(cacheDiagnostics[0]).toMatchObject({
      transport: 'stream',
      provider: TEST_PROVIDER_NAME,
      model: 'diagnostic-model',
      attempt: 1,
      contextId: budgets[0]?.contextId,
      contextKind: 'child',
      parentContextId: budgets[0]?.parentContextId,
      agentId: '/root/first-tier-child',
    });
    expect(cacheDiagnostics[0]).not.toHaveProperty('inputTokens');
    expect(cacheDiagnostics[0]).not.toHaveProperty('cachedReadTokens');
    expect(cacheDiagnostics[1]).toMatchObject({
      requestId: cacheDiagnostics[0]?.requestId,
      inputTokens: 42,
      outputTokens: 3,
      cachedReadTokens: 21,
      contextId: budgets[0]?.contextId,
      contextKind: 'child',
      parentContextId: budgets[0]?.parentContextId,
      agentId: '/root/first-tier-child',
    });
    expect(cacheDiagnostics[0]?.systemPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]?.toolSchemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]?.messagePrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(cacheDiagnostics)).not.toContain('inspect this repository');
  });

  it('propagates a typed capacity failure instead of returning success:false', async () => {
    await expect(runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        reasoningMode: 'off',
        maxIter: 1,
        compaction: { contextWindow: 1_000 },
        context: { repoIntelligenceMode: 'off' },
      },
      'hello',
    )).rejects.toBeInstanceOf(ContextCapacityError);

    expect(ContextDiagnosticsProvider.calls).toEqual([]);
  });
});
