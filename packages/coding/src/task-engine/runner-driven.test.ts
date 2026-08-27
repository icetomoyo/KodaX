/**
 * Runner-driven path tests — FEATURE_084 Shard 5a (v0.7.26).
 *
 * Covers:
 *   - Env flag detection (`KODAX_MANAGED_TASK_RUNTIME=runner`)
 *   - Agent construction (Scout with emit + core tools, no handoffs for H0)
 *   - LLM adapter: system split, tool serialization, RunnerLlmResult shape
 *   - End-to-end Scout H0_DIRECT flow via mocked provider stream
 *   - KodaXResult shape: success + lastText + messages, no managedTask
 *     (matches SA fast-path semantics for Shard 5a; Shard 5b populates
 *     managedTask when Generator/Evaluator enter the chain)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAssistantMessageFromLlmResult,
  ContextCapacityError,
  createAgentActorController,
  createMemoryControlPlane,
  createSessionLineage,
  getSessionMessageEntryId,
  getMessageQueue,
  listPendingEpisodeReviews,
  readLearningProposalStore,
  resolveActiveRootQueueRoute,
  resolveLearningProposalStore,
  type KodaXMemoryOutcomeDigest,
  type KodaXSessionData,
  type MemoryContextIdentity,
  type UnifiedLearningReviewModelInput,
} from '@kodax-ai/agent';
import {
  buildRunnerAgentChain,
  buildRunnerLlmAdapter,
  isRunnerDrivenRuntimeEnabled,
  runManagedTaskViaRunner,
  __runnerDrivenTestables,
} from './runner-driven.js';
import { createTodoStore } from './todo-store.js';
import {
  createTodoDriftReminderState,
  observeTodoDriftAfterToolResult,
} from './todo-drift-reminder.js';
import type { AgentTurnExecutor, RunnableTool } from '@kodax-ai/agent';
import type {
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type {
  KodaXEvents,
  KodaXOptions,
  KodaXPromptCacheDiagnosticEvent,
  KodaXToolEventMeta,
  KodaXToolExecutionContext,
} from '../types.js';
import { countTokens, estimateTokens } from '../tokenizer.js';
import { resolveContextTokenCount } from '../token-accounting.js';
import {
  estimateToolSchemaTokens,
  type RuntimeContextBudgetSnapshot,
} from '../agent-runtime/context-budget.js';
import { hashProviderVisibleMessages } from '../agent-runtime/prompt-cache-diagnostics.js';
import { CodingActorSession } from '../agent-runtime/actor-runtime.js';
import { buildFallbackRoutingDecision, type ReasoningPlan } from '../reasoning.js';
import { readTransientTextArtifact } from '../transient-text-artifacts.js';
import { createUserInputDegradationCache } from '../capacity-recovery.js';

// Shared scratch directory for `managedTaskWorkspaceDir` so the
// Shard 6d-h artifact writes (contract.json / managed-task.json /
// result.json / ... ) land inside a temp folder instead of polluting
// the repo's cwd with `.agent/managed-tasks/` entries.
let testWorkspaceRoot: string;
const testActorControllers: Array<Awaited<ReturnType<typeof createAgentActorController>>> = [];

beforeAll(async () => {
  testWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-driven-'));
});

afterAll(async () => {
  if (testWorkspaceRoot) {
    await rm(testWorkspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => undefined);
  }
});

afterEach(async () => {
  await Promise.all(testActorControllers.splice(0).map((controller) =>
    controller.shutdown('test complete')));
});

function makeCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
  };
}

function makeOptions(): KodaXOptions {
  return {
    provider: 'anthropic',
    context: {
      gitRoot: process.cwd(),
      executionCwd: process.cwd(),
      managedTaskWorkspaceDir: testWorkspaceRoot,
      // Shard 6d-i: disable task-scoped repo-intelligence capture in
      // unit tests — the capture walks the real repo (cwd is the kodax
      // monorepo during test runs), which would otherwise add tens of
      // seconds per test. Production callers keep the default auto mode.
      repoIntelligenceMode: 'off',
    },
    events: {},
  } as KodaXOptions;
}

describe('managed runner queue routing', () => {
  it('advertises its session root during execution and releases it on error', async () => {
    const observedRoutes: Array<string | undefined> = [];
    const failure = new Error('queue-route-test-stop');
    const options: KodaXOptions = {
      ...makeOptions(),
      session: { id: 'queue-route-session' },
    };

    await expect(runManagedTaskViaRunner(options, 'inspect route', async () => {
      observedRoutes.push(resolveActiveRootQueueRoute());
      throw failure;
    })).rejects.toBe(failure);

    expect(observedRoutes).toEqual(['actor:queue-route-session:/root']);
    expect(resolveActiveRootQueueRoute()).toBeUndefined();
  });

  it('durably records the initial Runtime prompt before provider execution', async () => {
    const sessionId = 'runtime-initial-durable-boundary';
    let stored: KodaXSessionData | null = null;
    const crash = new Error('simulated daemon crash after provider start');
    const save = vi.fn(async (_id: string, data: KodaXSessionData) => {
      stored = structuredClone(data);
    });

    await expect(runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: {
          id: sessionId,
          persistedByHost: false,
          storage: {
            load: vi.fn(async () => stored),
            save,
          },
        },
      },
      'INITIAL_PROMPT_DURABILITY_SENTINEL',
      async () => {
        expect(JSON.stringify(stored?.messages)).toContain(
          'INITIAL_PROMPT_DURABILITY_SENTINEL',
        );
        throw crash;
      },
    )).rejects.toBe(crash);

    expect(save).toHaveBeenCalled();
    expect(JSON.stringify(stored?.messages)).toContain(
      'INITIAL_PROMPT_DURABILITY_SENTINEL',
    );
  });

  it('does not report managed completion before the canonical Session commit', async () => {
    const sessionId = 'runtime-terminal-commit-order';
    let stored: KodaXSessionData | null = null;
    let releaseTerminalSave: (() => void) | undefined;
    let markTerminalSaveStarted: (() => void) | undefined;
    const terminalSaveStarted = new Promise<void>((resolve) => {
      markTerminalSaveStarted = resolve;
    });
    const terminalSaveGate = new Promise<void>((resolve) => {
      releaseTerminalSave = resolve;
    });
    const completedStatuses: string[] = [];
    const run = runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: {
          id: sessionId,
          persistedByHost: false,
          storage: {
            load: vi.fn(async () => stored),
            save: vi.fn(async (_id: string, data: KodaXSessionData) => {
              if (JSON.stringify(data.messages).includes('TERMINAL_COMMIT_ANSWER')) {
                markTerminalSaveStarted?.();
                await terminalSaveGate;
              }
              stored = structuredClone(data);
            }),
          },
        },
        events: {
          onManagedTaskStatus(status) {
            if (status.phase === 'completed') completedStatuses.push(status.phase);
          },
        },
      },
      'Complete after the durable boundary.',
      async () => ({
        textBlocks: [{ text: 'TERMINAL_COMMIT_ANSWER' }],
        toolBlocks: [],
      }),
    );

    await terminalSaveStarted;
    expect(completedStatuses).toEqual([]);
    releaseTerminalSave?.();
    await expect(run).resolves.toMatchObject({ success: true });
    expect(completedStatuses).toEqual(['completed']);
  });

  it('persists a completed turn and delivered queued prompt before the next Runtime turn runs', async () => {
    const sessionId = 'runtime-queued-durable-boundaries';
    const queueAgentId = `actor:${sessionId}:/root`;
    let stored: KodaXSessionData | null = null;
    let providerCall = 0;
    const crash = new Error('simulated daemon crash in queued turn');
    const completedSnapshots: KodaXSessionData[] = [];
    const deliveredSnapshots: KodaXSessionData[] = [];
    let deliveredEntryIds: Readonly<Record<string, string>> | undefined;
    let lineage: KodaXSessionData['lineage'];
    const save = vi.fn(async (_id: string, data: KodaXSessionData) => {
      lineage = createSessionLineage(data.messages, lineage);
      stored = structuredClone({ ...data, lineage });
    });

    try {
      await expect(runManagedTaskViaRunner(
        {
          ...makeOptions(),
          context: {
            ...makeOptions().context,
            interruptInput: {
              closeInputWindow() {},
              reopenInputWindow() {},
            },
          },
          session: {
            id: sessionId,
            persistedByHost: false,
            storage: {
              load: vi.fn(async () => stored),
              save,
            },
          },
          events: {
            onTurnCompleted() {
              if (stored !== null) completedSnapshots.push(structuredClone(stored));
            },
            onMidTurnUserMessages(_contents, meta) {
              if (stored !== null) deliveredSnapshots.push(structuredClone(stored));
              deliveredEntryIds = meta?.queuedMessageEntryIds;
            },
          },
        },
        'FIRST_RUNTIME_PROMPT',
        async () => {
          providerCall += 1;
          if (providerCall === 1) {
            getMessageQueue().enqueue({
              agentId: queueAgentId,
              priority: 'user',
              mode: 'prompt',
              content: 'QUEUED_RUNTIME_PROMPT',
            });
            return { textBlocks: [{ text: 'FIRST_RUNTIME_ANSWER' }], toolBlocks: [] };
          }

          const durableTranscript = JSON.stringify(stored?.messages);
          expect(durableTranscript).toContain('FIRST_RUNTIME_PROMPT');
          expect(durableTranscript).toContain('FIRST_RUNTIME_ANSWER');
          expect(durableTranscript).toContain('QUEUED_RUNTIME_PROMPT');
          throw crash;
        },
      )).rejects.toBe(crash);

      expect(completedSnapshots).toHaveLength(1);
      expect(JSON.stringify(completedSnapshots[0]?.messages)).toContain(
        'FIRST_RUNTIME_ANSWER',
      );
      expect(deliveredSnapshots).toHaveLength(1);
      expect(JSON.stringify(deliveredSnapshots[0]?.messages)).toContain(
        'QUEUED_RUNTIME_PROMPT',
      );
      const queuedEntry = stored?.lineage?.entries.find((entry) =>
        entry.type === 'message'
        && JSON.stringify(entry.message.content).includes('QUEUED_RUNTIME_PROMPT'));
      expect(Object.keys(deliveredEntryIds ?? {})).toHaveLength(1);
      expect(Object.values(deliveredEntryIds ?? {})).toEqual([queuedEntry?.id]);
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      });
    }
  });

  it('persists the complete canonical transcript after a normal Runtime multi-turn run', async () => {
    const sessionId = 'runtime-normal-multi-turn-persistence';
    const queueAgentId = `actor:${sessionId}:/root`;
    let stored: KodaXSessionData | null = null;
    let providerCall = 0;

    try {
      await runManagedTaskViaRunner(
        {
          ...makeOptions(),
          context: {
            ...makeOptions().context,
            interruptInput: {
              closeInputWindow() {},
              reopenInputWindow() {},
            },
          },
          session: {
            id: sessionId,
            persistedByHost: false,
            storage: {
              load: vi.fn(async () => stored),
              save: vi.fn(async (_id: string, data: KodaXSessionData) => {
                stored = structuredClone(data);
              }),
            },
          },
        },
        'NORMAL_FIRST_PROMPT',
        async () => {
          providerCall += 1;
          if (providerCall === 1) {
            getMessageQueue().enqueue({
              agentId: queueAgentId,
              priority: 'user',
              mode: 'prompt',
              content: 'NORMAL_QUEUED_PROMPT',
            });
            return { textBlocks: [{ text: 'NORMAL_FIRST_ANSWER' }], toolBlocks: [] };
          }
          return { textBlocks: [{ text: 'NORMAL_SECOND_ANSWER' }], toolBlocks: [] };
        },
      );

      const durableTranscript = JSON.stringify(stored?.messages);
      expect(durableTranscript).toContain('NORMAL_FIRST_PROMPT');
      expect(durableTranscript).toContain('NORMAL_FIRST_ANSWER');
      expect(durableTranscript).toContain('NORMAL_QUEUED_PROMPT');
      expect(durableTranscript).toContain('NORMAL_SECOND_ANSWER');
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      });
    }
  }, 60_000);

  it('does not start a Runtime turn when its initial durable write fails', async () => {
    const failure = new Error('canonical storage unavailable');
    const providerCall = vi.fn(async () => ({
      textBlocks: [{ text: 'unreachable' }],
      toolBlocks: [],
    }));
    const started = vi.fn();
    const completed = vi.fn();

    await expect(runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: {
          id: 'runtime-required-save-failure',
          persistedByHost: false,
          storage: {
            load: vi.fn(async () => null),
            save: vi.fn().mockRejectedValue(failure),
          },
        },
        events: {
          onTurnStarted: started,
          onTurnCompleted: completed,
        },
      },
      'must be durable before execution',
      providerCall,
    )).rejects.toBe(failure);

    expect(providerCall).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it('does not start or deliver a queued Runtime turn when its prompt snapshot fails', async () => {
    const sessionId = 'runtime-queued-save-failure';
    const queueAgentId = `actor:${sessionId}:/root`;
    const failure = new Error('queued canonical boundary unavailable');
    let stored: KodaXSessionData | null = null;
    let saveCount = 0;
    const started = vi.fn();
    const completed = vi.fn();
    const delivered = vi.fn();
    const providerCall = vi.fn(async () => {
      getMessageQueue().enqueue({
        agentId: queueAgentId,
        priority: 'user',
        mode: 'prompt',
        content: 'QUEUED_PROMPT_WITH_FAILED_SAVE',
      });
      return { textBlocks: [{ text: 'DURABLE_FIRST_ANSWER' }], toolBlocks: [] };
    });

    try {
      await expect(runManagedTaskViaRunner(
        {
          ...makeOptions(),
          context: {
            ...makeOptions().context,
            interruptInput: {
              closeInputWindow() {},
              reopenInputWindow() {},
            },
          },
          session: {
            id: sessionId,
            persistedByHost: false,
            storage: {
              load: vi.fn(async () => stored),
              save: vi.fn(async (_id: string, data: KodaXSessionData) => {
                saveCount += 1;
                if (saveCount === 3) throw failure;
                stored = structuredClone(data);
              }),
            },
          },
          events: {
            onTurnStarted: started,
            onTurnCompleted: completed,
            onMidTurnUserMessages: delivered,
          },
        },
        'DURABLE_FIRST_PROMPT',
        providerCall,
      )).rejects.toBe(failure);

      expect(started).toHaveBeenCalledTimes(1);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(delivered).not.toHaveBeenCalled();
      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(stored?.messages)).toContain('DURABLE_FIRST_ANSWER');
      expect(JSON.stringify(stored?.messages)).not.toContain(
        'QUEUED_PROMPT_WITH_FAILED_SAVE',
      );
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      });
    }
  });

  it('keeps a queued prompt canonical and stops before provider execution when delivery persistence fails', async () => {
    const sessionId = 'runtime-delivery-journal-failure';
    const queueAgentId = `actor:${sessionId}:/root`;
    const failure = new Error('run.input.delivered journal unavailable');
    let stored: KodaXSessionData | null = null;
    const started = vi.fn();
    const completed = vi.fn();
    const failed = vi.fn();
    let providerCalls = 0;

    try {
      await expect(runManagedTaskViaRunner(
        {
          ...makeOptions(),
          context: {
            ...makeOptions().context,
            interruptInput: {
              closeInputWindow() {},
              reopenInputWindow() {},
            },
          },
          session: {
            id: sessionId,
            persistedByHost: false,
            storage: {
              load: vi.fn(async () => stored),
              save: vi.fn(async (_id: string, data: KodaXSessionData) => {
                stored = structuredClone(data);
              }),
            },
          },
          events: {
            onTurnStarted: started,
            onTurnCompleted: completed,
            onTurnFailed: failed,
            onMidTurnUserMessages: () => {
              throw failure;
            },
          },
        },
        'DELIVERY_FAILURE_FIRST_PROMPT',
        async () => {
          providerCalls += 1;
          if (providerCalls > 1) {
            return { textBlocks: [{ text: 'unreachable' }], toolBlocks: [] };
          }
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'ACCEPTED_BUT_NOT_DELIVERED_PROMPT',
          });
          return { textBlocks: [{ text: 'DELIVERY_FAILURE_FIRST_ANSWER' }], toolBlocks: [] };
        },
      )).rejects.toBe(failure);

      expect(providerCalls).toBe(1);
      expect(started).toHaveBeenCalledTimes(2);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(stored?.messages)).toContain(
        'ACCEPTED_BUT_NOT_DELIVERED_PROMPT',
      );
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      });
    }
  });

  it('delivers an interrupt accepted during the final no-tool request before completing the run', async () => {
    const sessionId = 'terminal-interrupt-session';
    const queueAgentId = `actor:${sessionId}:/root`;
    let inputWindowOpen = true;
    let turn = 0;
    const delivered: Array<{
      contents: readonly string[];
      ids: readonly string[];
      entryIds?: Readonly<Record<string, string>>;
    }> = [];
    let lineage: KodaXSessionData['lineage'];
    const options: KodaXOptions = {
      ...makeOptions(),
      session: {
        id: sessionId,
        storage: {
          load: vi.fn(async () => null),
          save: vi.fn(async (_id: string, data: KodaXSessionData) => {
            lineage = createSessionLineage(data.messages, lineage);
          }),
        },
      },
      context: {
        ...makeOptions().context,
        interruptInput: {
          closeInputWindow() {
            inputWindowOpen = false;
          },
          reopenInputWindow() {
            inputWindowOpen = true;
          },
        },
      },
      events: {
        onMidTurnUserMessages(contents, meta) {
          delivered.push({
            contents,
            ids: meta?.queuedMessageIds ?? [],
            entryIds: meta?.queuedMessageEntryIds,
          });
        },
      },
    };

    try {
      const result = await runManagedTaskViaRunner(
        options,
        'first prompt',
        async (transcript) => {
          turn += 1;
          expect(inputWindowOpen).toBe(true);
          if (turn === 1) {
            getMessageQueue().enqueue({
              agentId: queueAgentId,
              priority: 'user',
              mode: 'prompt',
              content: 'interrupt accepted during the final request',
            });
            return {
              textBlocks: [{ text: 'first answer' }],
              toolBlocks: [],
            };
          }
          expect(transcript.at(-1)).toMatchObject({
            role: 'user',
          });
          expect(JSON.stringify(transcript.at(-1)?.content)).toContain(
            'interrupt accepted during the final request',
          );
          return {
            textBlocks: [{ text: 'follow-up answer' }],
            toolBlocks: [],
          };
        },
      );

      expect(turn).toBe(2);
      expect(result.lastText).toBe('follow-up answer');
      expect(delivered).toEqual([{
        contents: ['interrupt accepted during the final request'],
        ids: [expect.any(String)],
        entryIds: expect.any(Object),
      }]);
      const deliveredId = delivered[0]?.ids[0];
      expect(Object.keys(delivered[0]?.entryIds ?? {})).toEqual([deliveredId]);
      expect(deliveredId === undefined
        ? undefined
        : delivered[0]?.entryIds?.[deliveredId]).toBe(
        getSessionMessageEntryId(result.messages.at(-2)!),
      );
      expect(inputWindowOpen).toBe(false);
      expect(getMessageQueue().has({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      })).toBe(false);
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      });
    }
  });

  it('closes interrupt admission before a managed Runner failure propagates', async () => {
    let inputWindowOpen = true;
    const failure = new Error('managed-provider-failure');
    const options: KodaXOptions = {
      ...makeOptions(),
      session: { id: 'managed-failure-window' },
      context: {
        ...makeOptions().context,
        interruptInput: {
          closeInputWindow() {
            inputWindowOpen = false;
          },
          reopenInputWindow() {
            inputWindowOpen = true;
          },
        },
      },
    };

    await expect(runManagedTaskViaRunner(
      options,
      'fail this run',
      async () => {
        throw failure;
      },
    )).rejects.toBe(failure);

    expect(inputWindowOpen).toBe(false);
  });

  it('reopens interrupt admission while a managed run is idle-yielding', async () => {
    const sessionId = 'managed-idle-yield-window';
    const queueAgentId = `actor:${sessionId}:/root`;
    let inputWindowOpen = true;
    let turn = 0;
    let resumedWithInterrupt = false;
    let resumedTranscript: readonly KodaXMessage[] = [];
    let lineage: KodaXSessionData['lineage'];
    let deliveredIds: readonly string[] = [];
    let deliveredEntryIds: Readonly<Record<string, string>> | undefined;
    const actorSession = new CodingActorSession({
      sessionId,
      executor: {
        execute: async () => {
          await vi.waitFor(() => expect(inputWindowOpen).toBe(true));
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'interrupt while idle-yielding',
          });
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'second interrupt at the same idle boundary',
          });
          return { output: 'child completed' };
        },
      },
    });
    const options: KodaXOptions = {
      ...makeOptions(),
      session: {
        id: sessionId,
        storage: {
          load: vi.fn(async () => null),
          save: vi.fn(async (_id: string, data: KodaXSessionData) => {
            lineage = createSessionLineage(data.messages, lineage);
          }),
        },
      },
      context: {
        ...makeOptions().context,
        actorSession,
        interruptInput: {
          closeInputWindow() {
            inputWindowOpen = false;
          },
          reopenInputWindow() {
            inputWindowOpen = true;
          },
        },
      },
      events: {
        onMidTurnUserMessages(_contents, meta) {
          deliveredIds = meta?.queuedMessageIds ?? [];
          deliveredEntryIds = meta?.queuedMessageEntryIds;
        },
      },
    };

    try {
      const result = await runManagedTaskViaRunner(
        options,
        'wait for a child',
        async (transcript) => {
          turn += 1;
          if (turn === 1) {
            await actorSession.rootControl().spawn({
              taskName: 'idle-child',
              objective: 'Complete after the parent starts waiting.',
              kind: 'external',
            });
            return {
              textBlocks: [{ text: 'waiting' }],
              toolBlocks: [],
            };
          }
          resumedTranscript = [...transcript];
          expect(JSON.stringify(transcript)).toContain('interrupt while idle-yielding');
          expect(JSON.stringify(transcript)).toContain(
            'second interrupt at the same idle boundary',
          );
          resumedWithInterrupt = true;
          return {
            textBlocks: [{ text: 'resumed answer' }],
            toolBlocks: [],
          };
        },
      );

      expect(turn).toBeGreaterThanOrEqual(2);
      expect(resumedWithInterrupt).toBe(true);
      expect(result.lastText).toBe('resumed answer');
      expect(inputWindowOpen).toBe(false);
      const runtimeDeltaIndex = resumedTranscript.findIndex((message) =>
        message._source === 'managed-runtime-context');
      const wakeMessageIndex = resumedTranscript.findIndex((message) =>
        JSON.stringify(message.content).includes('interrupt while idle-yielding'));
      expect(runtimeDeltaIndex).toBeGreaterThanOrEqual(0);
      expect(wakeMessageIndex).toBeGreaterThan(runtimeDeltaIndex);
      expect(deliveredIds).toHaveLength(2);
      expect(Object.keys(deliveredEntryIds ?? {})).toEqual(deliveredIds);
      const entryRefs = Object.values(deliveredEntryIds ?? {});
      expect(entryRefs).toHaveLength(2);
      expect(new Set(entryRefs).size).toBe(2);
      expect(lineage?.entries.filter((entry) =>
        entry.type === 'message' && entryRefs.includes(entry.id))).toHaveLength(2);
    } finally {
      await actorSession.close('test complete');
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
      });
    }
  });
});

describe('isRunnerDrivenRuntimeEnabled', () => {
  const envKey = 'KODAX_MANAGED_TASK_RUNTIME';
  afterEach(() => {
    delete process.env[envKey];
  });

  it('returns false when env var is unset', () => {
    delete process.env[envKey];
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
  });

  it('returns true for "runner"', () => {
    process.env[envKey] = 'runner';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(true);
  });

  it('returns true for "RUNNER" (case insensitive)', () => {
    process.env[envKey] = 'RUNNER';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(true);
  });

  it('returns false for "legacy" or any other value', () => {
    process.env[envKey] = 'legacy';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
    process.env[envKey] = '1';
    expect(isRunnerDrivenRuntimeEnabled()).toBe(false);
  });
});

describe('resolveInitialRuntimeThinkingLevel', () => {
  it('maps legacy reasoningMode to effort and lets explicit effort win', () => {
    expect(__runnerDrivenTestables.resolveInitialRuntimeThinkingLevel({
      reasoningMode: 'balanced',
    } as KodaXOptions)).toBe('medium');
    expect(__runnerDrivenTestables.resolveInitialRuntimeThinkingLevel({
      reasoningMode: 'deep',
    } as KodaXOptions)).toBe('high');
    expect(__runnerDrivenTestables.resolveInitialRuntimeThinkingLevel({
      reasoningMode: 'off',
    } as KodaXOptions)).toBe('none');
    expect(__runnerDrivenTestables.resolveInitialRuntimeThinkingLevel({
      effort: 'high',
      reasoningMode: 'off',
    } as KodaXOptions)).toBe('high');
  });
});

// FEATURE_193 v0.7.43: describe('buildRunnerScoutAgent') deleted — V1 chain retired.

describe('buildRunnerLlmAdapter (via overrideStream)', () => {
  it('splits leading system message and sends rest to the stream', async () => {
    let capturedSystem = '';
    let capturedTranscript: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (transcript, _tools, system) => {
      capturedSystem = system;
      capturedTranscript = transcript;
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    await adapter(
      [
        { role: 'system', content: 'sys-text' },
        { role: 'user', content: 'user-q' },
      ],
      { name: 'x', instructions: 'ignored' },
    );
    expect(capturedSystem).toBe('sys-text');
    expect(capturedTranscript).toHaveLength(1);
    expect(capturedTranscript[0]!.content).toBe('user-q');
  });

  it('injects a one-shot todo drift reminder into the next provider call', async () => {
    const todoStore = createTodoStore();
    todoStore.init([{ id: 'todo_1', subject: 'Inspect implementation' }]);
    const driftState = createTodoDriftReminderState();
    observeTodoDriftAfterToolResult({
      state: driftState,
      todoStore,
      call: {
        id: 'read-1',
        name: 'read',
        input: { file_path: 'packages/coding/src/x.ts' },
      },
      result: { content: 'file contents' },
    });

    const capturedSystems: string[] = [];
    const capturedTranscripts: Array<readonly KodaXMessage[]> = [];
    const adapter = buildRunnerLlmAdapter(
      makeOptions(),
      async (transcript, _tools, system) => {
        capturedSystems.push(system);
        capturedTranscripts.push(transcript);
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
      undefined,
      undefined,
      undefined,
      todoStore,
      undefined,
      undefined,
      driftState,
    );

    const firstResult = await adapter(
      [{ role: 'system', content: 'sys-text' }],
      { name: 'worker', instructions: 'ignored' },
    );
    await adapter([{ role: 'system', content: 'sys-text' }], { name: 'worker', instructions: 'ignored' });

    expect(capturedSystems).toEqual(['sys-text', 'sys-text']);
    expect(capturedTranscripts[0]?.at(-1)).toEqual(expect.objectContaining({
      role: 'user',
      _synthetic: true,
      _source: 'managed-runtime-reminder',
      content: expect.stringContaining('no item marked in_progress'),
    }));
    expect(String(capturedTranscripts[0]?.at(-1)?.content)).toContain('call todo_update now');
    expect(firstResult.injectedInputMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        _source: 'managed-runtime-reminder',
      }),
    ]);
    expect(capturedTranscripts[1]).toHaveLength(0);
  });

  it('injects one Agent-completion todo checkpoint and deduplicates transcript replay', async () => {
    const todoStore = createTodoStore();
    todoStore.init([{ id: 'todo_1', subject: 'Review child findings' }]);
    todoStore.updateStatus('todo_1', 'in_progress');
    const driftState = createTodoDriftReminderState();
    const capturedSystems: string[] = [];
    const capturedTranscripts: Array<readonly KodaXMessage[]> = [];
    const adapter = buildRunnerLlmAdapter(
      makeOptions(),
      async (transcript, _tools, system) => {
        capturedSystems.push(system);
        capturedTranscripts.push(transcript);
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
      undefined,
      undefined,
      undefined,
      todoStore,
      undefined,
      undefined,
      driftState,
    );
    const baseline: KodaXMessage[] = [{ role: 'system', content: 'sys-text' }];
    const completion: KodaXMessage = {
      role: 'user',
      content: '<agent-completed>done</agent-completed>',
      _synthetic: true,
      _source: 'agent-completed',
      _taskResult: {
        type: 'task_result',
        source: 'child_task',
        taskId: 'turn-1',
        status: 'completed',
      },
    };

    await adapter(baseline, { name: 'worker', instructions: 'ignored' });
    await adapter([...baseline, completion], { name: 'worker', instructions: 'ignored' });
    await adapter([...baseline, completion], { name: 'worker', instructions: 'ignored' });

    expect(capturedSystems).toEqual(['sys-text', 'sys-text', 'sys-text']);
    expect(String(capturedTranscripts[1]?.at(-1)?.content))
      .toContain('terminal child Agent result');
    expect(String(capturedTranscripts[1]?.at(-1)?.content))
      .toContain('semantic milestones, not Actor instances');
    expect(capturedTranscripts[2]).toEqual([completion]);
  });

  // Regression: after compaction + `injectPostCompactAttachments`, the
  // transcript begins with `[compaction-summary, post-compact-ledger,
  // post-compact-file, ...]` — three or more contiguous role:'system'
  // entries. The adapter must join all leading system messages into the
  // `system` parameter so the agent role instructions that the Runner
  // seeded at position 0 don't get stranded behind the summary and so
  // strict OpenAI-compat proxies never see a role:'system' after a
  // user/assistant.
  it('merges all leading contiguous role:system messages into the system param', async () => {
    let capturedSystem = '';
    let capturedTranscript: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (transcript, _tools, system) => {
      capturedSystem = system;
      capturedTranscript = transcript;
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    await adapter(
      [
        { role: 'system', content: 'agent-instructions' },
        { role: 'system', content: '[对话历史摘要]\nrecent turn notes' },
        { role: 'system', content: '[Post-compact: recent operations]\nledger' },
        { role: 'system', content: '[Post-compact: file content] /a.ts\n...' },
        { role: 'user', content: 'follow-up' },
      ],
      { name: 'x', instructions: 'ignored' },
    );
    expect(capturedSystem).toBe(
      'agent-instructions\n\n'
        + '[对话历史摘要]\nrecent turn notes\n\n'
        + '[Post-compact: recent operations]\nledger\n\n'
        + '[Post-compact: file content] /a.ts\n...',
    );
    expect(capturedTranscript).toHaveLength(1);
    expect(capturedTranscript[0]!.role).toBe('user');
    expect(capturedTranscript[0]!.content).toBe('follow-up');
  });

  // The event denominator follows the real per-Runner panic fuse. It is not
  // a task-wide provider-call budget: fresh idle-yield resumes reset `iter`.
  it('reports the managed per-Runner panic fuse, not the stale default 20', async () => {
    const { MANAGED_RUNNER_PANIC_ITERATIONS } = await import('../constants.js');
    const starts: Array<{ iter: number; maxIter: number }> = [];
    const ends: Array<{ iter: number; maxIter: number }> = [];
    const adapter = buildRunnerLlmAdapter({
      ...makeOptions(),
      events: {
        onIterationStart: (iter, maxIter) => starts.push({ iter, maxIter }),
        onIterationEnd: (info) => ends.push({ iter: info.iter, maxIter: info.maxIter }),
      },
    } as unknown as KodaXOptions, async () => ({ textBlocks: [{ text: 'ok' }], toolBlocks: [] }));
    await adapter([{ role: 'user', content: 'q' }], { name: 'x', instructions: 'i' });
    expect(MANAGED_RUNNER_PANIC_ITERATIONS).toBe(500);
    expect(starts).toEqual([{ iter: 1, maxIter: 500 }]);
    expect(ends[0]!.maxIter).toBe(500);
  });

  it('keeps the managed task idle-yield lifecycle unbounded', async () => {
    const { MANAGED_TASK_IDLE_YIELD_ITERATIONS } = await import('../constants.js');
    expect(MANAGED_TASK_IDLE_YIELD_ITERATIONS).toBe(Number.POSITIVE_INFINITY);
  });

  it('resets the iteration counter for a fresh Runner invocation', async () => {
    const iters: number[] = [];
    const iterationStateRef = { current: 0 };
    const adapter = buildRunnerLlmAdapter(
      {
        ...makeOptions(),
        events: { onIterationStart: (iter) => iters.push(iter) },
      } as unknown as KodaXOptions,
      async () => ({ textBlocks: [{ text: 'ok' }], toolBlocks: [] }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      iterationStateRef,
    );
    const agent = { name: 'x', instructions: 'i' };
    await adapter([{ role: 'user', content: 'q1' }], agent);
    await adapter([{ role: 'user', content: 'q2' }], agent);
    iterationStateRef.current = 0;
    await adapter([{ role: 'user', content: 'q3' }], agent);
    expect(iters).toEqual([1, 2, 1]);
  });

  it('stops at the first non-system message — later role:system stays in transcript for provider-layer merge', async () => {
    let capturedTranscript: readonly KodaXMessage[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (transcript, _tools, _system) => {
      capturedTranscript = transcript;
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    await adapter(
      [
        { role: 'system', content: 'leading' },
        { role: 'user', content: 'q1' },
        { role: 'system', content: '[Post-compact: stray]' },
        { role: 'user', content: 'q2' },
      ],
      { name: 'x', instructions: 'ignored' },
    );
    // Adapter only strips the leading run; the stray mid-transcript
    // system survives here — the provider layer's normalizeSystemForWire
    // is the safety net that collapses it before the wire goes out.
    expect(capturedTranscript).toHaveLength(3);
    expect(capturedTranscript[0]!.role).toBe('user');
    expect(capturedTranscript[1]!.role).toBe('system');
    expect(capturedTranscript[2]!.role).toBe('user');
  });

  it('strips execute function from agent tools when serializing for the wire', async () => {
    let capturedTools: readonly { name: string; execute?: unknown }[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (_t, tools) => {
      capturedTools = tools as readonly { name: string; execute?: unknown }[];
      return { textBlocks: [], toolBlocks: [] };
    });
    // FEATURE_193 v0.7.43: migrated from Scout/emit_scout_verdict fixture to
    // Worker chain (V1 chain retired).
    const chain = buildRunnerAgentChain(makeCtx(), {});
    await adapter([{ role: 'system', content: 's' }], chain.worker);
    for (const t of capturedTools) {
      expect(t.execute).toBeUndefined();
    }
    expect(capturedTools.some((t) => t.name === 'read')).toBe(true);
  });

  it('preserves the agent-declared tool order on the wire', async () => {
    const observedNames: string[] = [];
    const adapter = buildRunnerLlmAdapter(
      makeOptions(),
      async (_messages, tools) => {
        observedNames.push(...tools.map((tool) => tool.name));
        return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      },
    );
    const makeTool = (name: string) => ({
      name,
      description: name,
      input_schema: { type: 'object' as const, properties: {} },
      execute: async () => ({ content: 'ok' }),
    });

    await adapter(
      [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }],
      {
        name: 'worker',
        instructions: '',
        tools: [makeTool('z_last_by_name'), makeTool('a_first_by_name')],
      },
    );

    expect(observedNames).toEqual(['z_last_by_name', 'a_first_by_name']);
  });

  it('converts textBlocks+toolBlocks to RunnerLlmResult shape', async () => {
    const toolBlock: KodaXToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'read',
      input: { path: 'package.json' },
    };
    const adapter = buildRunnerLlmAdapter(makeOptions(), async () => ({
      textBlocks: [{ text: 'Reading file' }],
      toolBlocks: [toolBlock],
    }));
    const result = await adapter(
      [{ role: 'system', content: 's' }],
      { name: 'x', instructions: '' },
    );
    expect(result.text).toBe('Reading file');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('read');
    expect(result.toolCalls![0]!.input).toEqual({ path: 'package.json' });
  });

  it('anchors API total tokens to the completed assistant transcript', async () => {
    const snapshotRef: import('./_internal/managed-task/compaction.js').ContextTokenSnapshotRef = {
      current: undefined,
    };
    const usage = {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cachedReadTokens: 60,
    };
    const adapter = buildRunnerLlmAdapter(
      makeOptions(),
      async () => ({
        textBlocks: [{ text: 'using a tool' }],
        toolBlocks: [{
          type: 'tool_use',
          id: 'read-1',
          name: 'read',
          input: { path: 'package.json' },
        }],
        thinkingBlocks: [],
        usage,
      } as KodaXStreamResult),
      undefined,
      undefined,
      snapshotRef,
    );
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect the package' },
    ];
    const result = await adapter(messages, { name: 'worker', instructions: '' });
    const completedTranscript = [
      ...messages,
      buildAssistantMessageFromLlmResult(result),
    ] as KodaXMessage[];

    expect(snapshotRef.current?.currentTokens).toBe(usage.totalTokens);
    expect(snapshotRef.current?.baselineEstimatedTokens)
      .toBe(estimateTokens(completedTranscript));
    expect(snapshotRef.current?.usage?.cachedReadTokens).toBe(60);
    expect(resolveContextTokenCount(completedTranscript, snapshotRef.current)).toBe(140);

    const nextTranscript: KodaXMessage[] = [
      ...completedTranscript,
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: 'new result only',
        }],
      },
    ];
    const physicalDelta = estimateTokens(nextTranscript) - estimateTokens(completedTranscript);
    expect(resolveContextTokenCount(nextTranscript, snapshotRef.current))
      .toBe(usage.totalTokens + physicalDelta);
  });

  it('builds a no-usage fallback snapshot from the final system + active tool-schema envelope', async () => {
    const snapshotRef: import('./_internal/managed-task/compaction.js').ContextTokenSnapshotRef = {
      current: undefined,
    };
    const largeSchemaTool: RunnableTool = {
      name: 'large_schema_tool',
      description: 'schema sentinel '.repeat(12_000),
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'query sentinel '.repeat(2_000) },
        },
      },
      execute: async () => ({ content: 'unused' }),
    };
    const adapter = buildRunnerLlmAdapter(
      makeOptions(),
      async () => ({ textBlocks: [{ text: 'done without usage' }] }),
      undefined,
      undefined,
      snapshotRef,
    );
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'FINAL_SYSTEM_SENTINEL '.repeat(200) },
      { role: 'user', content: 'restored history request' },
    ];
    const result = await adapter(messages, {
      name: 'worker',
      instructions: '',
      tools: [largeSchemaTool],
    });
    const completedRunnerTranscript = [
      ...messages,
      buildAssistantMessageFromLlmResult(result),
    ] as KodaXMessage[];
    const wireTool: KodaXToolDefinition = {
      name: largeSchemaTool.name,
      description: largeSchemaTool.description,
      input_schema: largeSchemaTool.input_schema,
    };
    const completedProviderTranscript = completedRunnerTranscript.slice(1);
    const expectedEnvelopeTokens = estimateTokens(completedProviderTranscript)
      + countTokens(String(messages[0]!.content))
      + estimateToolSchemaTokens(wireTool);

    expect(snapshotRef.current?.source).toBe('estimate');
    expect(snapshotRef.current?.baselineEstimatedTokens)
      .toBe(estimateTokens(completedRunnerTranscript));
    expect(snapshotRef.current?.currentTokens).toBe(expectedEnvelopeTokens);
    expect(expectedEnvelopeTokens)
      .toBeGreaterThan(estimateTokens(completedRunnerTranscript) + 5_000);
  });

  it('persists the latest legal transcript when hard capacity fails before the provider call', async () => {
    const save = vi.fn(async () => undefined);
    const providerCall = vi.fn(async () => ({
      textBlocks: [{ text: 'unreachable' }],
      toolBlocks: [],
    }));
    const optionsWithPressure: KodaXOptions = {
      ...makeOptions(),
      context: {
        ...makeOptions().context,
        contextTokenSnapshot: {
          currentTokens: 1_000_000,
          baselineEstimatedTokens: 0,
          source: 'estimate',
        },
      },
      session: {
        id: 'runner-hard-capacity-recovery',
        storage: {
          load: vi.fn(async () => null),
          save,
        },
      },
    };

    await expect(runManagedTaskViaRunner(
      optionsWithPressure,
      'HARD_CAPACITY_PERSISTENCE_SENTINEL',
      providerCall,
    )).rejects.toBeInstanceOf(ContextCapacityError);

    expect(providerCall).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(
      'runner-hard-capacity-recovery',
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
        ]),
        errorMetadata: expect.objectContaining({
          consecutiveErrors: 1,
        }),
      }),
    );
    expect(JSON.stringify(save.mock.calls.at(-1)?.[1])).toContain(
      'HARD_CAPACITY_PERSISTENCE_SENTINEL',
    );
  });

  it('clears stale crash metadata after a later managed Turn completes', async () => {
    const save = vi.fn(async () => undefined);
    const sessionId = 'managed-success-clears-error-metadata';
    let stored: KodaXSessionData = {
      messages: [
        { role: 'user', content: 'previous request' },
        { role: 'assistant', content: 'previous answer' },
      ],
      title: 'Recovered Session',
      gitRoot: process.cwd(),
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    };
    save.mockImplementation(async (_id, data) => {
      stored = structuredClone(data);
    });
    const options: KodaXOptions = {
      ...makeOptions(),
      session: {
        id: sessionId,
        storage: {
          load: vi.fn(async () => structuredClone(stored)),
          save,
        },
      },
    };

    await expect(runManagedTaskViaRunner(
      options,
      'later successful request',
      async () => ({
        textBlocks: [{ text: 'later successful answer' }],
        toolBlocks: [],
      }),
    )).resolves.toMatchObject({
      success: true,
      lastText: 'later successful answer',
    });

    expect(stored.errorMetadata).toBeUndefined();
  });
});

describe('buildRunnerLlmAdapter — max_tokens escalation (FEATURE_085 Scout parity)', () => {
  const ESCALATION_PROVIDER_NAME = 'runner-driven-max-tokens-test';
  const ESCALATION_PROVIDER_API_KEY_ENV = 'RUNNER_DRIVEN_MAX_TOKENS_TEST_API_KEY';

  let KodaXBaseProviderRef: typeof import('@kodax-ai/llm').KodaXBaseProvider;
  let registerModelProviderFn: typeof import('@kodax-ai/llm').registerModelProvider;
  let clearRuntimeModelProvidersFn: typeof import('@kodax-ai/llm').clearRuntimeModelProviders;
  let KODAX_CAPPED: number;
  let KODAX_ESCALATED: number;

  beforeAll(async () => {
    const aiModule = await import('@kodax-ai/llm');
    KodaXBaseProviderRef = aiModule.KodaXBaseProvider;
    registerModelProviderFn = aiModule.registerModelProvider;
    clearRuntimeModelProvidersFn = aiModule.clearRuntimeModelProviders;
    KODAX_CAPPED = aiModule.KODAX_CAPPED_MAX_OUTPUT_TOKENS;
    KODAX_ESCALATED = aiModule.KODAX_ESCALATED_MAX_OUTPUT_TOKENS;
  });

  afterEach(() => {
    clearRuntimeModelProvidersFn();
    delete process.env[ESCALATION_PROVIDER_API_KEY_ENV];
    delete process.env.KODAX_MAX_OUTPUT_TOKENS;
  });

  function registerScriptedProvider(
    responses: Array<{ textBlocks: { type: 'text'; text: string }[]; stopReason?: string }>,
    observedBudgets: number[],
  ): void {
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        observedBudgets.push(
          streamOptions?.maxOutputTokensOverride ?? this.getEffectiveMaxOutputTokens(),
        );
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        return {
          textBlocks: resp.textBlocks,
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: resp.stopReason,
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
  }

  function makeAdapterOptions(): KodaXOptions {
    return {
      ...makeOptions(),
      provider: ESCALATION_PROVIDER_NAME,
    };
  }

  it('removes volatile oversized-input artifacts when a managed run settles', async () => {
    let artifactPath: string | undefined;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      };

      async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
        artifactPath ??= JSON.stringify(messages)
          .match(/kodax-transient:\/\/text\/[0-9a-f]{64}/)?.[0];
        return {
          textBlocks: [{ type: 'text', text: 'done' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
    const oversized = `managed private sentinel\n${'evidence '.repeat(90_000)}`;

    const result = await runManagedTaskViaRunner(makeAdapterOptions(), oversized);

    expect(result.success).toBe(true);
    expect(artifactPath).toBeDefined();
    expect(readTransientTextArtifact(artifactPath!)).toBeUndefined();
    expect(JSON.stringify(result.messages)).toContain('managed private sentinel');
  }, 60_000);

  it('forwards provider retry callbacks from managed-worker stream options', async () => {
    const onProviderRateLimit = vi.fn();
    const onRetryAfter = vi.fn();

    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };

      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        streamOptions?.onRateLimit?.(1, 3, 500);
        streamOptions?.onRetryAfter?.({
          provider: this.name,
          waitMs: 500,
          reason: 'rate-limit',
          source: 'retry-after-ms',
          attempt: 1,
          maxAttempts: 3,
        });
        return {
          textBlocks: [{ type: 'text', text: 'done' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }

    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      events: {
        onProviderRateLimit,
        onRetryAfter,
      },
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Retry please.' }],
      { name: 'worker', instructions: '' },
    );

    expect(result.text).toBe('done');
    expect(onProviderRateLimit).toHaveBeenCalledWith(1, 3, 500);
    expect(onRetryAfter).toHaveBeenCalledWith({
      provider: ESCALATION_PROVIDER_NAME,
      waitMs: 500,
      reason: 'rate-limit',
      source: 'retry-after-ms',
      attempt: 1,
      maxAttempts: 3,
    });
  }, 15_000);

  it('emits prompt-free AMA budget snapshots and provider cache diagnostics before streaming', async () => {
    const snapshots: RuntimeContextBudgetSnapshot[] = [];
    const cacheDiagnostics: KodaXPromptCacheDiagnosticEvent[] = [];
    const observedToolNames: string[][] = [];
    const observedSuffixes: Array<KodaXEphemeralSuffix | undefined> = [];
    const eventOrder: string[] = [];

    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        baseUrl: 'https://user:secret@example.test/v1/tenant-secret?api_key=secret',
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };

      override supportsEphemeralSuffix(): boolean {
        return true;
      }

      async stream(
        _messages: KodaXMessage[],
        tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        eventOrder.push('stream');
        observedToolNames.push(tools.map((tool) => tool.name));
        observedSuffixes.push(streamOptions?.ephemeralSuffix);
        return {
          textBlocks: [{ type: 'text', text: 'done' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
          usage: {
            inputTokens: 144_563,
            outputTokens: 545,
            totalTokens: 145_108,
            cachedReadTokens: 19_328,
          },
        };
      }
    }

    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
    const skillCatalogText = 'Skill catalog entry for diagnostics.';
    const selectedSkillText = 'Full expanded skill selected for this run.';
    const mcpCatalogText = 'MCP catalog entry for diagnostics.';
    const volatileSuffix = 'AMA_EPHEMERAL_SUFFIX_MUST_NOT_LEAK';
    const adapter = buildRunnerLlmAdapter(
      {
        ...makeAdapterOptions(),
        session: { id: 'ama-context-diagnostics' },
        context: {
          ...makeOptions().context,
          contextDiagnostics: true,
          contextIdentitySessionId: 'ama-root-session',
          currentAgentId: '/root/reviewer',
          parentAgentId: '/root',
        },
        events: {
          onContextBudgetSnapshot: (event) => {
            eventOrder.push('budget');
            snapshots.push(event);
          },
          onPromptCacheDiagnostics: (event) => {
            eventOrder.push(`cache-${event.phase}`);
            cacheDiagnostics.push(event);
          },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        skillCatalogText,
        selectedSkillText,
        mcpCatalogText,
        contextWindow: 123_456,
      },
      () => ({ content: volatileSuffix }),
      createUserInputDegradationCache(),
    );
    const secretPrompt = 'AMA_DIAGNOSTIC_PROMPT_MUST_NOT_LEAK';
    await adapter(
      [
        { role: 'system', content: 'stable system\n\ninline policy' },
        { role: 'user', content: 'old query', turnId: 'turn-old' },
        { role: 'assistant', content: 'old answer', turnId: 'turn-old' },
        {
          role: 'user',
          content: [
            skillCatalogText,
            selectedSkillText,
            mcpCatalogText,
            secretPrompt,
          ].join('\n\n'),
          turnId: 'turn-current',
        },
      ],
      { name: 'worker', instructions: '' },
    );
    await adapter(
      [
        { role: 'system', content: 'stable system' },
        { role: 'user', content: 'old query', turnId: 'turn-old' },
        { role: 'assistant', content: 'old answer', turnId: 'turn-old' },
        { role: 'system', content: 'inline policy' },
        {
          role: 'user',
          content: [
            skillCatalogText,
            selectedSkillText,
            mcpCatalogText,
            'different current request',
          ].join('\n\n'),
          turnId: 'turn-current-2',
        },
      ],
      { name: 'worker', instructions: '' },
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual(expect.objectContaining({
      sessionId: 'ama-context-diagnostics',
      turnId: 'turn-current',
      contextId: `ama-root-session/agent/${encodeURIComponent('/root/reviewer')}`,
      contextKind: 'child',
      parentContextId: 'ama-root-session',
      agentId: '/root/reviewer',
      contextWindow: 123_456,
    }));
    expect(snapshots[0]!.tokenBreakdown.reservedResponse).toBe(8_000);
    expect(snapshots[0]!.tokenBreakdown.total).toBe(snapshots[0]!.usedTokens);
    expect(snapshots[0]!.tokenBreakdown.skillCatalog).toBeGreaterThan(0);
    expect(snapshots[0]!.tokenBreakdown.mcpCatalog).toBeGreaterThan(0);
    expect(snapshots[0]!.tokenBreakdown.pendingInput).toBeGreaterThan(0);
    expect(cacheDiagnostics.map((event) => event.phase)).toEqual([
      'request',
      'response',
      'request',
      'response',
    ]);
    expect(cacheDiagnostics[0]!.systemPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]!.transport).toBe('stream');
    expect(cacheDiagnostics[0]!.wireModel).toBe('scripted');
    expect(cacheDiagnostics[0]!.reasoningHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]!.maxOutputTokens).toBe(8_000);
    expect(cacheDiagnostics[0]!.kodaxPromptCacheEnabled).toBe(true);
    expect(cacheDiagnostics[0]!.toolSchemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]!.messagePrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]!.requestMessagesHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]!.ephemeralSuffixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]).toMatchObject({
      contextId: `ama-root-session/agent/${encodeURIComponent('/root/reviewer')}`,
      contextKind: 'child',
      parentContextId: 'ama-root-session',
      agentId: '/root/reviewer',
    });
    expect(cacheDiagnostics[0]!.messagePrefixCount).toBe(2);
    expect(cacheDiagnostics[2]!.messagePrefixCount).toBe(2);
    expect(cacheDiagnostics[0]!.messagePrefixHash)
      .toBe(cacheDiagnostics[2]!.messagePrefixHash);
    expect(cacheDiagnostics[0]!.systemPromptHash)
      .toBe(cacheDiagnostics[2]!.systemPromptHash);
    expect(cacheDiagnostics[0]!.requestMessagesHash)
      .not.toBe(cacheDiagnostics[2]!.requestMessagesHash);
    expect(cacheDiagnostics[1]).toEqual(expect.objectContaining({
      requestId: cacheDiagnostics[0]!.requestId,
      endpoint: 'https://example.test',
      endpointPathHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      cachedReadTokens: 19_328,
    }));
    expect(cacheDiagnostics[1]).not.toHaveProperty('cachedWriteTokens');
    expect(JSON.stringify({ snapshots, cacheDiagnostics })).not.toContain(secretPrompt);
    expect(JSON.stringify({ snapshots, cacheDiagnostics })).not.toContain(volatileSuffix);
    expect(JSON.stringify(cacheDiagnostics)).not.toContain('tenant-secret');
    expect(observedToolNames).toEqual([[], []]);
    expect(observedSuffixes).toEqual([
      { content: volatileSuffix },
      { content: volatileSuffix },
    ]);
    expect(eventOrder).toEqual([
      'budget',
      'cache-request',
      'stream',
      'cache-response',
      'budget',
      'cache-request',
      'stream',
      'cache-response',
    ]);
  }, 15_000);

  it('counts the request-only suffix exactly once in AMA context budgets', async () => {
    const snapshots: RuntimeContextBudgetSnapshot[] = [];
    const observedBudgets: number[] = [];
    const suffixContent = 'request-only context budget sentinel';
    const turnId = 'turn-suffix-budget';
    let suffixEnabled = false;
    registerScriptedProvider(
      [
        { textBlocks: [{ type: 'text', text: 'without suffix' }] },
        { textBlocks: [{ type: 'text', text: 'with suffix' }] },
      ],
      observedBudgets,
    );
    const adapter = buildRunnerLlmAdapter(
      {
        ...makeAdapterOptions(),
        context: {
          ...makeOptions().context,
          contextDiagnostics: true,
        },
        events: {
          onContextBudgetSnapshot: (snapshot) => snapshots.push(snapshot),
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => suffixEnabled ? { content: suffixContent } : undefined,
    );
    const messages: readonly KodaXMessage[] = [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'same request', turnId },
    ];

    await adapter(messages, { name: 'worker', instructions: '' });
    suffixEnabled = true;
    await adapter(messages, { name: 'worker', instructions: '' });

    expect(snapshots).toHaveLength(2);
    const expectedSuffixTokens = estimateTokens([{
      role: 'user',
      content: suffixContent,
      _synthetic: true,
      _source: 'managed-run-context',
      turnId,
    }]);
    expect(snapshots[1]!.usedTokens - snapshots[0]!.usedTokens)
      .toBe(expectedSuffixTokens);
    expect(snapshots[1]!.tokenBreakdown.pendingInput
      - snapshots[0]!.tokenBreakdown.pendingInput)
      .toBe(expectedSuffixTokens);
  });

  it('lowers the suffix into a request-only message for legacy runtime Providers', async () => {
    const observedMessages: KodaXMessage[][] = [];
    const observedSuffixes: Array<KodaXEphemeralSuffix | undefined> = [];
    const cacheDiagnostics: KodaXPromptCacheDiagnosticEvent[] = [];
    const suffixContent = 'legacy Provider managed context';

    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };

      async stream(
        messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        observedMessages.push(messages);
        observedSuffixes.push(streamOptions?.ephemeralSuffix);
        return {
          textBlocks: [{ type: 'text', text: 'done' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }

    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    const legacyProvider = new Scripted();
    Object.defineProperty(legacyProvider, 'supportsEphemeralSuffix', {
      value: undefined,
    });
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => legacyProvider);
    const adapter = buildRunnerLlmAdapter(
      {
        ...makeAdapterOptions(),
        context: {
          ...makeOptions().context,
          contextDiagnostics: true,
        },
        events: {
          onPromptCacheDiagnostics: (event) => cacheDiagnostics.push(event),
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ content: suffixContent }),
    );
    const input: readonly KodaXMessage[] = [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'original request', turnId: 'legacy-provider-turn' },
    ];

    await adapter(input, { name: 'worker', instructions: '' });

    expect(input[1]?.content).toBe('original request');
    expect(observedMessages).toEqual([[
      expect.objectContaining({
        role: 'user',
        content: `original request\n\n${suffixContent}`,
      }),
    ]]);
    expect(observedSuffixes).toEqual([undefined]);
    expect(cacheDiagnostics[0]?.ephemeralSuffixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheDiagnostics[0]?.requestMessagesHash).toBe(
      hashProviderVisibleMessages(input.slice(1), legacyProvider, 'scripted'),
    );
    expect(JSON.stringify(cacheDiagnostics)).not.toContain(suffixContent);
  });

  it('emits separate budget and cache diagnostics for non-streaming fallback calls', async () => {
    const snapshots: RuntimeContextBudgetSnapshot[] = [];
    const cacheDiagnostics: KodaXPromptCacheDiagnosticEvent[] = [];
    let streamCalls = 0;
    let completeCalls = 0;
    const promptCacheKeys: Array<string | undefined> = [];

    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };

      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        streamCalls += 1;
        promptCacheKeys.push(streamOptions?.promptCacheKey);
        throw new Error('zhipu-coding API error: terminated');
      }

      override supportsNonStreamingFallback(): boolean {
        return true;
      }

      override async complete(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        completeCalls += 1;
        promptCacheKeys.push(streamOptions?.promptCacheKey);
        return {
          textBlocks: [{ type: 'text', text: 'fallback done' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
          usage: {
            inputTokens: 100,
            outputTokens: 5,
            totalTokens: 105,
            cachedReadTokens: 0,
          },
        };
      }
    }

    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      session: { id: 'managed-fallback-cache-affinity' },
      context: {
        ...makeOptions().context,
        contextDiagnostics: true,
      },
      events: {
        onContextBudgetSnapshot: (event) => snapshots.push(event),
        onPromptCacheDiagnostics: (event) => cacheDiagnostics.push(event),
      },
    });

    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Retry please.' }],
      { name: 'worker', instructions: '' },
    );

    expect(result.text).toBe('fallback done');
    expect(streamCalls).toBe(2);
    expect(completeCalls).toBe(1);
    expect(new Set(promptCacheKeys).size).toBe(1);
    expect(promptCacheKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshots).toHaveLength(3);
    expect(cacheDiagnostics.map((event) => `${event.transport}:${event.phase}`)).toEqual([
      'stream:request',
      'stream:request',
      'complete:request',
      'complete:response',
    ]);
    expect(cacheDiagnostics.at(-1)?.cachedReadTokens).toBe(0);
  }, 15_000);

  it('does not recover or start fallback work after the caller AbortSignal is observed', async () => {
    const controller = new AbortController();
    const recoveries: string[] = [];
    let streamCalls = 0;
    let completeCalls = 0;

    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };

      async stream(): Promise<KodaXStreamResult> {
        streamCalls += 1;
        controller.abort(new Error('runtime run aborted'));
        const error = new Error('Provider observed the managed Run abort');
        error.name = 'AbortError';
        throw error;
      }

      override supportsNonStreamingFallback(): boolean {
        return true;
      }

      override async complete(): Promise<KodaXStreamResult> {
        completeCalls += 1;
        return {
          textBlocks: [{ type: 'text', text: 'must not run' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }

    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      abortSignal: controller.signal,
      events: {
        onProviderRecovery: (event) => recoveries.push(event.recoveryAction),
      },
    });

    await expect(adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'cancel me' }],
      { name: 'worker', instructions: '' },
    )).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Provider observed the managed Run abort',
    });
    expect(streamCalls).toBe(1);
    expect(completeCalls).toBe(0);
    expect(recoveries).toEqual([]);
  });

  it('keeps provider execution independent from throwing diagnostics callbacks', async () => {
    const streamSpy = vi.fn(async (): Promise<KodaXStreamResult> => ({
      textBlocks: [{ type: 'text', text: 'done' }],
      toolBlocks: [],
      thinkingBlocks: [],
      stopReason: 'end_turn',
    }));
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        baseUrl: 'https://example.test/v1',
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
      };
      stream = streamSpy;
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      context: {
        ...makeOptions().context,
        contextDiagnostics: true,
      },
      events: {
        onContextBudgetSnapshot: () => {
          throw new Error('budget observer failed');
        },
        onPromptCacheDiagnostics: () => {
          throw new Error('cache observer failed');
        },
      },
    });

    await expect(adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'query' }],
      { name: 'worker', instructions: '' },
    )).resolves.toEqual(expect.objectContaining({ text: 'done' }));
    expect(streamSpy).toHaveBeenCalledTimes(1);
  });

  it('passes the requested model into every provider stream call, including L5 continuation', async () => {
    const observedModels: Array<string | undefined> = [];
    const responses: KodaXStreamResult[] = [
      {
        textBlocks: [],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      {
        textBlocks: [{ type: 'text', text: 'half' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'max_tokens',
      },
      {
        textBlocks: [{ type: 'text', text: ' done' }],
        toolBlocks: [],
        thinkingBlocks: [],
        stopReason: 'end_turn',
      },
    ];
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        observedModels.push(streamOptions?.modelOverride);
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        return resp;
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      model: 'glm-5.2',
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    expect(result.text).toContain('half');
    expect(result.text).toContain('done');
    expect(observedModels).toEqual(['glm-5.2', 'glm-5.2', 'glm-5.2']);
  }, 15_000);

  it('does not start L5 continuation after a successful turn observes caller cancellation', async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
      };

      async stream(): Promise<KodaXStreamResult> {
        streamCalls += 1;
        if (streamCalls === 1) {
          return { textBlocks: [], toolBlocks: [], stopReason: 'max_tokens' };
        }
        if (streamCalls === 2) {
          controller.abort(new Error('runtime run aborted'));
          return {
            textBlocks: [{ type: 'text', text: 'partial' }],
            toolBlocks: [],
            stopReason: 'max_tokens',
          };
        }
        return {
          textBlocks: [{ type: 'text', text: 'must not continue' }],
          toolBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());
    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      abortSignal: controller.signal,
    });

    await expect(adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'large task' }],
      { name: 'worker', instructions: '' },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(streamCalls).toBe(2);
  }, 15_000);

  it('escalates capped budget to 64K on first max_tokens, reissues same turn', async () => {
    const observedBudgets: number[] = [];
    const reservedResponseTokens: number[] = [];
    registerScriptedProvider(
      [
        { textBlocks: [], stopReason: 'max_tokens' },
        { textBlocks: [{ type: 'text', text: 'done at 64K' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      context: {
        ...makeOptions().context,
        contextDiagnostics: true,
      },
      events: {
        onContextBudgetSnapshot: (snapshot) => {
          reservedResponseTokens.push(snapshot.tokenBreakdown.reservedResponse);
        },
      },
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Generate a long file.' }],
      { name: 'scout', instructions: '' },
    );

    expect(result.text).toBe('done at 64K');
    expect(observedBudgets).toEqual([KODAX_CAPPED, KODAX_ESCALATED]);
    expect(reservedResponseTokens).toEqual([KODAX_CAPPED, KODAX_ESCALATED]);
  }, 15_000);

  it('does not escalate a second time within the same adapter call', async () => {
    const observedBudgets: number[] = [];
    // v0.7.26 M6 parity — after L1 escalation, if stopReason remains
    // max_tokens with text, the L5 continuation ladder re-streams up to
    // KODAX_MAX_MAXTOKENS_RETRIES times with a synthetic "Continue" user
    // message appended. Script enough responses to satisfy the whole
    // ladder so the adapter settles naturally.
    registerScriptedProvider(
      [
        { textBlocks: [], stopReason: 'max_tokens' },
        // Escalated turn: max_tokens + has text → triggers L5 continuation.
        { textBlocks: [{ type: 'text', text: 'half' }], stopReason: 'max_tokens' },
        // L5 retries surface more text and eventually end_turn.
        { textBlocks: [{ type: 'text', text: ' second' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    // Budgets: L1 capped → L1 escalated → L5 continuation (cleared override).
    // L1 escalation is idempotent (the 64K escalation fires exactly once in
    // positions [1]); subsequent L5 calls reuse whatever effective budget
    // is active at invocation time.
    expect(observedBudgets[0]).toBe(KODAX_CAPPED);
    expect(observedBudgets[1]).toBe(KODAX_ESCALATED);
    // L5 continuation accumulates text across retries.
    expect(result.text).toContain('half');
  }, 15_000);

  it('declares replace for escalation and append for L5 continuation', async () => {
    const observedBudgets: number[] = [];
    const segments: Array<{
      responseId: string;
      providerRequestId: string;
      mode: 'replace' | 'append';
    }> = [];
    registerScriptedProvider(
      [
        { textBlocks: [], stopReason: 'max_tokens' },
        { textBlocks: [{ type: 'text', text: 'half' }], stopReason: 'max_tokens' },
        { textBlocks: [{ type: 'text', text: ' second' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      events: {
        onOutputSegmentStart: (segment) => segments.push(segment),
      },
    });
    await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    expect(segments.map((segment) => segment.mode)).toEqual(['append', 'replace', 'append']);
    expect(new Set(segments.map((segment) => segment.responseId)).size).toBe(1);
    expect(new Set(segments.map((segment) => segment.providerRequestId)).size).toBe(3);
  }, 15_000);

  it('keeps streamed L5 partial text when the continuation request fails', async () => {
    let streamCalls = 0;
    const textDeltas: string[] = [];
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
      };

      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        streamCalls += 1;
        if (streamCalls === 1) {
          return { textBlocks: [], toolBlocks: [], stopReason: 'max_tokens' };
        }
        if (streamCalls === 2) {
          return {
            textBlocks: [{ type: 'text', text: 'half' }],
            toolBlocks: [],
            stopReason: 'max_tokens',
          };
        }
        streamOptions?.onTextDelta?.(' streamed tail');
        throw new Error('continuation transport failed');
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      events: { onTextDelta: (text) => textDeltas.push(text) },
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    expect(streamCalls).toBe(3);
    expect(textDeltas).toEqual([' streamed tail']);
    expect(result.text).toBe('half streamed tail');
  }, 15_000);

  it('honors KODAX_MAX_OUTPUT_TOKENS env override and skips escalation', async () => {
    process.env.KODAX_MAX_OUTPUT_TOKENS = '32000';
    const observedBudgets: number[] = [];
    // With the env override pinned, L1 escalation is skipped (explicit
    // user intent). L5 continuation still fires on max_tokens + text,
    // so script enough responses for the ladder.
    registerScriptedProvider(
      [
        { textBlocks: [{ type: 'text', text: 'stuck at user budget' }], stopReason: 'max_tokens' },
        { textBlocks: [{ type: 'text', text: ' resumed' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'anything' }],
      { name: 'scout', instructions: '' },
    );

    // L1 never fires (KODAX_ESCALATED is absent from observedBudgets).
    expect(observedBudgets.every((b) => b !== KODAX_ESCALATED)).toBe(true);
    expect(result.text).toContain('stuck at user budget');
  }, 15_000);

  // MED-5: when the provider keeps returning max_tokens + text for every L5
  // retry, the adapter MUST bail out after KODAX_MAX_MAXTOKENS_RETRIES
  // iterations instead of looping forever. Regression guard for the
  // `l5Retries < KODAX_MAX_MAXTOKENS_RETRIES` break in runner-driven.ts.
  it('MED-5: L5 continuation breaks out after KODAX_MAX_MAXTOKENS_RETRIES and returns partial text', async () => {
    const { KODAX_MAX_MAXTOKENS_RETRIES } = await import('../constants.js');
    const observedBudgets: number[] = [];
    const responses: Array<{ textBlocks: { type: 'text'; text: string }[]; stopReason?: string }> = [
      // Call 1: capped budget → max_tokens empty triggers L1 escalation.
      { textBlocks: [], stopReason: 'max_tokens' },
      // Call 2: escalated budget, max_tokens + text → enters L5 loop.
      { textBlocks: [{ type: 'text', text: 'half' }], stopReason: 'max_tokens' },
    ];
    // Calls 3..(2 + KODAX_MAX_MAXTOKENS_RETRIES): every L5 retry ALSO
    // returns max_tokens + text so the break must fire, not end_turn.
    for (let i = 0; i < KODAX_MAX_MAXTOKENS_RETRIES; i += 1) {
      responses.push({
        textBlocks: [{ type: 'text', text: ` chunk${i + 1}` }],
        stopReason: 'max_tokens',
      });
    }
    // Guard: one extra response beyond the cap — if the loop keeps going
    // it will consume this, and `responses` will run out → throw. We
    // assert later that this extra entry is NEVER consumed.
    const sentinelMarker = 'SHOULD_NEVER_APPEAR';
    responses.push({
      textBlocks: [{ type: 'text', text: sentinelMarker }],
      stopReason: 'max_tokens',
    });

    registerScriptedProvider(responses, observedBudgets);

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'very large' }],
      { name: 'scout', instructions: '' },
    );

    // Exactly (1 capped + 1 escalated + KODAX_MAX_MAXTOKENS_RETRIES) calls.
    expect(observedBudgets.length).toBe(2 + KODAX_MAX_MAXTOKENS_RETRIES);
    // Sentinel never consumed — the break did its job.
    expect(result.text).not.toContain(sentinelMarker);
    // Partial accumulated text is returned instead of crashing.
    expect(result.text).toContain('half');
    for (let i = 1; i <= KODAX_MAX_MAXTOKENS_RETRIES; i += 1) {
      expect(result.text).toContain(`chunk${i}`);
    }
  }, 15_000);

  // L5 continuation meta message must match the Claude Code wording used by
  // agent.ts (cd213e4). Legacy "Continue from where you left off." was weaker;
  // the richer phrasing nudges the model to break remaining work into smaller
  // pieces so the continuation doesn't hit the same wall as the cut-off turn.
  it('L5 continuation injects the Claude Code style meta message', async () => {
    const observedBudgets: number[] = [];
    const capturedMessagesPerCall: Array<readonly import('@kodax-ai/llm').KodaXMessage[]> = [];
    const responses: Array<{ textBlocks: { type: 'text'; text: string }[]; stopReason?: string }> = [
      // Turn 1 returns max_tokens with text — after L1 escalation (which
      // doesn't fire here because first turn already at capped budget
      // returns max_tokens; escalation kicks in for turn 2).
      { textBlocks: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens' },
      // L1 escalation turn — still max_tokens with text → L5 continuation fires.
      { textBlocks: [{ type: 'text', text: 'half' }], stopReason: 'max_tokens' },
      // L5 continuation call finishes.
      { textBlocks: [{ type: 'text', text: ' done' }], stopReason: 'end_turn' },
    ];
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(
        messages: import('@kodax-ai/llm').KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        observedBudgets.push(
          streamOptions?.maxOutputTokensOverride ?? this.getEffectiveMaxOutputTokens(),
        );
        capturedMessagesPerCall.push([...messages]);
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        return {
          textBlocks: resp.textBlocks,
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: resp.stopReason,
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Big task.' }],
      { name: 'scout', instructions: '' },
    );

    // By the third stream call the adapter must have injected the meta
    // message on the provider messages. Scan all subsequent calls after
    // the first one — the L5-style user message must appear.
    const allInjectedTexts = capturedMessagesPerCall
      .slice(1)
      .flatMap((msgs) => msgs)
      .filter((m) => m.role === 'user')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    const hasClaudeCodeWording = allInjectedTexts.some((t) =>
      t.includes('Resume directly')
      && t.includes('no apology, no recap')
      && t.includes('Break remaining work into smaller pieces'),
    );
    expect(hasClaudeCodeWording).toBe(true);
    // And the legacy phrasing must NOT appear — otherwise the upgrade
    // silently regressed.
    expect(allInjectedTexts.some((t) => t === 'Continue from where you left off.')).toBe(false);
  }, 15_000);

  // Regression: escalation is a same-turn re-issue, not an error recovery.
  // Before the `attempt -= 1` fix, the L1 escalation silently consumed one
  // slot of `resilienceCfg.maxRetries`, so a subsequent real error passed
  // the wrong attempt number into the coordinator (leaking 1 retry worth
  // of budget). Concretely: a retryable error immediately after escalation
  // should be seen by `onProviderRecovery` with `attempt === 1`, because
  // the escalation did not consume any retry slot.
  it('L1 escalation does not consume recovery retry budget (onProviderRecovery sees attempt=1 after escalate+throw)', async () => {
    const observedBudgets: number[] = [];
    const recoveryAttempts: number[] = [];
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = ESCALATION_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: ESCALATION_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: KODAX_CAPPED,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(
        _messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
      ): Promise<KodaXStreamResult> {
        observedBudgets.push(
          streamOptions?.maxOutputTokensOverride ?? this.getEffectiveMaxOutputTokens(),
        );
        callIdx += 1;
        // Call 1: capped budget hit, forces L1 escalation.
        if (callIdx === 1) {
          return {
            textBlocks: [],
            toolBlocks: [],
            thinkingBlocks: [],
            stopReason: 'max_tokens',
          };
        }
        // Call 2: now at escalated budget — throw a retryable
        // connection_failure mid-stream to force the recovery
        // coordinator path. The coordinator receives `attempt` as an
        // argument; with the fix in place it must be 1 (fresh budget
        // after a successful L1 escalation). Without the fix it would
        // be 2 (leaked slot) and the ladder would pick a different
        // action (non_streaming_fallback instead of stable_boundary_retry).
        if (callIdx === 2) {
          throw new Error('zhipu-coding API error: terminated');
        }
        // Call 3 onward: recovery retry succeeds.
        return {
          textBlocks: [{ type: 'text', text: 'recovered ok' }],
          toolBlocks: [],
          thinkingBlocks: [],
          stopReason: 'end_turn',
        };
      }
    }
    process.env[ESCALATION_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(ESCALATION_PROVIDER_NAME, () => new Scripted());

    const adapter = buildRunnerLlmAdapter({
      ...makeAdapterOptions(),
      events: {
        onProviderRecovery: (evt) => {
          recoveryAttempts.push(evt.attempt);
        },
      },
    });
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'work' }],
      { name: 'scout', instructions: '' },
    );

    // Budgets observed: call 1 at capped, call 2 at escalated, call 3 at escalated (after recovery).
    expect(observedBudgets[0]).toBe(KODAX_CAPPED);
    expect(observedBudgets[1]).toBe(KODAX_ESCALATED);
    // The coordinator recovery event must have seen attempt=1 — proving that
    // the escalation did NOT consume a retry slot. Without the fix this
    // would be 2.
    expect(recoveryAttempts).toEqual([1]);
    expect(result.text).toContain('recovered ok');
  }, 15_000);
});

describe('buildRunnerLlmAdapter — empty-completion retry', () => {
  // A finish_reason-complete turn carrying no text, no tool calls, and no
  // thinking is a degraded response (common on budget OpenAI-compat
  // providers under load / right after a 429). The runner's no-tool
  // terminal branch would otherwise misread it as a clean text-only task
  // completion and end the task silently. The adapter re-streams the same
  // turn a bounded number of times. A canonical text-only termination
  // (text present, no tool) must be left untouched — FEATURE_190.
  const EMPTY_PROVIDER_NAME = 'runner-driven-empty-completion-test';
  const EMPTY_PROVIDER_API_KEY_ENV = 'RUNNER_DRIVEN_EMPTY_COMPLETION_TEST_API_KEY';

  let KodaXBaseProviderRef: typeof import('@kodax-ai/llm').KodaXBaseProvider;
  let registerModelProviderFn: typeof import('@kodax-ai/llm').registerModelProvider;
  let clearRuntimeModelProvidersFn: typeof import('@kodax-ai/llm').clearRuntimeModelProviders;

  beforeAll(async () => {
    const aiModule = await import('@kodax-ai/llm');
    KodaXBaseProviderRef = aiModule.KodaXBaseProvider;
    registerModelProviderFn = aiModule.registerModelProvider;
    clearRuntimeModelProvidersFn = aiModule.clearRuntimeModelProviders;
  });

  afterEach(() => {
    clearRuntimeModelProvidersFn();
    delete process.env[EMPTY_PROVIDER_API_KEY_ENV];
  });

  interface ScriptedTurn {
    textBlocks?: { type: 'text'; text: string }[];
    toolBlocks?: KodaXToolUseBlock[];
    thinkingBlocks?: { type: 'thinking'; thinking: string }[];
    stopReason?: string;
  }

  function registerScriptedProvider(turns: ScriptedTurn[], callLog: number[]): void {
    let callIdx = 0;
    class Scripted extends KodaXBaseProviderRef {
      readonly name = EMPTY_PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: EMPTY_PROVIDER_API_KEY_ENV,
        model: 'scripted',
        supportsThinking: false,
        reasoningCapability: 'prompt-only' as const,
        maxOutputTokens: 8192,
        capabilityProfile: {
          transport: 'native-api' as const,
          conversationSemantics: 'full-history' as const,
          mcpSupport: 'none' as const,
          contextFidelity: 'full' as const,
          toolCallingFidelity: 'full' as const,
          sessionSupport: 'stateless' as const,
          longRunningSupport: 'limited' as const,
          multimodalSupport: 'none' as const,
          evidenceSupport: 'limited' as const,
        },
      };
      async stream(): Promise<any> {
        callLog.push(++callIdx);
        const turn = turns[callIdx - 1];
        if (!turn) throw new Error(`No scripted turn for stream call #${callIdx}`);
        return {
          textBlocks: turn.textBlocks ?? [],
          toolBlocks: turn.toolBlocks ?? [],
          thinkingBlocks: turn.thinkingBlocks ?? [],
          stopReason: turn.stopReason ?? 'stop',
        };
      }
    }
    process.env[EMPTY_PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProviderFn(EMPTY_PROVIDER_NAME, () => new Scripted());
  }

  function makeEmptyAdapterOptions(): KodaXOptions {
    return { ...makeOptions(), provider: EMPTY_PROVIDER_NAME };
  }

  it('re-streams on a fully-empty turn, then returns the recovered turn', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        { textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'stop' },
        { textBlocks: [{ type: 'text', text: 'recovered answer' }], stopReason: 'stop' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(2); // original empty + 1 retry
    expect(result.text).toBe('recovered answer');
  }, 15_000);

  it('re-streams on a thinking-only turn, then returns the recovered public answer', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        {
          textBlocks: [],
          toolBlocks: [],
          thinkingBlocks: [{ type: 'thinking', thinking: 'The user greeted me; answer briefly.' }],
          stopReason: 'end_turn',
        },
        { textBlocks: [{ type: 'text', text: 'hello there' }], stopReason: 'end_turn' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(2);
    expect(result.text).toBe('hello there');
  }, 15_000);

  it('re-streams when text is only whitespace even if thinking is present', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        {
          textBlocks: [{ type: 'text', text: ' \n\t ' }],
          toolBlocks: [],
          thinkingBlocks: [{ type: 'thinking', thinking: 'I know the answer.' }],
          stopReason: 'end_turn',
        },
        { textBlocks: [{ type: 'text', text: 'visible answer' }], stopReason: 'end_turn' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(2);
    expect(result.text).toBe('visible answer');
  }, 15_000);

  it('gives up after KODAX_MAX_EMPTY_COMPLETION_RETRIES and fails locally', async () => {
    const { KODAX_MAX_EMPTY_COMPLETION_RETRIES } = await import('../constants.js');
    const callLog: number[] = [];
    const turns: ScriptedTurn[] = [];
    // original + cap retries all empty.
    for (let i = 0; i < KODAX_MAX_EMPTY_COMPLETION_RETRIES + 1; i += 1) {
      turns.push({ textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'stop' });
    }
    // Sentinel beyond the cap — must NEVER be consumed.
    turns.push({ textBlocks: [{ type: 'text', text: 'SHOULD_NEVER_APPEAR' }], stopReason: 'stop' });
    registerScriptedProvider(turns, callLog);

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    await expect(adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    )).rejects.toThrow(/no user-visible text or tool calls/);

    // original (1) + cap retries — sentinel never reached.
    expect(callLog.length).toBe(KODAX_MAX_EMPTY_COMPLETION_RETRIES + 1);
  }, 15_000);

  it('does NOT retry a canonical text-only termination (FEATURE_190 guard)', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        { textBlocks: [{ type: 'text', text: 'final text-only answer' }], stopReason: 'stop' },
        { textBlocks: [{ type: 'text', text: 'SHOULD_NEVER_APPEAR' }], stopReason: 'stop' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(1); // no retry — text present
    expect(result.text).toBe('final text-only answer');
  }, 15_000);

  it('does NOT retry a turn that has tool calls but no text', async () => {
    const callLog: number[] = [];
    registerScriptedProvider(
      [
        {
          textBlocks: [],
          toolBlocks: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
          thinkingBlocks: [{ type: 'thinking', thinking: 'Need to read first.' }],
          stopReason: 'tool_use',
        },
        { textBlocks: [{ type: 'text', text: 'SHOULD_NEVER_APPEAR' }], stopReason: 'stop' },
      ],
      callLog,
    );

    const adapter = buildRunnerLlmAdapter(makeEmptyAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do work' }],
      { name: 'scout', instructions: '' },
    );

    expect(callLog.length).toBe(1); // tool call present → not empty → no retry
    expect(result.toolCalls.length).toBe(1);
  }, 15_000);
});

describe('runManagedTaskViaRunner — end-to-end', () => {
  // FEATURE_193 v0.7.43: Scout H0_DIRECT emit_scout_verdict flow it deleted (V1 chain retired — Scout role + emit_scout_verdict tool retired)

  it('applies an explicit user preference immediately through the AMA Memory control plane', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-memory-loop-'));
    const sessionId = 'runner-explicit-memory-intent';
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-runner-memory',
      workspaceId: 'workspace-runner-memory',
      userId: 'user-runner-memory',
      agentId: 'kodax-coding',
      projectId: 'project-runner-memory',
      sessionId,
    };
    let sessionData: KodaXSessionData | null = null;
    let reviewedInput: UnifiedLearningReviewModelInput | undefined;
    let outcome:
      | { readonly digest: KodaXMemoryOutcomeDigest; readonly jobId?: string }
      | undefined;
    const receipts: Array<{ readonly proposalIds: readonly string[] }> = [];
    const notices: Array<{
      readonly summaries: readonly string[];
      readonly proposalIds: readonly string[];
    }> = [];
    const storage = {
      load: async (id: string) => id === sessionId ? sessionData : null,
      save: async (id: string, data: KodaXSessionData) => {
        if (id === sessionId) sessionData = data;
      },
      mutateLineage: async (
        id: string,
        mutation: (
          lineage: import('@kodax-ai/agent').KodaXSessionLineage,
        ) => import('@kodax-ai/agent').KodaXSessionLineage,
      ) => {
        if (id !== sessionId || sessionData === null) return false;
        const lineage = sessionData.lineage ?? createSessionLineage(sessionData.messages);
        sessionData = { ...sessionData, lineage: mutation(lineage) };
        return true;
      },
      list: async () => sessionData === null
        ? []
        : [{ id: sessionId, title: sessionData.title, msgCount: sessionData.messages.length }],
    };
    let turn = 0;
    const durableRequest =
      'From now on, remember to inspect code and tests before trusting status documents.';
    const explicitPrompt = `${'Background context. '.repeat(40)}${durableRequest}`;

    try {
      const result = await runManagedTaskViaRunner({
        ...makeOptions(),
        context: {
          ...makeOptions().context,
          executionCwd: home,
          gitRoot: home,
          configHome: home,
          memoryIdentity: identity,
        },
        session: { id: sessionId, storage },
        learningReviewer: async (input) => {
          reviewedInput = input;
          return {
            memoryPlan: {
              trigger: input.memory.trigger,
              createdAt: '2026-07-29T04:00:00.000Z',
              sourceRefs: input.memory.sourceRefs,
              candidateRefs: input.memory.candidateRefs,
              actions: [{
                action: 'write_memdir',
                targetRefIds: [],
                summary: 'Remember verification preference',
                rationale: 'The user explicitly requested this preference.',
                confidence: 'high',
                risk: 'low',
                requiresApproval: true,
                claimKind: 'preference',
                claimKey: 'verify-code-before-documentation',
                proposedBody: 'inspect code and tests before trusting status documents.',
              }],
              warnings: [],
            },
            capabilityDecision: {
              disposition: 'discard',
              reasonCodes: ['preference_belongs_in_memory'],
            },
          };
        },
        events: {
          onMemoryOutcomeDigest: (digest, metadata) => {
            outcome = { digest, ...metadata };
          },
          onMemoryReviewReceipt: (receipt) => {
            receipts.push({ proposalIds: receipt.proposalIds });
          },
          onMemoryNotice: (notice) => {
            notices.push({
              summaries: notice.summaries,
              proposalIds: notice.proposalIds,
            });
          },
        },
      }, explicitPrompt, async () => {
        turn += 1;
        return turn === 1
          ? {
              textBlocks: [],
              toolBlocks: [{
                type: 'tool_use',
                id: 'remember-user-preference',
                name: 'memory_intent',
                input: {
                  operation: 'remember',
                  statement: 'inspect code and tests before trusting status documents.',
                  userQuote: durableRequest,
                  claimKind: 'preference',
                  claimKey: 'verify-code-before-documentation',
                },
              }],
            }
          : {
              textBlocks: [{ text: '这条偏好已经记住。' }],
              toolBlocks: [],
            };
      });

      expect(result.success).toBe(true);
      expect(outcome).toBeDefined();
      expect(outcome?.digest.handledMemoryOperations).toMatchObject([{
        operation: 'remember',
        claimKey: 'verify-code-before-documentation',
      }]);
      await vi.waitFor(() => expect(receipts).toHaveLength(1), { timeout: 5_000 });
      expect(receipts).toEqual([{ proposalIds: [] }]);
      expect(notices).toEqual([]);
      expect(reviewedInput).toBeDefined();
      const proposalStore = await readLearningProposalStore(
        resolveLearningProposalStore(home, home),
      );
      expect(proposalStore.proposals).toMatchObject([{ status: 'approved', approvedBy: 'host' }]);

      const controller = createMemoryControlPlane({
        cwd: home,
        identity,
        projectDocs: [],
        discoverSkills: false,
      });
      const applied = (await controller.listRefs({ kinds: ['memdir'] }))[0];
      expect(applied).toMatchObject({ claimKind: 'preference', owner: 'user', lifecycle: 'active' });
      const appliedStorageUri = applied?.storageUri;
      await expect(readFile(appliedStorageUri ?? '', 'utf8')).resolves.toContain(
        'inspect code and tests before trusting status documents.',
      );
      expect(sessionData?.lineage?.entries ?? []).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'memory_outcome_digest' }),
      ]));
    } finally {
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }, 30_000);

  it('binds AMA memory_intent to a queued user turn', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-memory-follow-up-'));
    const sessionId = 'runner-memory-follow-up';
    const queueAgentId = `actor:${sessionId}:/root`;
    const followUp = 'From now on, remember to run focused tests before reporting success.';
    let call = 0;
    let outcome: KodaXMemoryOutcomeDigest | undefined;
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-runner-follow-up',
      agentId: 'kodax-coding',
      projectId: 'project-runner-follow-up',
      sessionId,
    };
    try {
      const result = await runManagedTaskViaRunner({
        ...makeOptions(),
        session: { id: sessionId },
        memoryReviewer: async (input) => ({
          trigger: input.trigger,
          createdAt: '2026-07-29T05:00:00.000Z',
          sourceRefs: input.sourceRefs,
          candidateRefs: input.candidateRefs,
          actions: [],
          warnings: [],
        }),
        context: {
          ...makeOptions().context,
          configHome: home,
          executionCwd: home,
          gitRoot: home,
          memoryIdentity: identity,
          interruptInput: {
            closeInputWindow() {},
            reopenInputWindow() {},
          },
        },
        events: {
          onMemoryOutcomeDigest(digest) {
            outcome = digest;
          },
        },
      }, 'Inspect the current implementation.', async () => {
        call += 1;
        if (call === 1) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: followUp,
          });
          return { textBlocks: [{ text: 'Initial answer.' }], toolBlocks: [] };
        }
        if (call === 2) {
          return {
            textBlocks: [],
            toolBlocks: [{
              type: 'tool_use',
              id: 'remember-queued-user-turn',
              name: 'memory_intent',
              input: {
                operation: 'remember',
                statement: 'run focused tests before reporting success.',
                userQuote: followUp,
                claimKind: 'procedure',
                claimKey: 'project.procedure.report-verification',
              },
            }],
          };
        }
        return { textBlocks: [{ text: 'Queued preference captured.' }], toolBlocks: [] };
      });

      expect(result.success).toBe(true);
      expect(outcome).toBeDefined();
      const controller = createMemoryControlPlane({ cwd: home, identity, discoverSkills: false });
      expect(await controller.listRefs({ kinds: ['memdir'] })).toHaveLength(1);
    } finally {
      getMessageQueue().clear();
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps an immediately applied AMA Memory when the episode is later aborted', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-memory-cancelled-'));
    const sessionId = 'runner-memory-cancelled';
    const userRequest = 'Going forward, remember to run focused tests before reporting success.';
    const abortController = new AbortController();
    let call = 0;
    let outcome: KodaXMemoryOutcomeDigest | undefined;
    const reviewTriggers: string[] = [];
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-runner-cancelled',
      agentId: 'kodax-coding',
      projectId: 'project-runner-cancelled',
      sessionId,
    };
    try {
      const run = runManagedTaskViaRunner({
        ...makeOptions(),
        abortSignal: abortController.signal,
        session: { id: sessionId },
        memoryReviewer: async (input) => {
          reviewTriggers.push(input.trigger);
          return {
            trigger: input.trigger,
            createdAt: '2026-07-29T07:00:00.000Z',
            sourceRefs: input.sourceRefs,
            candidateRefs: input.candidateRefs,
            actions: [],
            warnings: [],
          };
        },
        context: {
          ...makeOptions().context,
          configHome: home,
          executionCwd: home,
          gitRoot: home,
          memoryIdentity: identity,
        },
        events: {
          onMemoryOutcomeDigest(digest) {
            outcome = digest;
          },
        },
      }, userRequest, async () => {
        call += 1;
        if (call === 1) {
          return {
            textBlocks: [],
            toolBlocks: [{
              type: 'tool_use',
              id: 'remember-before-ama-abort',
              name: 'memory_intent',
              input: {
                operation: 'remember',
                statement: 'run focused tests before reporting success.',
                userQuote: userRequest,
                claimKind: 'procedure',
                claimKey: 'project.procedure.report-verification',
              },
            }],
          };
        }
        const error = new Error('managed run interrupted after intent capture');
        error.name = 'AbortError';
        throw error;
      });

      await expect(run).rejects.toThrow('managed run interrupted after intent capture');
      expect(outcome).toBeUndefined();
      expect(reviewTriggers).not.toContain('episode_completed');
      const controller = createMemoryControlPlane({ cwd: home, identity, discoverSkills: false });
      expect(await controller.listRefs({ kinds: ['memdir'] })).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);

  it('reviews a completed AMA episode even when the LLM does not call memory_intent', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-memory-fallback-'));
    const sessionId = 'runner-memory-fallback';
    const identity: MemoryContextIdentity = {
      configHome: home,
      tenantId: 'tenant-runner-fallback',
      workspaceId: 'workspace-runner-fallback',
      userId: 'user-runner-fallback',
      agentId: 'kodax-coding',
      projectId: 'project-runner-fallback',
      sessionId,
    };
    let sessionData: KodaXSessionData | null = null;
    let reviewedInput: UnifiedLearningReviewModelInput | undefined;
    let outcome:
      | { readonly digest: KodaXMemoryOutcomeDigest; readonly jobId?: string }
      | undefined;
    const receipts: Array<{
      readonly jobId?: string;
      readonly proposalIds: readonly string[];
    }> = [];
    const storage = {
      load: async (id: string) => id === sessionId ? sessionData : null,
      save: async (id: string, data: KodaXSessionData) => {
        if (id === sessionId) sessionData = data;
      },
      mutateLineage: async (
        id: string,
        mutation: (
          lineage: import('@kodax-ai/agent').KodaXSessionLineage,
        ) => import('@kodax-ai/agent').KodaXSessionLineage,
      ) => {
        if (id !== sessionId || sessionData === null) return false;
        const lineage = sessionData.lineage ?? createSessionLineage(sessionData.messages);
        sessionData = { ...sessionData, lineage: mutation(lineage) };
        return true;
      },
      list: async () => sessionData === null
        ? []
        : [{ id: sessionId, title: sessionData.title, msgCount: sessionData.messages.length }],
    };

    try {
      const result = await runManagedTaskViaRunner({
        ...makeOptions(),
        context: {
          ...makeOptions().context,
          executionCwd: home,
          gitRoot: home,
          configHome: home,
          memoryIdentity: identity,
        },
        session: { id: sessionId, storage },
        learningReviewer: async (input) => {
          reviewedInput = input;
          return {
            memoryPlan: {
              trigger: input.memory.trigger,
              createdAt: '2026-07-29T04:00:00.000Z',
              sourceRefs: input.memory.sourceRefs,
              candidateRefs: input.memory.candidateRefs,
              actions: [],
              warnings: [],
            },
            capabilityDecision: {
              disposition: 'discard',
              reasonCodes: ['no_reusable_learning'],
            },
          };
        },
        events: {
          onMemoryOutcomeDigest: (digest, metadata) => {
            outcome = { digest, ...metadata };
          },
          onMemoryReviewReceipt: (receipt) => {
            receipts.push({
              jobId: receipt.jobId,
              proposalIds: receipt.proposalIds,
            });
          },
        },
      }, '我记得昨天已经核对过文档', async () => ({
        textBlocks: [{
          text: '这句话是在叙述过去，不是要求我创建长期记忆。',
        }],
        toolBlocks: [],
      }));

      expect(result.success).toBe(true);
      expect(outcome?.digest.memoryIntent).toBeUndefined();
      expect(outcome?.jobId).toMatch(/^[a-f0-9]{64}$/);
      await vi.waitFor(() => expect(receipts).toHaveLength(1), { timeout: 5_000 });
      expect(receipts[0]).toEqual({
        jobId: outcome?.jobId,
        proposalIds: [],
      });
      expect(reviewedInput?.memory.trigger).toBe('episode_completed');
      expect(reviewedInput?.evidence.outcomeDigest.objective)
        .toBe('我记得昨天已经核对过文档');
      expect(sessionData?.lineage?.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'memory_outcome_digest',
          jobId: outcome?.jobId,
        }),
        expect.objectContaining({
          type: 'memory_review_receipt',
          jobId: outcome?.jobId,
        }),
      ]));
      await vi.waitFor(async () => {
        const pending = await listPendingEpisodeReviews(identity);
        expect(pending).toHaveLength(0);
      }, { timeout: 5_000 });
    } finally {
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }, 20_000);

  it('runs configured guardrails before permission and execution on the managed path', async () => {
    const order: string[] = [];
    let turn = 0;
    const options: KodaXOptions = {
      ...makeOptions(),
      guardrails: [{
        kind: 'tool',
        name: 'managed-order',
        beforeTool: async () => {
          order.push('guardrail');
          return { action: 'allow' as const };
        },
      }],
      events: {
        beforeToolExecute: async () => {
          order.push('permission');
          return true;
        },
        onToolResult: () => {
          order.push('execute');
        },
      },
    };

    const result = await runManagedTaskViaRunner(
      options,
      'Read the project README',
      async () => {
        turn += 1;
        return turn === 1
          ? {
              textBlocks: [],
              toolBlocks: [{
                type: 'tool_use',
                id: 'managed-read-order',
                name: 'read',
                input: { path: path.join(process.cwd(), 'README.md'), limit: 1 },
              }],
            }
          : { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      },
    );

    expect(result.success).toBe(true);
    expect(order).toEqual(['guardrail', 'permission', 'execute']);
  });

  it('handles a zero-tool direct answer (Worker answers without emit)', async () => {
    // Edge case: a minimalist Worker that just returns the answer as text.
    // The run still completes; managedTask is populated with defaults (harness=H0_DIRECT).
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Say hello',
      async () => ({ textBlocks: [{ text: 'Hello, world.' }], toolBlocks: [] }),
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Hello, world.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
  });

  it('injects the current Actor capacity as dynamic context outside System', async () => {
    const controller = await createAgentActorController();
    testActorControllers.push(controller);
    const options = makeOptions();
    options.context = {
      ...options.context,
      actorControl: controller.bind('/root'),
    };
    let systemPrompt = '';
    let transcript: readonly KodaXMessage[] = [];
    let ephemeralSuffix: KodaXEphemeralSuffix | undefined;

    try {
      await runManagedTaskViaRunner(
        options,
        'Review five independent dimensions.',
        async (messages, _tools, system, suffix) => {
          transcript = messages;
          systemPrompt = system;
          ephemeralSuffix = suffix;
          return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
        },
      );

      expect(ephemeralSuffix).toBeUndefined();
      const managedContext = transcript.find((message) =>
        message._source === 'managed-run-context');
      expect(managedContext?.content).toContain('This Actor tree has 4 total concurrency slots');
      expect(managedContext?.content).toContain('0 non-root turns are active');
      expect(managedContext?.content).toContain('3 child start slots are available');
      expect(managedContext?._synthetic).toBe(true);
      expect(transcript.indexOf(managedContext!)).toBeLessThan(
        transcript.findIndex((message) => message._synthetic !== true && message.role === 'user'),
      );
      expect(systemPrompt).not.toContain('ACTOR CAPACITY (authoritative runtime fact):');
    } finally {
      await controller.shutdown('test complete');
    }
  });

  it('refreshes changed Actor capacity before the next provider call', async () => {
    const sessionId = 'actor-capacity-delta-order';
    const queueAgentId = `actor:${sessionId}:/root`;
    const executor: AgentTurnExecutor = {
      execute: async ({ signal }) => new Promise((resolve) => {
        const finish = () => resolve({ output: 'interrupted' });
        if (signal.aborted) {
          finish();
        } else {
          signal.addEventListener('abort', finish, { once: true });
        }
      }),
    };
    const controller = await createAgentActorController({ executor });
    testActorControllers.push(controller);
    const options = {
      ...makeOptions(),
      session: { id: sessionId },
    };
    options.context = {
      ...options.context,
      actorControl: controller.bind('/root'),
    };
    const suffixes: Array<KodaXEphemeralSuffix | undefined> = [];
    const transcripts: Array<readonly KodaXMessage[]> = [];
    let call = 0;

    try {
      await runManagedTaskViaRunner(
        options,
        'Run one parallel review.',
        async (messages, _tools, _system, suffix) => {
          transcripts.push([...messages]);
          suffixes.push(suffix);
          call += 1;
          if (call === 1) {
            getMessageQueue().enqueue({
              agentId: queueAgentId,
              priority: 'user',
              mode: 'prompt',
              content: 'Keep this correction as the latest context.',
            });
            return {
              textBlocks: [],
              toolBlocks: [{
                type: 'tool_use',
                id: 'spawn-cache-state',
                name: 'spawn_agent',
                input: {
                  task_name: 'cache-state-lane',
                  objective: 'Wait until the parent observes capacity.',
                },
              }],
            };
          }
          if (call === 2) {
            return {
              textBlocks: [],
              toolBlocks: [{
                type: 'tool_use',
                id: 'interrupt-cache-state',
                name: 'interrupt_agent',
                input: { target: '/root/cache-state-lane' },
              }],
            };
          }
          return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
        },
      );

      expect(suffixes.every((suffix) => suffix === undefined)).toBe(true);
      expect(transcripts[0]?.find((message) => message._source === 'managed-run-context')?.content)
        .toContain('0 non-root turns are active');
      expect(transcripts[1]?.find((message) => message._source === 'managed-runtime-context')?.content)
        .toContain('1 non-root turns are active');
      const deltaIndex = transcripts[1]?.findIndex((message) =>
        message._source === 'managed-runtime-context') ?? -1;
      const correctionIndex = transcripts[1]?.findIndex((message) => (
        message.role === 'user'
        && message._synthetic !== true
        && JSON.stringify(message.content).includes('Keep this correction')
      )) ?? -1;
      expect(deltaIndex).toBeGreaterThanOrEqual(0);
      expect(correctionIndex).toBeGreaterThan(deltaIndex);
      expect(transcripts[1]?.at(-1)?.content).toContain('Keep this correction');
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      });
      await controller.shutdown('test complete');
    }
  });

  it('does not append runtime context when the managed state is unchanged', async () => {
    const transcripts: Array<readonly KodaXMessage[]> = [];
    let call = 0;

    await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: { id: 'stable-runtime-context-session' },
      },
      'Read one line, then finish.',
      async (messages) => {
        transcripts.push([...messages]);
        call += 1;
        return call === 1
          ? {
              textBlocks: [],
              toolBlocks: [{
                type: 'tool_use',
                id: 'read-with-stable-runtime-context',
                name: 'read',
                input: { path: path.join(process.cwd(), 'README.md'), limit: 1 },
              }],
            }
          : { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      },
    );

    expect(transcripts).toHaveLength(2);
    expect(transcripts[1]?.filter((message) => (
      message._source === 'managed-run-context'
      || message._source === 'managed-runtime-context'
    ))).toHaveLength(1);
    expect(transcripts[1]?.some((message) =>
      message._source === 'managed-runtime-context')).toBe(false);
  });

  it('attributes strategy tools to the initial production Runner Turn', async () => {
    const executor: AgentTurnExecutor = {
      execute: async () => ({ output: 'strategy lane complete' }),
    };
    const controller = await createAgentActorController({ executor });
    testActorControllers.push(controller);
    const root = controller.bind('/root');
    const startedTurnIds: string[] = [];
    const options: KodaXOptions = {
      ...makeOptions(),
      context: {
        ...makeOptions().context,
        actorControl: root,
        interruptInput: {
          closeInputWindow() {},
          reopenInputWindow() {},
        },
      },
      events: {
        onTurnStarted: (event) => startedTurnIds.push(event.turnId),
      },
    };
    let call = 0;

    await runManagedTaskViaRunner(options, 'Run one attributed strategy lane.', async () => {
      call += 1;
      return call === 1
        ? {
            textBlocks: [],
            toolBlocks: [{
              type: 'tool_use',
              id: 'spawn-attributed-1',
              name: 'spawn_agent',
              input: {
                task_name: 'attributed-lane',
                objective: 'Inspect one independent dimension.',
                quality_strategy: {
                  schemaVersion: 1,
                  stageId: 'initial-stage',
                  pattern: 'fan-out-and-synthesize',
                  role: 'investigator',
                  laneRelation: 'coverage',
                },
              },
            }],
          }
        : { textBlocks: [{ text: 'Integrated.' }], toolBlocks: [] };
    });

    expect(root.get('/root/attributed-lane').turns[0]?.metadata?.qualityStrategy)
      .toMatchObject({
        ownerTurnRef: {
          actorPath: '/root',
          turnId: startedTurnIds[0],
        },
      });
  });

  it('rotates strategy ownership to the queued production Runner Turn', async () => {
    const sessionId = 'queued-strategy-owner';
    const queueAgentId = `actor:${sessionId}:/root`;
    const executor: AgentTurnExecutor = {
      execute: async () => ({ output: 'queued strategy lane complete' }),
    };
    const controller = await createAgentActorController({ executor });
    testActorControllers.push(controller);
    const root = controller.bind('/root');
    const startedTurnIds: string[] = [];
    const options: KodaXOptions = {
      ...makeOptions(),
      session: { id: sessionId },
      context: {
        ...makeOptions().context,
        actorControl: root,
        interruptInput: {
          closeInputWindow() {},
          reopenInputWindow() {},
        },
      },
      events: {
        onTurnStarted: (event) => startedTurnIds.push(event.turnId),
      },
    };
    let call = 0;
    try {
      await runManagedTaskViaRunner(options, 'First prompt.', async () => {
        call += 1;
        if (call === 1) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'Queued prompt.',
          });
          return { textBlocks: [{ text: 'First answer.' }], toolBlocks: [] };
        }
        if (call === 2) {
          return {
            textBlocks: [],
            toolBlocks: [{
              type: 'tool_use',
              id: 'spawn-attributed-queued',
              name: 'spawn_agent',
              input: {
                task_name: 'queued-attributed-lane',
                objective: 'Inspect the queued request.',
                quality_strategy: {
                  schemaVersion: 1,
                  stageId: 'queued-stage',
                  pattern: 'fan-out-and-synthesize',
                  role: 'investigator',
                  laneRelation: 'coverage',
                },
              },
            }],
          };
        }
        return { textBlocks: [{ text: 'Queued answer integrated.' }], toolBlocks: [] };
      });

      expect(startedTurnIds).toHaveLength(2);
      expect(root.get('/root/queued-attributed-lane').turns[0]?.metadata?.qualityStrategy)
        .toMatchObject({
          ownerTurnRef: {
            actorPath: '/root',
            turnId: startedTurnIds[1],
          },
        });
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'user',
        mode: 'prompt',
      });
    }
  });

  it('delivers mailbox evidence as synthetic context after wait_agent', async () => {
    const sessionId = 'runner-mailbox-wait';
    const queueAgentId = `actor:${sessionId}:/root`;
    const controller = await createAgentActorController();
    testActorControllers.push(controller);
    const options: KodaXOptions = {
      ...makeOptions(),
      session: { id: sessionId },
      context: {
        ...makeOptions().context,
        actorControl: controller.bind('/root'),
      },
    };
    const transcripts: readonly KodaXMessage[][] = [];
    let callCount = 0;
    getMessageQueue().enqueue({
      agentId: queueAgentId,
      priority: 'background',
      mode: 'agent-message',
      content: '<agent-message id="msg-1" from="/root/reviewer">ready</agent-message>',
    });

    try {
      await runManagedTaskViaRunner(options, 'Coordinate review.', async (transcript) => {
        transcripts.push([...transcript]);
        callCount += 1;
        return callCount === 1
          ? {
              textBlocks: [],
              toolBlocks: [{
                type: 'tool_use',
                id: 'wait-mailbox-1',
                name: 'wait_agent',
                input: { timeout_ms: 10_000 },
              }],
            }
          : { textBlocks: [{ text: 'Integrated.' }], toolBlocks: [] };
      });

      const mailboxMessage = transcripts[1]?.find((message) => (
        message._synthetic === true
        && typeof message.content === 'string'
        && message.content.includes('<agent-message')
      ));
      expect(mailboxMessage).toEqual(expect.objectContaining({
        role: 'user',
        _synthetic: true,
      }));
      expect(mailboxMessage?._source).toBeUndefined();
      const toolResultText = (transcripts[1] ?? []).flatMap((message) => (
        typeof message.content === 'string'
          ? []
          : (message.content as readonly { readonly type: string; readonly content?: unknown }[])
              .filter((block) => block.type === 'tool_result')
              .flatMap((block) => typeof block.content === 'string' ? [block.content] : [])
      ));
      expect(toolResultText.some((text) => text.includes('"status": "mailbox"'))).toBe(true);
    } finally {
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: 'background',
      });
    }
  });

  it('records todo drift telemetry and injects the next-turn reminder through runner wiring', async () => {
    const warnings: Array<Parameters<NonNullable<KodaXEvents['onTodoDriftWarning']>>[0]> = [];
    const todoSnapshots: Array<Parameters<NonNullable<KodaXEvents['onTodoUpdate']>>[0]> = [];
    const systems: string[] = [];
    const transcripts: Array<readonly KodaXMessage[]> = [];
    let callCount = 0;
    const options: KodaXOptions = {
      ...makeOptions(),
      events: {
        onTodoDriftWarning: (event) => {
          warnings.push(event);
        },
        onTodoUpdate: (items) => {
          todoSnapshots.push(items);
        },
      },
    };

    const result = await runManagedTaskViaRunner(
      options,
      'Inspect todo drift wiring',
      async (transcript, _tools, system) => {
        transcripts.push(transcript);
        systems.push(system);
        callCount += 1;
        if (callCount === 1) {
          return {
            textBlocks: [],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'todo-create-1',
                name: 'todo_create',
                input: { subject: 'Inspect implementation' },
              },
              {
                type: 'tool_use',
                id: 'read-1',
                name: 'read',
                input: { path: path.join(process.cwd(), 'README.md') },
              },
            ],
          };
        }
        return {
          textBlocks: [{ text: 'Done after reminder.' }],
          toolBlocks: [],
        };
      },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: 'work_started_without_claimed_todo',
      toolName: 'read',
      firstPendingTodoSubject: 'Inspect implementation',
    });
    expect(todoSnapshots.some((snapshot) => snapshot[0]?.status === 'pending')).toBe(true);
    expect(systems[1]).toBe(systems[0]);
    expect(String(transcripts[1]?.at(-1)?.content)).toContain('no item marked in_progress');
    expect(String(transcripts[1]?.at(-1)?.content)).toContain('call todo_update now');
    expect(warnings[0]).toEqual(expect.objectContaining({
      sessionId: expect.any(String),
      seq: expect.any(Number),
      turnId: expect.any(String),
    }));
    expect(result.managedTask?.runtime?.todoDriftWarnings).toEqual([
      expect.objectContaining({
        kind: 'work_started_without_claimed_todo',
        toolName: 'read',
        firstPendingTodoSubject: 'Inspect implementation',
      }),
    ]);
  });

  it('FEATURE_211: returns and persists extension runtime session snapshots', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
      appendSessionRecord(
        extensionId: string,
        type: string,
        data?: unknown,
        options?: { dedupeKey?: string },
      ): unknown;
    };

    let controller: TestSessionController | undefined;
    let released = false;
    const save = vi.fn(async () => undefined);
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return () => {
          released = true;
          controller = undefined;
        };
      },
      hydrateSession: async (sessionId: string) => {
        controller?.setSessionState('ext:runner', 'visits', 1);
        controller?.appendSessionRecord('ext:runner', 'hydrate', { sessionId });
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          id: 'runner-feature-211',
          storage: {
            load: vi.fn(async () => null),
            save,
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { visits: 1 },
    });
    expect(result.runtimeSessionSnapshot?.extensionRecords).toEqual([
      expect.objectContaining({
        extensionId: 'ext:runner',
        type: 'hydrate',
        data: { sessionId: 'runner-feature-211' },
      }),
    ]);
    expect(save).toHaveBeenCalledWith(
      'runner-feature-211',
      expect.objectContaining({
        extensionState: { 'ext:runner': { visits: 1 } },
        extensionRecords: [
          expect.objectContaining({
            extensionId: 'ext:runner',
            type: 'hydrate',
          }),
        ],
      }),
    );
    expect(released).toBe(true);
  });

  it('FEATURE_211: hydrates extension runtime with the resolved fallback session id', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
    };

    let controller: TestSessionController | undefined;
    let hydratedSessionId: string | undefined;
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return () => {
          controller = undefined;
        };
      },
      hydrateSession: async (sessionId: string) => {
        hydratedSessionId = sessionId;
        controller?.setSessionState('ext:runner', 'sessionId', sessionId);
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          storage: {
            load: vi.fn(async () => null),
            save: vi.fn(async () => undefined),
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.sessionId).toMatch(/^runner-/);
    expect(hydratedSessionId).toBe(result.sessionId);
    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { sessionId: result.sessionId },
    });
  });

  it('FEATURE_211: hydrateSession intentionally wins duplicate keys over storage state', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
    };

    let controller: TestSessionController | undefined;
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return () => {
          controller = undefined;
        };
      },
      hydrateSession: async () => {
        controller?.setSessionState('ext:runner', 'phase', 'hydrate');
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          id: 'runner-feature-211-hydrate-order',
          storage: {
            load: vi.fn(async () => ({
              messages: [{ role: 'user', content: 'previous turn' }],
              title: 'Previous',
              gitRoot: '/repo',
              extensionState: {
                'ext:runner': { phase: 'storage', keep: true },
              },
            })),
            save: vi.fn(async () => undefined),
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { phase: 'hydrate', keep: true },
    });
  });

  it('FEATURE_211: ignores invalid extension runtime release handles', async () => {
    type TestSessionController = {
      setSessionState(extensionId: string, key: string, value: unknown | undefined): void;
    };

    let controller: TestSessionController | undefined;
    const extensionRuntime = {
      searchCapabilities: vi.fn(async () => []),
      describeCapability: vi.fn(async () => ({})),
      executeCapability: vi.fn(async () => ({ content: [] })),
      readCapability: vi.fn(async () => ({ content: [] })),
      getCapabilityPrompt: vi.fn(async () => undefined),
      getCapabilityPromptContext: vi.fn(async () => undefined),
      bindController: (nextController: TestSessionController) => {
        controller = nextController;
        return { release: true };
      },
      hydrateSession: async () => {
        controller?.setSessionState('ext:runner', 'phase', 'hydrate');
      },
    } as unknown as KodaXOptions['extensionRuntime'];

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        extensionRuntime,
        session: {
          id: 'runner-feature-211-invalid-release',
          storage: {
            load: vi.fn(async () => null),
            save: vi.fn(async () => undefined),
          },
        },
      },
      'Say hello',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.success).toBe(true);
    expect(result.runtimeSessionSnapshot?.extensionState).toEqual({
      'ext:runner': { phase: 'hydrate' },
    });
  });

  it('surfaces tool errors back to the LLM without failing the run', async () => {
    let turn = 0;
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Read /nonexistent/path',
      async (transcript) => {
        turn += 1;
        if (turn === 1) {
          return {
            textBlocks: [],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'read-1',
                name: 'read',
                input: { file_path: '/definitely/does/not/exist/xyz.txt' },
              },
            ],
          };
        }
        // Second turn: LLM sees the tool error and adapts.
        const last = transcript[transcript.length - 1]!;
        const blocks = last.content as Array<{ type: string; content: string; is_error?: boolean }>;
        expect(blocks[0]!.type).toBe('tool_result');
        // The read tool might fail with a specific error; either is_error
        // is true or content carries a "[Tool Error]" prefix.
        const errored = blocks[0]!.is_error === true
          || blocks[0]!.content.toLowerCase().includes('error')
          || blocks[0]!.content.toLowerCase().includes('enoent');
        expect(errored).toBe(true);
        return { textBlocks: [{ text: 'File does not exist; try a different path.' }], toolBlocks: [] };
      },
    );
    expect(result.success).toBe(true);
    expect(result.lastText).toMatch(/does not exist/);
  });
});

// FEATURE_114 v0.7.36 Slice 5 — V2 single-loop end-to-end runner test.
// Sibling to the Slice 3b unit tests that asserted chain SHAPE; this
// test asserts the chain actually FLOWS through Worker → Evaluator
// when KODAX_HARNESS_V2=true. Reuses the `makeChainMockLlm` helper
// (per-agent turn detection via system-prompt sniffing) and adds a
// 'worker' branch.
describe('FEATURE_114 v0.7.36 Slice 5 — V2 Worker→Evaluator end-to-end', () => {
  // FEATURE_193 v0.7.43: withHarnessV2 helper deleted (KODAX_HARNESS_V2 env flag retired — V2 is now unconditional default)

  it('runs a V2 trivial flow: Worker terminates text-only', async () => {
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Trivial arithmetic — answering directly. 2 + 2 = 4.' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: '2 + 2 = 4.' }], toolBlocks: [] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    });
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'What is 2 + 2?',
      mock,
    );
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // Worker answer reaches the user via lastText.
    expect(result.lastText).toMatch(/2 \+ 2 = 4/);
    // FEATURE_184 (v0.7.45): the Sidecar Verifier StopHook fires on
    // Worker text-only termination and writes a verdict slot via
    // `verifier-recorder-bridge.applySidecarVerdictToRecorder`. In the
    // unit-test environment the verifier provider is `anthropic`
    // without a real API key, so `provider.stream` throws inside the
    // verifier; the fail-open policy resolves to `verdict: 'accept'`
    // (trace=`provider_error`, see `verifier.ts:251`). The recorder
    // bridge stamps `source: 'sidecar'` on the recorded payload.
    //
    // Pre-2026-05-23 this slot was silently `undefined` because
    // `currentAgentRoleRef` was stuck at the V1 `'scout'` sentinel and
    // the verifier gate (`isExecutionRole === 'worker'`) never opened
    // (regression from F193 Commit 2 `c5d4b829`, restored by the
    // ref-init fix).
    expect(result.managedProtocolPayload?.verdict).toBeDefined();
    expect(result.managedProtocolPayload?.verdict?.source).toBe('sidecar');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });

  it('V2 active: preflight emits activeWorkerTitle="Worker" (not "Scout")', async () => {
    // FEATURE_114 v0.7.38 Slice 7 — when V2 is the entry path
    // (chain.worker), the runner's preflight emit MUST carry the
    // Worker label so the REPL prefix on Worker's tool calls reads
    // `[Worker] read/bash/grep`. The previous hardcoded scout label
    // persisted into every Worker tool call (no slot emit had fired
    // yet) and made V2 sessions appear to still be running V1.
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          // FEATURE_190 Phase 3: text-only termination (emit_handoff deleted).
          return {
            textBlocks: [{ text: 'Done.' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      },
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    });
    await runManagedTaskViaRunner(opts, 'What is 2 + 2?', mock);
    const preflight = statuses.find((s) => s.phase === 'preflight');
    expect(preflight?.activeWorkerId).toBe('worker');
    expect(preflight?.activeWorkerTitle).toBe('Worker');
    expect(preflight?.note).toBe('Worker analyzing task');
  });

  // FEATURE_190 Phase 3: Worker terminates text-only — onRoleEmit('worker')
  // is never called, so no `phase:'worker', activeWorkerId:'worker'` event
  // with the "completed a turn" note exists to assert against. The agentSwitched
  // event does fire but was not the invariant this test exercised (it checked
  // the onRoleEmit path specifically). Covered by text-only-termination.test.ts.
  it.todo('post-F190: V2 worker onRoleEmit event no longer fires — Worker terminates text-only; covered by text-only-termination.test.ts');

  // FEATURE_193 v0.7.43: V1 flag-off routing test deleted (Scout chain agents retired).
});

// FEATURE_196 (v0.7.43) — content-aware sidecar fire gate integration.
//
// Gate logic + regex boundaries covered exhaustively in `gate.test.ts`
// (23 unit tests). These integration tests verify the wire-up to
// `runner-driven.ts:composedStopHook` — fire/skip routing produces the
// right end-state in `managedProtocolPayload.verdict`. The unit-test
// env has no API keys so when the sidecar verifier fires it fail-opens
// to `accept` (trace=`provider_error`); when it skips, no verdict is
// recorded.
describe('FEATURE_196 v0.7.43 — sidecar content-aware fire gate (integration)', () => {
  it('trivial greeting → gate skips → no sidecar verdict written', async () => {
    // User: "你好" (Chinese greeting, 2 chars, no imperative).
    // Worker: text-only "你好!". Layer 2 detects conversational
    // intent → gate skips → composedStopHook returns through the
    // extension chain without invoking the verifier.
    //
    // Pre-F196 the verifier would have fail-open to accept and
    // stamped `source: 'sidecar'` on the verdict. Post-F196 the gate
    // skips → no verdict slot is written → `managedProtocolPayload?.verdict`
    // is undefined.
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          return {
            textBlocks: [{ text: '你好! 我是 KodaX 的开发助手。' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), '你好', mock);
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    // Gate skipped sidecar — verdict slot never populated.
    expect(result.managedProtocolPayload?.verdict).toBeUndefined();
  });

  it('mutation tool call → gate fires → sidecar verdict written', async () => {
    // Worker invokes a mutation tool (action-surface signal). Layer 1
    // returns fire. Verifier fires + fail-opens to accept in the
    // key-less test env.
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'w-1',
              name: 'todo_create',
              input: { items: [{ subject: 'plan step', description: 'do work' }] },
            }],
          };
        }
        // Turn 2 — text-only termination after tool ran.
        return {
          textBlocks: [{ text: 'Done. Plan items recorded.' }],
          toolBlocks: [],
        };
      },
    });
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      // Imperative user message — even without Layer 1, Layer 2 would
      // defer to default fire.
      'plan three things and implement them',
      mock,
    );
    // Mutation tool call signals "real work" — gate fires regardless
    // of user-message intent.
    expect(result.managedProtocolPayload?.verdict).toBeDefined();
    expect(result.managedProtocolPayload?.verdict?.source).toBe('sidecar');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });

  it('imperative + zero tool action (zhipu floor) → gate fires safely (F184 contract)', async () => {
    // The CORE F184 contract case: user asked Worker to do something
    // imperative, Worker responds text-only without invoking a tool
    // (intent-vs-action floor). Layer 2's conversational check must
    // NOT skip this — safe default fires → sidecar verifies the claim.
    const mock = makeChainMockLlm({
      worker: (turn) => {
        if (turn === 1) {
          return {
            // No tool call — Worker just claims to have done it.
            textBlocks: [{ text: '明白，我用 grep 搜索了 README 文件。结果如下...' }],
            toolBlocks: [],
          };
        }
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
    });
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      '查一下 README 文件',
      mock,
    );
    // Imperative user + zero action ⇒ gate defaults to fire.
    expect(result.managedProtocolPayload?.verdict).toBeDefined();
    expect(result.managedProtocolPayload?.verdict?.source).toBe('sidecar');
    // Fail-open accept in key-less test env. Production with real API
    // would surface the verifier's actual verdict (likely revise/
    // blocked given the false-action claim).
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

// FEATURE_167 (v0.7.41) Evaluator terminal-verdict fallback (B1+B2) deleted
// in FEATURE_184 Phase C.2 (v0.7.45). The three-layer B0/B1/B2 retry/synth
// fallback block is superseded by the Sidecar Verifier StopHook (Phase D.2).

describe('parity — Runner path and legacy SA path produce compatible KodaXResult shape', () => {
  // The goal of Shard 5a parity is NOT byte-level equivalence (the legacy
  // AMA state machine emits dozens of observer events and populates a
  // full managedTask payload that the Shard 5a skeleton doesn't produce).
  // The goal IS user-facing shape parity: both paths return a KodaXResult
  // with success + lastText + messages + sessionId, and FEATURE_076's
  // round-boundary reshape can consume either one without special casing.
  it('runner-path KodaXResult is compatible with FEATURE_076 round-boundary reshape', async () => {
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Trivial task',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    // Required fields for reshape (see round-boundary.ts):
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.lastText).toBe('string');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(typeof result.sessionId).toBe('string');
    // Shard 6a populates managedTask even on zero-tool runs.
    // FEATURE_184 (v0.7.45): Sidecar Verifier fires on Worker text-only
    // termination. In the unit-test environment without a real API
    // key, the verifier fail-opens to `accept` (provider_error trace),
    // which `payload-builder.ts:285-294` maps to `status: 'completed'`.
    // Restored 2026-05-23 by fixing the `currentAgentRoleRef` init
    // regression that previously gated the verifier off (was stuck at
    // V1 `'scout'` sentinel; now `'worker'` so `isExecutionRole` opens
    // the gate from turn 0).
    expect(result.managedTask?.verdict?.status).toBe('completed');
  });

  // FEATURE_173 (v0.7.42) Part A — kill `runner-${epoch}` ghost-session
  // double-write. When the REPL caller passes `options.session.id` (the
  // canonical `YYYYMMDD_HHMMSS` session file id), the result must echo it
  // back verbatim — `Runner.run` does not own a Session here (would
  // trigger `session.append` writes), so the synth `runner-${Date.now()}`
  // fallback at runner-driven.ts MUST NOT fire. The pre-fix bug caused
  // REPL to save TWO `.jsonl` files per conversation (REPL-side under
  // `YYYYMMDD_HHMMSS` + ghost-side under `runner-${epoch}`).
  it('FEATURE_173 Part A: propagates caller-supplied session.id, never falls through to runner-${epoch} ghost', async () => {
    const callerSessionId = '20260522_180000';
    const options = {
      ...makeOptions(),
      session: { id: callerSessionId },
    } as KodaXOptions;

    const result = await runManagedTaskViaRunner(
      options,
      'Trivial task',
      async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    );

    expect(result.sessionId).toBe(callerSessionId);
    // Negative assertion: the ghost-fallback prefix must NEVER appear when
    // caller supplied an id. Future regressions where someone reverses the
    // ??-chain order at runner-driven.ts:~1965 will trip this immediately.
    expect(result.sessionId.startsWith('runner-')).toBe(false);
  });
});

// =============================================================================
// Shard 5b parity matrix — 4 multi-agent canonical paths
// =============================================================================

/**
 * Helper: build a mock LLM that dispatches per agent name. Each agent's
 * turn handler receives the turn number (1-indexed per agent) and may
 * return a text-only response, a tool-calling response, or throw.
 */
type AgentTurn = (
  turnOfThisAgent: number,
  transcript: readonly KodaXMessage[],
) => {
  textBlocks?: readonly { text: string }[];
  toolBlocks?: readonly KodaXToolUseBlock[];
};

function makeChainMockLlm(handlers: Record<string, AgentTurn>) {
  const turnCount: Record<string, number> = {};
  // We can't see the agent name from the stream signature, but the system
  // message content tells us: it's the agent's instructions. We grep each
  // role's distinct marker.
  const detectRole = (system: string): string => {
    if (system.includes('You are Scout')) return 'scout';
    if (system.includes('You are Planner')) return 'planner';
    if (system.includes('You are Generator')) return 'generator';
    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // FEATURE_114 v0.7.36 Slice 5 — Worker prompt opens with one
    // of two markers depending on whether the prompt is built via
    // `worker-role-prompt.ts` (production path: "You are the Worker
    // — KodaX's single primary agent …") or the
    // `WORKER_INSTRUCTIONS_FALLBACK` constant in this file
    // (test/topology-only path: "You are Worker (AMA Harness V2 …").
    // Match both so e2e tests work whether or not promptContext is
    // wired by the test fixture.
    if (
      system.includes('You are the Worker')
      || system.includes('You are Worker (AMA Harness V2')
    ) {
      return 'worker';
    }
    return 'unknown';
  };
  return async (
    transcript: readonly KodaXMessage[],
    _tools: readonly KodaXToolDefinition[],
    system: string,
  ) => {
    const role = detectRole(system);
    turnCount[role] = (turnCount[role] ?? 0) + 1;
    const handler = handlers[role];
    if (!handler) {
      // Debug aid: when role is "unknown", surface the first 200
      // chars of the system prompt so the test failure tells us why
      // the role detector missed.
      throw new Error(
        `No mock handler for role ${role}. system head: ${JSON.stringify(system.slice(0, 240))}`,
      );
    }
    return handler(turnCount[role]!, transcript);
  };
}

// FEATURE_193 v0.7.43: V1 Scout→Generator H1 accept describe deleted (V1 chain retired).

// FEATURE_193 v0.7.43: M5 Scout pre-handoff write warning describe deleted (V1 chain retired).

// FEATURE_193 v0.7.43: Shard 5b parity H1 (scout→generator text-only) describe deleted (V1 chain retired — uses emit_scout_verdict + generator role)

// FEATURE_193 v0.7.43: Shard 5b parity H2 (scout→planner→generator) describe deleted (V1 chain retired — uses emit_scout_verdict + emit_contract + generator role)

describe('Shard 5b parity — blocked path', () => {
  // FEATURE_190 Phase 3: emit_handoff deleted. BLOCKED semantics now owned
  // by Sidecar Verifier — covered by sidecar.test.ts.
  it.todo('post-F190: blocked semantics owned by Sidecar Verifier — covered by sidecar.test.ts');
});

// =============================================================================
// Shard 6a — Observer events + managedTask payload
// =============================================================================

describe('Shard 6a — onManagedTaskStatus observer events', () => {
  it('fires preflight at start and completed at end', async () => {
    const statuses: Array<{
      phase?: string;
      activeWorkerId?: string;
      activeWorkerTitle?: string;
      note?: string;
    }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: {
          phase?: string;
          activeWorkerId?: string;
          activeWorkerTitle?: string;
          note?: string;
        }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'Say hi', async () => ({
      textBlocks: [{ text: 'Hi.' }], toolBlocks: [],
    }));
    const preflight = statuses.find((s) => s.phase === 'preflight');
    expect(preflight).toBeDefined();
    // FEATURE_193 v0.7.43: V2 default — preflight carries Worker label.
    expect(preflight?.activeWorkerId).toBe('worker');
    expect(preflight?.activeWorkerTitle).toBe('Worker');
    expect(preflight?.note).toBe('Worker analyzing task');
    expect(statuses.some((s) => s.phase === 'completed')).toBe(true);
  });

  // FEATURE_193 v0.7.43: fires round events per role emit (Scout → Generator) it deleted (V1 chain retired)

  // FEATURE_193 v0.7.43: fires completed with BLOCKED signal note on blocked handoff it deleted (V1 chain retired — emit_handoff deleted)
});

// FEATURE_193 v0.7.43: Shard 6a managedTask payload shape describe deleted (V1 chain retired — all its used scout/planner/generator roles)

// =============================================================================
// Shard 6b — Real budget tracking + mutation tracker
// =============================================================================

// FEATURE_193 v0.7.43: 'Shard 6b — budget controller' describe deleted — all 4 tests used scout + emit_scout_verdict (V1 chain retired)
//   increments spentBudget per tool invocation it deleted
//   upgrades totalBudget when Scout picks H1 it deleted
//   keeps H0 budget when Scout chooses H0_DIRECT it deleted
//   upgrades to 200 when Scout picks H2 it deleted

// FEATURE_193 v0.7.43: Shard 6b mutation tracker describe deleted (V1 chain retired — uses scout + generator roles)

// =============================================================================
// Shard 6c — Checkpoint recovery (FEATURE_071)
// =============================================================================

// FEATURE_193 v0.7.43: Shard 6c checkpoint handling describe deleted (V1 chain retired — both its used scout/generator roles)

// FEATURE_193 v0.7.43: Shard 5b H2 Generator terminates after planning describe deleted (V1 chain retired — uses scout/planner/generator roles)

describe('Shard 6d-c1 — observer event enrichment', () => {
  // FEATURE_193 v0.7.43: populates activeWorkerTitle/currentRound/maxRounds on round events it deleted (V1 chain retired — uses scout/generator roles)

  it('populates globalWorkBudget and budgetUsage on every event', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'Say hi', async () => ({
      textBlocks: [{ text: 'Hi.' }], toolBlocks: [],
    }));
    const event = statuses.find((s) => s.phase === 'preflight');
    expect(typeof event?.globalWorkBudget).toBe('number');
    expect(typeof event?.budgetUsage).toBe('number');
    expect(event?.budgetApprovalRequired).toBe(false);
  });

  // FEATURE_193 v0.7.43: completed event has persistToHistory=true it deleted (V1 chain retired — uses scout/generator roles)
  // FEATURE_193 v0.7.43: round events default persistToHistory=false it deleted (V1 chain retired — onRoleEmit path is V1-only; V2 Worker text-only termination does not fire onRoleEmit)
});

describe('Shard 6d-c2 — stream event passthrough', () => {
  it('forwards onTextDelta / onThinkingDelta via provider stream options', async () => {
    // We verify by going through the real adapter + a fake provider.stream
    // the adapter passes streamOptions to. Since `runManagedTaskViaRunner`
    // accepts an `adapterOverride` that *replaces* the stream entirely
    // (bypassing `resolveProvider`), these two hooks are exercised at the
    // adapter layer in `buildRunnerLlmAdapter` rather than here — this
    // test confirms the adapter propagates events through the override
    // signature (which carries `system` + `tools` + `transcript`).
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const opts = {
      ...makeOptions(),
      events: {
        onTextDelta: (t: string) => textDeltas.push(t),
        onThinkingDelta: (t: string) => thinkingDeltas.push(t),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    // The override stream path does NOT hit provider.stream; for this
    // regression it is sufficient that options.events is surfaced into
    // buildRunnerLlmAdapter (verified via type-check) and tests below
    // exercise the non-override path only under integration.
    await runManagedTaskViaRunner(opts, 'hi', async () => ({
      textBlocks: [{ text: 'hi' }], toolBlocks: [],
    }));
    // With adapterOverride, no provider.stream call happens, so deltas
    // remain empty. The field wiring itself is compile-time guaranteed
    // via buildRunnerLlmAdapter's passthrough of streamOptions.
    expect(textDeltas).toEqual([]);
    expect(thinkingDeltas).toEqual([]);
  });
});

describe('Shard 6d-f — role-scoped tool boundaries (legacy toolPolicy parity)', () => {
  function findTool(agent: { tools?: readonly KodaXToolDefinition[] }, name: string): RunnableTool {
    const tool = agent.tools?.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool '${name}' not found on agent`);
    return tool as RunnableTool;
  }

  // Minimal RunnerToolContext for tests — `agent` is unused by the
  // bash / mutation-guard path but required by the interface.
  function makeToolCtx(agentName: string): import('@kodax-ai/agent').RunnerToolContext {
    return { agent: { name: agentName } as unknown as import('@kodax-ai/agent').Agent };
  }

  // FEATURE_193 v0.7.43: Planner + Generator topology tests deleted —
  // V1 chain agents retired from agent-chain.ts.

  // FEATURE_114 v0.7.36 Slice 3a — Worker agent in the runner chain.
  // Slice 3a is intentionally additive: the Worker slot is built but
  // never dispatched until Slice 3b flips the entry agent under
  // KODAX_HARNESS_V2=true. These tests assert structural presence
  // (chain.worker exists with the right name + tool surface +
  // single-handoff topology) so Slice 3b has a stable target.
  describe('FEATURE_114 Slice 3a — Worker agent topology', () => {
    it('chain.worker exists with the canonical worker agent name', () => {
      const chain = buildRunnerAgentChain(makeCtx(), {});
      expect(chain.worker.name).toBe('kodax/role/worker');
    });

    it('Worker exposes the full execution toolbox (Scout exec ∪ Generator mutation surface)', () => {
      // FEATURE_190 Phase 3: emit_handoff deleted — Worker terminates text-only.
      const chain = buildRunnerAgentChain(makeCtx(), {});
      const workerTools = chain.worker.tools?.map((t) => t.name) ?? [];
      // emit_handoff no longer exists post-F190 Phase 3.
      expect(workerTools).not.toContain('emit_handoff');
      // Read surface — every probe Scout/Generator have.
      expect(workerTools).toContain('read');
      expect(workerTools).toContain('grep');
      expect(workerTools).toContain('glob');
      // Mutation surface — Worker is the V2 single-loop executor.
      expect(workerTools).toContain('bash');
      expect(workerTools).toContain('write');
      expect(workerTools).toContain('edit');
      expect(workerTools).toContain('multi_edit');
      // Plan + flow control.
      expect(workerTools).toContain('todo_update');
      expect(workerTools).toContain('todo_list');
      expect(workerTools).toContain('exit_plan_mode');
      // Unified recursive Actor collaboration surface.
      for (const name of [
        'spawn_agent',
        'send_message',
        'followup_task',
        'wait_agent',
        'interrupt_agent',
        'list_agents',
        'agent_output',
      ]) {
        expect(workerTools).toContain(name);
      }
      expect(workerTools).not.toContain('dispatch_child_task');
      expect(workerTools).not.toContain('task_output');
      expect(workerTools).not.toContain('task_stop');
      // Worker MUST NOT carry the V1 emit tools — those belong to the
      // legacy roles only.
      expect(workerTools).not.toContain('emit_scout_verdict');
      expect(workerTools).not.toContain('emit_contract');
      expect(workerTools).not.toContain('emit_verdict');
    });

    it('Worker has no handoffs (FEATURE_184 C.1: Evaluator removed from chain)', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // FEATURE_190 Phase 3: Worker terminates text-only; no agent handoff edge.
      const chain = buildRunnerAgentChain(makeCtx(), {});
      const handoffs = chain.worker.handoffs ?? [];
      expect(handoffs).toHaveLength(0);
    });

    // FEATURE_193 v0.7.43: 'V1/V2 chain topology: no Worker targets in scout/planner/generator handoffs' deleted
    //   (KODAX_HARNESS_V2='false' + chain.scout/planner/generator — V1 chain retired)
  });

  // FEATURE_114 v0.7.36 Slice 3b — V2 single-loop topology under flag.
  // When KODAX_HARNESS_V2=true, the runner-driven chain swaps
  // Evaluator's revise target from Generator to Worker so the
  // single-loop Worker → Evaluator → revise(Worker) path resolves.
  // The entry-agent swap (chain.scout vs chain.worker) is wired in
  // `runManagedTaskViaRunnerInner` itself; that requires the full
  // runner harness so it's covered indirectly via the existing
  // Scout-H0 e2e test under flag-off baseline + a unit assertion on
  // `isHarnessV2Enabled` here.
  describe('FEATURE_114 Slice 3b — V2 flag-gated handoff topology', () => {
    // FEATURE_193 v0.7.43: withHarnessV2 sync helper deleted (KODAX_HARNESS_V2 env flag retired — V2 is now unconditional default)

    // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
    // "V2 active: Evaluator revise targets Worker" test deleted (chain.evaluator gone).

    it('V2 active: Worker has no handoffs (FEATURE_184 C.1: Evaluator removed)', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // FEATURE_190 Phase 3: Worker terminates text-only (emit_handoff deleted); no edge to Evaluator.
      // FEATURE_193 v0.7.43: withHarnessV2 wrapper removed (V2 is now unconditional default)
      const chain = buildRunnerAgentChain(makeCtx(), {});
      const workerTargets = (chain.worker.handoffs ?? []).map((h) => h.target.name);
      expect(workerTargets).toHaveLength(0);
      expect(workerTargets).not.toContain('kodax/role/evaluator');
    });

    it('flag toggles deterministically: same chain factory, Worker has no Evaluator target in either mode', () => {
      // FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
      // chain.evaluator no longer exists; verify Worker has no Evaluator target.
      // FEATURE_193 v0.7.43: withHarnessV2 wrappers removed (V2 is now unconditional default)
      const chain1 = buildRunnerAgentChain(makeCtx(), {});
      expect((chain1.worker.handoffs ?? [])).toHaveLength(0);
      const chain2 = buildRunnerAgentChain(makeCtx(), {});
      expect((chain2.worker.handoffs ?? [])).toHaveLength(0);
    });
  });

  // FEATURE_114 v0.7.36 Slice 3c — deterministic per-step evaluator.
  // The runner wraps `todo_update` so a successful pending|in_progress
  // → completed transition on an item with `evaluator: 'build'|'test'|
  // 'lint'` triggers the corresponding npm command and threads stderr
  // back into the tool result. These tests use a stub evaluator runner
  // (injected via `buildRunnerAgentChain`'s last param) to avoid
  // spawning real shell commands; the helper's own contract is covered
  // by `deterministic-evaluator.test.ts`.
  describe('FEATURE_114 Slice 3c — deterministic per-step evaluator wrap', () => {
    type StubCall = {
      hint: 'build' | 'test' | 'lint';
      cwd: string;
    };

    function buildStubRunner(calls: StubCall[], outcome: 'pass' | 'fail'): (
      input: { hint: 'build' | 'test' | 'lint'; cwd: string },
    ) => Promise<{
      hint: 'build' | 'test' | 'lint';
      command: string;
      status: 'pass' | 'fail' | 'skipped' | 'error';
      exitCode: number | undefined;
      stderrTail: string;
      stdoutTail: string;
      durationMs: number;
    }> {
      return async (input) => {
        calls.push({ hint: input.hint, cwd: input.cwd });
        return outcome === 'pass'
          ? {
            hint: input.hint,
            command: `npm run ${input.hint}`,
            status: 'pass',
            exitCode: 0,
            stderrTail: '',
            stdoutTail: '',
            durationMs: 12,
          }
          : {
            hint: input.hint,
            command: `npm run ${input.hint}`,
            status: 'fail',
            exitCode: 1,
            stderrTail: 'TypeError: cannot read x of undefined',
            stdoutTail: '',
            durationMs: 18,
          };
      };
    }

    async function buildChainWithEvaluator(
      stubCalls: StubCall[],
      outcome: 'pass' | 'fail',
    ): Promise<{
      chain: ReturnType<typeof buildRunnerAgentChain>;
      todoStore: import('./todo-store.js').TodoStore;
    }> {
      const { createTodoStore } = await import('./todo-store.js');
      const todoStore = createTodoStore();
      const stub = buildStubRunner(stubCalls, outcome);
      // Production wires `todoStore` into baseCtx so the underlying
      // todo_update tool handler can read it via `ctx.todoStore`. Mirror
      // that here so the wrapper sees real status transitions instead
      // of the not-active error path.
      const ctxWithStore: KodaXToolExecutionContext = { ...makeCtx(), todoStore };
      const chain = buildRunnerAgentChain(
        ctxWithStore,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // FEATURE_188 v0.7.42 — childWriteWorktreePathsRef param removed.
        // The remaining trailing slots stay in the same order.
        undefined,
        undefined,
        todoStore,
        undefined,
        undefined,
        '/test/cwd',
        stub,
      );
      return { chain, todoStore };
    }

    function findTodoUpdate(chain: ReturnType<typeof buildRunnerAgentChain>): RunnableTool {
      const tool = chain.worker.tools?.find((t) => t.name === 'todo_update');
      if (!tool) throw new Error('todo_update tool not on worker');
      return tool;
    }

    it('triggers the evaluator when an item with evaluator hint flips to completed', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'pass');
      todoStore.init([
        { id: 't1', subject: 'Build the package', evaluator: 'build' },
        { id: 't2', subject: 'Run tests' },
      ]);
      const tool = findTodoUpdate(chain);
      // Set t1 to completed via the wrapped tool. Snapshot pre-state
      // is captured by the wrapper; post-state shows status='completed'
      // with evaluator='build', so the stub fires.
      const result = await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].hint).toBe('build');
      expect(calls[0].cwd).toBe('/test/cwd');
      expect(typeof result.content).toBe('string');
      expect(String(result.content)).toContain('[evaluator:t1]');
      expect(String(result.content)).toContain('[deterministic-evaluator:build] pass');
    });

    it('threads fail stderr tail into the tool result so the LLM sees it', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'fail');
      todoStore.init([{ id: 't1', subject: 'Run tests', evaluator: 'test' }]);
      const tool = findTodoUpdate(chain);
      const result = await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls[0].hint).toBe('test');
      expect(String(result.content)).toContain('fail');
      expect(String(result.content)).toContain('TypeError: cannot read x of undefined');
    });

    it('does NOT trigger the evaluator on items without an evaluator hint', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'pass');
      todoStore.init([{ id: 't1', subject: 'Plain step (no hint)' }]);
      const tool = findTodoUpdate(chain);
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(0);
    });

    it('does NOT re-trigger the evaluator when the item was already completed (no transition)', async () => {
      const calls: StubCall[] = [];
      const { chain, todoStore } = await buildChainWithEvaluator(calls, 'pass');
      todoStore.init([{ id: 't1', subject: 'Build', evaluator: 'build' }]);
      const tool = findTodoUpdate(chain);
      // First flip — fires.
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      // Second call attempting the same transition — already-completed,
      // wrapper short-circuits.
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(1);
    });

    it('no-op when runtimeCwd is omitted (legacy callers / test fixtures)', async () => {
      const calls: StubCall[] = [];
      const { createTodoStore } = await import('./todo-store.js');
      const todoStore = createTodoStore();
      const stub = buildStubRunner(calls, 'pass');
      const ctxWithStore: KodaXToolExecutionContext = { ...makeCtx(), todoStore };
      const chain = buildRunnerAgentChain(
        ctxWithStore,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        todoStore,
        undefined,
        undefined,
        // runtimeCwd intentionally omitted
        undefined,
        stub,
      );
      todoStore.init([{ id: 't1', subject: 'Build', evaluator: 'build' }]);
      const tool = chain.worker.tools?.find((t) => t.name === 'todo_update');
      if (!tool) throw new Error('todo_update tool missing');
      await tool.execute(
        { id: 't1', status: 'completed' },
        { agent: { name: 'worker' } as unknown as import('@kodax-ai/agent').Agent },
      );
      expect(calls).toHaveLength(0);
    });
  });
});

// FEATURE_193 v0.7.43: 'Shard 6d-T — Scout skillMap injected into Generator + Evaluator instructions' deleted
//   (all tests used chain.generator / chain.scout — V1 chain roles retired)

// FEATURE_193 v0.7.43: Shard 6d-Q V1-agent dispatch_child_task tests deleted
// (chain.scout/.planner/.generator retired). Worker dispatch is covered by
// Worker topology tests in the Slice 3a describe.

// FEATURE_193 v0.7.43: 'Shard 6d-S — task verification contract completionContractStatus' deleted
//   (all tests used makeChainMockLlm with scout:/generator: — V1 chain roles retired)

// FEATURE_193 v0.7.43: 'Shard 6d-U — degraded-continue when upgrade beyond ceiling' deleted
//   (test used makeChainMockLlm with scout:/generator: — V1 chain roles retired)

// FEATURE_184 Phase C.1 (v0.7.45): Evaluator removed from chain.
// "Shard 6d-f — evaluator graceful fallback when verdict is not emitted" deleted.
// The F167 three-layer B0/B1/B2 retry/synth fallback is superseded by Sidecar Verifier (Phase D.2).

describe('Shard 6d-d — session continuity', () => {
  it('keeps the AMA wire prefix stable across runs in the same session', async () => {
    const sessionId = 'runner-prefix-stability';
    const firstPrompt = 'Inspect the current cache behavior.';
    const secondPrompt = 'Now check the context diagnostics.';
    const makePlan = (prompt: string): ReasoningPlan => ({
      effort: 'medium',
      decision: buildFallbackRoutingDecision(prompt),
      promptOverlay: '',
    });
    const calls: Array<{
      readonly system: string;
      readonly tools: readonly KodaXToolDefinition[];
      readonly transcript: readonly KodaXMessage[];
      readonly ephemeralSuffix?: KodaXEphemeralSuffix;
    }> = [];
    const capture = async (
      transcript: readonly KodaXMessage[],
      tools: readonly KodaXToolDefinition[],
      system: string,
      ephemeralSuffix?: KodaXEphemeralSuffix,
    ) => {
      calls.push({
        system,
        tools: [...tools],
        transcript: [...transcript],
        ephemeralSuffix,
      });
      return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
    };

    const first = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: { id: sessionId },
      },
      firstPrompt,
      capture,
      makePlan(firstPrompt),
    );
    await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: {
          id: sessionId,
          initialMessages: [
            ...first.messages,
            {
              role: 'user',
              content: 'STALE MANAGED CONTEXT MUST NOT REPLAY',
              _synthetic: true,
              _source: 'managed-run-context',
            },
            {
              role: 'user',
              content: 'STALE RUNTIME DELTA MUST NOT REPLAY',
              _synthetic: true,
              _source: 'managed-runtime-context',
            },
          ],
        },
      },
      secondPrompt,
      capture,
      makePlan(secondPrompt),
    );

    expect(calls).toHaveLength(2);
    const firstCall = calls[0]!;
    const secondCall = calls[1]!;
    expect(firstCall.system).toBe(secondCall.system);
    expect(firstCall.system).not.toContain(firstPrompt);
    expect(firstCall.system).not.toContain(secondPrompt);
    expect(firstCall.tools).toEqual(secondCall.tools);
    const firstContextIndex = firstCall.transcript.findIndex((message) =>
      message._source === 'managed-run-context');
    const firstTaskIndex = firstCall.transcript.findIndex((message) => (
      message.role === 'user' && message._synthetic !== true
    ));
    expect(firstCall.transcript[firstTaskIndex]).toEqual(expect.objectContaining({
      role: 'user',
      content: firstPrompt,
    }));
    expect(firstContextIndex).toBeGreaterThanOrEqual(0);
    expect(firstContextIndex).toBeLessThan(firstTaskIndex);
    expect(firstCall.ephemeralSuffix).toBeUndefined();
    expect(secondCall.ephemeralSuffix).toBeUndefined();
    expect(first.messages.some((message) =>
      message._source === 'managed-run-context'
      || message._source === 'managed-runtime-context')).toBe(false);
    const visibleFirstTranscript = firstCall.transcript.filter((message) =>
      message._source !== 'managed-run-context'
      && message._source !== 'managed-runtime-context');
    expect(secondCall.transcript.slice(0, visibleFirstTranscript.length))
      .toEqual(visibleFirstTranscript);
    expect(secondCall.transcript.filter((message) =>
      message._source === 'managed-run-context')).toHaveLength(1);
    expect(JSON.stringify(secondCall.transcript)).not.toContain('STALE MANAGED CONTEXT');
    expect(JSON.stringify(secondCall.transcript)).not.toContain('STALE RUNTIME DELTA');
    expect(secondCall.transcript.at(-1)).toEqual(expect.objectContaining({
      role: 'user',
      content: secondPrompt,
    }));
  });

  it('keeps the cacheable AMA wire prefix stable across two fresh Sessions', async () => {
    const prompt = 'Inspect the current cache behavior.';
    const plan: ReasoningPlan = {
      effort: 'medium',
      decision: buildFallbackRoutingDecision(prompt),
      promptOverlay: '',
    };
    const calls: Array<{
      readonly system: string;
      readonly tools: readonly KodaXToolDefinition[];
      readonly transcript: readonly KodaXMessage[];
      readonly ephemeralSuffix?: KodaXEphemeralSuffix;
    }> = [];
    const capture = async (
      transcript: readonly KodaXMessage[],
      tools: readonly KodaXToolDefinition[],
      system: string,
      ephemeralSuffix?: KodaXEphemeralSuffix,
    ) => {
      calls.push({
        system,
        tools: [...tools],
        transcript: [...transcript],
        ephemeralSuffix,
      });
      return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
    };

    await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: { id: 'fresh-prefix-session-A' },
      },
      prompt,
      capture,
      plan,
    );
    await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: { id: 'fresh-prefix-session-B' },
      },
      prompt,
      capture,
      plan,
    );

    expect(calls).toHaveLength(2);
    const firstCall = calls[0]!;
    const secondCall = calls[1]!;
    expect(firstCall.system).toBe(secondCall.system);
    expect(firstCall.tools).toEqual(secondCall.tools);
    const providerVisibleTranscript = (messages: readonly KodaXMessage[]) =>
      messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
    expect(providerVisibleTranscript(firstCall.transcript))
      .not.toEqual(providerVisibleTranscript(secondCall.transcript));
    expect(firstCall.system).not.toContain('fresh-prefix-session-');
    expect(JSON.stringify(firstCall.transcript)).toContain('fresh-prefix-session-A');
    expect(JSON.stringify(secondCall.transcript)).toContain('fresh-prefix-session-B');
    expect(firstCall.ephemeralSuffix).toBeUndefined();
    expect(secondCall.ephemeralSuffix).toBeUndefined();
  });

  it('prepends options.session.initialMessages before the new prompt', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    const opts = {
      ...makeOptions(),
      session: {
        id: 'initial-messages-context-session',
        initialMessages: [
          { role: 'user' as const, content: 'prior question' },
          { role: 'assistant' as const, content: 'prior answer' },
        ],
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const result = await runManagedTaskViaRunner(opts, 'follow-up question', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'got it' }], toolBlocks: [] };
    });
    // The topology-only path still installs one hidden managed context carrier
    // immediately before the current real user prompt.
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.length).toBe(4);
    expect(firstTurn[0]!.role).toBe('user');
    expect(firstTurn[0]!.content).toBe('prior question');
    expect(firstTurn[1]!.role).toBe('assistant');
    expect(firstTurn[2]).toEqual(expect.objectContaining({
      role: 'user',
      _synthetic: true,
      _source: 'managed-run-context',
    }));
    expect(firstTurn[3]!.role).toBe('user');
    expect(firstTurn[3]!.content).toBe('follow-up question');

    const textOf = (message: KodaXMessage): string =>
      typeof message.content === 'string'
        ? message.content
        : message.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('');
    const systemMessage = result.messages.find((message) => message.role === 'system');
    const priorUser = result.messages.find((message) => textOf(message) === 'prior question');
    const currentUser = result.messages.find((message) => textOf(message) === 'follow-up question');
    const assistant = result.messages.find((message) => textOf(message) === 'got it');
    expect(result.messages[0]?.role).not.toBe('system');
    expect(systemMessage?.turnId).toBeUndefined();
    expect(priorUser?.turnId).toBeUndefined();
    expect(currentUser?.turnId).toMatch(/^turn_/);
    expect(assistant?.turnId).toBe(currentUser?.turnId);
  });

  it('falls back to raw string prompt when session.initialMessages is empty', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    await runManagedTaskViaRunner(makeOptions(), 'fresh task', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.at(-1)!.content).toBe('fresh task');
  });

  it('keeps Session scratch guidance request-only without a ReasoningPlan', async () => {
    const sessionId = 'topology-scratch-session';
    let capturedSystem = '';
    let capturedTranscript: readonly KodaXMessage[] = [];
    let capturedSuffix: KodaXEphemeralSuffix | undefined;

    await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        session: { id: sessionId },
      },
      'fresh task',
      async (transcript, _tools, system, ephemeralSuffix) => {
        capturedSystem = system;
        capturedTranscript = [...transcript];
        capturedSuffix = ephemeralSuffix;
        return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
      },
    );

    expect(capturedSystem).not.toContain(sessionId);
    expect(JSON.stringify(capturedTranscript)).toContain(sessionId);
    expect(capturedTranscript.at(-1)?.content).toBe('fresh task');
    expect(capturedSuffix).toBeUndefined();
    expect(capturedTranscript.find((message) =>
      message._source === 'managed-run-context')?.content)
      .toContain('Session Scratch Directory:');
  });
});

describe('Shard 6d-c4 — onIterationEnd + contextTokenSnapshot', () => {
  it('fires onIterationEnd after LLM turn with scope=worker', async () => {
    // FEATURE_193 v0.7.43: migrated from scout/generator to worker (V1 chain retired)
    const iterations: Array<{ iter: number; scope?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onIterationEnd: (info: { iter: number; scope?: string }) =>
          iterations.push({ iter: info.iter, scope: info.scope }),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'T', makeChainMockLlm({
      worker: () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }),
    }));
    expect(iterations.length).toBeGreaterThanOrEqual(1);
    expect(iterations.every((i) => i.scope === 'worker')).toBe(true);
  });

  it('returns a full-envelope estimate when no provider usage is reported', async () => {
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Hi',
      async () => ({ textBlocks: [{ text: 'Hi' }], toolBlocks: [] }),
    );
    expect(result.contextTokenSnapshot).toEqual(expect.objectContaining({
      source: 'estimate',
      currentTokens: expect.any(Number),
      baselineEstimatedTokens: expect.any(Number),
    }));
    expect(result.contextTokenSnapshot!.currentTokens)
      .toBeGreaterThan(result.contextTokenSnapshot!.baselineEstimatedTokens);
  });
});

describe('Shard 6d-c3 — budget extension at 90% threshold', () => {
  // FEATURE_193 v0.7.43: 'budget extension askUser is NOT fired on short Scout→Generator run' deleted
  //   (used makeChainMockLlm with scout:/generator: — V1 chain roles retired)

  it('fires askUser when revise summary lands and usage crosses 90% threshold', async () => {
    // Directly exercise `maybeRequestAdditionalWorkBudget` with a
    // pre-seeded controller, proving the helper we wire into the runner
    // path produces the expected askUser dialog + budget extension. The
    // integration with the Runner is exercised at compile-time via the
    // `wrapEmitterWithRecorder` budgetExtension path.
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<{ question: string }> = [];
    const events: KodaXEvents = {
      askUser: async (q: { question: string }) => {
        askUserCalls.push({ question: q.question });
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 370, // 92.5% — over 90% threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'needs more inspection',
      currentRound: 4,
      maxRounds: 6,
      originalTask: 'Heavy task',
    });
    expect(decision).toBe('approved');
    expect(askUserCalls.length).toBe(1);
    expect(askUserCalls[0]!.question).toMatch(/work units|budget/i);
    // Extension increased the budget
    expect(controller.totalBudget).toBeGreaterThan(400);
  });

  it('does not fire askUser when usage is below 90% threshold', async () => {
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<unknown> = [];
    const events: KodaXEvents = {
      askUser: async () => {
        askUserCalls.push({});
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 100, // 25% — well under threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'minor revise',
      currentRound: 2,
      maxRounds: 6,
      originalTask: 'Task',
    });
    expect(decision).toBe('skipped');
    expect(askUserCalls.length).toBe(0);
    expect(controller.totalBudget).toBe(400);
  });

  it('Risk-3: force=true bypasses the 90% threshold short-circuit', async () => {
    // Evaluator explicit budgetRequest funnels through this path: the
    // caller sets `force: true` so the dialog fires even when spent
    // budget is well below the 90% gate.
    const { maybeRequestAdditionalWorkBudget } = await import(
      './_internal/managed-task/budget.js'
    );
    const askUserCalls: Array<{ question: string }> = [];
    const events: KodaXEvents = {
      askUser: async (q: { question: string }) => {
        askUserCalls.push({ question: q.question });
        return 'continue';
      },
    } as KodaXEvents;
    const controller = {
      totalBudget: 400,
      spentBudget: 50, // 12.5% — deeply under the auto threshold
      currentHarness: 'H1_EXECUTE_EVAL' as const,
    };
    const decision = await maybeRequestAdditionalWorkBudget(events, controller, {
      summary: 'Evaluator requested more budget: need e2e',
      currentRound: 2,
      maxRounds: 6,
      originalTask: 'Task',
      force: true,
    });
    expect(decision).toBe('approved');
    expect(askUserCalls.length).toBe(1);
    expect(controller.totalBudget).toBeGreaterThan(400);
  });
});

// =============================================================================
// Risk-2 + Risk-3 + Risk-5 — wrapEmitterWithRecorder behavioural guards
//
// Direct exercises of the emit-wrapper's verdict processing via the
// `__runnerDrivenTestables` export. These tests stub the underlying
// emitter (no real LLM, no Runner boot) and assert the wrapper's
// rewrite / auto-conversion / budget-dialog behaviour.
// =============================================================================

describe('wrapEmitterWithRecorder — Risk 2/3/5 behavioural guards', () => {
  type VerdictFixture = {
    status: 'accept' | 'revise' | 'blocked';
    reason?: string;
    followups?: string[];
    nextHarness?: 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
    budgetRequest?: string;
  };

  async function harnessTestables() {
    const mod = await import('./runner-driven.js');
    const budgetMod = await import('./_internal/managed-task/budget.js');
    return { ...mod.__runnerDrivenTestables, ...budgetMod };
  }

  function makeFakeVerdictEmitter(verdict: VerdictFixture): RunnableTool {
    return {
      name: 'emit_verdict',
      description: 'stub',
      input_schema: { type: 'object' },
      execute: async () => ({
        content: 'emitted',
        metadata: {
          role: 'evaluator',
          payload: {
            verdict: {
              source: 'evaluator',
              status: verdict.status,
              reason: verdict.reason,
              followups: verdict.followups ?? [],
              userFacingText: '',
              nextHarness: verdict.nextHarness,
              budgetRequest: verdict.budgetRequest,
            },
          },
          handoffTarget: verdict.status === 'revise' ? 'kodax/role/generator' : undefined,
          isTerminal: verdict.status !== 'revise',
        },
      }),
    } as unknown as RunnableTool;
  }

  function makeBudgetExtensionFixture(opts: {
    events?: KodaXEvents;
    upgradeCeiling?: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
    harness?: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
  }) {
    // Plan fixture is intentionally minimal — the wrapper only reads
    // `decision.harnessProfile` and `decision.upgradeCeiling`, so the
    // rest of ReasoningPlan's surface is not required for these tests.
    // Cast through `unknown` to satisfy the full interface.
    const planRef = {
      current: {
        decision: {
          primaryTask: 'edit',
          workIntent: 'implement',
          complexity: 'medium',
          riskLevel: 'low',
          harnessProfile: opts.harness ?? 'H1_EXECUTE_EVAL',
          upgradeCeiling: opts.upgradeCeiling ?? 'H2_PLAN_EXECUTE_EVAL',
          topologyCeiling: 'solo',
          assuranceIntent: 'default',
          recommendedMode: 'default',
          requiresBrainstorm: false,
          reason: 'test',
        },
        effort: 'medium',
        promptOverlay: undefined,
      },
    };
    return {
      planRef,
      degradedContinueRef: { current: false },
      harnessRef: { current: opts.harness ?? 'H1_EXECUTE_EVAL' },
      events: opts.events,
      originalTask: 'test task',
      roundRef: { current: 1 },
      maxRoundsRef: { current: 6 },
      budgetApprovalRef: { current: false },
    } as any;
  }

  function makeBudgetController(init: { total: number; spent: number; harness?: string }) {
    return {
      totalBudget: init.total,
      spentBudget: init.spent,
      currentHarness: init.harness ?? 'H1_EXECUTE_EVAL',
      lastApprovalBudgetTotal: 0,
    } as any;
  }

  const makeRecorder = (): any => ({
    scout: undefined,
    contract: undefined,
    handoff: undefined,
    verdict: undefined,
  });

  const noopObserver: any = {
    onRoleEmit: () => undefined,
    notifyBudgetApprovalRequest: () => undefined,
  };

  const toolCtx: any = { gitRoot: process.cwd(), executionCwd: process.cwd(), agent: 'test' };

  it('Risk-3: explicit budgetRequest triggers askUser below 90% threshold', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const askUserCalls: Array<{ question: string }> = [];
    const events: KodaXEvents = {
      askUser: async (q: { question: string }) => {
        askUserCalls.push({ question: q.question });
        return 'continue';
      },
    } as KodaXEvents;
    const base = makeFakeVerdictEmitter({
      status: 'revise',
      reason: 'need another e2e pass',
      budgetRequest: 'need another e2e pass',
    });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 40 }); // 20% — well below 90%
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      events,
    });

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await wrapped.execute({}, toolCtx);

    expect(askUserCalls.length).toBe(1);
    // The dialog summary surfaces the Evaluator's explicit reason.
    expect(askUserCalls[0]!.question).toMatch(/work units|budget/i);
  });

  it('Risk-3: missing budgetRequest + below 90% → no dialog fires', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const askUserCalls: Array<unknown> = [];
    const events: KodaXEvents = {
      askUser: async () => {
        askUserCalls.push({});
        return 'continue';
      },
    } as KodaXEvents;
    const base = makeFakeVerdictEmitter({ status: 'accept', reason: 'done' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 40 });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      events,
    });

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await wrapped.execute({}, toolCtx);

    expect(askUserCalls.length).toBe(0);
  });

  it.each(['accept', 'blocked'] as const)(
    'Risk-3: %s verdict never requests more budget even with an explicit budgetRequest',
    async (status) => {
      const { wrapEmitterWithRecorder } = await harnessTestables();
      const askUserCalls: Array<unknown> = [];
      const approvalNotifications: Array<unknown> = [];
      const events: KodaXEvents = {
        askUser: async () => {
          askUserCalls.push({});
          return 'continue';
        },
      } as KodaXEvents;
      const base = makeFakeVerdictEmitter({
        status,
        reason: status === 'accept' ? 'done' : 'needs user input',
        budgetRequest: 'stale evaluator budget request',
      });
      const recorder = makeRecorder();
      const budget = makeBudgetController({ total: 200, spent: 200 });
      const budgetExtension = makeBudgetExtensionFixture({
        harness: 'H1_EXECUTE_EVAL',
        events,
      });
      const observer = {
        ...noopObserver,
        notifyBudgetApprovalRequest: (...args: unknown[]) => {
          approvalNotifications.push(args);
        },
      };

      const wrapped = wrapEmitterWithRecorder(
        base,
        'verdict',
        recorder,
        observer,
        budget,
        budgetExtension,
      );
      await wrapped.execute({}, toolCtx);

      expect(approvalNotifications).toHaveLength(0);
      expect(askUserCalls).toHaveLength(0);
    },
  );

  it('Risk-5: a revise verdict passes through unchanged (no same-harness revise cap)', async () => {
    // The per-harness revise cap (reviseCountByHarnessRef) was never wired —
    // the counter was created but never read — and was removed in ADR-043. A
    // revise verdict therefore always passes through; the round cap is the only
    // bound.
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const base = makeFakeVerdictEmitter({ status: 'revise', reason: 'retry' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50, harness: 'H2_PLAN_EXECUTE_EVAL' });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H2_PLAN_EXECUTE_EVAL',
    });

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as { payload: { verdict: { status: string } } };
    expect(meta.payload.verdict.status).toBe('revise');
  });

  it('Risk-5: multi-emit on same slot — recorder holds the LAST payload (last-wins)', async () => {
    // When the LLM calls emit_verdict twice in one turn (either by
    // accident or as a self-correction), the recorder must hold the
    // SECOND payload so handoff routing reflects the corrected intent.
    // Legacy managed-protocol-handoff.test.ts explicitly covered this
    // for the text-fence path ("uses the last verdict block when
    // multiple exist"); the same semantic must hold for the tool-call
    // path.
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 10 });
    const budgetExtension = makeBudgetExtensionFixture({ harness: 'H1_EXECUTE_EVAL' });

    // First emit: revise with one reason
    const firstBase = makeFakeVerdictEmitter({ status: 'revise', reason: 'first pass incomplete' });
    const firstWrapped = wrapEmitterWithRecorder(firstBase, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await firstWrapped.execute({}, toolCtx);
    expect((recorder as any).verdict?.payload.verdict?.reason).toBe('first pass incomplete');

    // Second emit on same slot: self-correct to accept
    const secondBase = makeFakeVerdictEmitter({ status: 'accept', reason: 'actually done' });
    const secondWrapped = wrapEmitterWithRecorder(secondBase, 'verdict', recorder, noopObserver, budget, budgetExtension);
    await secondWrapped.execute({}, toolCtx);
    // Last-wins semantic — recorder now holds the second payload
    expect((recorder as any).verdict?.payload.verdict?.status).toBe('accept');
    expect((recorder as any).verdict?.payload.verdict?.reason).toBe('actually done');
  });

  it('Risk-5: malformed verdict (missing payload fields) passes through without mutation', async () => {
    // When the emitter's base.execute returns a metadata-less error
    // (e.g. schema validation failed, emit tool rejected the input),
    // wrapEmitterWithRecorder must NOT try to rewrite — the recorder
    // stays empty and downstream handoff falls through to whatever the
    // fallback path decides. This guards the silent-fatal regression
    // the old managed-protocol-handoff.test.ts covered.
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const errorBase = {
      name: 'emit_verdict',
      description: 'stub',
      input_schema: { type: 'object' },
      execute: async () => ({ content: '[emit error]', isError: true }),
    } as unknown as RunnableTool;
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50 });
    const budgetExtension = makeBudgetExtensionFixture({ harness: 'H1_EXECUTE_EVAL' });

    const wrapped = wrapEmitterWithRecorder(errorBase, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    expect(result.isError).toBe(true);
    // Degraded-continue flag untouched
    expect(budgetExtension.degradedContinueRef.current).toBe(false);
  });
});

// =============================================================================
// H1 structural resume (v0.7.26) — buildStructuralResumeSeed
// =============================================================================

// FEATURE_193 v0.7.43: 'H1 structural resume — buildStructuralResumeSeed' describe deleted
//   (all 6 tests used V1 chain resume concepts: scoutCompleted, rolesEmitted=['scout'], startingRole='generator'/'planner'/'scout')

describe('FEATURE_166 v0.7.41 follow-up — agent-switch label flip', () => {
  // FEATURE_193 v0.7.43: withHarnessV2 async helper deleted (KODAX_HARNESS_V2 env flag retired — V2 is now unconditional default)

  // FEATURE_184 Phase C.1 (v0.7.45): Deleted "emits a phase=worker status
  // with activeWorkerTitle='Evaluator' AFTER Worker emit_handoff and BEFORE
  // Evaluator emit_verdict" test — tested V2 Worker→Evaluator handoff label
  // flip which required in-chain Evaluator. Evaluator removed from chain.

  // FEATURE_193 v0.7.43: 'does not emit agent-switched when no handoff happens (single-role H0 direct run)' deleted
  //   (used withHarnessV2('false') + scout: mock with emit_scout_verdict — V1 chain roles retired)

  it('NULL_OBSERVER provides a no-op agentSwitched so chain-only test paths do not throw', () => {
    // The NULL_OBSERVER is used in topology-only tests that build the
    // chain without runtime events. agentSwitched must exist (or
    // calling it would throw `undefined is not a function`) but be
    // a no-op. This is a structural pin — without it, the
    // ObserverBridge contract addition could silently break any
    // existing test that passes NULL_OBSERVER.
    //
    // We can't import NULL_OBSERVER directly (not exported), but
    // buildRunnerAgentChain accepts the default `observer:
    // NULL_OBSERVER` parameter, so reaching this line without
    // throwing is itself the assertion.
    expect(() => buildRunnerAgentChain(makeCtx(), {})).not.toThrow();
  });
});
