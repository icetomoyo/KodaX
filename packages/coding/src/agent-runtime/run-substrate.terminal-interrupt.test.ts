import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMessageQueueForTests,
  actorQueueId,
  createMemoryControlPlane,
  createSessionLineage,
  getMessageQueue,
  getSessionMessageEntryId,
  type KodaXMemoryOutcomeDigest,
  type KodaXSessionData,
} from '@kodax-ai/agent';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
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

import { runKodaX } from '../agent.js';
import { deriveCodingMemoryIdentity } from '../memory-runtime.js';
import { CodingActorSession } from './actor-runtime.js';

const PROVIDER_NAME = 'terminal-interrupt-provider';
const API_KEY_ENV = 'TERMINAL_INTERRUPT_PROVIDER_API_KEY';
const MAX_CONTINUATION_TURNS = 8;

describe('runKodaX Runtime terminal interrupt continuation', { timeout: 30_000 }, () => {
  let actorSession: CodingActorSession | undefined;

  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    _resetMessageQueueForTests();
  });

  afterEach(async () => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
    _resetMessageQueueForTests();
    await actorSession?.close('test complete');
    actorSession = undefined;
  });

  it('reports a local dispatch exception independently of the last assistant reply', async () => {
    class LocalFailureProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV, model: 'baseline-model', supportsThinking: false,
      };
      async stream(): Promise<KodaXStreamResult> {
        return { textBlocks: [{ type: 'text', text: 'Reading the image now.' }],
          toolBlocks: [{ type: 'tool_use', id: 'read-image', name: 'read', input: { path: 'image.png' } }],
          thinkingBlocks: [] };
      }
    }
    registerModelProvider(PROVIDER_NAME, () => new LocalFailureProvider());
    const result = await runKodaX({ provider: PROVIDER_NAME, maxIter: 2, lsp: false,
      context: { executionCwd: process.cwd(), repoIntelligenceMode: 'off' },
      events: { beforeToolExecute: async () => { throw new TypeError('result.startsWith is not a function'); } },
    }, 'Read the image');
    expect(result.success).toBe(false);
    expect(result.failure).toMatchObject({ source: 'local', errorClass: 'local_execution_error',
      errorName: 'TypeError', message: expect.stringContaining('result.startsWith is not a function') });
    expect(result.failure?.provider).toBeUndefined();
  });

  it('consumes input accepted during the final provider request before completing', async () => {
    const sessionId = 'ordinary-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');
    let turn = 0;
    let inputWindowOpen = true;
    const delivered: string[][] = [];
    const turnStarts: Array<{ turnId: string; deliveryKind: string }> = [];
    const turnCompletions: string[] = [];
    const outputSegments: Array<{ responseId: string; mode: 'append' | 'replace' }> = [];

    class TerminalInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(
        messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        _streamOptions?: KodaXProviderStreamOptions,
        _signal?: AbortSignal,
      ): Promise<KodaXStreamResult> {
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
            textBlocks: [{ type: 'text', text: 'first answer' }],
            toolBlocks: [],
            thinkingBlocks: [],
          };
        }
        expect(JSON.stringify(messages.at(-1)?.content)).toContain(
          'interrupt accepted during the final request',
        );
        return {
          textBlocks: [{ type: 'text', text: 'follow-up answer' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new TerminalInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
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
          onMidTurnUserMessages(contents) {
            delivered.push([...contents]);
          },
          onTurnStarted(event) {
            turnStarts.push({
              turnId: event.turnId,
              deliveryKind: event.deliveryKind,
            });
          },
          onTurnCompleted(event) {
            turnCompletions.push(event.turnId);
          },
          onOutputSegmentStart({ responseId, mode }) {
            outputSegments.push({ responseId, mode });
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('follow-up answer');
    expect(turn).toBe(2);
    expect(delivered).toEqual([['interrupt accepted during the final request']]);
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0]?.deliveryKind).toBe('initial');
    expect(turnStarts[1]?.deliveryKind).toBe('queued');
    expect(turnStarts[1]?.turnId).not.toBe(turnStarts[0]?.turnId);
    expect(outputSegments).toEqual([
      { responseId: turnStarts[0]?.turnId, mode: 'append' },
      { responseId: turnStarts[1]?.turnId, mode: 'append' },
    ]);
    expect(turnCompletions).toEqual([
      turnStarts[0]?.turnId,
      turnStarts[1]?.turnId,
    ]);
    expect(inputWindowOpen).toBe(false);
    expect(getMessageQueue().has({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    })).toBe(false);
  });

  it('does not consume a Runtime prompt queued behind a host-owned Skill invocation', async () => {
    const sessionId = 'host-owned-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');
    const delivered: string[][] = [];
    let turn = 0;

    class HostOwnedInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(): Promise<KodaXStreamResult> {
        turn += 1;
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'user',
          mode: 'prompt',
          delivery: 'host',
          content: '/hidden-skill args',
        });
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'user',
          mode: 'prompt',
          content: 'later Runtime prompt',
        });
        return {
          textBlocks: [{ type: 'text', text: 'first answer' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new HostOwnedInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX({
      provider: PROVIDER_NAME,
      model: 'baseline-model',
      maxIter: 1,
      lsp: false,
      session: { id: sessionId },
      context: {
        actorSession,
        gitRoot: process.cwd(),
        executionCwd: process.cwd(),
        repoIntelligenceMode: 'off',
        interruptInput: {
          closeInputWindow() {},
          reopenInputWindow() {},
        },
      },
      events: {
        onMidTurnUserMessages(contents) {
          delivered.push([...contents]);
        },
      },
    }, 'first prompt');

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('first answer');
    expect(turn).toBe(1);
    expect(delivered).toEqual([]);
    expect(getMessageQueue().peek({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    }).map((message) => message.content)).toEqual([
      '/hidden-skill args',
      'later Runtime prompt',
    ]);
  });

  it('persists a Runtime-owned interrupt before exposing its exact entry reference', async () => {
    const sessionId = 'runtime-terminal-interrupt-entry-reference';
    const queueAgentId = actorQueueId(sessionId, '/root');
    let turn = 0;
    let lineage: KodaXSessionData['lineage'];
    let deliveredQueueId: string | undefined;
    let deliveredEntryId: string | undefined;

    class RuntimeInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(): Promise<KodaXStreamResult> {
        turn += 1;
        if (turn === 1) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'runtime durable interrupt',
          });
        }
        return {
          textBlocks: [{ type: 'text', text: `answer ${turn}` }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new RuntimeInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });
    const result = await runKodaX({
      provider: PROVIDER_NAME,
      model: 'baseline-model',
      maxIter: 1,
      lsp: false,
      session: {
        id: sessionId,
        persistedByHost: false,
        storage: {
          load: async () => null,
          save: async (_id: string, data: KodaXSessionData) => {
            lineage = createSessionLineage(data.messages, lineage);
          },
        },
      },
      context: {
        actorSession,
        gitRoot: process.cwd(),
        executionCwd: process.cwd(),
        repoIntelligenceMode: 'off',
        interruptInput: {
          closeInputWindow() {},
          reopenInputWindow() {},
        },
      },
      events: {
        onMidTurnUserMessages(_contents, meta) {
          expect(lineage).toBeDefined();
          deliveredQueueId = meta?.queuedMessageIds?.[0];
          deliveredEntryId = deliveredQueueId === undefined
            ? undefined
            : meta?.queuedMessageEntryIds?.[deliveredQueueId];
        },
      },
    }, 'first prompt');

    expect(turn).toBe(2);
    expect(deliveredEntryId).toMatch(/^entry_/);
    expect(deliveredEntryId).toBe(getSessionMessageEntryId(result.messages.at(-2)!));
  });

  it('does not expose a Runtime-owned interrupt when its canonical persistence fails', async () => {
    const sessionId = 'runtime-terminal-interrupt-save-failure';
    const queueAgentId = actorQueueId(sessionId, '/root');
    const delivered: string[][] = [];
    let turn = 0;

    class FailedRuntimeInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(): Promise<KodaXStreamResult> {
        turn += 1;
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'user',
          mode: 'prompt',
          content: 'must not be reported delivered',
        });
        return {
          textBlocks: [{ type: 'text', text: 'first answer' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new FailedRuntimeInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });
    const result = await runKodaX({
      provider: PROVIDER_NAME,
      model: 'baseline-model',
      maxIter: 1,
      lsp: false,
      session: {
        id: sessionId,
        persistedByHost: false,
        storage: {
          load: async () => null,
          save: async () => {
            throw new Error('canonical interrupt persistence failed');
          },
        },
      },
      context: {
        actorSession,
        gitRoot: process.cwd(),
        executionCwd: process.cwd(),
        repoIntelligenceMode: 'off',
        interruptInput: {
          closeInputWindow() {},
          reopenInputWindow() {},
        },
      },
      events: {
        onMidTurnUserMessages(contents) {
          delivered.push([...contents]);
        },
      },
    }, 'first prompt');

    expect(result.success).toBe(false);
    expect(turn).toBe(1);
    expect(delivered).toEqual([]);
  });

  it('binds memory_intent to a queued user turn instead of the initial prompt', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-sa-memory-follow-up-'));
    const sessionId = 'ordinary-memory-follow-up';
    const queueAgentId = actorQueueId(sessionId, '/root');
    const followUp = 'From now on, remember to run focused tests before reporting success.';
    let turn = 0;
    let outcome: KodaXMemoryOutcomeDigest | undefined;

    class MemoryFollowUpProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
        turn += 1;
        if (turn === 1) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: followUp,
          });
          return {
            textBlocks: [{ type: 'text', text: 'first answer' }],
            toolBlocks: [],
            thinkingBlocks: [],
          };
        }
        if (turn === 2) {
          expect(JSON.stringify(messages.at(-1)?.content)).toContain(followUp);
          return {
            textBlocks: [],
            toolBlocks: [{
              type: 'tool_use',
              id: 'remember-follow-up',
              name: 'memory_intent',
              input: {
                operation: 'remember',
                statement: 'run focused tests before reporting success.',
                userQuote: followUp,
                claimKind: 'procedure',
                claimKey: 'project.procedure.report-verification',
              },
            }],
            thinkingBlocks: [],
          };
        }
        expect(JSON.stringify(messages.at(-1)?.content)).toContain('Memory remembered');
        return {
          textBlocks: [{ type: 'text', text: 'follow-up captured' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new MemoryFollowUpProvider());
    actorSession = new CodingActorSession({ sessionId });
    try {
      const result = await runKodaX({
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 4,
        lsp: false,
        memoryReviewer: async (input) => ({
          trigger: input.trigger,
          createdAt: '2026-07-29T05:00:00.000Z',
          sourceRefs: input.sourceRefs,
          candidateRefs: input.candidateRefs,
          actions: [],
          warnings: [],
        }),
        session: { id: sessionId },
        context: {
          actorSession,
          configHome: home,
          gitRoot: home,
          executionCwd: home,
          repoIntelligenceMode: 'off',
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
      }, 'Inspect the current implementation.');

      expect(result.success).toBe(true);
      expect(outcome).toBeDefined();
      expect(outcome?.handledMemoryOperations).toMatchObject([{
        operation: 'remember',
        claimKey: 'project.procedure.report-verification',
      }]);
      const identity = deriveCodingMemoryIdentity({
        provider: PROVIDER_NAME,
        context: { configHome: home, executionCwd: home, gitRoot: home },
      }, home, sessionId);
      const controller = createMemoryControlPlane({ cwd: home, identity, discoverSkills: false });
      const [remembered] = await controller.listRefs({ kinds: ['memdir'] });
      if (remembered === undefined) throw new Error('expected durable explicit Memory');
      expect((await controller.readRef(remembered)).body)
        .toContain('run focused tests before reporting success.');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps immediately applied Memory after a later AbortError interrupts the episode', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-sa-memory-cancelled-'));
    const sessionId = 'ordinary-memory-cancelled';
    const userRequest = 'Going forward, remember to run focused tests before reporting success.';
    let turn = 0;
    let outcome: KodaXMemoryOutcomeDigest | undefined;
    const reviewTriggers: string[] = [];

    class CancelledMemoryProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(): Promise<KodaXStreamResult> {
        turn += 1;
        if (turn === 1) {
          return {
            textBlocks: [],
            toolBlocks: [{
              type: 'tool_use',
              id: 'remember-before-interrupt',
              name: 'memory_intent',
              input: {
                operation: 'remember',
                statement: 'run focused tests before reporting success.',
                userQuote: userRequest,
                claimKind: 'procedure',
                claimKey: 'project.procedure.report-verification',
              },
            }],
            thinkingBlocks: [],
          };
        }
        const error = new Error('user interrupted after intent capture');
        error.name = 'AbortError';
        throw error;
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new CancelledMemoryProvider());
    actorSession = new CodingActorSession({ sessionId });
    try {
      const result = await runKodaX({
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 4,
        lsp: false,
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
        session: { id: sessionId },
        context: {
          actorSession,
          configHome: home,
          gitRoot: home,
          executionCwd: home,
          repoIntelligenceMode: 'off',
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
      }, userRequest);

      expect(result).toMatchObject({ success: true, interrupted: true });
      expect(outcome).toBeUndefined();
      expect(reviewTriggers).not.toContain('episode_completed');
      const identity = deriveCodingMemoryIdentity({
        provider: PROVIDER_NAME,
        context: { configHome: home, executionCwd: home, gitRoot: home },
      }, home, sessionId);
      const controller = createMemoryControlPlane({ cwd: home, identity, discoverSkills: false });
      expect(await controller.listRefs({ kinds: ['memdir'] })).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not expose root memory tools for a parent-only internal run', async () => {
    const sessionId = 'ordinary-parent-only-internal';
    let exposedTools: readonly string[] = [];
    let outcome: KodaXMemoryOutcomeDigest | undefined;

    class ParentOnlyInternalProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(
        _messages: KodaXMessage[],
        tools: KodaXToolDefinition[],
      ): Promise<KodaXStreamResult> {
        exposedTools = tools.map((tool) => tool.name);
        return {
          textBlocks: [{ type: 'text', text: 'internal run complete' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new ParentOnlyInternalProvider());
    const result = await runKodaX({
      provider: PROVIDER_NAME,
      model: 'baseline-model',
      maxIter: 1,
      lsp: false,
      session: { id: sessionId },
      context: {
        parentAgentId: '/root',
        gitRoot: process.cwd(),
        executionCwd: process.cwd(),
        repoIntelligenceMode: 'off',
      },
      events: {
        onMemoryOutcomeDigest(digest) {
          outcome = digest;
        },
      },
    }, 'Run one internal task.');

    expect(result.success).toBe(true);
    expect(exposedTools).not.toContain('memory_intent');
    expect(exposedTools).not.toContain('memory_recall');
    expect(outcome).toBeUndefined();
  });

  it('bounds continuously accepted terminal input to a fixed continuation allowance', async () => {
    const sessionId = 'ordinary-bounded-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');
    let turn = 0;
    let inputWindowOpen = true;

    class ContinuousTerminalInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
        turn += 1;
        if (inputWindowOpen && turn <= MAX_CONTINUATION_TURNS + 3) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: `interrupt-${turn}`,
          });
        }
        if (turn === MAX_CONTINUATION_TURNS + 1) {
          expect(JSON.stringify(messages.at(-1)?.content)).toContain(
            `interrupt-${MAX_CONTINUATION_TURNS}`,
          );
        }
        return {
          textBlocks: [{ type: 'text', text: `answer-${turn}` }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new ContinuousTerminalInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {
              inputWindowOpen = false;
            },
            reopenInputWindow() {
              inputWindowOpen = true;
            },
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe(`answer-${MAX_CONTINUATION_TURNS + 1}`);
    expect(turn).toBe(MAX_CONTINUATION_TURNS + 1);
    expect(inputWindowOpen).toBe(false);
  });

  it('commits a COMPLETE assistant before continuing with accepted input', async () => {
    const sessionId = 'ordinary-complete-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');
    let turn = 0;
    let inputWindowOpen = true;

    class CompleteTerminalInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(
        messages: KodaXMessage[],
        _tools: KodaXToolDefinition[],
        _system: string,
      ): Promise<KodaXStreamResult> {
        turn += 1;
        if (turn === 1) {
          getMessageQueue().enqueue({
            agentId: queueAgentId,
            priority: 'user',
            mode: 'prompt',
            content: 'follow up after COMPLETE',
          });
          return {
            textBlocks: [{ type: 'text', text: 'first answer <promise>COMPLETE</promise>' }],
            toolBlocks: [],
            thinkingBlocks: [],
          };
        }
        const previousAssistant = messages.at(-2);
        expect(previousAssistant?.role).toBe('assistant');
        expect(JSON.stringify(previousAssistant?.content)).toContain('first answer');
        expect(JSON.stringify(messages.at(-1)?.content)).toContain('follow up after COMPLETE');
        return {
          textBlocks: [{ type: 'text', text: 'follow-up answer' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new CompleteTerminalInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {
              inputWindowOpen = false;
            },
            reopenInputWindow() {
              inputWindowOpen = true;
            },
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('follow-up answer');
    expect(turn).toBe(2);
    expect(inputWindowOpen).toBe(false);
  });

  it('keeps the complete interrupt batch queued when any artifact fails validation', async () => {
    const sessionId = 'ordinary-invalid-terminal-interrupt';
    const queueAgentId = actorQueueId(sessionId, '/root');

    class InvalidInterruptProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(): Promise<KodaXStreamResult> {
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'user',
          mode: 'prompt',
          content: 'valid queued input',
        });
        getMessageQueue().enqueue({
          agentId: queueAgentId,
          priority: 'user',
          mode: 'prompt',
          content: 'invalid queued input',
          inputArtifacts: [{
            kind: 'file',
            path: 'report.pdf',
            mediaType: 'application/pdf',
          }],
        });
        return {
          textBlocks: [{ type: 'text', text: 'first answer' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new InvalidInterruptProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {},
            reopenInputWindow() {},
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(false);
    expect(getMessageQueue().peek({
      agentId: queueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    }).map((message) => message.content)).toEqual([
      'valid queued input',
      'invalid queued input',
    ]);
  });

  it('closes interrupt admission before ordinary failure cleanup', async () => {
    const sessionId = 'ordinary-terminal-failure';
    let inputWindowOpen = true;

    class FailingProvider extends KodaXBaseProvider {
      readonly name = PROVIDER_NAME;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: API_KEY_ENV,
        model: 'baseline-model',
        supportsThinking: false,
      };

      async stream(): Promise<KodaXStreamResult> {
        throw new Error('ordinary-provider-failure');
      }
    }

    registerModelProvider(PROVIDER_NAME, () => new FailingProvider());
    actorSession = new CodingActorSession({ sessionId });

    const result = await runKodaX(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        lsp: false,
        session: { id: sessionId },
        context: {
          actorSession,
          gitRoot: process.cwd(),
          executionCwd: process.cwd(),
          repoIntelligenceMode: 'off',
          interruptInput: {
            closeInputWindow() {
              inputWindowOpen = false;
            },
            reopenInputWindow() {
              inputWindowOpen = true;
            },
          },
        },
      },
      'first prompt',
    );

    expect(result.success).toBe(false);
    expect(inputWindowOpen).toBe(false);
  });
});
