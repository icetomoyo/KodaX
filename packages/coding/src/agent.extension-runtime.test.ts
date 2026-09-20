import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import type { KodaXSessionData, KodaXSessionStorage } from '@kodax-ai/agent';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import { clearRuntimeModelProviders } from '@kodax-ai/llm';
import { runKodaX } from './agent.js';
import { createExtensionRuntime, getActiveExtensionRuntime } from './extensions/index.js';
import { LEARNING_REVIEW_TOOL } from './learning-reviewer.js';
import { awaitLatestCodingMemoryReviewDrain } from './memory-runtime.js';

const TEST_PROVIDER_NAME = 'feature-034-test-provider';
const TEST_PROVIDER_API_KEY_ENV = 'FEATURE_034_TEST_PROVIDER_API_KEY';

class Feature034TestProvider extends KodaXBaseProvider {
  static beforeReview: (() => Promise<void>) | undefined;
  static reviewsInFlight = 0;
  static completedReviews = 0;
  static calls: Array<{
    messages: KodaXMessage[];
    tools: KodaXToolDefinition[];
    reasoning?: boolean | KodaXReasoningRequest;
    streamOptions?: KodaXProviderStreamOptions;
  }> = [];

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'baseline-model',
    supportsThinking: true,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    _system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    if (tools.some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) {
      Feature034TestProvider.reviewsInFlight += 1;
      try {
        await Feature034TestProvider.beforeReview?.();
        Feature034TestProvider.completedReviews += 1;
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: 'learning-review', name: LEARNING_REVIEW_TOOL.name,
          input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } },
        }] };
      } finally { Feature034TestProvider.reviewsInFlight -= 1; }
    }
    Feature034TestProvider.calls.push({
      messages,
      tools,
      reasoning,
      streamOptions,
    });

    const lastMessage = messages[messages.length - 1];
    const text = lastMessage?.role === 'user' && typeof lastMessage.content === 'string' && lastMessage.content.includes('extension follow up')
      ? 'second pass complete'
      : 'first pass pending';

    return {
      textBlocks: [{ type: 'text', text }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    };
  }
}

class Feature034ParallelProvider extends KodaXBaseProvider {
  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'baseline-model',
    supportsThinking: true,
  };

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    const lastMessage = messages[messages.length - 1];
    const hasToolResults = lastMessage?.role === 'user'
      && Array.isArray(lastMessage.content)
      && lastMessage.content.some((block) => block.type === 'tool_result');

    if (hasToolResults) {
      return {
        textBlocks: [{ type: 'text', text: 'parallel tools complete' }],
        toolBlocks: [],
        thinkingBlocks: [],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      };
    }

    return {
      textBlocks: [],
      toolBlocks: [
        { type: 'tool_use', id: 'tool-a', name: 'slow_tool', input: { label: 'a', delayMs: 60 } },
        { type: 'tool_use', id: 'tool-b', name: 'slow_tool', input: { label: 'b', delayMs: 60 } },
      ],
      thinkingBlocks: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    };
  }
}

class Feature034ManagedProtocolProvider extends KodaXBaseProvider {
  static calls: Array<{
    messages: KodaXMessage[];
    tools: KodaXToolDefinition[];
  }> = [];

  readonly name = TEST_PROVIDER_NAME;
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: TEST_PROVIDER_API_KEY_ENV,
    model: 'baseline-model',
    supportsThinking: true,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    Feature034ManagedProtocolProvider.calls.push({ messages, tools });
    return {
      textBlocks: [{ type: 'text', text: 'Structured evaluator answer.' }],
      toolBlocks: [
        {
          type: 'tool_use',
          id: 'protocol-1',
          name: 'emit_managed_protocol',
          input: {
            role: 'evaluator',
            payload: {
              status: 'accept',
              reason: 'Protocol payload emitted through the hidden tool.',
              followups: ['none'],
            },
          },
        },
      ],
      thinkingBlocks: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    };
  }
}

describe('runKodaX extension runtime integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    expect(Feature034TestProvider.reviewsInFlight).toBe(0);
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-034-'));
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    Feature034TestProvider.calls = [];
    Feature034TestProvider.beforeReview = undefined;
    Feature034TestProvider.completedReviews = 0;
    Feature034ManagedProtocolProvider.calls = [];
  });

  afterEach(async () => {
    // Persisted foreground runs leave a real review drain behind. Keep its
    // provider/environment alive until settlement instead of leaking it into
    // the next test's foreground call snapshot.
    await awaitLatestCodingMemoryReviewDrain(5_000);
    expect(Feature034TestProvider.reviewsInFlight).toBe(0);
    clearRuntimeModelProviders();
    delete process.env[TEST_PROVIDER_API_KEY_ENV];
    delete (globalThis as typeof globalThis & {
      __feature034ProviderClass?: typeof Feature034TestProvider;
      __feature034ParallelProviderClass?: typeof Feature034ParallelProvider;
      __feature034ManagedProtocolProviderClass?: typeof Feature034ManagedProtocolProvider;
      __feature034ParallelMetrics?: { active: number; max: number };
    }).__feature034ProviderClass;
    delete (globalThis as typeof globalThis & {
      __feature034ParallelProviderClass?: typeof Feature034ParallelProvider;
      __feature034ManagedProtocolProviderClass?: typeof Feature034ManagedProtocolProvider;
      __feature034ParallelMetrics?: { active: number; max: number };
    }).__feature034ParallelProviderClass;
    delete (globalThis as typeof globalThis & {
      __feature034ManagedProtocolProviderClass?: typeof Feature034ManagedProtocolProvider;
    }).__feature034ManagedProtocolProviderClass;
    delete (globalThis as typeof globalThis & {
      __feature034ParallelMetrics?: { active: number; max: number };
    }).__feature034ParallelMetrics;
    const runtime = getActiveExtensionRuntime();
    if (runtime) {
      await runtime.dispose();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  // Every runKodaX integration it-block below passes an explicit 30_000ms
  // timeout (vitest default is 5_000). A full extension-runtime + runKodaX run
  // is ~3s single but can exceed 5s under full-suite parallel scheduling — and a
  // 5s timeout aborts the it-block WITHOUT halting the underlying async runKodaX,
  // which then keeps writing the shared static `Feature034TestProvider.calls`
  // and pollutes the next test (shows up as `calls` length 2 instead of 1).
  it('lets extensions drive tools, model selection, thinking level, and queued follow-ups', async () => {
    const extensionPath = path.join(tempDir, 'feature-034-extension.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerModelProvider({
          name: '${TEST_PROVIDER_NAME}',
          factory: () => new (globalThis.__feature034ProviderClass)(),
        });
        api.runtime.setActiveTools(['read']);
        api.runtime.setModelSelection({ model: 'extension-default-model' });
        api.runtime.setThinkingLevel('high');
        api.hook('provider:before', (context) => {
          context.replaceModel('hooked-model');
        });
        api.hook('turn:settle', (context) => {
          if (!api.runtime.getSessionState('queued')) {
            api.runtime.setSessionState('queued', true);
            context.queueUserMessage('extension follow up');
          }
        });
      }`,
      'utf8',
    );

    (globalThis as typeof globalThis & {
      __feature034ProviderClass?: typeof Feature034TestProvider;
    }).__feature034ProviderClass = Feature034TestProvider;

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        extensionRuntime: runtime,
        reasoningMode: 'off',
      },
      'start feature 034',
    );
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('second pass complete');
    expect(Feature034TestProvider.calls).toHaveLength(2);
    expect(Feature034TestProvider.calls[0]?.tools.map((tool) => tool.name)).toEqual(['read']);
    expect(Feature034TestProvider.calls[0]?.streamOptions?.modelOverride).toBe('hooked-model');
    expect(Feature034TestProvider.calls[0]?.reasoning).toMatchObject({ enabled: true, effort: 'high' });
    expect(
      Feature034TestProvider.calls[1]?.messages.some(
        (message) => message.role === 'user'
          && typeof message.content === 'string'
          && message.content.includes('extension follow up'),
      ),
    ).toBe(true);

    await runtime.dispose();
  }, 30_000);

  it('respects empty active tool sets and provider hook reasoning overrides', async () => {
    const extensionPath = path.join(tempDir, 'feature-034-empty-tools.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerModelProvider({
          name: '${TEST_PROVIDER_NAME}',
          factory: () => new (globalThis.__feature034ProviderClass)(),
        });
        api.runtime.setActiveTools([]);
        api.hook('provider:before', (context) => {
          context.setThinkingLevel('none');
        });
      }`,
      'utf8',
    );

    (globalThis as typeof globalThis & {
      __feature034ProviderClass?: typeof Feature034TestProvider;
    }).__feature034ProviderClass = Feature034TestProvider;

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        extensionRuntime: runtime,
        reasoningMode: 'off',
      },
      'start feature 034 with no tools',
    );
    expect(result.success).toBe(true);
    expect(Feature034TestProvider.calls).toHaveLength(1);
    expect(Feature034TestProvider.calls[0]?.tools).toEqual([]);
    expect(Feature034TestProvider.calls[0]?.reasoning).toMatchObject({
      enabled: false,
      effort: 'none',
    });

    await runtime.dispose();
  }, 30_000);

  it('persists extension session state and records across session resume', async () => {
    const extensionPath = path.join(tempDir, 'feature-034-persisted-runtime.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerModelProvider({
          name: '${TEST_PROVIDER_NAME}',
          factory: () => new (globalThis.__feature034ProviderClass)(),
        });
        api.hook('session:hydrate', (context) => {
          const visits = (context.getState('visits') ?? 0) + 1;
          context.setState('visits', visits);
          context.appendRecord('hydrate', { visits }, { dedupeKey: 'latest' });
        });
        api.hook('provider:before', (context) => {
          if ((api.runtime.getSessionState('visits') ?? 0) > 1) {
            context.replaceModel('resumed-model');
          }
        });
        api.hook('turn:settle', (context) => {
          api.runtime.appendSessionRecord('turn', { lastText: context.lastText });
        });
      }`,
      'utf8',
    );

    (globalThis as typeof globalThis & {
      __feature034ProviderClass?: typeof Feature034TestProvider;
    }).__feature034ProviderClass = Feature034TestProvider;

    const storage: KodaXSessionStorage & { snapshots: Map<string, KodaXSessionData> } = {
      snapshots: new Map<string, KodaXSessionData>(),
      async save(id: string, data: KodaXSessionData) {
        this.snapshots.set(id, structuredClone(data));
      },
      async load(id: string): Promise<KodaXSessionData | null> {
        return structuredClone(this.snapshots.get(id) ?? null);
      },
    };

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    Feature034TestProvider.calls = [];
    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        extensionRuntime: runtime,
        session: {
          id: 'feature-034-persisted-session',
          storage,
        },
      },
      'first persisted run',
    );

    const extensionId = `api:extension:${extensionPath}`;
    const firstSaved = storage.snapshots.get('feature-034-persisted-session') as {
      extensionState?: Record<string, Record<string, unknown>>;
      extensionRecords?: Array<{ type: string; data?: Record<string, unknown> }>;
    };
    expect(firstSaved.extensionState?.[extensionId]?.visits).toBe(1);
    expect(firstSaved.extensionRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId,
          type: 'hydrate',
          data: { visits: 1 },
        }),
        expect.objectContaining({
          extensionId,
          type: 'turn',
          data: { lastText: 'first pass pending' },
        }),
      ]),
    );

    Feature034TestProvider.calls = [];
    await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        extensionRuntime: runtime,
        session: {
          id: 'feature-034-persisted-session',
          storage,
          resume: true,
        },
      },
      'second persisted run',
    );

    const secondSaved = storage.snapshots.get('feature-034-persisted-session') as {
      extensionState?: Record<string, Record<string, unknown>>;
      extensionRecords?: Array<{
        extensionId: string;
        type: string;
        data?: Record<string, unknown>;
        dedupeKey?: string;
      }>;
    };
    expect(secondSaved.extensionState?.[extensionId]?.visits).toBe(2);
    expect(secondSaved.extensionRecords?.filter((record) => record.type === 'hydrate')).toEqual([
      expect.objectContaining({
        extensionId,
        type: 'hydrate',
        dedupeKey: 'latest',
        data: { visits: 2 },
      }),
    ]);
    expect(secondSaved.extensionRecords?.filter((record) => record.type === 'turn')).toHaveLength(2);
    expect(Feature034TestProvider.calls).toHaveLength(1);
    expect(Feature034TestProvider.calls[0]?.streamOptions?.modelOverride).toBe('resumed-model');

    await runtime.dispose();
  }, 30_000);

  it('restores the previously active runtime when startup fails', async () => {
    // Force the "provider not configured" startup failure by removing the key,
    // then restore it so the deletion does not leak to other tests sharing the
    // process env (this provider env is ambient in many sibling suites).
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const previousRuntime = createExtensionRuntime().activate();
    const requestedRuntime = createExtensionRuntime();

    try {
      await expect(
        runKodaX(
          {
            provider: 'anthropic',
            extensionRuntime: requestedRuntime,
          },
          'this should fail early',
        ),
      ).rejects.toThrow('Provider "anthropic" not configured. Set ANTHROPIC_API_KEY');

      expect(getActiveExtensionRuntime()).toBe(previousRuntime);
    } finally {
      if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      await previousRuntime.dispose();
      await requestedRuntime.dispose();
    }
  });

  it('runs independent extension tools concurrently when parallel mode is enabled', async () => {
    const extensionPath = path.join(tempDir, 'feature-034-parallel-tools.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerModelProvider({
          name: '${TEST_PROVIDER_NAME}',
          factory: () => new (globalThis.__feature034ParallelProviderClass)(),
        });
        api.registerTool({
          name: 'slow_tool',
          description: 'Delay briefly and report concurrency',
          input_schema: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              delayMs: { type: 'number' }
            },
            required: ['label', 'delayMs']
          },
          handler: async (input) => {
            const metrics = globalThis.__feature034ParallelMetrics;
            metrics.active += 1;
            metrics.max = Math.max(metrics.max, metrics.active);
            await new Promise((resolve) => setTimeout(resolve, Number(input.delayMs)));
            metrics.active -= 1;
            return String(input.label);
          }
        });
      }`,
      'utf8',
    );

    (globalThis as typeof globalThis & {
      __feature034ParallelProviderClass?: typeof Feature034ParallelProvider;
      __feature034ParallelMetrics?: { active: number; max: number };
    }).__feature034ParallelProviderClass = Feature034ParallelProvider;
    (globalThis as typeof globalThis & {
      __feature034ParallelMetrics?: { active: number; max: number };
    }).__feature034ParallelMetrics = { active: 0, max: 0 };

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        extensionRuntime: runtime,
      },
      'start feature 034 parallel tools',
    );
    const metrics = (globalThis as typeof globalThis & {
      __feature034ParallelMetrics?: { active: number; max: number };
    }).__feature034ParallelMetrics;

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('parallel tools complete');
    expect(metrics?.max).toBe(2);

    await runtime.dispose();
  }, 30_000);

  it('removes repo-intelligence working tools from the provider-visible tool list in off mode', async () => {
    const extensionPath = path.join(tempDir, 'feature-034-off-mode-tools.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerModelProvider({
          name: '${TEST_PROVIDER_NAME}',
          factory: () => new (globalThis.__feature034ProviderClass)(),
        });
      }`,
      'utf8',
    );

    (globalThis as typeof globalThis & {
      __feature034ProviderClass?: typeof Feature034TestProvider;
    }).__feature034ProviderClass = Feature034TestProvider;

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        extensionRuntime: runtime,
        context: {
          repoIntelligenceMode: 'off',
        },
      },
      'summarize this workspace',
    );

    expect(result.success).toBe(true);
    expect(Feature034TestProvider.calls).toHaveLength(1);
    const toolNames = Feature034TestProvider.calls[0]?.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('glob');
    expect(toolNames).not.toContain('repo_overview');
    expect(toolNames).not.toContain('changed_scope');
    expect(toolNames).not.toContain('changed_diff');
    expect(toolNames).not.toContain('changed_diff_bundle');
    expect(toolNames).not.toContain('module_context');
    expect(toolNames).not.toContain('semantic_lookup');
    expect(toolNames).not.toContain('impact_estimate');

    await runtime.dispose();
  }, 30_000);

  it('settles a delayed background review without polluting the next foreground call snapshot', async () => {
    let releaseReview: () => void = () => {};
    let startedReview: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseReview = resolve; });
    const started = new Promise<void>(resolve => { startedReview = resolve; });
    Feature034TestProvider.beforeReview = async () => { startedReview(); await gate; };
    const extensionPath = path.join(tempDir, 'late-review.mjs');
    await writeFile(extensionPath, `export default function(api) {
      api.registerModelProvider({ name: '${TEST_PROVIDER_NAME}',
        factory: () => new (globalThis.__feature034ProviderClass)() });
    }`);
    (globalThis as typeof globalThis & { __feature034ProviderClass?: typeof Feature034TestProvider })
      .__feature034ProviderClass = Feature034TestProvider;
    const snapshots = new Map<string, KodaXSessionData>();
    const storage: KodaXSessionStorage = {
      async save(id, data) { snapshots.set(id, structuredClone(data)); },
      async load(id) { return structuredClone(snapshots.get(id) ?? null); },
    };
    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);
    try {
      // The Map isolates Session data; the review inbox also needs its own home.
      await runKodaX({ provider: TEST_PROVIDER_NAME, extensionRuntime: runtime,
        context: { executionCwd: tempDir, configHome: path.join(tempDir, '.kodax') },
        session: { id: path.basename(tempDir), storage } }, 'A persisted foreground request');
      await started;
      expect(Feature034TestProvider.calls).toHaveLength(1);
      // Reproduce the next beforeEach reset while the previous review is late.
      Feature034TestProvider.calls = [];
      let drained = false;
      const draining = awaitLatestCodingMemoryReviewDrain(5_000).then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(Feature034TestProvider.reviewsInFlight).toBe(1);
      releaseReview();
      await draining;
      expect(Feature034TestProvider.reviewsInFlight).toBe(0);
      expect(Feature034TestProvider.completedReviews).toBe(1);
      expect(Feature034TestProvider.calls).toHaveLength(0);
    } finally {
      releaseReview();
      await awaitLatestCodingMemoryReviewDrain(5_000);
      await runtime.dispose();
    }
  }, 30_000);

  // FEATURE_193 (v0.7.43) deep V1 cleanup: the "captures hidden managed
  // protocol tool payloads" integration test was tied to the
  // `emit_managed_protocol` tool. That tool has been physically removed
  // from the registry alongside the V1 chain retirement, so the test no
  // longer has a hidden-protocol surface to capture. Sidecar Verifier
  // (FEATURE_184) emits verdicts via the dedicated `emit_verdict` tool on
  // a separate AMA path covered by `verifier-recorder-bridge.test.ts`.
});
