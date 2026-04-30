/**
 * FEATURE_107 (v0.7.32) — Plan-intent fidelity judge for H2 plan-execute
 * boundary eval.
 *
 * Question this judge answers: did the Generator's final deliverable match
 * what the Planner actually intended, or did it drift in a way an Evaluator
 * accept signal alone wouldn't catch?
 *
 * Why a separate file (not added to `judges.ts`): existing judges are
 * synchronous + text-only + zero-LLM by design (see judges.ts line 9-12).
 * This is the project's first LLM-as-judge. Per CLAUDE.md "3+ concrete
 * cases before abstracting", we keep it as a focused single-purpose module
 * rather than retrofitting `judges.ts` to async/LLM. If/when more LLM
 * judges arrive, generalize then.
 *
 * Used by `h2-boundary-runner.ts` to compare plan_artifact (H2-A/H2-B) or
 * scout_verdict (H1-ref) against the Generator's final state diff.
 */

import { getProvider, type KodaXMessage } from '@kodax/ai';

import { resolveAlias, type ModelAlias } from './aliases.js';

// SYSTEM_PROMPT is the rubric text the judge runs on. Extracted for testing
// (zero-LLM tests verify parser behavior without round-tripping through
// the provider API).

const SYSTEM_PROMPT = `You are an impartial evaluator scoring whether a code-change deliverable
matches the intent expressed in a planning artifact.

You will receive:
  PLAN: the planning text (from Planner role, or Scout verdict for H1)
  DELIVERABLE: a summary of what changed (file list + key diffs)
  ACCEPTANCE_CRITERIA: the case's pre-locked acceptance criteria

Score plan-intent fidelity on 0-100:
  90-100: deliverable accomplishes the plan's intent fully and faithfully
  70-89:  deliverable accomplishes most of the intent, minor drift acceptable
  50-69:  partial accomplishment, notable drift on substance OR scope creep
  30-49:  significant drift OR missed core intent
  0-29:   deliverable contradicts the plan, or attempts a different problem

Output STRICTLY this JSON shape (no prose, no markdown fence):
{"score": <int 0-100>, "rationale": "<one to three sentences>", "drift_flags": ["..."]}

drift_flags items are short tags from this fixed vocabulary:
  "scope-creep" — touched files outside the plan
  "scope-shrink" — left planned work undone
  "wrong-direction" — implemented opposite intent
  "format-violation" — broke acceptance-criteria format requirement
  "stale-plan" — deliverable is correct but plan was already wrong
  (omit drift_flags entirely or use [] when score >= 90)`;

export interface PlanIntentFidelityInput {
  /** Planner output / Scout verdict text the Generator was meant to fulfill. */
  readonly plan: string;
  /** Generator's deliverable summary: list of files changed + key diff hunks
   *  + any final commit-message-style description. Caller assembles this
   *  from the worktree state after the eval round. */
  readonly deliverable: string;
  /** Pre-locked acceptance criteria from the case (`H2BoundaryCase.acceptanceCriteria`). */
  readonly acceptanceCriteria: string;
  /** Which alias to use as judge. Per FEATURE_107 design, judge runs on a
   *  fixed alias across all cells so the metric is consistent. Caller picks
   *  it (recommended: cross-family from the cell's executor alias). */
  readonly judgeAlias: ModelAlias;
}

export interface PlanIntentFidelityResult {
  readonly score: number;
  readonly rationale: string;
  readonly driftFlags: readonly string[];
  /** Raw LLM response text. Persisted for audit when judges disagree. */
  readonly rawResponse: string;
}

const VALID_DRIFT_FLAGS = new Set([
  'scope-creep',
  'scope-shrink',
  'wrong-direction',
  'format-violation',
  'stale-plan',
]);

function extractJson(raw: string): unknown {
  // The LLM was instructed not to fence, but tolerate ```json … ``` anyway.
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced ? fenced[1] : raw;
  // Some providers prefix with whitespace or a leading "JSON:" tag; trim
  // until the first `{`.
  const start = candidate.indexOf('{');
  if (start < 0) {
    throw new Error('plan-intent-fidelity judge: no JSON object in response');
  }
  return JSON.parse(candidate.slice(start));
}

/**
 * Parse a raw judge response into the structured result. Exported so the
 * zero-LLM self-test suite can exercise the parser without consuming an
 * API key (matches FEATURE_104's "41 zero-LLM self-test" pattern).
 */
export function parsePlanIntentFidelityResponse(raw: string): PlanIntentFidelityResult {
  const parsed = extractJson(raw) as {
    score?: unknown;
    rationale?: unknown;
    drift_flags?: unknown;
  };
  if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) {
    throw new Error(
      `plan-intent-fidelity judge: score missing or non-numeric: ${JSON.stringify(parsed)}`,
    );
  }
  const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  const rationale =
    typeof parsed.rationale === 'string' ? parsed.rationale : '';
  const flagsRaw = Array.isArray(parsed.drift_flags) ? parsed.drift_flags : [];
  const driftFlags = flagsRaw
    .filter((f): f is string => typeof f === 'string')
    .filter((f) => VALID_DRIFT_FLAGS.has(f));
  return { score, rationale, driftFlags, rawResponse: raw };
}

/**
 * Score plan-intent fidelity for one (plan, deliverable, acceptance) triple.
 * Caller is responsible for batching across cases / cells.
 */
export async function gradePlanIntentFidelity(
  input: PlanIntentFidelityInput,
): Promise<PlanIntentFidelityResult> {
  const target = resolveAlias(input.judgeAlias);
  const provider = getProvider(target.provider);

  const userMessage = [
    `PLAN:\n${input.plan}`,
    `DELIVERABLE:\n${input.deliverable}`,
    `ACCEPTANCE_CRITERIA:\n${input.acceptanceCriteria}`,
  ].join('\n\n---\n\n');

  const messages: KodaXMessage[] = [
    { role: 'user', content: userMessage },
  ];

  const result = await provider.stream(messages, [], SYSTEM_PROMPT);
  const text = result.textBlocks.map((b) => b.text).join('').trim();

  return parsePlanIntentFidelityResponse(text);
}
