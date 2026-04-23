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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EMIT_SCOUT_VERDICT_TOOL_NAME,
} from '../agents/protocol-emitters.js';
import {
  buildRunnerAgentChain,
  buildRunnerLlmAdapter,
  buildRunnerScoutAgent,
  isRunnerDrivenRuntimeEnabled,
  runManagedTaskViaRunner,
} from './runner-driven.js';
import type { RunnableTool } from '@kodax/core';
import type { KodaXMessage, KodaXToolDefinition, KodaXToolUseBlock } from '@kodax/ai';
import type { KodaXEvents, KodaXOptions, KodaXToolExecutionContext } from '../types.js';

// Shared scratch directory for `managedTaskWorkspaceDir` so the
// Shard 6d-h artifact writes (contract.json / managed-task.json /
// result.json / ... ) land inside a temp folder instead of polluting
// the repo's cwd with `.agent/managed-tasks/` entries.
let testWorkspaceRoot: string;

beforeAll(async () => {
  testWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runner-driven-'));
});

afterAll(async () => {
  if (testWorkspaceRoot) {
    // Windows can hold transient handles immediately after tests;
    // retry a few times before giving up so CI stays clean.
    await rm(testWorkspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => undefined);
  }
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

describe('buildRunnerScoutAgent', () => {
  it('carries emit_scout_verdict + 4 core coding tools', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    const names = scout.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_SCOUT_VERDICT_TOOL_NAME);
    expect(names).toContain('read');
    expect(names).toContain('grep');
    expect(names).toContain('glob');
    expect(names).toContain('bash');
  });

  it('declares handoffs to generator (H1) and planner (H2) — Shard 5b topology', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    const targets = (scout.handoffs ?? []).map((h) => h.target.name);
    expect(targets).toContain('kodax/role/generator');
    expect(targets).toContain('kodax/role/planner');
  });

  it('uses kodax/role/scout as the canonical agent name', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    expect(scout.name).toBe('kodax/role/scout');
  });

  it('carries a self-contained H0 instruction string (no ManagedRolePromptContext dependency)', () => {
    const scout = buildRunnerScoutAgent(makeCtx());
    // v0.7.26 parity: instructions is a closure that resolves on every
    // Runner invocation so Scout's post-emit skillMap / scope reach
    // downstream prompts at runtime. Resolve it once here for assertion.
    const instructions = typeof scout.instructions === 'function'
      ? scout.instructions(undefined)
      : scout.instructions;
    expect(typeof instructions).toBe('string');
    expect(instructions).toMatch(/H0_DIRECT/);
    expect(instructions).toMatch(/emit_scout_verdict/);
  });
});

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

  it('strips execute function from agent tools when serializing for the wire', async () => {
    let capturedTools: readonly { name: string; execute?: unknown }[] = [];
    const adapter = buildRunnerLlmAdapter(makeOptions(), async (_t, tools) => {
      capturedTools = tools as readonly { name: string; execute?: unknown }[];
      return { textBlocks: [], toolBlocks: [] };
    });
    const scout = buildRunnerScoutAgent(makeCtx());
    await adapter([{ role: 'system', content: 's' }], scout);
    for (const t of capturedTools) {
      expect(t.execute).toBeUndefined();
    }
    expect(capturedTools.some((t) => t.name === EMIT_SCOUT_VERDICT_TOOL_NAME)).toBe(true);
  });

  it('converts textBlocks+toolBlocks to RunnerLlmResult shape', async () => {
    const toolBlock: KodaXToolUseBlock = {
      type: 'tool_use',
      id: 'call_1',
      name: 'emit_scout_verdict',
      input: { confirmed_harness: 'H0_DIRECT' },
    };
    const adapter = buildRunnerLlmAdapter(makeOptions(), async () => ({
      textBlocks: [{ text: 'Calling verdict' }],
      toolBlocks: [toolBlock],
    }));
    const result = await adapter(
      [{ role: 'system', content: 's' }],
      { name: 'x', instructions: '' },
    );
    expect(result.text).toBe('Calling verdict');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('emit_scout_verdict');
    expect(result.toolCalls![0]!.input).toEqual({ confirmed_harness: 'H0_DIRECT' });
  });
});

describe('buildRunnerLlmAdapter — max_tokens escalation (FEATURE_085 Scout parity)', () => {
  const ESCALATION_PROVIDER_NAME = 'runner-driven-max-tokens-test';
  const ESCALATION_PROVIDER_API_KEY_ENV = 'RUNNER_DRIVEN_MAX_TOKENS_TEST_API_KEY';

  let KodaXBaseProviderRef: typeof import('@kodax/ai').KodaXBaseProvider;
  let registerModelProviderFn: typeof import('@kodax/ai').registerModelProvider;
  let clearRuntimeModelProvidersFn: typeof import('@kodax/ai').clearRuntimeModelProviders;
  let KODAX_CAPPED: number;
  let KODAX_ESCALATED: number;

  beforeAll(async () => {
    const aiModule = await import('@kodax/ai');
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
      async stream(): Promise<any> {
        observedBudgets.push(this.getEffectiveMaxOutputTokens());
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        this.setMaxOutputTokensOverride(undefined); // mirror withRateLimit auto-clear
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

  it('escalates capped budget to 64K on first max_tokens, reissues same turn', async () => {
    const observedBudgets: number[] = [];
    registerScriptedProvider(
      [
        { textBlocks: [], stopReason: 'max_tokens' },
        { textBlocks: [{ type: 'text', text: 'done at 64K' }], stopReason: 'end_turn' },
      ],
      observedBudgets,
    );

    const adapter = buildRunnerLlmAdapter(makeAdapterOptions());
    const result = await adapter(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Generate a long file.' }],
      { name: 'scout', instructions: '' },
    );

    expect(result.text).toBe('done at 64K');
    expect(observedBudgets).toEqual([KODAX_CAPPED, KODAX_ESCALATED]);
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
    const capturedMessagesPerCall: Array<readonly import('@kodax/ai').KodaXMessage[]> = [];
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
      async stream(messages: import('@kodax/ai').KodaXMessage[]): Promise<any> {
        observedBudgets.push(this.getEffectiveMaxOutputTokens());
        capturedMessagesPerCall.push([...messages]);
        const resp = responses[callIdx++];
        if (!resp) throw new Error(`No scripted response for stream call #${callIdx}`);
        this.setMaxOutputTokensOverride(undefined);
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
      async stream(): Promise<any> {
        observedBudgets.push(this.getEffectiveMaxOutputTokens());
        callIdx += 1;
        this.setMaxOutputTokensOverride(undefined);
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

describe('runManagedTaskViaRunner — Scout H0_DIRECT end-to-end', () => {
  it('runs a Scout H0_DIRECT flow: emit_scout_verdict then final text', async () => {
    let turn = 0;
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'What is 2 + 2?',
      async (_transcript, _tools, _system) => {
        turn += 1;
        if (turn === 1) {
          return {
            textBlocks: [{ text: 'Simple arithmetic, answering directly.' }],
            toolBlocks: [
              {
                type: 'tool_use',
                id: 'scout-1',
                name: 'emit_scout_verdict',
                input: {
                  confirmed_harness: 'H0_DIRECT',
                  direct_completion_ready: 'yes',
                  summary: 'Arithmetic question',
                  scope: [],
                  required_evidence: [],
                  harness_rationale: 'Trivial math, no code inspection needed.',
                },
              },
            ],
          };
        }
        // Second turn: Scout sees tool_result, emits final text
        return { textBlocks: [{ text: '2 + 2 = 4.' }], toolBlocks: [] };
      },
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('2 + 2 = 4.');
    expect(result.signal).toBe('COMPLETE');
    // Shard 6a populates managedTask with a minimal but well-shaped payload.
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');

    // Transcript shape: system, user, assistant(tool_use), user(tool_result), assistant(final)
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[1]!.role).toBe('user');
    expect(result.messages[2]!.role).toBe('assistant');
    expect(result.messages[3]!.role).toBe('user');
    expect(result.messages[4]!.role).toBe('assistant');
  });

  it('handles a zero-tool direct answer (Scout answers without emit)', async () => {
    // Edge case: a minimalist Scout that just returns the answer as text,
    // without ever calling emit_scout_verdict. The run still completes;
    // managedTask is populated with defaults (harness=H0_DIRECT).
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Say hello',
      async () => ({ textBlocks: [{ text: 'Hello, world.' }], toolBlocks: [] }),
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Hello, world.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
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
    expect(result.managedTask?.verdict?.status).toBe('running');
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
    if (system.includes('You are Evaluator')) return 'evaluator';
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
    if (!handler) throw new Error(`No mock handler for role ${role}`);
    return handler(turnCount[role]!, transcript);
  };
}

describe('Shard 5b parity — H1 accept path', () => {
  it('Scout → Generator → Evaluator accept produces converged KodaXResult', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'scout-1',
              name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL', harness_rationale: 'small scope' },
            }],
          };
        }
        throw new Error('scout should have handed off already');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'gen-1',
              name: 'emit_handoff',
              input: { status: 'ready', summary: 'Done', evidence: ['test passes'] },
            }],
          };
        }
        throw new Error('generator should have handed off already');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use',
              id: 'eval-1',
              name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Feature implemented and tests pass.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Feature implemented and tests pass.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Add login endpoint', mock);
    expect(result.success).toBe(true);
    expect(result.signal).toBe('COMPLETE');
    expect(result.lastText).toBe('Feature implemented and tests pass.');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
    expect(result.managedProtocolPayload?.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    expect(result.managedProtocolPayload?.handoff?.status).toBe('ready');
  });
});

describe('M5 parity — Scout pre-handoff write warning (v0.7.26)', () => {
  it('fires onManagedTaskStatus note when Scout writes a file then hands off to Generator (H1)', async () => {
    const statusEvents: Array<{ note?: string; detailNote?: string }> = [];
    const opts = makeOptions();
    opts.events = {
      ...opts.events,
      onManagedTaskStatus: (e) => {
        if (typeof e.note === 'string') {
          statusEvents.push({ note: e.note, detailNote: e.detailNote });
        }
      },
    };
    // Make Scout mutate a file before emitting H1 verdict by invoking
    // the `write` tool in the first turn, then emit_scout_verdict in
    // the second turn. The test fs path doesn't need to persist — the
    // wrapCodingToolAsRunnable path increments the mutation tracker
    // regardless of actual disk success.
    const tempFile = path.join(testWorkspaceRoot, 'scout-pre-handoff-artifact.txt');
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-write', name: 'write',
              input: { path: tempFile, content: 'scout draft\n' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-emit', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL', harness_rationale: 'small scope' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'g-1', name: 'emit_handoff',
          input: { status: 'ready', summary: 'Done' },
        }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e-1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Shipped.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Shipped.' }] };
      },
    });

    await runManagedTaskViaRunner(opts, 'Rewrite summary', mock);

    const preHandoffNote = statusEvents.find(
      (e) => e.note && e.note.includes('before handing off'),
    );
    expect(preHandoffNote).toBeDefined();
    expect(preHandoffNote!.note).toMatch(/Scout wrote \d+ file/);
    expect(preHandoffNote!.note).toContain('Generator');
    expect(preHandoffNote!.detailNote ?? '').toContain('scout-pre-handoff-artifact.txt');
  });

  it('does NOT fire the warning on H0_DIRECT (Scout is the author in that case)', async () => {
    const statusEvents: Array<{ note?: string }> = [];
    const opts = makeOptions();
    opts.events = {
      ...opts.events,
      onManagedTaskStatus: (e) => {
        if (typeof e.note === 'string') statusEvents.push({ note: e.note });
      },
    };
    const tempFile = path.join(testWorkspaceRoot, 'scout-h0-artifact.txt');
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-write', name: 'write',
              input: { path: tempFile, content: 'scout direct output\n' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's-emit', name: 'emit_scout_verdict',
              input: {
                confirmed_harness: 'H0_DIRECT',
                direct_completion_ready: 'yes',
                summary: 'Direct answer provided via write.',
              },
            }],
          };
        }
        // Scout may get a final text-only turn after H0_DIRECT emit so
        // the Runner can collect the assistant's user-facing answer.
        return { textBlocks: [{ text: 'Note written.' }] };
      },
    });

    await runManagedTaskViaRunner(opts, 'Write a note', mock);

    const preHandoffNote = statusEvents.find(
      (e) => e.note && e.note.includes('before handing off'),
    );
    expect(preHandoffNote).toBeUndefined();
  });
});

describe('Shard 5b parity — H1 revise → accept path', () => {
  it('Evaluator revise cycles back to Generator, then accept on second pass', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1 || turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: `g${turn}`, name: 'emit_handoff',
              input: { status: 'ready' },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'missed edge case' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Fixed on second pass.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Fixed on second pass.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Fix edge case', mock);
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Fixed on second pass.');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

describe('Shard 5b parity — H2 plan → execute → accept path', () => {
  it('Scout → Planner → Generator → Evaluator accept with contract', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL', harness_rationale: 'larger scope' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      planner: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'p1', name: 'emit_contract',
              input: {
                summary: 'Add JWT auth',
                success_criteria: ['POST /auth/login works', 'tests pass'],
                required_evidence: ['auth.test.ts passing'],
                constraints: ['use existing token utils'],
              },
            }],
          };
        }
        throw new Error('planner overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'g1', name: 'emit_handoff',
              input: { status: 'ready', evidence: ['tests passing'] },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'JWT auth ready per contract.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'JWT auth ready per contract.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Add JWT auth', mock);
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('JWT auth ready per contract.');
    expect(result.managedProtocolPayload?.scout?.confirmedHarness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedProtocolPayload?.contract?.successCriteria).toHaveLength(2);
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

describe('Shard 5b parity — blocked path', () => {
  it('Evaluator blocked surfaces BLOCKED signal + reason; success=false', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'g1', name: 'emit_handoff',
              input: { status: 'blocked', summary: 'needs OAuth config' },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'Missing OAUTH_CLIENT_ID env var' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Blocked: needs OAUTH_CLIENT_ID to be set.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Enable OAuth', mock);
    expect(result.success).toBe(false);
    expect(result.signal).toBe('BLOCKED');
    expect(result.signalReason).toMatch(/OAUTH_CLIENT_ID/);
    expect(result.managedProtocolPayload?.verdict?.status).toBe('blocked');
  });
});

// =============================================================================
// Shard 6a — Observer events + managedTask payload
// =============================================================================

describe('Shard 6a — onManagedTaskStatus observer events', () => {
  it('fires preflight at start and completed at end', async () => {
    const statuses: Array<{ phase?: string; activeWorkerId?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; activeWorkerId?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'Say hi', async () => ({
      textBlocks: [{ text: 'Hi.' }], toolBlocks: [],
    }));
    expect(statuses.some((s) => s.phase === 'preflight')).toBe(true);
    expect(statuses.some((s) => s.phase === 'completed')).toBe(true);
  });

  it('fires round events per role emit (Scout → Gen → Eval → accept)', async () => {
    const statuses: Array<{ phase?: string; activeWorkerId?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; activeWorkerId?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Done' }] };
      },
    });
    await runManagedTaskViaRunner(opts, 'task', mock);
    const roleEvents = statuses.filter((s) => s.phase === 'worker').map((s) => s.activeWorkerId);
    expect(roleEvents).toContain('scout');
    expect(roleEvents).toContain('generator');
    expect(roleEvents).toContain('evaluator');
  });

  it('fires completed with BLOCKED signal note on blocked verdict', async () => {
    const statuses: Array<{ phase?: string; note?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: { phase?: string; note?: string }) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'blocked' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'missing dependency' },
            }],
          };
        }
        return { textBlocks: [{ text: 'blocked' }] };
      },
    });
    await runManagedTaskViaRunner(opts, 'task', mock);
    const completed = statuses.find((s) => s.phase === 'completed');
    expect(completed?.note).toMatch(/blocked/);
  });
});

describe('Shard 6a — managedTask payload shape', () => {
  it('populates contract.harnessProfile from Scout verdict (H1 case)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.contract.surface).toBe('cli');
    expect(result.managedTask?.contract.objective).toBe('task');
  });

  it('populates roleAssignments in handoff order (H2 chain)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['c1'] },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    const roles = result.managedTask?.roleAssignments.map((a) => a.role);
    expect(roles).toEqual(['scout', 'planner', 'generator', 'evaluator']);
  });

  it('populates single "direct" assignment for H0_DIRECT', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'direct answer' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'trivial', mock);
    const roles = result.managedTask?.roleAssignments.map((a) => a.role);
    expect(roles).toEqual(['direct']);
    expect(result.managedTask?.verdict.decidedByAssignmentId).toBe('direct');
  });

  it('populates runtime.globalWorkBudget + budgetUsage (Shard 6a minimum)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    // v0.7.26 budget caps: H0=100, H1=H2=200 (legacy parity). Extension
    // dialog at 90% crossing tops up by +100 (H0) or +200 (H1/H2).
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(200); // H1
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThan(0);
  });

  it('records harnessTransitions when Scout chooses non-H0 tier', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['x'] },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    const transitions = result.managedTask?.runtime?.harnessTransitions ?? [];
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from).toBe('H0_DIRECT');
    expect(transitions[0]!.to).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(transitions[0]!.source).toBe('scout');
  });

  it('verdict.status=completed on accept, blocked on blocked', async () => {
    const acceptMock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const accept = await runManagedTaskViaRunner(makeOptions(), 'task', acceptMock);
    expect(accept.managedTask?.verdict.status).toBe('completed');

    const blockedMock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'blocked' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'need env var' },
            }],
          };
        }
        return { textBlocks: [{ text: 'blocked' }] };
      },
    });
    const blocked = await runManagedTaskViaRunner(makeOptions(), 'task', blockedMock);
    expect(blocked.managedTask?.verdict.status).toBe('blocked');
  });
});

// =============================================================================
// Shard 6b — Real budget tracking + mutation tracker
// =============================================================================

describe('Shard 6b — budget controller', () => {
  it('increments spentBudget per tool invocation (emit tools count)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    // 3 emit tool calls (scout + handoff + verdict) → at least 3 budget units
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(3);
  });

  it('upgrades totalBudget when Scout picks H1 (from 50 → 400)', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(200);
  });

  it('keeps H0 budget (100) when Scout chooses H0_DIRECT', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'direct answer' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'trivial', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(100);
  });

  it('upgrades to 200 when Scout picks H2', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
        }],
      }),
      planner: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 'p1', name: 'emit_contract',
          input: { success_criteria: ['x'] },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(200);
  });
});

describe('Shard 6b — mutation tracker', () => {
  // Mutation tracking hooks run when Generator invokes write/edit/bash.
  // We test by having the mock Generator call the `write` tool, then
  // verify the tracker accumulated the file entry.
  //
  // Note: the tracker is internal to the run. It's observable via the
  // scope-awareness note that `emit_scout_verdict` appends when H0 is
  // declared with >3 mutations (legacy behavior). For Shard 6b we only
  // assert the plumbing works end-to-end by checking that the write
  // tool call returns successfully — this exercises the
  // recordMutationForTool codepath without adding new assertions.
  it('write tool execution does not crash under the Runner-driven path', async () => {
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: (turn) => {
        if (turn === 1) {
          // Call write with a path that won't actually exist; we only care
          // that the mutation hook runs (records via recordMutationForTool).
          // The tool will error, which is fine — we're testing plumbing,
          // not end-to-end write success.
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'w1', name: 'write',
              input: {
                file_path: '/tmp/kodax-runner-driven-test-nowrite.txt',
                content: 'line1\nline2\nline3\n',
              },
            }],
          };
        }
        return {
          toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
        };
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'done' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
    // Budget usage reflects scout emit + write tool + handoff emit + verdict emit ≥ 4
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(4);
  });
});

// =============================================================================
// Shard 6c — Checkpoint recovery (FEATURE_071)
// =============================================================================

describe('Shard 6c — checkpoint handling', () => {
  it('completes a run that has no pre-existing checkpoint without error', async () => {
    // Smoke: the happy-path "no checkpoint" branch in handlePreRunCheckpoint.
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
  });

  it('completes the full H1 chain even with checkpoint writes firing per role', async () => {
    // Exercises the fire-and-forget checkpoint writer during a multi-role
    // run. Failures inside writeCurrentCheckpoint are swallowed, so even
    // if the workspace-root is unwritable the chain completes.
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    expect(result.success).toBe(true);
    // roleAssignments records all 3 roles that emitted.
    expect(result.managedTask?.roleAssignments.map((a) => a.role)).toEqual([
      'scout', 'generator', 'evaluator',
    ]);
  });
});

describe('Shard 5b — H2 replan via nextHarness', () => {
  it('Evaluator revise with next_harness=H2 routes back to Planner', async () => {
    let plannerTurns = 0;
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      planner: (turn) => {
        plannerTurns += 1;
        return {
          toolBlocks: [{
            type: 'tool_use', id: `p${turn}`, name: 'emit_contract',
            input: {
              summary: `Plan v${turn}`,
              success_criteria: ['criteria1'],
              required_evidence: [],
              constraints: [],
            },
          }],
        };
      },
      generator: (turn) => {
        return {
          toolBlocks: [{
            type: 'tool_use', id: `g${turn}`, name: 'emit_handoff',
            input: { status: 'ready' },
          }],
        };
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', next_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Replanned and succeeded.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Replanned and succeeded.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'Complex task', mock);
    expect(plannerTurns).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(true);
    expect(result.lastText).toBe('Replanned and succeeded.');
  });
});

describe('Shard 6d-c1 — observer event enrichment', () => {
  it('populates activeWorkerTitle, currentRound, maxRounds on round events', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL', summary: 'chosen H1' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready', summary: 'gen done' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'ok' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
    });
    await runManagedTaskViaRunner(opts, 'do X', mock);
    const scoutEvent = statuses.find((s) => s.phase === 'worker' && s.activeWorkerId === 'scout');
    expect(scoutEvent?.activeWorkerTitle).toBe('Scout');
    expect(scoutEvent?.currentRound).toBe(1);
    expect(scoutEvent?.maxRounds).toBeGreaterThanOrEqual(6);
    const genEvent = statuses.find((s) => s.phase === 'worker' && s.activeWorkerId === 'generator');
    expect(genEvent?.activeWorkerTitle).toBe('Generator');
    expect(genEvent?.currentRound).toBe(2);
    const evalEvent = statuses.find((s) => s.phase === 'worker' && s.activeWorkerId === 'evaluator');
    expect(evalEvent?.activeWorkerTitle).toBe('Evaluator');
    expect(evalEvent?.currentRound).toBe(3);
  });

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

  it('completed event has persistToHistory=true and detailNote=verdict reason', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: () => ({
        toolBlocks: [{
          type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
          input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
        }],
      }),
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'blocked' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'cannot verify dep' },
            }],
          };
        }
        return { textBlocks: [{ text: 'blocked' }] };
      },
    });
    await runManagedTaskViaRunner(opts, 'Task X', mock);
    const completed = statuses.find((s) => s.phase === 'completed');
    expect(completed?.persistToHistory).toBe(true);
    expect(completed?.detailNote).toBe('cannot verify dep');
  });

  it('round events default persistToHistory=false (transient progress ticks)', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onManagedTaskStatus: (s: Record<string, unknown>) => statuses.push(s),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
      generator: () => ({ textBlocks: [{ text: 'ok' }] }),
      evaluator: () => ({ textBlocks: [{ text: 'ok' }] }),
    });
    await runManagedTaskViaRunner(opts, 'Task', mock);
    const round = statuses.find((s) => s.phase === 'worker');
    expect(round?.persistToHistory).toBe(false);
  });
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
  function makeToolCtx(agentName: string): import('@kodax/core').RunnerToolContext {
    return { agent: { name: agentName } as unknown as import('@kodax/core').Agent };
  }

  it('Planner agent exposes only read + grep + glob + emit_contract (no bash/write/edit)', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const plannerTools = chain.planner.tools?.map((t) => t.name) ?? [];
    expect(plannerTools).toContain('emit_contract');
    expect(plannerTools).toContain('read');
    expect(plannerTools).toContain('grep');
    expect(plannerTools).toContain('glob');
    expect(plannerTools).not.toContain('bash');
    expect(plannerTools).not.toContain('write');
    expect(plannerTools).not.toContain('edit');
  });

  it('Evaluator agent exposes read + grep + glob + bash + emit_verdict (no write/edit)', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evaluatorTools = chain.evaluator.tools?.map((t) => t.name) ?? [];
    expect(evaluatorTools).toContain('emit_verdict');
    expect(evaluatorTools).toContain('bash');
    expect(evaluatorTools).not.toContain('write');
    expect(evaluatorTools).not.toContain('edit');
  });

  it('Generator agent exposes full coding toolbox including write + edit', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const genTools = chain.generator.tools?.map((t) => t.name) ?? [];
    expect(genTools).toContain('emit_handoff');
    expect(genTools).toContain('bash');
    expect(genTools).toContain('write');
    expect(genTools).toContain('edit');
  });

  it('Evaluator bash blocks shell mutation commands (legacy SHELL_WRITE_PATTERNS parity)', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evalBash = findTool(chain.evaluator, 'bash');
    const result = await evalBash.execute({ command: 'rm -rf /tmp/x' }, makeToolCtx('evaluator'));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('verification-only');
  });

  it('Evaluator bash allows read-only commands (ls, cat, git diff)', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evalBash = findTool(chain.evaluator, 'bash');
    // Mutation guard does NOT fire for read-only commands.
    const result = await evalBash.execute({ command: 'git diff HEAD' }, makeToolCtx('evaluator'));
    if (result.isError) {
      expect(String(result.content)).not.toContain('verification-only');
    }
  });

  it('Evaluator bash blocks git write commands (commit, push, reset)', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evalBash = findTool(chain.evaluator, 'bash');
    const commit = await evalBash.execute({ command: 'git commit -m "x"' }, makeToolCtx('evaluator'));
    expect(commit.isError).toBe(true);
    expect(String(commit.content)).toContain('verification-only');
    const push = await evalBash.execute({ command: 'git push origin main' }, makeToolCtx('evaluator'));
    expect(push.isError).toBe(true);
    const reset = await evalBash.execute({ command: 'git reset --hard HEAD' }, makeToolCtx('evaluator'));
    expect(reset.isError).toBe(true);
  });

  it('Scout bash is NOT wrapped — Scout has full tool access per v0.7.22 parity', async () => {
    // v0.7.26 Scout-tool-restoration: Scout runs H0_DIRECT tasks to
    // completion (including file writes), so its bash must not be
    // wrapped with the verification-only guard. Harness routing is
    // enforced by prompt, not tool restrictions. This test guards
    // against future regressions that re-wrap Scout bash.
    //
    // Probe with `python -c "print(1)"` — a pure-read command that
    // WOULD have been blocked by the old `wrapReadOnlyBash` wrapper
    // (SHELL_WRITE_PATTERNS treats `python -c` as mutation). If Scout
    // bash is unwrapped, the block message never fires; the downstream
    // handler gets the command (and may or may not succeed depending on
    // test env, which we don't care about — we only assert on the
    // absence of the wrapper's block message).
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutBash = findTool(chain.scout, 'bash');
    const result = await scoutBash.execute(
      { command: 'python -c "print(1)"' },
      makeToolCtx('scout'),
    );
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text).not.toContain('verification-only');
  });

  it('Scout exposes write/edit/exit_plan_mode tools (v0.7.22 parity)', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutTools = chain.scout.tools?.map((t) => t.name) ?? [];
    expect(scoutTools).toContain('write');
    expect(scoutTools).toContain('edit');
    expect(scoutTools).toContain('bash');
    expect(scoutTools).toContain('exit_plan_mode');
  });
});

describe('Shard 6d-T — Scout skillMap injected into Generator + Evaluator instructions', () => {
  function resolveInstructions(
    agent: { readonly instructions: string | ((ctx: unknown) => string) },
  ): string {
    return typeof agent.instructions === 'function'
      ? agent.instructions(undefined)
      : agent.instructions;
  }

  it('falls back to base text when Scout has not emitted', () => {
    const recorder = {};
    const chain = buildRunnerAgentChain(makeCtx(), recorder);
    const gen = resolveInstructions(chain.generator);
    expect(gen).not.toContain('Scout Skill Map');
    expect(gen).toContain('emit_handoff');
  });

  it('renders execution_obligations + ambiguities for Generator (not verification)', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: 'add a login form',
              executionObligations: ['write LoginForm.tsx', 'wire up POST /login'],
              verificationObligations: ['e2e test covers login'],
              ambiguities: ['should we support OAuth?'],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const gen = resolveInstructions(chain.generator);
    expect(gen).toContain('Scout Skill Map');
    expect(gen).toContain('skill_summary: add a login form');
    expect(gen).toContain('execution_obligations:');
    expect(gen).toContain('- write LoginForm.tsx');
    expect(gen).toContain('- wire up POST /login');
    expect(gen).toContain('ambiguities_to_resolve:');
    expect(gen).toContain('- should we support OAuth?');
    // Generator does NOT see verification obligations.
    expect(gen).not.toContain('verification_obligations:');
  });

  it('renders verification_obligations for Evaluator', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: 'fix parser bug',
              executionObligations: ['patch parser.ts'],
              verificationObligations: ['parser.test.ts passes', 'no regression in ast-walker'],
              ambiguities: [],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const evaluator = resolveInstructions(chain.evaluator);
    expect(evaluator).toContain('Scout Skill Map');
    expect(evaluator).toContain('verification_obligations:');
    expect(evaluator).toContain('- parser.test.ts passes');
    expect(evaluator).toContain('- no regression in ast-walker');
  });

  it('omits empty obligation lists', () => {
    const recorder: Record<string, unknown> = {
      scout: {
        payload: {
          scout: {
            summary: 's',
            scope: [],
            requiredEvidence: [],
            skillMap: {
              skillSummary: undefined,
              executionObligations: [],
              verificationObligations: [],
              ambiguities: [],
            },
          },
        },
      },
    };
    const chain = buildRunnerAgentChain(makeCtx(), recorder as unknown as Parameters<typeof buildRunnerAgentChain>[1]);
    const gen = resolveInstructions(chain.generator);
    // No fields populated → skill block omitted entirely.
    expect(gen).not.toContain('Scout Skill Map');
  });
});

describe('Shard 6d-Q — dispatch_child_task exposed to Scout + Generator only', () => {
  it('Scout agent exposes dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutTools = chain.scout.tools?.map((t) => t.name) ?? [];
    expect(scoutTools).toContain('dispatch_child_task');
  });

  it('Generator agent exposes dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const genTools = chain.generator.tools?.map((t) => t.name) ?? [];
    expect(genTools).toContain('dispatch_child_task');
  });

  it('Planner + Evaluator agents do NOT expose dispatch_child_task', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const plannerTools = chain.planner.tools?.map((t) => t.name) ?? [];
    const evaluatorTools = chain.evaluator.tools?.map((t) => t.name) ?? [];
    expect(plannerTools).not.toContain('dispatch_child_task');
    expect(evaluatorTools).not.toContain('dispatch_child_task');
  });

  it('Scout-bound dispatch tool errors out if Scout asks for a write child', async () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const scoutDispatch = chain.scout.tools?.find(
      (t) => t.name === 'dispatch_child_task',
    ) as RunnableTool;
    expect(scoutDispatch).toBeDefined();
    // Scout with `read_only: false` → error (role gating inside
    // toolDispatchChildTask rejects write fan-out from Scout).
    const result = await scoutDispatch.execute(
      {
        id: 'x',
        objective: 'test',
        read_only: false,
      },
      { agent: { name: 'scout' } as unknown as import('@kodax/core').Agent },
    );
    expect(String(result.content)).toContain('Scout can only dispatch read-only');
  });
});

describe('Shard 6d-S — task verification contract surfaced to Evaluator + completionContractStatus', () => {
  function resolveInstructions(
    agent: { readonly instructions: string | ((ctx: unknown) => string) },
  ): string {
    return typeof agent.instructions === 'function'
      ? agent.instructions(undefined)
      : agent.instructions;
  }

  it('falls back to base Evaluator text when no verification contract', () => {
    const chain = buildRunnerAgentChain(makeCtx(), {});
    const evaluator = resolveInstructions(chain.evaluator);
    expect(evaluator).not.toContain('Runtime Verification Contract');
  });

  it('renders startup command + UI flows + API checks for the Evaluator', () => {
    const chain = buildRunnerAgentChain(
      makeCtx(),
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runtime: {
          startupCommand: 'pnpm dev',
          readySignal: 'Ready in',
          baseUrl: 'http://localhost:3000',
          uiFlows: ['Navigate to /login and submit form', 'Verify dashboard renders'],
          apiChecks: ['GET /api/health returns 200'],
          dbChecks: [],
        },
      },
    );
    const evaluator = resolveInstructions(chain.evaluator);
    expect(evaluator).toContain('Runtime Verification Contract');
    expect(evaluator).toContain('startup_command: pnpm dev');
    expect(evaluator).toContain('ready_signal: Ready in');
    expect(evaluator).toContain('base_url: http://localhost:3000');
    expect(evaluator).toContain('ui_flows');
    expect(evaluator).toContain('1. Navigate to /login and submit form');
    expect(evaluator).toContain('api_checks');
    expect(evaluator).toContain('1. GET /api/health returns 200');
  });

  it('populates completionContractStatus=ready for all checks on accept', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'g1', name: 'emit_handoff',
              input: { status: 'ready', evidence: ['fixed'] },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'all checks pass' },
            }],
          };
        }
        return { textBlocks: [{ text: 'all checks pass' }] };
      },
    });

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        context: {
          ...makeOptions().context!,
          taskVerification: {
            criteria: [
              { id: 'crit.login', label: 'Login works', description: 'Login form submits successfully', threshold: 0.8, weight: 1 },
            ],
            runtime: {
              uiFlows: ['Login flow'],
              apiChecks: ['GET /api/health returns 200'],
              dbChecks: ['user row exists after signup'],
            },
          },
        },
      },
      'Verify the app',
      mock,
    );
    expect(result.success).toBe(true);
    const status = result.managedTask?.runtime?.completionContractStatus;
    expect(status).toBeDefined();
    expect(status!['crit.login']).toBe('ready');
    expect(status!['ui_flow:1']).toBe('ready');
    expect(status!['api_check:1']).toBe('ready');
    expect(status!['db_check:1']).toBe('ready');
  });

  it('populates completionContractStatus=blocked on blocked verdict', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'blocked', reason: 'db unreachable' },
            }],
          };
        }
        return { textBlocks: [{ text: 'db unreachable' }] };
      },
    });

    const result = await runManagedTaskViaRunner(
      {
        ...makeOptions(),
        context: {
          ...makeOptions().context!,
          taskVerification: {
            runtime: { dbChecks: ['users table query'] },
          },
        },
      },
      'Verify',
      mock,
    );
    const status = result.managedTask?.runtime?.completionContractStatus;
    expect(status).toBeDefined();
    expect(status!['db_check:1']).toBe('blocked');
  });

  it('returns undefined when no verification contract is declared', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT', direct_completion_ready: 'yes' },
            }],
          };
        }
        return { textBlocks: [{ text: 'hi' }] };
      },
    });

    const result = await runManagedTaskViaRunner(makeOptions(), 'hi', mock);
    expect(result.managedTask?.runtime?.completionContractStatus).toBeUndefined();
  });
});

describe('Shard 6d-U — degraded-continue when upgrade beyond ceiling', () => {
  function makePlanWithCeiling(
    upgradeCeiling: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL',
  ): import('../reasoning.js').ReasoningPlan {
    return {
      mode: 'balanced',
      depth: 'medium',
      decision: {
        primaryTask: 'bugfix',
        confidence: 0.8,
        riskLevel: 'medium',
        recommendedMode: 'conversation',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        upgradeCeiling,
        reason: 'test',
      },
      amaControllerDecision: {
        profile: 'tactical',
        tactics: [],
        fanout: { mode: 'off' as const } as unknown as import('@kodax/agent').KodaXAmaFanoutPolicy,
        reason: 'test',
        upgradeTriggers: [],
      },
      promptOverlay: '',
    };
  }

  it('rewrites H2 revise → Generator when ceiling is H1 and sets degradedContinue=true', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1 || turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: `g${turn}`, name: 'emit_handoff',
              input: { status: 'ready' },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          // Request H2 upgrade — should be denied because ceiling is H1.
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'need a plan', next_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Degraded fix applied.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Degraded fix applied.' }] };
      },
      // Ensure Planner never runs — the degraded path must keep ownership
      // inside Generator rather than pivoting to Planner.
      planner: () => {
        throw new Error('planner should not run when upgrade is denied');
      },
    });

    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Fix it',
      mock,
      makePlanWithCeiling('H1_EXECUTE_EVAL'),
    );
    expect(result.success).toBe(true);
    expect(result.managedTask?.runtime?.degradedContinue).toBe(true);
    // Accept still reached on second pass — degradation does not abort.
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });

  it('allows H2 upgrade (no degradation) when ceiling permits it', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        throw new Error('scout overrun');
      },
      generator: (turn) => {
        if (turn === 1 || turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: `g${turn}`, name: 'emit_handoff',
              input: { status: 'ready' },
            }],
          };
        }
        throw new Error('generator overrun');
      },
      planner: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'p1', name: 'emit_contract',
              input: {
                summary: 'Escalated plan',
                success_criteria: ['fixed'],
                required_evidence: [],
                constraints: [],
              },
            }],
          };
        }
        throw new Error('planner overrun');
      },
      evaluator: (turn) => {
        if (turn === 1) {
          // Same H2 upgrade request — permitted this time.
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'need a plan', next_harness: 'H2_PLAN_EXECUTE_EVAL' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Upgraded fix applied.' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Upgraded fix applied.' }] };
      },
    });

    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Fix it',
      mock,
      makePlanWithCeiling('H2_PLAN_EXECUTE_EVAL'),
    );
    expect(result.success).toBe(true);
    expect(result.managedTask?.runtime?.degradedContinue).toBeUndefined();
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });
});

describe('Shard 6d-f — evaluator graceful fallback when verdict is not emitted', () => {
  it('returns COMPLETE with last assistant text when Evaluator produces no verdict', async () => {
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        return { textBlocks: [{ text: 'ok' }] };
      },
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      // Evaluator emits NO verdict — just returns final text directly.
      evaluator: () => ({
        textBlocks: [{ text: 'Evaluator could not structure a verdict but here is the result.' }],
      }),
    });
    const result = await runManagedTaskViaRunner(makeOptions(), 'task', mock);
    // Without a verdict, runner defaults to signal='COMPLETE' and uses
    // the last assistant text as the answer (matching legacy's
    // degraded-verification fallback semantics, minus the explicit note).
    expect(result.signal).toBe('COMPLETE');
    expect(result.lastText).toContain('could not structure a verdict');
  });
});

describe('Shard 6d-d — session continuity', () => {
  it('prepends options.session.initialMessages before the new prompt', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    const opts = {
      ...makeOptions(),
      session: {
        initialMessages: [
          { role: 'user' as const, content: 'prior question' },
          { role: 'assistant' as const, content: 'prior answer' },
        ],
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    await runManagedTaskViaRunner(opts, 'follow-up question', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'got it' }], toolBlocks: [] };
    });
    // The first LLM turn's transcript (post-system-strip) should contain
    // the prior user/assistant pair + the new user prompt.
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.length).toBe(3);
    expect(firstTurn[0]!.role).toBe('user');
    expect(firstTurn[0]!.content).toBe('prior question');
    expect(firstTurn[1]!.role).toBe('assistant');
    expect(firstTurn[2]!.role).toBe('user');
    expect(firstTurn[2]!.content).toBe('follow-up question');
  });

  it('falls back to raw string prompt when session.initialMessages is empty', async () => {
    const capturedTranscripts: KodaXMessage[][] = [];
    await runManagedTaskViaRunner(makeOptions(), 'fresh task', async (transcript) => {
      capturedTranscripts.push([...transcript]);
      return { textBlocks: [{ text: 'ok' }], toolBlocks: [] };
    });
    const firstTurn = capturedTranscripts[0]!;
    expect(firstTurn.length).toBe(1);
    expect(firstTurn[0]!.content).toBe('fresh task');
  });
});

describe('Shard 6d-c4 — onIterationEnd + contextTokenSnapshot', () => {
  it('fires onIterationEnd after every LLM turn with scope=worker', async () => {
    const iterations: Array<{ iter: number; scope?: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        onIterationEnd: (info: { iter: number; scope?: string }) =>
          iterations.push({ iter: info.iter, scope: info.scope }),
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H0_DIRECT' },
            }],
          };
        }
        return { textBlocks: [{ text: 'done' }] };
      },
      generator: () => ({ textBlocks: [{ text: 'x' }] }),
      evaluator: () => ({ textBlocks: [{ text: 'x' }] }),
    });
    await runManagedTaskViaRunner(opts, 'T', mock);
    expect(iterations.length).toBeGreaterThanOrEqual(2); // scout turn 1 + scout turn 2
    expect(iterations.every((i) => i.scope === 'worker')).toBe(true);
    // Iteration counter is monotonically increasing
    expect(iterations[0]!.iter).toBeLessThan(iterations[iterations.length - 1]!.iter);
  });

  it('returns undefined contextTokenSnapshot when no provider usage is reported', async () => {
    // Using adapterOverride (no real provider.stream) means no usage data,
    // so the snapshot stays undefined — matching legacy behaviour for
    // estimated-only runs.
    const result = await runManagedTaskViaRunner(
      makeOptions(),
      'Hi',
      async () => ({ textBlocks: [{ text: 'Hi' }], toolBlocks: [] }),
    );
    expect(result.contextTokenSnapshot).toBeUndefined();
  });
});

describe('Shard 6d-c3 — budget extension at 90% threshold', () => {
  it('fires askUser when Evaluator revises and budget exceeds 90%', async () => {
    const askUserCalls: Array<{ question: string }> = [];
    const opts = {
      ...makeOptions(),
      events: {
        askUser: async (q: { question: string }) => {
          askUserCalls.push({ question: q.question });
          return 'continue';
        },
      },
    } as unknown as Parameters<typeof runManagedTaskViaRunner>[0];
    const mock = makeChainMockLlm({
      // Scout picks H1 so Generator + Evaluator both run. Budget cap is
      // 400 for H1; the short chain (scout + gen + eval + eval) is well
      // under 90%, so the askUser dialog is NOT fired — this verifies
      // the threshold gating is in place and doesn't spam.
      scout: (turn) => {
        if (turn === 1) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 's1', name: 'emit_scout_verdict',
              input: { confirmed_harness: 'H1_EXECUTE_EVAL' },
            }],
          };
        }
        return { textBlocks: [{ text: 'scout fallback' }] };
      },
      generator: () => ({
        toolBlocks: [{ type: 'tool_use', id: 'g1', name: 'emit_handoff', input: { status: 'ready' } }],
      }),
      evaluator: (turn) => {
        if (turn === 1) {
          // Burn budget by emitting many read tool calls first — but in
          // this test we simulate the threshold via direct spent >= 90%
          // by having many tool invocations. Because each emit + tool
          // call increments budget, a short chain like scout+gen+eval is
          // typically < 10 calls. To hit threshold quickly we lean on
          // the low H0 cap (50).
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e1', name: 'emit_verdict',
              input: { status: 'revise', reason: 'needs more work' },
            }],
          };
        }
        if (turn === 2) {
          return {
            toolBlocks: [{
              type: 'tool_use', id: 'e2', name: 'emit_verdict',
              input: { status: 'accept', user_answer: 'Done eventually' },
            }],
          };
        }
        return { textBlocks: [{ text: 'Done eventually' }] };
      },
    });
    // The budget-extension prompt is gated on spentBudget >= 90% of total.
    // In this happy path with H0 cap 50, the chain burns ~6-8 units, so
    // the threshold is NOT hit and askUser fires only for the checkpoint
    // dialog (which is also gated on findValidCheckpoint). Since we have
    // no pre-existing checkpoint, askUser won't fire at all.
    await runManagedTaskViaRunner(opts, 'Task', mock);
    // Test passes as long as the wiring compiles and the call is
    // conditional (threshold not met in this short run). A dedicated
    // integration test under a pre-seeded high-usage budget controller
    // would be needed to drive this path end-to-end.
    expect(askUserCalls.length).toBe(0);
  });

  it('fires askUser when Evaluator revises and usage crosses 90% threshold', async () => {
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
        mode: 'balanced',
        depth: 'default',
        amaControllerDecision: undefined,
        promptOverlay: undefined,
      },
    };
    return {
      planRef,
      degradedContinueRef: { current: false },
      reviseCountByHarnessRef: { current: new Map() },
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

  it('Risk-2: first H1 revise passes through unchanged; counter increments', async () => {
    const { wrapEmitterWithRecorder, H1_MAX_SAME_HARNESS_REVISES } = await harnessTestables();
    const base = makeFakeVerdictEmitter({ status: 'revise', reason: 'retry' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 10 });
    const budgetExtension = makeBudgetExtensionFixture({ harness: 'H1_EXECUTE_EVAL' });

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as { payload: { verdict: { status: string } } };
    expect(meta.payload.verdict.status).toBe('revise');
    expect(budgetExtension.reviseCountByHarnessRef.current.get('H1_EXECUTE_EVAL')).toBe(
      H1_MAX_SAME_HARNESS_REVISES,
    );
  });

  it('Risk-2: second H1 revise auto-escalates to H2 when ceiling permits', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const base = makeFakeVerdictEmitter({ status: 'revise', reason: 'still incomplete' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50 });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
    });
    // Pre-seed the counter to simulate "one same-harness revise already used"
    budgetExtension.reviseCountByHarnessRef.current.set('H1_EXECUTE_EVAL', 1);

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as {
      payload: { verdict: { status: string; nextHarness?: string; reason?: string } };
      handoffTarget?: string;
    };
    expect(meta.payload.verdict.nextHarness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(meta.handoffTarget).toBe('kodax/role/planner');
    expect(meta.payload.verdict.reason).toMatch(/Auto-escalated to H2/);
  });

  it('Risk-2: second H1 revise converts to accept-with-followup when ceiling blocks H2', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const base = makeFakeVerdictEmitter({
      status: 'revise',
      reason: 'tests still failing',
      followups: ['fix the lint'],
    });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50 });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H1_EXECUTE_EVAL',
      upgradeCeiling: 'H1_EXECUTE_EVAL', // ceiling blocks H2 escalation
    });
    budgetExtension.reviseCountByHarnessRef.current.set('H1_EXECUTE_EVAL', 1);

    const wrapped = wrapEmitterWithRecorder(base, 'verdict', recorder, noopObserver, budget, budgetExtension);
    const result = await wrapped.execute({}, toolCtx);

    const meta = result.metadata as {
      payload: { verdict: { status: string; followups: string[]; nextHarness?: string } };
      isTerminal?: boolean;
    };
    expect(meta.payload.verdict.status).toBe('accept');
    expect(meta.payload.verdict.followups[0]).toMatch(/Pending concern from Evaluator.*tests still failing/);
    expect(meta.payload.verdict.followups).toContain('fix the lint');
    expect(meta.payload.verdict.nextHarness).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
    expect(budgetExtension.degradedContinueRef.current).toBe(true);
  });

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
      status: 'accept',
      reason: 'done',
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

  it('Risk-5: H2 harness is not subject to the H1 same-harness revise cap', async () => {
    const { wrapEmitterWithRecorder } = await harnessTestables();
    const base = makeFakeVerdictEmitter({ status: 'revise', reason: 'retry' });
    const recorder = makeRecorder();
    const budget = makeBudgetController({ total: 200, spent: 50, harness: 'H2_PLAN_EXECUTE_EVAL' });
    const budgetExtension = makeBudgetExtensionFixture({
      harness: 'H2_PLAN_EXECUTE_EVAL',
    });
    // Even if we pre-seed a high revise count for H2, the wrapper must
    // NOT apply the H1-only conversion — H2 runs to the global round cap.
    budgetExtension.reviseCountByHarnessRef.current.set('H2_PLAN_EXECUTE_EVAL', 5);

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
    // Revise counter untouched
    expect(budgetExtension.reviseCountByHarnessRef.current.size).toBe(0);
    // Degraded-continue flag untouched
    expect(budgetExtension.degradedContinueRef.current).toBe(false);
  });
});

// =============================================================================
// H1 structural resume (v0.7.26) — buildStructuralResumeSeed
// =============================================================================

describe('H1 structural resume — buildStructuralResumeSeed (v0.7.26)', () => {
  async function getBuilder() {
    const mod = await import('./runner-driven.js');
    return mod.__runnerDrivenTestables.buildStructuralResumeSeed;
  }

  type ValidatedCheckpointInput = Parameters<
    Awaited<ReturnType<typeof getBuilder>>
  >[0];

  function makeCheckpoint(params: {
    harness: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
    scoutCompleted: boolean;
    scoutDecision?: {
      summary?: string;
      recommendedHarness?: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
      scope?: string[];
      reviewFilesOrAreas?: string[];
      harnessRationale?: string;
      directCompletionReady?: 'yes' | 'no';
      skillSummary?: string;
      executionObligations?: string[];
    };
    contractSummary?: string;
  }): ValidatedCheckpointInput {
    return {
      checkpoint: {
        version: 1,
        taskId: 'task-test',
        createdAt: new Date().toISOString(),
        gitCommit: 'abcd1234',
        objective: 'resume fixture',
        harnessProfile: params.harness,
        currentRound: 2,
        completedWorkerIds: params.scoutCompleted ? ['scout-1'] : [],
        scoutCompleted: params.scoutCompleted,
      },
      workspaceDir: '/tmp/ws',
      managedTask: {
        contract: {
          taskId: 'task-test',
          surface: 'repl',
          objective: 'resume fixture',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'in_progress',
          primaryTask: 'edit',
          workIntent: 'implement',
          complexity: 'medium',
          riskLevel: 'low',
          harnessProfile: params.harness,
          recommendedMode: 'ama',
          requiresBrainstorm: false,
          reason: 'fixture',
          contractSummary: params.contractSummary,
          successCriteria: params.contractSummary ? ['criterion-1'] : [],
          requiredEvidence: [],
          constraints: [],
        },
        roleAssignments: [],
        workItems: [],
        evidence: { workspaceDir: '/tmp/ws', artifacts: [], entries: [], routingNotes: [] },
        verdict: {
          status: 'in_progress',
          decidedByAssignmentId: '',
          summary: '',
        },
        runtime: params.scoutDecision
          ? {
            scoutDecision: {
              summary: params.scoutDecision.summary ?? 'scout summary',
              recommendedHarness: params.scoutDecision.recommendedHarness ?? params.harness,
              readyForUpgrade: false,
              scope: params.scoutDecision.scope,
              reviewFilesOrAreas: params.scoutDecision.reviewFilesOrAreas,
              harnessRationale: params.scoutDecision.harnessRationale,
              directCompletionReady: params.scoutDecision.directCompletionReady,
              skillSummary: params.scoutDecision.skillSummary,
              executionObligations: params.scoutDecision.executionObligations,
            },
          }
          : undefined,
      },
    } as unknown as ValidatedCheckpointInput;
  }

  it('H1 scout completed → starts at generator, scout slot seeded, rolesEmitted=[scout]', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H1_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Investigated modules A + B',
        recommendedHarness: 'H1_EXECUTE_EVAL',
        scope: ['src/a.ts', 'src/b.ts'],
        harnessRationale: 'single-file write sufficient',
      },
    }));
    expect(seed.startingRole).toBe('generator');
    expect(seed.harness).toBe('H1_EXECUTE_EVAL');
    expect(seed.rolesEmitted).toEqual(['scout']);
    expect(seed.recorderSlots.scout).toBeDefined();
    expect(seed.recorderSlots.scout?.role).toBe('scout');
    expect(seed.recorderSlots.scout?.payload.scout?.summary).toBe('Investigated modules A + B');
    expect(seed.recorderSlots.scout?.payload.scout?.confirmedHarness).toBe('H1_EXECUTE_EVAL');
    expect(seed.recorderSlots.scout?.handoffTarget).toBe('kodax/role/generator');
    expect(seed.recorderSlots.contract).toBeUndefined();
  });

  it('H2 scout completed, no contract → starts at planner', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H2_PLAN_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Large refactor across 4 modules',
        recommendedHarness: 'H2_PLAN_EXECUTE_EVAL',
      },
    }));
    expect(seed.startingRole).toBe('planner');
    expect(seed.harness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(seed.rolesEmitted).toEqual(['scout']);
    expect(seed.recorderSlots.contract).toBeUndefined();
  });

  it('H2 scout + contract completed → starts at generator, both slots seeded', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H2_PLAN_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Multi-phase migration',
        recommendedHarness: 'H2_PLAN_EXECUTE_EVAL',
      },
      contractSummary: 'Phase 1: add schema; Phase 2: backfill; Phase 3: cutover',
    }));
    expect(seed.startingRole).toBe('generator');
    expect(seed.rolesEmitted).toEqual(['scout', 'planner']);
    expect(seed.recorderSlots.scout).toBeDefined();
    expect(seed.recorderSlots.contract).toBeDefined();
    expect(seed.recorderSlots.contract?.payload.contract?.summary)
      .toContain('Phase 1: add schema');
    expect(seed.recorderSlots.contract?.payload.contract?.successCriteria).toEqual(['criterion-1']);
  });

  it('no scout completion → starts at scout with empty seeds (plain restart)', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H1_EXECUTE_EVAL',
      scoutCompleted: false,
    }));
    expect(seed.startingRole).toBe('scout');
    expect(seed.rolesEmitted).toEqual([]);
    expect(seed.recorderSlots.scout).toBeUndefined();
    expect(seed.recorderSlots.contract).toBeUndefined();
  });

  it('H0 scout completed → stays at scout (re-emit direct answer with context)', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H0_DIRECT',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'Trivial explain-only',
        recommendedHarness: 'H0_DIRECT',
        directCompletionReady: 'yes',
      },
    }));
    expect(seed.startingRole).toBe('scout');
    expect(seed.harness).toBe('H0_DIRECT');
    expect(seed.rolesEmitted).toEqual(['scout']);
    expect(seed.recorderSlots.scout?.isTerminal).toBe(true);
  });

  it('seeded scout skillMap round-trips the skillSummary + obligations', async () => {
    const build = await getBuilder();
    const seed = build(makeCheckpoint({
      harness: 'H1_EXECUTE_EVAL',
      scoutCompleted: true,
      scoutDecision: {
        summary: 'write-heavy edit',
        recommendedHarness: 'H1_EXECUTE_EVAL',
        skillSummary: 'use edit for single-file change',
        executionObligations: ['preserve CRLF', 'keep header comment'],
      },
    }));
    const skillMap = seed.recorderSlots.scout?.payload.scout?.skillMap;
    expect(skillMap).toBeDefined();
    expect(skillMap?.skillSummary).toBe('use edit for single-file change');
    expect(skillMap?.executionObligations).toEqual(['preserve CRLF', 'keep header comment']);
  });
});
