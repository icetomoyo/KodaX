import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXSessionData, QueuedMessage } from '@kodax-ai/agent';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  type KodaXMessage,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { runKodaX } from './agent.js';
import { LEARNING_REVIEW_TOOL } from './learning-reviewer.js';
import { awaitLatestCodingMemoryReviewDrain } from './memory-runtime.js';

const PROVIDER = 'queue-input-limit-test';
const API_KEY_ENV = 'KODAX_QUEUE_INPUT_LIMIT_TEST_KEY';

describe('SA Host queue consumption at the iteration limit', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-queue-limit-'));
    vi.stubEnv(API_KEY_ENV, 'test-key');
  });

  afterEach(async () => {
    await awaitLatestCodingMemoryReviewDrain(5_000);
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it.each([
    { label: 'consumes a follow-up at the next safe point', enqueueEveryRequest: false, requestCount: 2 },
    { label: 'retains the final follow-up when no continuation request remains', enqueueEveryRequest: true, requestCount: 9 },
  ])('$label', async ({ enqueueEveryRequest, requestCount }) => {
    const requests: KodaXMessage[][] = [];
    const pending: QueuedMessage[] = [];
    const consumed: string[] = [];
    let saved: KodaXSessionData = { messages: [], gitRoot: cwd };

    class QueueLimitProvider extends KodaXBaseProvider {
      readonly name = PROVIDER;
      readonly supportsThinking = false;
      protected readonly config = {
        apiKeyEnv: API_KEY_ENV, model: 'queue-limit-test', supportsThinking: false,
      };

      async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
        if (tools.some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) {
          return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
            type: 'tool_use', id: 'review', name: LEARNING_REVIEW_TOOL.name,
            input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } },
          }] };
        }
        requests.push(structuredClone(messages));
        const index = requests.length;
        if (enqueueEveryRequest || index === 1) {
          pending.push({
            id: `queued-${index}`, inputId: `input-${index}`, agentId: 'queue-limit-session',
            priority: 'user', mode: 'prompt', content: `follow-up-${index}`, enqueuedAt: index,
          });
        }
        return { textBlocks: [{ type: 'text', text: `answer-${index}` }], toolBlocks: [], thinkingBlocks: [] };
      }
    }

    registerModelProvider(PROVIDER, () => new QueueLimitProvider());
    const result = await runKodaX({
      provider: PROVIDER, model: 'queue-limit-test', agentMode: 'sa', maxIter: 1, lsp: false,
      session: {
        id: 'queue-limit-session', persistedByHost: false,
        storage: {
          async load() { return structuredClone(saved); },
          async save(_id, data) { saved = structuredClone(data); },
        },
      },
      context: {
        executionCwd: cwd, gitRoot: cwd, repoIntelligenceMode: 'off',
        interruptInput: {
          closeInputWindow() {},
          reopenInputWindow() {},
          async consumePendingInputs(persist) {
            const batch = pending.slice();
            if (batch.length === 0) return [];
            await persist(batch);
            pending.splice(0, batch.length);
            consumed.push(...batch.map(input => input.inputId!));
            return batch;
          },
        },
      },
    }, 'initial query');

    expect(result.failure).toBeUndefined();
    expect(requests).toHaveLength(requestCount);
    expect(consumed).toEqual(Array.from({ length: requestCount - 1 }, (_, i) => `input-${i + 1}`));
    for (let i = 1; i < requestCount; i += 1) {
      const followUp = requests[i]!.filter(message => message.inputId === `input-${i}`);
      expect(followUp).toHaveLength(1);
      expect(followUp[0]?.content).toBe(`follow-up-${i}`);
      expect(requests[i - 1]!.some(message => message.inputId === `input-${i}`)).toBe(false);
    }
    expect(pending.map(input => input.inputId)).toEqual(enqueueEveryRequest ? ['input-9'] : []);
    expect(result.messages.some(message => message.inputId === 'input-9')).toBe(false);
    expect(saved.messages.filter(message => message.inputId?.startsWith('input-'))).toHaveLength(requestCount - 1);
    expect(saved.messages.some(message => message.inputId === 'input-9')).toBe(false);
  });
});
