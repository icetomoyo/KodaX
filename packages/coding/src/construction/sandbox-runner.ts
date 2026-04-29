/**
 * FEATURE_089 Phase 3.5 — Sandbox Agent Test Runner.
 *
 * Drives the manifest's `testCases` through `Runner.run` with an
 * isolated configuration, then grades the outputs against the per-case
 * expectations (expectMatch / expectNotMatch / expectFinalText). Used
 * by `testAgentArtifact` when a sandbox LLM callback is provided.
 *
 * Isolation approach:
 *
 *   - Each case gets a fresh `Runner.run` call. No shared session or
 *     transcript across cases.
 *   - The agent's tools are NOT executed in the sandbox path — the
 *     sandbox grades the agent's text output, not its tool invocation
 *     pattern. (Tool sandboxing is its own concern; FEATURE_088
 *     ConstructionRuntime already gates tool capability.)
 *   - `tracer: null` is passed so sandbox runs don't pollute the
 *     production trace graph.
 *   - `budgetMs` provides a per-case wall-clock cap; default 30s
 *     mirrors the `DEFAULT_HANDLER_TIMEOUT_MS` used for tool sandbox.
 *
 * The result aggregates per-case verdicts. Aggregate `ok` is true iff
 * every case passed; the `cases[]` array preserves order so callers
 * (TestResult renderer) can surface a granular failure summary.
 */

import { Runner } from '@kodax/core';
import type {
  Agent,
  AgentMessage,
  RunnerLlmReturn,
} from '@kodax/core';

import { resolveConstructedAgent } from './agent-resolver.js';
import type { AgentArtifact, AgentTestCase } from './types.js';

/**
 * Per-case timing cap. 30s mirrors the constructed-tool handler
 * timeout (DEFAULT_HANDLER_TIMEOUT_MS) — symmetry with the existing
 * sandbox surface.
 */
const DEFAULT_SANDBOX_BUDGET_MS = 30_000;

/**
 * LLM callback type accepted by the sandbox runner. Same shape as
 * `Runner.run`'s `opts.llm` so callers can either reuse their
 * production callback (with caching) or inject a deterministic mock.
 */
export type SandboxLlmCallback = (
  messages: readonly AgentMessage[],
  agent: Agent,
) => Promise<RunnerLlmReturn>;

export interface SandboxRunnerOptions {
  /** LLM callback driving each case's Runner.run. Required. */
  readonly llm: SandboxLlmCallback;
  /**
   * Per-case wall-clock budget. Defaults to 30s. Cases that exceed it
   * are recorded as `{ ok: false, error: 'timeout' }` so a hung case
   * doesn't block the rest of the suite.
   */
  readonly budgetMs?: number;
  /**
   * Override the resolved Agent the sandbox runs against. Defaults to
   * looking the agent up in `resolveConstructedAgent(artifact.name)`.
   * The override is used when the caller wants to test a candidate
   * manifest without first registering it (Phase 3.5 wires this so
   * `testAgentArtifact` can sandbox-test before activation).
   */
  readonly resolvedAgent?: Agent;
}

export interface SandboxCaseResult {
  readonly caseId: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
}

export interface SandboxRunResult {
  readonly ok: boolean;
  readonly cases: readonly SandboxCaseResult[];
}

/**
 * Grade a single case's final text against the manifest expectations.
 * At least one of expectMatch / expectNotMatch / expectFinalText must
 * be present per the AgentTestCase contract; we treat absence of all
 * three as "the case author forgot to specify an expectation" and
 * mark it as a soft failure rather than silently passing.
 */
function gradeCase(testCase: AgentTestCase, finalText: string): SandboxCaseResult {
  const reasons: string[] = [];

  let anyExpectation = false;
  if (testCase.expectMatch !== undefined) {
    anyExpectation = true;
    let pattern: RegExp;
    try {
      pattern = new RegExp(testCase.expectMatch);
    } catch (err) {
      return {
        caseId: testCase.id,
        ok: false,
        output: finalText,
        error: `expectMatch is not a valid regex: ${(err as Error).message}`,
      };
    }
    if (!pattern.test(finalText)) {
      reasons.push(`expectMatch ${JSON.stringify(testCase.expectMatch)} did not match output`);
    }
  }
  if (testCase.expectNotMatch !== undefined) {
    anyExpectation = true;
    let pattern: RegExp;
    try {
      pattern = new RegExp(testCase.expectNotMatch);
    } catch (err) {
      return {
        caseId: testCase.id,
        ok: false,
        output: finalText,
        error: `expectNotMatch is not a valid regex: ${(err as Error).message}`,
      };
    }
    if (pattern.test(finalText)) {
      reasons.push(`expectNotMatch ${JSON.stringify(testCase.expectNotMatch)} unexpectedly matched`);
    }
  }
  if (testCase.expectFinalText !== undefined) {
    anyExpectation = true;
    if (!finalText.includes(testCase.expectFinalText)) {
      reasons.push(`expectFinalText ${JSON.stringify(testCase.expectFinalText)} not found in output`);
    }
  }

  if (!anyExpectation) {
    return {
      caseId: testCase.id,
      ok: false,
      output: finalText,
      error: 'test case has no expectMatch / expectNotMatch / expectFinalText — at least one is required',
    };
  }

  if (reasons.length > 0) {
    return {
      caseId: testCase.id,
      ok: false,
      output: finalText,
      error: reasons.join('; '),
    };
  }
  return { caseId: testCase.id, ok: true, output: finalText };
}

/**
 * Run a single test case through the resolved Agent. Wraps `Runner.run`
 * with a wall-clock budget; returns a typed result that never throws
 * — case errors become `{ ok: false, error: ... }` entries.
 */
async function runOneCase(
  agent: Agent,
  testCase: AgentTestCase,
  llm: SandboxLlmCallback,
  budgetMs: number,
): Promise<SandboxCaseResult> {
  const controller = new AbortController();
  let timeoutFired = false;
  let timer: NodeJS.Timeout | undefined;
  // Promise.race: whichever finishes first wins. The abort signal is
  // forwarded to Runner.run as a courtesy (well-behaved LLM callbacks
  // honor it to short-circuit network reads), but the wall-clock cap
  // is enforced by this race regardless of whether the callback
  // notices the signal — protects against a misbehaving sandbox LLM
  // that ignores AbortSignal and hangs indefinitely.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutFired = true;
      controller.abort();
      reject(new Error('SANDBOX_TIMEOUT'));
    }, budgetMs);
  });
  try {
    const runPromise = Runner.run(agent, testCase.input, {
      llm,
      tracer: null,
      abortSignal: controller.signal,
    });
    // After a timeout race fires, runPromise keeps running (Node has
    // no Promise cancellation). Attach a silent discard so its
    // eventual rejection does not surface as an unhandledRejection
    // in the test harness or production logs.
    runPromise.catch(() => undefined);
    const result = await Promise.race([runPromise, timeoutPromise]);
    return gradeCase(testCase, result.output);
  } catch (err) {
    if (timeoutFired) {
      return {
        caseId: testCase.id,
        ok: false,
        error: `timeout after ${budgetMs}ms`,
      };
    }
    return {
      caseId: testCase.id,
      ok: false,
      error: (err as Error).message,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run every case in `artifact.content.testCases` through the resolved
 * agent. Returns aggregate ok + per-case verdicts.
 *
 * When the artifact carries no test cases, the result is
 * `{ ok: true, cases: [] }` — callers can choose whether to treat
 * "no cases" as a clean pass or a soft warning (testAgentArtifact
 * folds this into the TestResult.warnings stream when desired).
 */
export async function runSandboxAgentTest(
  artifact: AgentArtifact,
  options: SandboxRunnerOptions,
): Promise<SandboxRunResult> {
  const cases = artifact.content.testCases ?? [];
  if (cases.length === 0) {
    return { ok: true, cases: [] };
  }
  const agent = options.resolvedAgent ?? resolveConstructedAgent(artifact.name);
  if (!agent) {
    return {
      ok: false,
      cases: cases.map((c) => ({
        caseId: c.id,
        ok: false,
        error: `sandbox: agent '${artifact.name}' not found in resolver and no resolvedAgent override supplied`,
      })),
    };
  }
  const budgetMs = options.budgetMs ?? DEFAULT_SANDBOX_BUDGET_MS;
  const results: SandboxCaseResult[] = [];
  for (const c of cases) {
    results.push(await runOneCase(agent, c, options.llm, budgetMs));
  }
  return {
    ok: results.every((r) => r.ok),
    cases: results,
  };
}
