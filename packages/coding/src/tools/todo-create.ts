/**
 * KodaX `todo_create` Tool — FEATURE_170 (v0.7.41) + v0.7.42 schema split.
 *
 * Insert ONE new pending or in-progress item into the visible plan list, with a
 * store-generated monotonic id. Companion to `todo_update` (single-item
 * state transition) and `todo_update({op:'init', ...})` (whole-list
 * batch seed; deprecated for LLM use in v0.7.42 — see Step 4).
 *
 * Why a separate tool instead of overloading `todo_update`: prior to
 * FEATURE_170 the only insertion path was `op:'init'` (full replace),
 * which wipes user-visible progress. Mid-task realisation that "the
 * plan needs one more step" had no incremental path — the LLM was
 * forced to choose between dropping the entire list or doing nothing.
 * `todo_create` closes that gap, mirroring claudecode V2's `TaskCreate`
 * surface.
 *
 * Contract (v0.7.42 — content → subject + description):
 *
 *   Input:
 *     subject     string     — required. Brief imperative title shown in
 *                              the plan-list row (e.g. "Audit handleAuth
 *                              callers"). Keep short (≤80 chars).
 *     status      enum?      — pending (default) or in_progress for work starting now.
 *                              Terminal states require todo_update and its checks.
 *     description string?    — optional. Fuller context / work instructions
 *                              read when the executing role picks up this
 *                              item (claudecode V2 TaskGet-style detail).
 *                              Multi-line OK; NOT rendered in the compact
 *                              row, only when fetched via `todo_get`.
 *     activeForm  string?    — optional. Present-continuous form
 *                              (e.g. "Auditing handleAuth callers"). Shown
 *                              by the spinner when the item flips to
 *                              `in_progress` (FEATURE_149).
 *     evaluator   enum?      — optional `'build' | 'test' | 'lint'`. When
 *                              the item flips to `completed`, the runner
 *                              runs the corresponding deterministic check
 *                              (FEATURE_114). Use sparingly — only on
 *                              milestone steps with a real ground-truth
 *                              check.
 *     metadata    object?    — optional opaque key-value bag carried
 *                              alongside the item (FEATURE_170). Surface
 *                              for extension hooks / eval harnesses;
 *                              the UI does NOT render it.
 *
 *   Output (JSON string):
 *     {ok: true, id: "todo_<n>"}     — success; `n` is the new monotonic id.
 *     {ok: false, code: "todo_...", reason: "..."}     — validation error, store not wired,
 *                                       OR extension hook
 *                                       `'todo:before-create'` blocked.
 *
 * Failures retain the original reason and identify their source. A hook veto
 * does not imply that retrying is permitted or that it is permanently blocked.
 * No exception propagation per ADR-021 unified tool-result envelope.
 */

import { runActiveExtensionHook, emitActiveExtensionEvent } from '../extensions/runtime.js';
import type {
  ExtensionTodoCreateSeed,
  KodaXTodoItem,
} from '../extensions/types.js';
import type { KodaXToolExecutionContext, TodoEvaluatorHint } from '../types.js';

const ALLOWED_EVALUATOR_HINTS: ReadonlySet<string> = new Set(['build', 'test', 'lint']);

interface TodoCreateInput {
  subject?: unknown;
  status?: unknown;
  description?: unknown;
  activeForm?: unknown;
  evaluator?: unknown;
  metadata?: unknown;
}

function jsonResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  );
}

export async function toolTodoCreate(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const { subject, status, description, activeForm, evaluator, metadata } = input as TodoCreateInput;

  if (!ctx.todoStore) {
    return jsonResult({
      ok: false,
      code: 'todo_unavailable',
      reason:
        'todo_create is not active in this run (no plan list was seeded). ' +
        'You may continue working without calling todo_create.',
    });
  }

  // v0.7.42 — `subject` is the new required field (claudecode V2 parity).
  // `description` is optional; pass when the work instruction warrants more
  // context than fits in the row label.
  if (typeof subject !== 'string' || subject.length === 0) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        'Missing or invalid required parameter: subject (non-empty string). ' +
        'Provide a brief imperative title for the plan-list row, e.g. ' +
        '"Audit handleAuth callers".',
    });
  }

  if (description !== undefined && typeof description !== 'string') {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        'Invalid description: when provided, must be a string ' +
        '(fuller context / work instructions; multi-line OK).',
    });
  }

  if (status !== undefined && status !== 'pending' && status !== 'in_progress') {
    return jsonResult({ ok: false, code: 'todo_invalid_input', reason: 'Invalid status: use pending (default) or in_progress for work starting now.' });
  }

  if (activeForm !== undefined && typeof activeForm !== 'string') {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        'Invalid activeForm: when provided, must be a string ' +
        '(present-continuous form, e.g. "Running tests").',
    });
  }

  if (
    evaluator !== undefined
    && (typeof evaluator !== 'string' || !ALLOWED_EVALUATOR_HINTS.has(evaluator))
  ) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        `Invalid evaluator: when provided, must be one of 'build' | 'test' | 'lint'. ` +
        `Got ${JSON.stringify(evaluator)}.`,
    });
  }

  if (metadata !== undefined && !isPlainObject(metadata)) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason: 'Invalid metadata: when provided, must be a plain object.',
    });
  }

  // FEATURE_170 — extension hook gate. Hook returns string => block with that
  // reason; false => block with default reason; void/undefined => allow.
  // The hook fires BEFORE store.add() so a blocked create produces no
  // 'todo:created' event downstream and no allocated id.
  const seed: ExtensionTodoCreateSeed = {
    subject,
    ...(status !== undefined ? { status } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof activeForm === 'string' ? { activeForm } : {}),
    ...(typeof evaluator === 'string' ? { evaluator: evaluator as TodoEvaluatorHint } : {}),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
  };
  const hookResult = await runActiveExtensionHook('todo:before-create', { seed });
  if (typeof hookResult === 'string') {
    return jsonResult({ ok: false, code: 'todo_hook_veto', reason: hookResult });
  }
  if (hookResult === false) {
    return jsonResult({ ok: false, code: 'todo_hook_veto', reason: 'blocked-by-hook' });
  }

  const id = ctx.todoStore.add(seed);
  // Fire the broadcast event so extensions / observability tooling can
  // react. `source: 'tool'` distinguishes LLM-driven creates from any
  // future runner-side internal add paths (none today).
  const items = ctx.todoStore.getAll();
  const newItem = items.find((it) => it.id === id);
  if (newItem) {
    // The KodaXTodoItem extension shape is structurally identical to
    // the engine TodoItem (drift-guarded via a compile-time check in
    // extensions/types.ts). No conversion needed.
    await emitActiveExtensionEvent('todo:created', {
      id,
      item: newItem as KodaXTodoItem,
      source: 'tool',
    });
  }

  return jsonResult({ ok: true, id });
}
