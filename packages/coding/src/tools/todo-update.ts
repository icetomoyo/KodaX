/**
 * KodaX `todo_update` Tool — FEATURE_097 (v0.7.34).
 *
 * Drives the Scout-seeded todo plan list visible in the AMA REPL surface.
 * The tool is injected into Scout (H0 path), Generator, and Planner tool
 * sets at runner setup time; Evaluator does NOT receive it (its verdict
 * drives the list via runner-side auto-handling per design §5 ①).
 *
 * Contract (per design-doc §5 决策细节 ⑤ for unknown-id handling):
 *
 *   Input:
 *     id      string     — required. Must match a current todo id.
 *     status  enum       — required. one of: in_progress | completed | failed | skipped.
 *                                     pending is intentionally excluded — items
 *                                     start at pending automatically and only
 *                                     `resetFailed()` (Runner-driven) sends them
 *                                     back to that state.
 *     note    string?    — optional. Free-text reason / detail. When omitted,
 *                                     any pre-existing note on the item is
 *                                     preserved (e.g. an Evaluator-failure note
 *                                     persists across a re-try transition).
 *
 *   Output (string, JSON-stringified):
 *     {ok: true}                                — success
 *     {ok: false, reason: "Unknown todo id ..."} — id not in store; reason
 *                                                   includes the full set of
 *                                                   currently valid ids so the
 *                                                   model can self-correct on
 *                                                   the next turn
 *     {ok: false, reason: "..."}                — validation error (bad status,
 *                                                   missing id, todo store not
 *                                                   wired in this run, etc.)
 *
 * Why we return `{ok:false}` instead of throwing on unknown id: a single
 * hallucinated id should not crash the Runner loop. Returning a structured
 * error with the valid-id list lets the LLM recover on the next turn.
 * (Hermetic test coverage: see todo-update.test.ts.)
 */

import type { KodaXToolExecutionContext, TodoStatus } from '../types.js';

const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
  'failed',
  'skipped',
]);

interface TodoUpdateInput {
  id?: unknown;
  status?: unknown;
  note?: unknown;
}

function jsonResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export async function toolTodoUpdate(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const { id, status, note } = input as TodoUpdateInput;

  if (!ctx.todoStore) {
    // Configuration error — runner-driven did not wire a store for this run.
    // Surface this clearly so the model knows the tool call did nothing.
    return jsonResult({
      ok: false,
      reason:
        'todo_update is not active in this run (no plan list was seeded). ' +
        'You may continue working without calling todo_update.',
    });
  }

  if (typeof id !== 'string' || id.length === 0) {
    return jsonResult({
      ok: false,
      reason: 'Missing or invalid required parameter: id (non-empty string).',
    });
  }

  if (typeof status !== 'string' || !ALLOWED_STATUSES.has(status)) {
    return jsonResult({
      ok: false,
      reason:
        `Invalid status: ${JSON.stringify(status)}. ` +
        `Allowed: in_progress | completed | failed | skipped.`,
    });
  }

  if (note !== undefined && typeof note !== 'string') {
    return jsonResult({
      ok: false,
      reason: 'Invalid note: when provided, must be a string.',
    });
  }

  if (!ctx.todoStore.has(id)) {
    const validIds = ctx.todoStore.allIds();
    const validList =
      validIds.length === 0
        ? 'no todos currently exist'
        : validIds.join(', ');
    return jsonResult({
      ok: false,
      reason:
        `Unknown todo id: ${JSON.stringify(id)}. ` +
        `Current valid ids: ${validList}. ` +
        `Please retry with one of the valid ids, or skip this update.`,
    });
  }

  ctx.todoStore.updateStatus(id, status as TodoStatus, note as string | undefined);
  // Note: store fires its onChange callback internally — no need for the
  // tool to also emit onTodoUpdate.
  return jsonResult({ ok: true });
}
