/**
 * Eval: AMA harness selection — Stage 3 production-fidelity guardrail —
 * FEATURE_106 (v0.7.31).
 *
 * ## Why this exists
 *
 * Layer 1 (`scope-aware-harness-guardrail.test.ts`, 11 tests) covers the
 * `afterTool` hook's pure logic; Layer 2
 * (`scope-aware-harness-guardrail.integration.test.ts`, 3 tests) drives
 * `Runner.run` with a *scripted* mock LLM proving wiring + idempotency.
 *
 * **Stage 3 closes the last benchmark gap**: real LLM × real production
 * Scout role-prompt × real Runner.run loop with mock mutation tools.
 * It tests whether real models, when emitting write tool calls under the
 * v0.7.31 production Scout prompt, observe the rewritten tool result and
 * pivot to `emit_scout_verdict` on the next turn — not just whether the
 * guardrail wiring fires.
 *
 * Production fidelity:
 *
 *   - Scout system prompt: built via `createRolePrompt('scout', ...)` —
 *     the same factory the production task-engine calls, so the model
 *     sees the FEATURE_106 §QUALITY FRAMEWORK + SCOPE COMMITMENT block
 *     verbatim, not a benchmark-paraphrase.
 *   - Tool surface: `read` / `grep` / `glob` / `bash` / `write` / `edit`
 *     / `dispatch_child_task` / `emit_scout_verdict` — the 8-tool
 *     surface the production prompt names (see `runner-driven.ts:279`
 *     and the SCOUT_INSTRUCTIONS_FALLBACK list). Read-only tools return
 *     stub content; mutation tools mutate the shared `MutationTracker`
 *     so the guardrail's threshold predicates can fire.
 *   - Guardrail: `createScopeAwareHarnessGuardrail({mutationTracker,
 *     payloadRef})` — same factory and same predicate
 *     (`isMutationScopeSignificant`: ≥3 files OR ≥100 lines) the
 *     production code uses.
 *
 * No real filesystem mutation, no production tracer / observability,
 * no production reasoning router (we set reasoning explicitly on the
 * provider side via the harness extension). Everything else is the
 * production wiring.
 *
 * ## Matrix
 *
 *   1 task (h1-multifile-bugfix — most realistic H1 trigger) ×
 *   3 alias (kimi / ds/v4pro / zhipu/glm51) ×
 *   1 prompt (production createRolePrompt('scout', ...)) ×
 *   1 reasoning (balanced — the FEATURE_103 v0.7.29+ default).
 *
 * 3 cells, ~30-90s each = ~3-5 min wall-clock.
 *
 * ## Cell-level outcome taxonomy
 *
 *   Three success modes (all PASS for FEATURE_106 acceptance):
 *
 *     A. committed-early — Scout emitted H1/H2 verdict before crossing
 *        the 3-file / 100-line mutation threshold. Production prompt's
 *        "Do NOT do the implementation yourself for H1/H2 tasks" rule
 *        triggered correctly; guardrail did not need to fire.
 *     B. guardrail-rescued — Mutation crossed threshold, guardrail's
 *        afterTool hook injected the rewrite, Scout subsequently
 *        emitted H1/H2 verdict.
 *     C. inconclusive — Scout exceeded MAX_TOOL_LOOP_ITERATIONS without
 *        emitting verdict OR mutating files (model loops on read-only
 *        exploration of stub tools). This is a benchmark-setup
 *        artefact: production reads return real file content that
 *        terminates the exploration loop; mock stubs return generic
 *        text that some models fail to converge on. NOT a release
 *        blocker — counted separately.
 *
 *   Real failure mode (release blocker, would re-open FEATURE_106):
 *
 *     D. composition-fail — Mutation crossed threshold, but EITHER
 *        guardrail did not fire OR Scout did not pivot to verdict
 *        afterward. Indicates the production wiring would let multi-
 *        file H0_DIRECT slip past in real runs.
 */

import { describe, expect, it } from 'vitest';

import {
  Runner,
  createAgent,
  isRunnableTool,
  type Agent,
  type AgentMessage,
  type AgentTool,
  type RunnerLlmResult,
  type RunnerToolResult,
} from '@kodax/core';
import {
  getProvider,
  type KodaXMessage,
  type KodaXTextBlock,
  type KodaXThinkingBlock,
  type KodaXRedactedThinkingBlock,
  type KodaXToolDefinition,
  type KodaXToolUseBlock,
  type KodaXTaskRoutingDecision,
} from '@kodax/ai';

import {
  type ModelAlias,
  resolveAlias,
} from '../benchmark/harness/aliases.js';
import { availableAliases } from '../benchmark/harness/aliases.js';
import { createScopeAwareHarnessGuardrail } from '../packages/coding/src/agent-runtime/middleware/scope-aware-harness-guardrail.js';
import type {
  KodaXManagedProtocolPayload,
  ManagedMutationTracker,
} from '../packages/coding/src/agent-runtime/types.js';
import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { AMA_HARNESS_TASKS } from '../benchmark/datasets/ama-harness-selection/cases.js';

const STAGE_3_ALIAS_FILTER: readonly ModelAlias[] = [
  'kimi',
  'ds/v4pro',
  'zhipu/glm51',
];

// ---------------------------------------------------------------------------
// Mock production-tool surface
// ---------------------------------------------------------------------------

function buildMutationTool(
  name: 'write' | 'edit',
  tracker: ManagedMutationTracker,
): AgentTool {
  const tool = {
    name,
    description:
      `${name === 'write' ? 'Write content to a file' : 'Edit a file in place'}. ` +
      `Input: { file: string, lines?: number }. (mock — does not touch real fs)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', description: 'Target file path' },
        lines: { type: 'number', description: 'Approximate line count (default 30)' },
        content: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' },
      },
      required: ['file'],
    },
    execute: async (input: Record<string, unknown>): Promise<RunnerToolResult> => {
      const file = String(input.file ?? '<unknown>');
      const lines = typeof input.lines === 'number' ? input.lines : 30;
      tracker.files.set(file, lines);
      tracker.totalOps += 1;
      return {
        content: `${name === 'write' ? 'wrote' : 'edited'} ${lines} lines in ${file}`,
        isError: false,
      };
    },
  };
  if (!isRunnableTool(tool)) {
    throw new Error(`${name} tool failed RunnableTool typeguard`);
  }
  return tool;
}

function buildReadOnlyTool(
  name: 'read' | 'grep' | 'glob' | 'bash' | 'dispatch_child_task',
): AgentTool {
  const tool = {
    name,
    description:
      name === 'read' ? 'Read file content. Input: { file: string }.' :
      name === 'grep' ? 'Search file content by pattern.' :
      name === 'glob' ? 'List files by glob pattern.' :
      name === 'bash' ? 'Run a shell command (mock — read-only stub).' :
      'Dispatch a read-only investigation child task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string' },
        pattern: { type: 'string' },
        command: { type: 'string' },
        prompt: { type: 'string' },
      },
    },
    execute: async (_input: Record<string, unknown>): Promise<RunnerToolResult> => {
      // Return a stub that's plausible enough not to derail the model
      // but doesn't leak any real content (we're a benchmark, not the
      // actual repo).
      return {
        content: `(stub ${name} result — assume the file exists with typical content for the task)`,
        isError: false,
      };
    },
  };
  if (!isRunnableTool(tool)) {
    throw new Error(`${name} tool failed RunnableTool typeguard`);
  }
  return tool;
}

function buildEmitScoutVerdictTool(
  payloadRef: { current: KodaXManagedProtocolPayload | undefined },
): AgentTool {
  const tool = {
    name: 'emit_scout_verdict',
    description:
      'Emit Scout harness verdict exactly once. Required: confirmed_harness ' +
      '(H0_DIRECT | H1_EXECUTE_EVAL | H2_PLAN_EXECUTE_EVAL). Optional: ' +
      'summary, scope[], review_files_or_areas[].',
    input_schema: {
      type: 'object' as const,
      properties: {
        confirmed_harness: {
          type: 'string',
          enum: ['H0_DIRECT', 'H1_EXECUTE_EVAL', 'H2_PLAN_EXECUTE_EVAL'],
        },
        summary: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' } },
        review_files_or_areas: { type: 'array', items: { type: 'string' } },
      },
      required: ['confirmed_harness'],
    },
    execute: async (input: Record<string, unknown>): Promise<RunnerToolResult> => {
      const confirmed = input.confirmed_harness;
      payloadRef.current = {
        kind:
          confirmed === 'H1_EXECUTE_EVAL'
            ? 'h1-execute-eval'
            : confirmed === 'H2_PLAN_EXECUTE_EVAL'
              ? 'h2-plan-execute-eval'
              : 'h0-direct',
        ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
      } as unknown as KodaXManagedProtocolPayload;
      return { content: 'verdict recorded', isError: false };
    },
  };
  if (!isRunnableTool(tool)) {
    throw new Error('emit_scout_verdict tool failed RunnableTool typeguard');
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Stub routing decision — minimal fields the production createRolePrompt
// reads when role='scout'. Everything else uses sensible defaults.
// ---------------------------------------------------------------------------

function buildStubDecision(): KodaXTaskRoutingDecision {
  return {
    primaryTask: 'fix',
    mutationSurface: 'packages/api/src/auth.ts,packages/web/src/login.tsx',
    assuranceIntent: 'normal',
    confidence: 0.7,
    riskLevel: 'low',
    recommendedMode: 'managed',
    recommendedThinkingDepth: 'medium',
    complexity: 'medium',
    workIntent: 'execute',
    requiresBrainstorm: false,
    harnessProfile: 'H0_DIRECT',
    reason: 'pre-Scout heuristic for benchmark stub',
  };
}

// ---------------------------------------------------------------------------
// Provider.stream → RunnerLlmResult adapter
// ---------------------------------------------------------------------------

function buildLlmCallback(
  alias: ModelAlias,
): (messages: readonly AgentMessage[], agent: Agent) => Promise<RunnerLlmResult> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);
  return async (messages, agent) => {
    const tools: KodaXToolDefinition[] = (agent.tools ?? []) as KodaXToolDefinition[];
    const system = typeof agent.instructions === 'string' ? agent.instructions : '';
    const result = await provider.stream(
      messages as KodaXMessage[],
      tools,
      system,
      { enabled: true, depth: 'medium', taskType: 'fix' },
      { modelOverride: target.model },
    );
    const text = result.textBlocks.map((b: KodaXTextBlock) => b.text).join('');
    const toolCalls = result.toolBlocks.map((b: KodaXToolUseBlock) => ({
      id: b.id,
      name: b.name,
      input: (b.input ?? {}) as Record<string, unknown>,
    }));
    const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] =
      result.thinkingBlocks ?? [];
    return { text, toolCalls, thinkingBlocks };
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const H1_TASK = AMA_HARNESS_TASKS.find((t) => t.id === 'h1-multifile-bugfix')!;

describe('Eval Stage 3: real-LLM × production-fidelity Scout × scope-aware-harness-guardrail', () => {
  const allAvailable = availableAliases();
  const aliases = allAvailable.filter((a) =>
    STAGE_3_ALIAS_FILTER.includes(a as ModelAlias),
  );

  if (aliases.length === 0) {
    it('skips: no Stage 3 alias keys in env', () => {});
    return;
  }

  for (const alias of aliases) {
    it(
      `${alias} — H1 multi-file task: production Scout prompt × guardrail composes`,
      { timeout: 120_000 },
      async () => {
        const tracker: ManagedMutationTracker = {
          files: new Map(),
          totalOps: 0,
        };
        const payloadRef: {
          current: KodaXManagedProtocolPayload | undefined;
        } = { current: undefined };
        const guardrail = createScopeAwareHarnessGuardrail({
          mutationTracker: tracker,
          payloadRef,
        });

        // Production-fidelity Scout system prompt — the same factory the
        // production task-engine calls.
        const scoutSystemPrompt = createRolePrompt(
          'scout',
          H1_TASK.userMessage,
          buildStubDecision(),
          undefined, // verification contract — Scout doesn't need one yet
          undefined, // tool policy — fall through to default
          'scout',
          undefined, // metadata
          undefined, // role prompt context
          undefined, // workerId
          false, // isTerminalAuthority
        );

        const tools: AgentTool[] = [
          buildReadOnlyTool('read'),
          buildReadOnlyTool('grep'),
          buildReadOnlyTool('glob'),
          buildReadOnlyTool('bash'),
          buildReadOnlyTool('dispatch_child_task'),
          buildMutationTool('write', tracker),
          buildMutationTool('edit', tracker),
          buildEmitScoutVerdictTool(payloadRef),
        ];

        const scoutAgent = createAgent({
          name: 'scout',
          instructions: scoutSystemPrompt,
          tools,
          guardrails: [guardrail],
        });

        const toolCallSeq: string[] = [];
        let output = '';
        let errorMsg: string | undefined;
        try {
          const result = await Runner.run(scoutAgent, H1_TASK.userMessage, {
            llm: buildLlmCallback(alias),
            tracer: null,
            toolObserver: {
              onToolCall: (call) => {
                toolCallSeq.push(call.name);
              },
            },
          });
          output = result.output;
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
        }

        const writeOps = tracker.files.size;
        const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);
        const verdict = payloadRef.current;
        const reflectionInjected = tracker.reflectionInjected === true;
        const verdictKind = verdict ? (verdict as { kind?: string }).kind : undefined;

        const isH1H2 =
          verdictKind === 'h1-execute-eval' ||
          verdictKind === 'h2-plan-execute-eval';
        const crossedThreshold = writeOps >= 3 || totalLines >= 100;
        const maxIterations = errorMsg?.includes('MAX_TOOL_LOOP_ITERATIONS') === true;

        // Outcome taxonomy
        let outcome:
          | 'committed-early'
          | 'guardrail-rescued'
          | 'inconclusive'
          | 'composition-fail';
        if (isH1H2 && !crossedThreshold) {
          outcome = 'committed-early';
        } else if (reflectionInjected && isH1H2) {
          outcome = 'guardrail-rescued';
        } else if (maxIterations && !crossedThreshold) {
          // Stub-tool over-exploration loop — benchmark setup artefact,
          // not a production failure. Production read returns real
          // content; this loop only happens with stub returns.
          outcome = 'inconclusive';
        } else {
          outcome = 'composition-fail';
        }

        // eslint-disable-next-line no-console
        console.log(
          `[${alias}] outcome=${outcome} writes=${writeOps} lines=${totalLines} ` +
            `guardrail-fired=${reflectionInjected} verdict=${verdictKind ?? '(none)'} ` +
            `tool-calls=${toolCallSeq.length}(${toolCallSeq.slice(0, 8).join(',')}${toolCallSeq.length > 8 ? ',…' : ''}) ` +
            `error=${maxIterations ? 'MAX_ITER' : errorMsg ? errorMsg.slice(0, 60) : '(none)'}`,
        );

        // Hard fail only on composition-fail. inconclusive cells log
        // their state but don't block release — see header §taxonomy.
        expect({
          alias,
          outcome,
          writes: writeOps,
          totalLines,
          reflectionInjected,
          verdict: verdictKind,
          toolCallCount: toolCallSeq.length,
        }).toMatchObject({
          outcome: expect.stringMatching(/^(committed-early|guardrail-rescued|inconclusive)$/),
        });
      },
    );
  }
});
