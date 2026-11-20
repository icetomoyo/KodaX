/**
 * Contract test for CAP-005: onComplete event
 *
 * Test obligations:
 * - CAP-EVENTS-COMPLETE-001a: fires on success terminal
 * - CAP-EVENTS-COMPLETE-001b: fires on interrupt / abort terminal
 * - CAP-EVENTS-COMPLETE-001c: error terminal fires `onError` (not
 *   `onComplete`) — these terminal events are mutually exclusive per
 *   CAP-084 contract
 * - CAP-EVENTS-COMPLETE-001d: fires exactly once on iteration-limit success
 * - CAP-EVENTS-COMPLETE-001e: fires only after asynchronous result finalization
 * - CAP-EVENTS-COMPLETE-001f: observer errors cannot rewrite a finalized result
 *
 * Risk: HIGH — REPL terminal cleanup relies on exactly-one terminal
 * event per run.
 *
 * Verified call sites: agent-runtime/run-substrate.ts (model completion,
 * iteration-limit completion, and block sites) +
 * agent-runtime/catch-terminals.ts:applyGenericErrorTerminal (error site
 * fires `onError` only).
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6u.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  runWithProviderCredential,
} from '@kodax-ai/llm';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';

import { runTestLeaf as runLeafAgent } from '../test-leaf.js';

const PROVIDER_NAME = 'cap-005-test-provider';
const API_KEY_ENV = 'CAP_005_TEST_PROVIDER_API_KEY';

type Behavior = 'success' | 'throw' | 'tool-loop';

class CompleteEventProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'baseline-model',
    supportsThinking: false,
  };
  constructor(private readonly behavior: Behavior) {
    super();
  }
  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    if (this.behavior === 'throw') throw new Error('synthetic terminal failure');
    if (this.behavior === 'tool-loop') {
      return {
        textBlocks: [],
        toolBlocks: [{
          type: 'tool_use',
          id: 'read-package',
          name: 'read',
          input: { path: 'package.json' },
        }],
        thinkingBlocks: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

// Issue 128: contract tests drive runLeafAgent end-to-end and flake at 5000ms
// default under heavy parallel vitest load. Match the root 30s ceiling.
describe('CAP-005: onComplete event contract', { timeout: 30_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('CAP-EVENTS-COMPLETE-001a: fires on success terminal (text-only run completes)', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const onComplete = vi.fn();
    const result = await runLeafAgent(
      { provider: PROVIDER_NAME, model: 'baseline-model', events: { onComplete } },
      'do thing',
    );
    expect(result.success).toBe(true);
    expect(onComplete).toHaveBeenCalled();
  });

  it('CAP-EVENTS-COMPLETE-001b: fires on interrupt / abort terminal', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const controller = new AbortController();
    controller.abort();
    const onComplete = vi.fn();
    const result = await runLeafAgent(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        abortSignal: controller.signal,
        events: { onComplete },
      },
      'do thing',
    );
    // Whether success=false or success=true (race), the terminal MUST
    // emit a single terminal event. For abort the substrate fires
    // `onComplete` with no signal value (interrupt branch). Asserting
    // it was called at least once is the contract.
    expect(result).toBeDefined();
    expect(onComplete).toHaveBeenCalled();
  });

  it('CAP-EVENTS-COMPLETE-001f: isolates a completion observer AbortError after finalization', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const onComplete = vi.fn(() => {
      const error = new Error('observer interrupted');
      error.name = 'AbortError';
      throw error;
    });
    const completedStatuses: string[] = [];

    const result = await runLeafAgent(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: {
          onComplete,
          onTurnCompleted: (event) => completedStatuses.push(event.status),
        },
      },
      'do thing',
    );

    expect(result.success).toBe(true);
    expect(result.interrupted).not.toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(completedStatuses).toEqual(['completed']);
  });

  it('CAP-EVENTS-COMPLETE-001f: isolates a non-abort completion observer error', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const onComplete = vi.fn(() => {
      throw new Error('observer failed');
    });
    const onError = vi.fn();
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });

    try {
      const result = await runLeafAgent(
        {
          provider: PROVIDER_NAME,
          model: 'baseline-model',
          events: { onComplete, onError },
        },
        'do thing',
      );

      expect(result.success).toBe(true);
      expect(result.interrupted).not.toBe(true);
      expect(onComplete).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(diagnostics).toContainEqual(expect.objectContaining({
        source: 'coding:completion-observer',
        level: 'warn',
        message: 'Completion observer failed after result finalization.',
      }));
    } finally {
      restoreDiagnostics();
    }
  });

  it('CAP-EVENTS-COMPLETE-001f: isolates an uninspectable observer failure', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const hostileFailure = new Proxy({}, {
      ownKeys: () => {
        throw new Error('observer failure must not be inspected');
      },
    });
    const onComplete = vi.fn(() => {
      throw hostileFailure;
    });
    const completedStatuses: string[] = [];

    const result = await runWithProviderCredential(
      PROVIDER_NAME,
      'scoped-test-key',
      () => runLeafAgent(
        {
          provider: PROVIDER_NAME,
          model: 'baseline-model',
          events: {
            onComplete,
            onTurnCompleted: (event) => completedStatuses.push(event.status),
          },
        },
        'do thing',
      ),
    );

    expect(result.success).toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(completedStatuses).toEqual(['completed']);
  });

  it('CAP-EVENTS-COMPLETE-001d: iteration-limit success fires onComplete exactly once', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('tool-loop'));
    const onComplete = vi.fn();

    const result = await runLeafAgent(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        maxIter: 1,
        events: { onComplete },
      },
      'inspect the package',
    );

    expect(result.success).toBe(true);
    expect(result.limitReached).toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('CAP-EVENTS-COMPLETE-001e: waits for asynchronous result finalization', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('success'));
    const order: string[] = [];
    const onComplete = vi.fn(() => order.push('complete'));

    const resultPromise = runLeafAgent(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onComplete },
        context: {
          // Keep this injected finalizer authoritative instead of installing
          // the root run's learned-Skill binding callback.
          currentAgentId: 'cap-005-finalization-child',
          completeLearnedSkillOutcomes: async () => {
            order.push('finalization:start');
            await new Promise<void>((resolve) => setImmediate(resolve));
            order.push('finalization:end');
          },
        },
      },
      'do thing',
    );

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      lastText: 'done',
    });
    expect(order).toEqual(['finalization:start', 'finalization:end', 'complete']);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('CAP-EVENTS-COMPLETE-001c: error terminal fires `onError` (not onComplete) — mutually exclusive per CAP-084 contract', async () => {
    registerModelProvider(PROVIDER_NAME, () => new CompleteEventProvider('throw'));
    const onComplete = vi.fn();
    const onError = vi.fn();
    const result = await runLeafAgent(
      {
        provider: PROVIDER_NAME,
        model: 'baseline-model',
        events: { onComplete, onError },
      },
      'do thing',
    );
    expect(result.success).toBe(false);
    // Mutual exclusion: error path → onError fired, onComplete NOT fired.
    expect(onError).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
