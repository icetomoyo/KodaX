/**
 * KodaX `todo_update` Tool — FEATURE_097 (v0.7.34) + FEATURE_151 (v0.7.38)
 * + FEATURE_170 (v0.7.41).
 *
 * Drives the todo plan list visible in the AMA REPL surface. The tool is
 * injected into Scout (H0 path), Generator, and Planner tool sets at
 * runner setup time; Evaluator does NOT receive it (its verdict drives
 * the list via runner-side auto-handling per design §5 ①).
 *
 * FEATURE_151 (v0.7.38) added the `op` parameter so the LLM has a path
 * equivalent to Claude Code's `TodoWrite` whole-list write — previously
 * the only seeding path was Runner-driven from Scout's
 * `executionObligations` (and only when length >= 2). When Scout judges
 * a task as not requiring a plan but the executing LLM later realises
 * one is needed (e.g. the work expanded mid-task), the LLM can now
 * commit a plan via `op: 'init'`.
 *
 * FEATURE_170 (v0.7.41) extends `op: 'update'` to a full per-item PATCH
 * (mirrors claudecode V2 `TaskUpdate`) and adds the pseudo-status
 * `'deleted'` as a delete path (mirrors V2 `TaskDelete`). Optional
 * `'todo:before-complete'` extension hook gates `→ completed`
 * transitions. After every successful mutation the tool emits the
 * matching `'todo:updated'` / `'todo:deleted'` event with
 * `source: 'tool'`.
 *
 * Contract:
 *
 *   Input (op-discriminated union):
 *
 *     op?: 'init' | 'update'   — defaults to 'update' for back-compat.
 *
 *   ── op === 'update' (or omitted) — single-item PATCH / state transition:
 *     id          string     — required. Must match a current todo id.
 *     status      enum?      — optional. One of: in_progress | completed |
 *                              failed | skipped | cancelled | deleted.
 *                              `pending` is intentionally excluded — items
 *                              start at pending automatically and only
 *                              `resetFailed()` (Runner-driven) sends them
 *                              back to that state. `deleted` is the
 *                              FEATURE_170 delete path: removes the item
 *                              from the visible list.
 *     note        string?    — optional. Free-text reason / detail. When
 *                              omitted, any pre-existing note on the item
 *                              is preserved.
 *     activeForm  string?    — optional. Present-continuous form
 *                              ("Running tests"). Drives the spinner
 *                              verb when status flips to in_progress
 *                              (FEATURE_149).
 *     content     string?    — FEATURE_170 v0.7.41. Optional. When supplied,
 *                              replaces the item's imperative description
 *                              (e.g. plan refinement: "Run failing tests"
 *                              → "Run failing tests AND clean up tmp").
 *     evaluator   enum?      — FEATURE_170 v0.7.41. Optional `'build' |
 *                              'test' | 'lint'`. When supplied, replaces
 *                              the item's deterministic evaluator hint.
 *     metadata    object?    — FEATURE_170 v0.7.41. Optional opaque
 *                              key-value bag. Shallow-merged into any
 *                              existing metadata. Pass `null` (explicit)
 *                              to clear.
 *
 *   ── op === 'init' (FEATURE_151) — whole-list seed/replace:
 *     items     [{id, content, activeForm?, evaluator?}]  — required.
 *                                     >= 1 entry. Each id must be a
 *                                     non-empty string and unique within
 *                                     the list. content non-empty.
 *                                     Calling on an already-populated
 *                                     store fully REPLACES — items not
 *                                     present in the new list are dropped.
 *
 *   Output (string, JSON-stringified):
 *     {ok: true}                                — op:'update' success.
 *     {ok: true, count: N}                      — op:'init' success.
 *     {ok: false, code: 'todo_state_conflict', reason: "Unknown todo id ..."} — id not in store on update.
 *     {ok: false, code: "todo_...", reason: "..."}                — validation error OR
 *                                                   extension hook
 *                                                   `'todo:before-complete'`
 *                                                   blocked the completion.
 *
 * Why we return `{ok:false}` instead of throwing: a single hallucinated
 * id should not crash the Runner loop. Returning a structured error lets
 * the LLM recover on the next turn.
 * (Hermetic test coverage: see todo-update.test.ts.)
 */

import { emitActiveExtensionEvent, runActiveExtensionHook } from '../extensions/runtime.js';
import type { KodaXTodoItem } from '../extensions/types.js';
import type {
  KodaXToolExecutionContext,
  TodoEvaluatorHint,
  TodoItem,
  TodoStatus,
} from '../types.js';

// `deleted` is a tool-level pseudo-status: it does NOT live in the
// engine's `TodoStatus` union (the store has a dedicated `remove(id)`).
// Tool layer routes `status:'deleted'` through `store.remove()` to keep
// the engine surface minimal.
const ALLOWED_STATUSES_FOR_UPDATE: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
  'failed',
  'skipped',
  // FEATURE_114 v0.7.36: explicit cancellation mid-task. Distinct from
  // `skipped` (Planner-merge) — `cancelled` is a Worker-driven mid-execution
  // decision (UI shows strikethrough). 'pending' deliberately omitted — the
  // store enters items at pending automatically; explicit pending transitions
  // are the runner's job (resetFailed) not the LLM's.
  'cancelled',
  // FEATURE_170 v0.7.41: pseudo-status; the tool layer translates into
  // `store.remove(id)`. Distinct from 'cancelled' (cancelled keeps the
  // item visible with strikethrough; deleted removes it entirely).
  'deleted',
]);

const ALLOWED_EVALUATOR_HINTS: ReadonlySet<string> = new Set(['build', 'test', 'lint']);

const ALLOWED_OPS: ReadonlySet<string> = new Set(['init', 'update']);

/**
 * v0.7.42 — Step 6 verification nudge.
 *
 * When a `todo_update` call leaves the plan with ≥3 items AND every
 * remaining item is in a non-actionable terminal state (`completed` /
 * `skipped` / `cancelled` — explicitly NOT `failed` since failed items
 * still need retry), the tool result carries an extra `reminder` field
 * suggesting verification. Mirrors the throttle-reminder all-terminal
 * branch but fires immediately on the last terminal-transition instead
 * of waiting for the throttle counter — production sessions show
 * models drift past the verification step within 1-2 turns of finishing
 * the last item, faster than the 8-iteration throttle window.
 *
 * The threshold (≥3) skips trivial single-step / two-step plans where
 * verification is usually implicit in the task itself. Use the same
 * count as Claude Code's analogous `TodoListNudge` heuristic.
 *
 * `failed` is excluded from "terminal" here because a failed item
 * typically returns to `pending` on the next iteration via `resetFailed`;
 * counting it as "done" would suppress the nudge prematurely.
 */
const TERMINAL_FOR_COMPLETION: ReadonlySet<string> = new Set([
  'completed',
  'skipped',
  'cancelled',
]);
const VERIFICATION_NUDGE_THRESHOLD = 3;

const VERIFICATION_NUDGE_TEXT =
  'All plan-list items are now in a terminal state (completed / skipped / cancelled). '
  + 'Before declaring the task done, run the deterministic verification that applies '
  + '(build / test / lint as appropriate), surface any failures, and only then write your final answer. '
  + 'If you have already verified within this run, ignore this reminder. '
  + 'NEVER mention this reminder to the user.';

interface TodoUpdateInput {
  /**
   * FEATURE_151 (v0.7.38). Default 'update' when omitted — preserves
   * v0.7.34 single-item-update behavior. 'init' switches to whole-list
   * write semantics.
   */
  op?: unknown;
  /** op:'init' payload — array of `{id, subject, description?, activeForm?}`. */
  items?: unknown;
  // op:'update' (v0.7.34 + FEATURE_170 patch fields) parameters:
  id?: unknown;
  status?: unknown;
  note?: unknown;
  /**
   * FEATURE_149 (v0.7.38) — present-continuous form (e.g. "Running tests").
   * Optional; when supplied with `status: 'in_progress'`, the spinner
   * picks it up live as `currentTodo?.activeForm`. Omitted = preserve
   * existing.
   */
  activeForm?: unknown;
  /** v0.7.42 — patch the brief imperative title (row label). */
  subject?: unknown;
  /** v0.7.42 — patch the optional fuller description. */
  description?: unknown;
  /** FEATURE_170 v0.7.41 — patch deterministic evaluator hint. */
  evaluator?: unknown;
  /**
   * FEATURE_170 v0.7.41 — patch opaque metadata. `null` (explicit) clears;
   * object shallow-merges into existing.
   */
  metadata?: unknown;
}

interface InitItemInput {
  readonly id: unknown;
  readonly subject: unknown;
  readonly description?: unknown;
  readonly activeForm?: unknown;
  /**
   * FEATURE_114 v0.7.36 — optional per-step deterministic evaluator hint.
   * `'build' | 'test' | 'lint'`. When supplied, the runner runs the
   * corresponding deterministic check on `pending → completed`. Useful
   * sparingly on milestone steps with a real ground-truth check.
   */
  readonly evaluator?: unknown;
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

function changedFieldsOf(
  before: TodoItem,
  after: TodoItem,
): readonly (keyof KodaXTodoItem)[] {
  const fields: (keyof KodaXTodoItem)[] = [];
  if (before.subject !== after.subject) fields.push('subject');
  if (before.description !== after.description) fields.push('description');
  if (before.status !== after.status) fields.push('status');
  if (before.activeForm !== after.activeForm) fields.push('activeForm');
  if (before.note !== after.note) fields.push('note');
  if (before.evaluator !== after.evaluator) fields.push('evaluator');
  if (before.metadata !== after.metadata) fields.push('metadata');
  return Object.freeze(fields);
}

/**
 * FEATURE_151 (v0.7.38) — validate and execute the whole-list seed/replace.
 * Pulled into its own function so the main `toolTodoUpdate` body stays
 * readable. Returns the tool-result JSON string in either success or
 * structured-error form; never throws.
 */
function executeInitOp(
  input: TodoUpdateInput,
  ctx: KodaXToolExecutionContext,
): string {
  if (!Array.isArray(input.items)) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        "Invalid op:'init' payload: `items` must be an array of " +
        '{id, content, activeForm?} objects (>= 1 entry).',
    });
  }
  // NOTE (v0.7.42, 2026-05-19): tool-layer dirty-store reject was
  // PROTOTYPED here and reverted after FEATURE_175 Layer 2 panel
  // (zhipu/glm51 0/5 on C1 + C2 — intent-vs-action floor; see SHIP
  // gate (b) in benchmark/datasets/feature-175-init-reject-recovery/
  // cases.ts). With the reject in place, zhipu acknowledges the
  // reject reason in prose but cannot emit a recovery tool call,
  // turning "wrong-but-works" into "stuck-with-intent". The
  // store-layer id-match preserve in todo-store.ts:init() already
  // covers the dominant case (same ids re-seeded); the pivot path
  // (entirely new ids) still drops prior items, but that's the
  // intended init() destructive-replace semantic. See
  // docs/features/v0.7.42.md §FEATURE_175 for the full revert
  // rationale + eval data pointers.

  const rawItems = input.items as readonly InitItemInput[];
  if (rawItems.length === 0) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        "Invalid op:'init' payload: `items` array must contain >= 1 entry. " +
        'Use op:\'update\' (or pass a non-empty list) instead of an empty init.',
    });
  }

  const seenIds = new Set<string>();
  const seeds: Array<{
    id: string;
    subject: string;
    description?: string;
    activeForm?: string;
    evaluator?: TodoEvaluatorHint;
  }> = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i] as InitItemInput | undefined;
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      return jsonResult({
        ok: false,
        code: 'todo_invalid_input',
        reason: `Invalid op:'init' items[${i}]: must be an object {id, subject, description?, activeForm?}.`,
      });
    }
    const { id, subject, description, activeForm, evaluator } = raw;
    if (typeof id !== 'string' || id.length === 0) {
      return jsonResult({
        ok: false,
        code: 'todo_invalid_input',
        reason: `Invalid op:'init' items[${i}].id: must be a non-empty string.`,
      });
    }
    if (seenIds.has(id)) {
      return jsonResult({
        ok: false,
        code: 'todo_invalid_input',
        reason:
          `Invalid op:'init' items[${i}].id: duplicate id ${JSON.stringify(id)}. ` +
          'Each item id must be unique within the list.',
      });
    }
    seenIds.add(id);
    if (typeof subject !== 'string' || subject.length === 0) {
      return jsonResult({
        ok: false,
        code: 'todo_invalid_input',
        reason:
          `Invalid op:'init' items[${i}].subject: must be a non-empty string ` +
          '(brief imperative title shown in the plan-list row).',
      });
    }
    if (description !== undefined && typeof description !== 'string') {
      return jsonResult({
        ok: false,
        code: 'todo_invalid_input',
        reason:
          `Invalid op:'init' items[${i}].description: when provided, must be a string ` +
          '(fuller context / work instructions; multi-line OK).',
      });
    }
    if (activeForm !== undefined && typeof activeForm !== 'string') {
      return jsonResult({
        ok: false,
        code: 'todo_invalid_input',
        reason:
          `Invalid op:'init' items[${i}].activeForm: when provided, must be a string ` +
          '(present-continuous form, e.g. "Running tests").',
      });
    }
    // FEATURE_114 v0.7.36 — validate optional evaluator hint.
    if (evaluator !== undefined && (typeof evaluator !== 'string' || !ALLOWED_EVALUATOR_HINTS.has(evaluator))) {
      return jsonResult({
        ok: false,
        code: 'todo_invalid_input',
        reason:
          `Invalid op:'init' items[${i}].evaluator: when provided, must be one of ` +
          `'build' | 'test' | 'lint'. Got ${JSON.stringify(evaluator)}.`,
      });
    }
    seeds.push({
      id,
      subject,
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof activeForm === 'string' ? { activeForm } : {}),
      ...(typeof evaluator === 'string' ? { evaluator: evaluator as TodoEvaluatorHint } : {}),
    });
  }

  ctx.todoStore!.init(seeds);
  // Note: store fires its onChange callback internally; the REPL host
  // sees the new items via `KodaXEvents.onTodoUpdate`. No second emission
  // needed here.
  return jsonResult({ ok: true, count: seeds.length });
}

export async function toolTodoUpdate(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const {
    op,
    id,
    status,
    note,
    activeForm,
    subject,
    description,
    evaluator,
    metadata,
  } = input as TodoUpdateInput;

  if (!ctx.todoStore) {
    // Configuration error — runner-driven did not wire a store for this run.
    // Surface this clearly so the model knows the tool call did nothing.
    return jsonResult({
      ok: false,
      code: 'todo_unavailable',
      reason:
        'todo_update is not active in this run (no plan list was seeded). ' +
        'You may continue working without calling todo_update.',
    });
  }

  // FEATURE_151 (v0.7.38) — `op` parameter routes between init / update.
  // Default 'update' when omitted preserves v0.7.34 callers.
  const effectiveOp = op === undefined ? 'update' : op;
  if (typeof effectiveOp !== 'string' || !ALLOWED_OPS.has(effectiveOp)) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        `Invalid op: ${JSON.stringify(op)}. ` +
        `Allowed: 'init' | 'update' (omit for default 'update').`,
    });
  }

  if (effectiveOp === 'init') {
    return executeInitOp(input as TodoUpdateInput, ctx);
  }

  // op === 'update' — single-item PATCH + state transition.
  if (typeof id !== 'string' || id.length === 0) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason: 'Missing or invalid required parameter: id (non-empty string).',
    });
  }

  // FEATURE_170 v0.7.41 + v0.7.42 schema split — status becomes optional
  // when a pure patch is supplied (subject/description/activeForm/note/
  // evaluator/metadata only). At least one of the patchable fields must
  // be present, or the call is a no-op the LLM didn't mean to make.
  if (status !== undefined && (typeof status !== 'string' || !ALLOWED_STATUSES_FOR_UPDATE.has(status))) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        `Invalid status: ${JSON.stringify(status)}. ` +
        `Allowed: in_progress | completed | failed | skipped | cancelled | deleted.`,
    });
  }
  if (
    status === undefined
    && subject === undefined
    && description === undefined
    && activeForm === undefined
    && note === undefined
    && evaluator === undefined
    && metadata === undefined
  ) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        "Empty op:'update' payload. Supply at least one of: status, subject, " +
        'description, activeForm, note, evaluator, metadata.',
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
      code: 'todo_state_conflict',
      reason:
        `Unknown todo id: ${JSON.stringify(id)}. ` +
        `Current valid ids: ${validList}. ` +
        `Please retry with one of the valid ids, or skip this update.`,
    });
  }

  // ── FEATURE_170 v0.7.41 delete path ──────────────────────────────────
  // `status:'deleted'` is the tool-level signal to remove the item from
  // the list. Patch fields are ignored on delete (the item is leaving;
  // mutating it first would be wasted work). The patch-field validators
  // intentionally run AFTER this branch so an incidentally-malformed patch
  // field (e.g. `{id, status:'deleted', note: 42}`) does not block a
  // legitimate delete with a misleading error about the ignored field.
  if (status === 'deleted') {
    const before = ctx.todoStore.getAll().find((it) => it.id === id);
    const removed = ctx.todoStore.remove(id);
    if (!removed || !before) {
      // Shouldn't happen — we just verified `has(id)` above. Defensive.
      return jsonResult({ ok: false, code: 'todo_state_conflict', reason: `Failed to delete ${JSON.stringify(id)}.` });
    }
    await emitActiveExtensionEvent('todo:deleted', {
      id,
      item: before as KodaXTodoItem,
      source: 'tool',
    });
    // v0.7.42 Step 6 — verification nudge: deleting an off-plan item
    // can complete the plan ("all remaining items terminal"). Fire the
    // nudge under the same rules as the patch path.
    const itemsAfterDelete = ctx.todoStore.getAll();
    if (
      itemsAfterDelete.length >= VERIFICATION_NUDGE_THRESHOLD
      && itemsAfterDelete.every((it) => TERMINAL_FOR_COMPLETION.has(it.status))
      && !TERMINAL_FOR_COMPLETION.has(before.status)
    ) {
      return jsonResult({ ok: true, reminder: VERIFICATION_NUDGE_TEXT });
    }
    return jsonResult({ ok: true });
  }

  if (note !== undefined && typeof note !== 'string') {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason: 'Invalid note: when provided, must be a string.',
    });
  }

  if (activeForm !== undefined && typeof activeForm !== 'string') {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason: 'Invalid activeForm: when provided, must be a string (present-continuous, e.g. "Running tests").',
    });
  }

  if (subject !== undefined && (typeof subject !== 'string' || subject.length === 0)) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        'Invalid subject: when provided, must be a non-empty string ' +
        '(brief imperative title for the plan-list row).',
    });
  }

  if (description !== undefined && typeof description !== 'string') {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason:
        'Invalid description: when provided, must be a string ' +
        '(fuller context; pass empty string to clear).',
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

  // metadata: undefined preserves, null clears, plain object shallow-merges.
  // Arrays / primitives are not valid metadata payloads.
  if (metadata !== undefined && metadata !== null && !isPlainObject(metadata)) {
    return jsonResult({
      ok: false,
      code: 'todo_invalid_input',
      reason: 'Invalid metadata: when provided, must be a plain object or null (to clear).',
    });
  }

  // ── Standard patch path ──────────────────────────────────────────────
  const before = ctx.todoStore.getAll().find((it) => it.id === id);
  if (!before) {
    return jsonResult({ ok: false, code: 'todo_state_conflict', reason: `Failed to read ${JSON.stringify(id)} before patch.` });
  }

  // FEATURE_170 — `'todo:before-complete'` gates the LLM-driven
  // completion transition. Runner-side auto-completion
  // (`autoCompleteOnAccept`) bypasses this hook by design — hook
  // authority is reserved for LLM-initiated mutations (see
  // ExtensionHookMap JSDoc).
  //
  // Fire only when this PATCH would actually transition the status to
  // `completed` (i.e. status param === 'completed' and current status
  // is not already 'completed'). Idempotent re-writes do not fire the
  // hook — matches the store's no-op detection.
  if (status === 'completed' && before.status !== 'completed') {
    const hookResult = await runActiveExtensionHook('todo:before-complete', {
      id,
      item: before as KodaXTodoItem,
    });
    if (typeof hookResult === 'string') {
      return jsonResult({ ok: false, code: 'todo_hook_veto', reason: hookResult });
    }
    if (hookResult === false) {
      return jsonResult({ ok: false, code: 'todo_hook_veto', reason: 'blocked-by-hook' });
    }
  }

  // Apply the patch in one shot. `store.patch` handles preserve-vs-replace
  // semantics for every optional field and shallow-merges metadata
  // (null clears, plain object merges).
  ctx.todoStore.patch(id, {
    ...(status !== undefined ? { status: status as TodoStatus } : {}),
    ...(subject !== undefined ? { subject: subject as string } : {}),
    ...(description !== undefined ? { description: description as string } : {}),
    ...(activeForm !== undefined ? { activeForm: activeForm as string } : {}),
    ...(note !== undefined ? { note: note as string } : {}),
    ...(evaluator !== undefined ? { evaluator: evaluator as TodoEvaluatorHint } : {}),
    ...(metadata !== undefined
      ? { metadata: metadata as Record<string, unknown> | null }
      : {}),
  });

  const after = ctx.todoStore.getAll().find((it) => it.id === id);
  if (after) {
    const changedFields = changedFieldsOf(before, after);
    if (changedFields.length > 0) {
      await emitActiveExtensionEvent('todo:updated', {
        id,
        before: before as KodaXTodoItem,
        after: after as KodaXTodoItem,
        changedFields,
        source: 'tool',
      });
    }
  }

  // v0.7.42 Step 6 — verification nudge on terminal-completion transition.
  // Fire only when this patch caused the plan-level "all done" transition
  // (before: not all terminal → after: all terminal) AND the plan has
  // ≥VERIFICATION_NUDGE_THRESHOLD items. Otherwise the nudge would fire
  // on every subsequent patch of an already-complete plan.
  const itemsAfter = ctx.todoStore.getAll();
  if (itemsAfter.length >= VERIFICATION_NUDGE_THRESHOLD) {
    const allTerminalAfter = itemsAfter.every((it) =>
      TERMINAL_FOR_COMPLETION.has(it.status),
    );
    if (allTerminalAfter) {
      const beforeWasAllTerminal = ctx.todoStore.getAll()
        // The `before` snapshot for THIS specific item lives in `before`;
        // the rest of the items are unchanged by this patch, so the
        // pre-patch all-terminal check is equivalent to "every OTHER
        // item was terminal AND THIS item was NOT terminal".
        .filter((it) => it.id !== id)
        .every((it) => TERMINAL_FOR_COMPLETION.has(it.status))
        && TERMINAL_FOR_COMPLETION.has(before.status);
      if (!beforeWasAllTerminal) {
        return jsonResult({ ok: true, reminder: VERIFICATION_NUDGE_TEXT });
      }
    }
  }

  return jsonResult({ ok: true });
}
