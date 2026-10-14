/**
 * KodaX `todo_get` Tool — v0.7.42 plan-list parity with claudecode V2.
 *
 * Read-only single-item lookup. Returns the full TodoItem detail for one
 * id — including the optional `description` carried alongside `subject`
 * since the v0.7.42 schema split. Mirrors claudecode V2's `TaskGet`
 * ([c:/Works/claudecode/src/tools/TaskGetTool/TaskGetTool.ts](
 * c:/Works/claudecode/src/tools/TaskGetTool/TaskGetTool.ts)).
 *
 * Why a separate tool when `todo_list` already returns full DTOs:
 *   1. STALENESS GUARD — Worker / Generator can refresh a single item's
 *      state right before mutating it (a `todo_update` race window
 *      exists when the runner-side `verdict-slot` auto-handler flips
 *      items independently). claudecode's `TaskUpdate` prompt explicitly
 *      teaches "read the latest with TaskGet before update"
 *      ([prompt.ts:49](c:/Works/claudecode/src/tools/TaskUpdateTool/prompt.ts#L49));
 *      KodaX mirrors the same discipline in Step 5 prompt updates.
 *   2. PICK-UP CONTEXT — when an executor finally reaches an item
 *      previously written by Planner / Scout, `todo_get` returns the
 *      fuller `description` (the work instruction) without forcing the
 *      executor to scan the whole list. Inexpensive for KodaX single-
 *      agent loops (5-20 typical items), but the cost grows linearly
 *      and `todo_get` keeps it constant.
 *   3. ANTI-DEDUP — paired with `todo_list`, `todo_get` lets the model
 *      check "does an item with this ~subject already exist?" via a
 *      cheap targeted lookup after listing ids.
 *
 * Contract:
 *
 *   Input:
 *     id  string  — required. The todo id to retrieve (e.g. "todo_3").
 *
 *   Output (JSON string):
 *     {ok: true,  item: {id, subject, description?, status, activeForm?, note?, evaluator?, metadata?}}
 *     {ok: false, reason: "..."}   — store not wired, OR id not found.
 *
 *   Unknown-id response carries the same `Current valid ids: …` hint
 *   `todo_update` returns so the model can recover on the next turn
 *   without guessing.
 */

import type {
  KodaXToolExecutionContext,
  TodoEvaluatorHint,
  TodoItem,
  TodoStatus,
} from '../types.js';

interface TodoGetItemDTO {
  readonly id: string;
  readonly subject: string;
  readonly description?: string;
  readonly status: TodoStatus;
  readonly activeForm?: string;
  readonly note?: string;
  readonly evaluator?: TodoEvaluatorHint;
  readonly owner?: string;
  readonly metadata?: Record<string, unknown>;
}

function toDTO(item: TodoItem): TodoGetItemDTO {
  // Strip undefined fields so prompt-cache hits stay stable across calls
  // (mirrors `todo_list`'s DTO discipline).
  const dto: TodoGetItemDTO = {
    id: item.id,
    subject: item.subject,
    status: item.status,
    ...(item.description ? { description: item.description } : {}),
    ...(item.activeForm ? { activeForm: item.activeForm } : {}),
    ...(item.note ? { note: item.note } : {}),
    ...(item.evaluator ? { evaluator: item.evaluator } : {}),
    ...(item.owner !== undefined ? { owner: item.owner } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  };
  return dto;
}

function jsonResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

interface TodoGetInput {
  id?: unknown;
}

export async function toolTodoGet(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const { id } = input as TodoGetInput;

  if (!ctx.todoStore) {
    return jsonResult({
      ok: false,
      reason:
        'todo_get is not active in this run (no plan list infrastructure ' +
        'is wired). Either no managed task is active, or the runtime did ' +
        'not provide a todo store. You may continue working without ' +
        'querying the plan list.',
    });
  }

  if (typeof id !== 'string' || id.length === 0) {
    return jsonResult({
      ok: false,
      reason: 'Missing or invalid required parameter: id (non-empty string).',
    });
  }

  // Targeted lookup. Use a linear scan since the engine's list is small
  // (5-20 typical, capped at the few-dozen mark by the throttle reminder
  // surface). No need to maintain a separate id→item index.
  const item = ctx.todoStore.getAll().find((it) => it.id === id);
  if (!item) {
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
        `Call todo_list to see the full plan, or retry with one of the valid ids.`,
    });
  }

  return jsonResult({ ok: true, item: toDTO(item) });
}
