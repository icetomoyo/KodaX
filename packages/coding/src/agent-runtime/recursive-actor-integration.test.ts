import {
  _resetMessageQueueForTests,
} from '@kodax-ai/agent';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXLiveEventMeta,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';
import type { RuntimeContextBudgetSnapshot } from './context-budget.js';
import { CodingActorSession } from './actor-runtime.js';
import { allowAll } from './permission-gate.js';

const PROVIDER_NAME = 'recursive-actor-integration-provider';
const API_KEY_ENV = 'RECURSIVE_ACTOR_INTEGRATION_PROVIDER_API_KEY';
const PARENT_OBJECTIVE = 'PARENT_RECURSIVE_OBJECTIVE';
const GRANDCHILD_OBJECTIVE = 'GRANDCHILD_RECURSIVE_OBJECTIVE';
const GRANDCHILD_RESULT = 'GRANDCHILD_RECURSIVE_RESULT';
const PARENT_RESULT = 'PARENT_INTEGRATED_GRANDCHILD_RESULT';

interface WireCall {
  readonly actor: 'parent' | 'grandchild';
  readonly transcript: string;
  readonly toolNames: readonly string[];
  readonly promptCacheKey?: string;
  readonly transportSessionId?: string;
}

let releaseGrandchild: (() => void) | undefined;
let grandchildGate: Promise<void> = Promise.resolve();

class RecursiveActorProvider extends KodaXBaseProvider {
  static calls: WireCall[] = [];
  static parentCalls = 0;

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'recursive-actor-model',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
    contextWindow: 64_000,
    maxOutputTokens: 2_048,
  };

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    const transcript = JSON.stringify(messages);
    const firstUserMessage = messages.find((message) => message.role === 'user');
    const actor = JSON.stringify(firstUserMessage?.content).includes(GRANDCHILD_OBJECTIVE)
      ? 'grandchild'
      : 'parent';
    RecursiveActorProvider.calls.push({
      actor,
      transcript,
      toolNames: tools.map((tool) => tool.name),
      promptCacheKey: streamOptions?.promptCacheKey,
      transportSessionId: streamOptions?.sessionId,
    });

    if (actor === 'grandchild') {
      await grandchildGate;
      return textResult(GRANDCHILD_RESULT);
    }

    RecursiveActorProvider.parentCalls += 1;
    if (RecursiveActorProvider.parentCalls === 1) {
      return toolResult('spawn-grandchild', 'spawn_agent', {
        task_name: 'grandchild',
        objective: GRANDCHILD_OBJECTIVE,
        read_only: true,
      });
    }
    if (RecursiveActorProvider.parentCalls === 2) {
      releaseGrandchild?.();
      return toolResult('wait-grandchild', 'wait_agent', {
        timeout_ms: 10_000,
      });
    }
    if (RecursiveActorProvider.parentCalls === 3) {
      if (!transcript.includes('mailbox')) {
        throw new Error('Parent wait_agent call did not wake on the grandchild mailbox.');
      }
      return toolResult('read-grandchild', 'agent_output', {
        target: '/root/parent/grandchild',
      });
    }
    if (
      !transcript.includes('/root/parent/grandchild')
      || !transcript.includes(GRANDCHILD_RESULT)
    ) {
      throw new Error('Parent provider call did not receive the grandchild output.');
    }
    return textResult(PARENT_RESULT);
  }
}

function textResult(text: string): KodaXStreamResult {
  return {
    textBlocks: [{ type: 'text', text }],
    toolBlocks: [],
    thinkingBlocks: [],
    stopReason: 'end_turn',
  };
}

function toolResult(
  id: string,
  name: string,
  input: Record<string, unknown>,
): KodaXStreamResult {
  return {
    textBlocks: [],
    toolBlocks: [{ type: 'tool_use', id, name, input }],
    thinkingBlocks: [],
    stopReason: 'tool_use',
  };
}

describe('recursive Runtime Actor integration', { timeout: 30_000 }, () => {
  let actorSession: CodingActorSession | undefined;

  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    RecursiveActorProvider.calls = [];
    RecursiveActorProvider.parentCalls = 0;
    grandchildGate = new Promise<void>((resolve) => {
      releaseGrandchild = resolve;
    });
    _resetMessageQueueForTests();
    registerModelProvider(PROVIDER_NAME, () => new RecursiveActorProvider());
  });

  afterEach(async () => {
    releaseGrandchild?.();
    releaseGrandchild = undefined;
    clearRuntimeModelProviders();
    delete process.env[API_KEY_ENV];
    _resetMessageQueueForTests();
    await actorSession?.close('test complete');
    actorSession = undefined;
  });

  it('executes child -> spawn_agent -> grandchild through the production chain', async () => {
    const sessionId = 'recursive-actor-integration';
    const budgets: Array<
      RuntimeContextBudgetSnapshot & Partial<KodaXLiveEventMeta>
    > = [];
    actorSession = new CodingActorSession({ sessionId });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      sessionId,
      gitRoot: process.cwd(),
      executionCwd: process.cwd(),
      actorHost: actorSession,
      parentAgentConfig: {
        provider: PROVIDER_NAME,
        reasoningMode: 'off',
        repoIntelligenceMode: 'off',
        contextDiagnostics: true,
      },
      parentEvents: {
        beforeToolExecute: allowAll,
        onContextBudgetSnapshot: (event) => budgets.push(event),
      },
    };
    const options: KodaXOptions = {
      provider: PROVIDER_NAME,
      reasoningMode: 'off',
      events: { beforeToolExecute: allowAll },
      context: {
        gitRoot: process.cwd(),
        executionCwd: process.cwd(),
        repoIntelligenceMode: 'off',
        contextDiagnostics: true,
      },
    };
    const root = actorSession.attach(ctx, options);
    ctx.actorControl = root;

    const parent = await root.spawn({
      taskName: 'parent',
      objective: PARENT_OBJECTIVE,
      capabilities: { filesystem: 'read' },
    });
    await vi.waitFor(() => {
      expect(root.output(parent.actorPath, parent.turnId).state).not.toBe('running');
    }, { timeout: 20_000 });

    const parentCalls = RecursiveActorProvider.calls.filter((call) => call.actor === 'parent');
    const grandchildCalls = RecursiveActorProvider.calls.filter(
      (call) => call.actor === 'grandchild',
    );
    expect(parentCalls[0]?.toolNames).toContain('spawn_agent');
    expect(parentCalls[0]?.toolNames).not.toContain('run_workflow');
    expect(parentCalls[0]?.toolNames).not.toContain('emit_managed_protocol');
    expect(parentCalls[0]?.toolNames).not.toContain('list_dispatchable_agents');
    expect(parentCalls[0]?.toolNames).toContain('wait_agent');
    expect(parentCalls[0]?.toolNames).toContain('agent_output');
    expect(grandchildCalls).toHaveLength(1);
    expect(new Set(parentCalls.map((call) => call.promptCacheKey)).size).toBe(1);
    expect(parentCalls[0]?.promptCacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(grandchildCalls[0]?.promptCacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(grandchildCalls[0]?.promptCacheKey).not.toBe(parentCalls[0]?.promptCacheKey);
    expect([...parentCalls, ...grandchildCalls].every(
      (call) => call.transportSessionId === undefined,
    )).toBe(true);
    expect(root.list().actors.map((actor) => actor.path)).toContain(
      '/root/parent/grandchild',
    );
    expect(budgets.map((budget) => budget.agentId)).toEqual(expect.arrayContaining([
      '/root/parent',
      '/root/parent/grandchild',
    ]));
    const parentBudget = budgets.find((budget) => budget.agentId === '/root/parent');
    const grandchildBudget = budgets.find(
      (budget) => budget.agentId === '/root/parent/grandchild',
    );
    expect(parentBudget).toMatchObject({
      contextId: `${sessionId}/agent/${encodeURIComponent('/root/parent')}`,
      parentContextId: sessionId,
    });
    expect(parentBudget?.sessionId).not.toBe(sessionId);
    expect(grandchildBudget).toMatchObject({
      contextId: `${sessionId}/agent/${encodeURIComponent('/root/parent/grandchild')}`,
      parentContextId: parentBudget?.contextId,
    });
    expect(grandchildBudget?.sessionId).not.toBe(sessionId);
    expect(parentCalls.at(-1)?.transcript).toContain('/root/parent/grandchild');
    expect(parentCalls.at(-1)?.transcript).toContain(GRANDCHILD_RESULT);
    const parentOutput = root.output(parent.actorPath, parent.turnId);
    expect(parentOutput, parentOutput.error).toMatchObject({
      state: 'completed',
      output: PARENT_RESULT,
    });

    const followup = await root.followup(parent.actorPath, 'FOLLOWUP_OBJECTIVE');
    await vi.waitFor(() => {
      expect(root.output(parent.actorPath, followup.turnId).state).not.toBe('running');
    }, { timeout: 20_000 });
    const parentBudgets = budgets.filter((budget) => budget.agentId === '/root/parent');
    expect(new Set(parentBudgets.map((budget) => budget.contextId))).toEqual(
      new Set([parentBudget?.contextId]),
    );
    expect(new Set(parentBudgets.map((budget) => budget.sessionId)).size).toBeGreaterThan(1);
    const resumedParentCalls = RecursiveActorProvider.calls.filter(
      (call) => call.actor === 'parent',
    );
    expect(new Set(resumedParentCalls.map((call) => call.promptCacheKey))).toEqual(
      new Set([parentCalls[0]?.promptCacheKey]),
    );
  });
});
