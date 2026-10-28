/**
 * KodaX `todo_list` Tool — FEATURE_151 (v0.7.38) Slice D.
 *
 * Read-only query that returns the current visible plan list as the LLM
 * sees it. Mirrors Claude Code's `TaskListTool`
 * ([c:/Works/claudecode/src/tools/TaskListTool/TaskListTool.ts](
 * c:/Works/claudecode/src/tools/TaskListTool/TaskListTool.ts)) which gives
 * the model an explicit way to inspect its own plan rather than relying
 * on echoes from prior `todo_update` results scattered through the turn
 * history.
 *
 * Use cases (from CC `TaskListTool/prompt.ts`):
 *   - Scout / Generator wants to confirm what's still pending before
 *     deciding the next move (especially after a long quiet stretch
 *     where the throttle reminder fires).
 *   - Planner refining a contract wants to see whether Scout's
 *     obligations match its refined success criteria.
 *   - Recovery after `todo_update op:'update'` returned `Unknown todo
 *     id` — the model can list to see the canonical id set rather
 *     than guess.
 *
 * Output: JSON-stringified `{ ok: true, items: [...] }` matching the
 * `TodoItem` shape KodaX already exposes via `KodaXEvents.onTodoUpdate`.
 * When the store is unwired (Scout obligations < 2 and no LLM-driven
 * init), returns `{ ok: false, code: 'todo_unavailable', reason: "todo_list is not active ..." }`
 * — same soft-fail contract as `todo_update`.
 *
 * Tool surface visibility: like `todo_update`, this tool is invisible to
 * the user transcript (`isVisibleToolName` filters it). The user already
 * sees the plan via `TodoListSurface`; LLM-side queries are scaffolding,
 * not a UX surface.
 */

import type { KodaXToolExecutionContext, TodoItem } from '../types.js';
import { toolTodoGet } from './todo-get.js';

interface TodoListItemDTO {
  readonly id: string;
  /** v0.7.42 — brief imperative title (renamed from `content`). */
  readonly subject: string;
  /** Optional fuller description. Pass an id for full item details. */
  readonly description?: string;
  readonly status: string;
  readonly activeForm?: string;
  readonly note?: string;
}

function toDTO(item: TodoItem): TodoListItemDTO {
  // Strip undefined fields so the JSON envelope stays compact and stable
  // (no `"activeForm":null` noise polluting prompt-cache hits).
  const dto: TodoListItemDTO = {
    id: item.id,
    subject: item.subject,
    status: item.status,
    ...(item.description ? { description: item.description } : {}),
    ...(item.activeForm ? { activeForm: item.activeForm } : {}),
    ...(item.note ? { note: item.note } : {}),
  };
  return dto;
}

function jsonResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export async function toolTodoList(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (Object.hasOwn(input, 'id')) {
    return toolTodoGet(input, ctx);
  }

  if (!ctx.todoStore) {
    return jsonResult({
      ok: false,
      code: 'todo_unavailable',
      reason:
        'todo_list is not active in this run (no plan list infrastructure ' +
        'is wired). Either no managed task is active, or the runtime did ' +
        'not provide a todo store. You may continue working without ' +
        'querying the plan list.',
    });
  }

  const items = ctx.todoStore.getAll().map(toDTO);
  return jsonResult({
    ok: true,
    count: items.length,
    items,
  });
}
