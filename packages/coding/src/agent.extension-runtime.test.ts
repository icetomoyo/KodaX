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
} from '@kodax/ai';
import type { KodaXSessionData, KodaXSessionStorage } from '@kodax/agent';
import { KodaXBaseProvider } from '@kodax/ai';
import { clearRuntimeModelProviders } from '@kodax/ai';
import { runKodaX } from './agent.js';
import { createExtensionRuntime, getActiveExtensionRuntime } from './extensions/index.js';

const TEST_PROVIDER_NAME = 'feature-034-test-provider';
const TEST_PROVIDER_API_KEY_ENV = 'FEATURE_034_TEST_PROVIDER_API_KEY';

class Feature034TestProvider extends KodaXBaseProvider {
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-034-'));
    process.env[TEST_PROVIDER_API_KEY_ENV] = 'test-key';
    Feature034TestProvider.calls = [];
    Feature034ManagedProtocolProvider.calls = [];
  });

  afterEach(async () => {
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
        api.runtime.setThinkingLevel('deep');
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
      },
      'start feature 034',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('second pass complete');
    expect(Feature034TestProvider.calls).toHaveLength(2);
    expect(Feature034TestProvider.calls[0]?.tools.map((tool) => tool.name)).toEqual(['read']);
    expect(Feature034TestProvider.calls[0]?.streamOptions?.modelOverride).toBe('hooked-model');
    expect(Feature034TestProvider.calls[0]?.reasoning).toMatchObject({ mode: 'deep', depth: 'high' });
    expect(
      Feature034TestProvider.calls[1]?.messages.some(
        (message) => message.role === 'user'
          && typeof message.content === 'string'
          && message.content.includes('extension follow up'),
      ),
    ).toBe(true);

    await runtime.dispose();
  });

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
          context.setThinkingLevel('off');
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
      },
      'start feature 034 with no tools',
    );

    expect(result.success).toBe(true);
    expect(Feature034TestProvider.calls).toHaveLength(1);
    expect(Feature034TestProvider.calls[0]?.tools).toEqual([]);
    expect(Feature034TestProvider.calls[0]?.reasoning).toMatchObject({
      enabled: false,
      mode: 'off',
      depth: 'off',
    });

    await runtime.dispose();
  });

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
  });

  it('restores the previously active runtime when startup fails', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const previousRuntime = createExtensionRuntime().activate();
    const requestedRuntime = createExtensionRuntime();

    await expect(
      runKodaX(
        {
          provider: 'anthropic',
          extensionRuntime: requestedRuntime,
        },
        'this should fail early',
      ),
    ).rejects.toThrow('ANTHROPIC_API_KEY not set');

    expect(getActiveExtensionRuntime()).toBe(previousRuntime);

    await previousRuntime.dispose();
    await requestedRuntime.dispose();
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
  });

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
    expect(toolNames).not.toContain('impact_estimate');

    await runtime.dispose();
  });

  it('captures hidden managed protocol tool payloads without surfacing protocol tool blocks in messages', async () => {
    const extensionPath = path.join(tempDir, 'feature-034-managed-protocol.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerModelProvider({
          name: '${TEST_PROVIDER_NAME}',
          factory: () => new (globalThis.__feature034ManagedProtocolProviderClass)(),
        });
      }`,
      'utf8',
    );

    (globalThis as typeof globalThis & {
      __feature034ManagedProtocolProviderClass?: typeof Feature034ManagedProtocolProvider;
    }).__feature034ManagedProtocolProviderClass = Feature034ManagedProtocolProvider;
    Feature034ManagedProtocolProvider.calls = [];

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    const result = await runKodaX(
      {
        provider: TEST_PROVIDER_NAME,
        extensionRuntime: runtime,
        context: {
          managedProtocolEmission: {
            enabled: true,
            role: 'evaluator',
          },
        },
      },
      'run managed evaluator with hidden protocol tool',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Structured evaluator answer.');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
    const toolNames = Feature034ManagedProtocolProvider.calls[0]?.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain('emit_managed_protocol');
    const assistantMessages = result.messages.filter((message) => message.role === 'assistant');
    expect(
      assistantMessages.some((message) =>
        Array.isArray(message.content)
        && message.content.some((block) => block.type === 'tool_use' && block.name === 'emit_managed_protocol'),
      ),
    ).toBe(false);

    await runtime.dispose();
  });
});
