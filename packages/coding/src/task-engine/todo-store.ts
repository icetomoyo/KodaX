/**
 * Todo Store — FEATURE_097 (v0.7.34).
 *
 * In-memory store for the Scout-seeded todo list. Lives within the scope
 * of one `runManagedTaskViaRunner` call; not shared across tasks, not
 * persisted across sessions (per design-doc §5 决策细节 ④ task-scoped
 * resume behavior).
 *
 * KodaX is a single-process CLI — no fs.watch, no proper-lockfile,
 * none of the Claude Code V2 swarm-multiprocess machinery. The store
 * is a plain object hidden behind a small interface.
 *
 * State transitions (Evaluator verdict handling per §5 ①):
 *   - `accept` verdict   → all `pending` AND `in_progress` items auto-flip to
 *                          `completed`. Including `in_progress` is intentional:
 *                          Evaluator only accepts when the work is done, so any
 *                          item the model forgot to close via `todo_update` is
 *                          finalized automatically. The design doc says
 *                          "remaining pending" which abbreviates "any
 *                          non-terminal state".
 *   - `revise` verdict   → all current `in_progress` auto-flip to `failed`
 *                          (with note); the next iteration's `resetFailed()`
 *                          flips them back to `pending` so Generator retries
 *   - `replan` verdict   → caller invokes `reset()` then Planner repopulates
 *                          via `replace(...)`
 */

import type { TodoEvaluatorHint, TodoItem, TodoList, TodoStatus } from '../types.js';

export interface TodoInit {
  readonly id: string;
  /** v0.7.42 — see TodoItem.subject JSDoc. */
  readonly subject: string;
  readonly description?: string;
  readonly owner?: string;
  readonly sourceObligationIndex?: number;
  /**
   * FEATURE_149 (v0.7.38) — present-continuous form for spinner display
   * while this item is `in_progress`. See `TodoItem.activeForm` JSDoc.
   */
  readonly activeForm?: string;
  /**
   * FEATURE_114 v0.7.36 — per-step deterministic evaluator hint. When
   * present, the runner runs the corresponding deterministic check
   * (build / test / lint) on `pending → completed`. Failure surfaces
   * stderr in the next tool result so the Worker can self-correct.
   * See `TodoItem.evaluator` JSDoc.
   */
  readonly evaluator?: TodoEvaluatorHint;
  /**
   * FEATURE_170 v0.7.41 — opaque per-task metadata bag. Carried through
   * `init()` so a fan-out plan-first seed can also pre-attach metadata.
   * See `TodoItem.metadata` JSDoc.
   */
  readonly metadata?: Record<string, unknown>;
}

/**
 * FEATURE_170 v0.7.41 — input shape for `add()`. No `id` (auto-generated
 * by the store). Status defaults to `pending`; work starting now may use `in_progress`.
 *
 * v0.7.42 — `content` renamed to `subject` + optional `description`.
 */
export interface TodoAddSeed {
  readonly subject: string;
  readonly status?: 'pending' | 'in_progress';
  readonly description?: string;
  readonly activeForm?: string;
  readonly evaluator?: TodoEvaluatorHint;
  readonly owner?: string;
  readonly sourceObligationIndex?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * FEATURE_170 v0.7.41 — input shape for `patch()`. Every field optional;
 * only those present in the patch object are applied.
 *
 * Metadata patch semantics (mirrors React setState mental model):
 *   - `metadata: undefined` (omitted) → preserve existing metadata as-is.
 *   - `metadata: null` (explicit)     → CLEAR all metadata.
 *   - `metadata: {key: value}`        → shallow-merge `key=value` into
 *                                       existing metadata.
 *   - `metadata: {key: null}`         → v0.7.42 — DELETE that key from
 *                                       existing metadata. Other existing
 *                                       keys not mentioned in the patch
 *                                       are preserved. If all keys end up
 *                                       removed, the metadata field is
 *                                       set back to `undefined` so the
 *                                       JSON envelope stays compact.
 *   - Mixed (`{keyA: null, keyB: v}`) → deletes keyA, sets keyB. Useful
 *                                       for atomic "rename a flag" patches.
 *
 * `owner` and `sourceObligationIndex` are intentionally NOT patchable
 * post-creation — they identify provenance (which child-Actor
 * branch / which Scout obligation produced the item) and must stay
 * stable for downstream consumers. Pass them via `add()` or `init()`
 * seed and treat them as immutable thereafter.
 */
export interface TodoPatch {
  /** v0.7.42 — `content` renamed; patch the row label. */
  readonly subject?: string;
  /** v0.7.42 — patch the optional fuller description. Empty string clears. */
  readonly description?: string;
  readonly activeForm?: string;
  readonly status?: TodoStatus;
  readonly note?: string;
  readonly evaluator?: TodoEvaluatorHint;
  /**
   * Opaque metadata patch. See type-level JSDoc for the four semantics
   * (preserve / clear-all / merge / per-key-delete). Individual values
   * inside the object MAY be `null` (v0.7.42 — interpreted as "delete
   * this key from existing metadata").
   */
  readonly metadata?: Record<string, unknown> | null;
}

export interface TodoStoreOptions {
  /**
   * Fired whenever the store's contents actually change. Wire this to
   * `KodaXEvents.onTodoUpdate` at runner-driven setup time so callers
   * (the `todo_update` tool, Evaluator verdict auto-handlers) do not
   * each have to remember to emit the event after every mutation.
   *
   * No-op writes (unknown id on updateStatus, 0-change auto-fills,
   * reset() on an empty store) do NOT fire onChange — only real
   * state transitions surface to subscribers.
   */
  readonly onChange?: (items: TodoList) => void;
}

export interface TodoStore {
  /** True when the store has at least one item. */
  hasItems(): boolean;
  /** True when the given id corresponds to an existing item. */
  has(id: string): boolean;
  /** Stable list of all valid ids in insertion order. Useful for unknown-id error reasons. */
  allIds(): readonly string[];
  /** Snapshot of all items (frozen, safe to pass to event handlers). */
  getAll(): TodoList;
  /** Replace the store's contents with a fresh seed list. */
  init(seeds: readonly TodoInit[]): void;
  /**
   * Update one item's status. When `note` is supplied, replaces the item's
   * existing note; when omitted (undefined), preserves any existing note.
   * Use `resetFailed()` (or pass an explicit empty-string note) to clear.
   * No-op for unknown id.
   *
   * FEATURE_149 (v0.7.38): when `activeForm` is supplied, replaces the
   * item's `activeForm` field (used by the spinner). Omitted = preserve
   * existing. Empty string = clear. Same preserve-vs-clear semantics as
   * `note`.
   */
  updateStatus(id: string, status: TodoStatus, note?: string, activeForm?: string): boolean;
  /**
   * FEATURE_170 v0.7.41 — insert a new item with a store-generated
   * id. Returns the new id. Counter is monotonic across the lifetime of
   * the store (does NOT reuse ids of items deleted via `remove()`).
   * Status defaults to `pending`; creation cannot mark work completed.
   */
  add(seed: TodoAddSeed): string;
  /**
   * FEATURE_170 v0.7.41 — apply a partial update. Every key in `patch` is
   * optional; only the ones present are applied. `metadata` is shallow-
   * merged; an explicit `metadata: null` clears it. Returns true iff the
   * id existed (even if patch caused no real diff — same return semantics
   * as `updateStatus`).
   */
  patch(id: string, patch: TodoPatch): boolean;
  /**
   * FEATURE_170 v0.7.41 — drop one item. Returns true iff it existed.
   * Does NOT reuse the id (monotonic counter, see `add()`).
   */
  remove(id: string): boolean;
  /** Planner H2 path: full-replace the list (used after the planner refines obligations). */
  replace(items: readonly TodoItem[]): void;
  /**
   * Auto-fill Evaluator `accept` verdict: every `pending` AND `in_progress`
   * item flips to `completed`. Items already in a terminal state
   * (`completed` / `failed` / `skipped`) are left as-is. Returns the number
   * of items that actually changed. Calling on an empty store returns 0.
   */
  autoCompleteOnAccept(): number;
  /**
   * Auto-fill Evaluator `revise` verdict: every `in_progress` item flips
   * to `failed` (with the supplied reviewer note). Returns the number
   * that actually changed.
   */
  markInProgressFailed(note: string): number;
  /**
   * Reset every `failed` item back to `pending`. Called at the start of
   * the next Generator iteration so the model retries them.
   */
  resetFailed(): number;
  /** Drop everything. Called on `replan` verdict and at task end. */
  reset(): void;
}

export function createTodoStore(options: TodoStoreOptions = {}): TodoStore {
  // The internal array is mutable; consumers see frozen snapshots only.
  let items: TodoItem[] = [];
  const onChange = options.onChange;
  // FEATURE_170 v0.7.41 — monotonic id counter for `add()`. Bumped past
  // the highest `^todo_(\d+)$` suffix among the most recent `init()`
  // seeds (or 0 when seeds contain no recognizable numeric suffix).
  // Never decreases; `remove()` does NOT reuse ids.
  let idCounter = 0;

  function freeze(arr: readonly TodoItem[]): TodoList {
    return Object.freeze(arr.slice()) as TodoList;
  }

  function notifyIfChanged(changed: boolean): void {
    if (changed && onChange) onChange(freeze(items));
  }

  function recomputeCounterFromSeeds(seeds: readonly { readonly id: string }[]): void {
    // Initialize from seeds: highest `^todo_(\d+)$` numeric suffix, or 0
    // when none match (custom non-numeric ids are tolerated). Per
    // design spec, the counter is monotonic — re-running init() with
    // smaller ids cannot regress it.
    let highest = 0;
    for (const s of seeds) {
      const m = /^todo_(\d+)$/.exec(s.id);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > highest) highest = n;
      }
    }
    if (highest > idCounter) idCounter = highest;
  }

  return {
    hasItems(): boolean {
      return items.length > 0;
    },
    has(id: string): boolean {
      return items.some((it) => it.id === id);
    },
    allIds(): readonly string[] {
      return Object.freeze(items.map((it) => it.id));
    },
    getAll(): TodoList {
      return freeze(items);
    },
    init(seeds): void {
      // v0.7.42 — id-match status preservation. Mid-task re-init
      // (Worker calls `todo_update({op:'init'})` to refine scope) used to
      // wipe every item back to `pending`, including ids that matched a
      // previously `completed` / `skipped` / `cancelled` / `in_progress`
      // item. UI then showed `0/N completed` even when prior work was
      // actually done, and the active item lost its `●` accent while the
      // model kept executing it (spinner verb vanished). Both invited
      // redundant execution or confused the user about progress.
      //
      // Preservation rules:
      //   - Seed id matches existing item AND existing status is
      //     `completed` | `skipped` | `cancelled` → KEEP that status.
      //     The `note` is preserved alongside (e.g. cancelled reason).
      //   - Seed id matches existing item AND existing status is
      //     `in_progress` → KEEP `in_progress`. Re-seeding does not
      //     imply "stop working on it"; if the model wanted to demote
      //     it would have emitted `op:'patch'` to mark completed /
      //     cancelled first. Defaulting to RESET loses execution
      //     intent and surfaces the UX bug above. Note: `activeForm`
      //     is NOT preserved alongside status — the seed value wins
      //     (a re-emit may legitimately rephrase the spinner verb),
      //     and an undefined seed `activeForm` falls through to
      //     `subject` in the REPL spinner fallback chain.
      //   - Seed id matches existing item AND existing status is
      //     `failed` → reset to `pending` and DROP the stale failure
      //     note. Rationale: a `failed` item carries a Worker note
      //     ("missing dep X"); re-seeding implicitly retries with a
      //     clean slate, and a pending row carrying that note would
      //     mislead the throttle-reminder and next-turn context.
      //   - Seed id matches existing item AND existing status is
      //     `pending` → stays `pending` (no-op transition, but flows
      //     through the same branch for uniformity).
      //   - Seed id has no match in existing items → enter as `pending`
      //     (new item).
      //   - Existing items whose ids are NOT in the seed list are
      //     dropped (init() is still a destructive replace for the
      //     LIST shape; only per-id statuses survive).
      //
      // `reset()` remains the explicit "wipe everything" path for true
      // start-over scenarios (Evaluator replan verdict → store.reset()
      // → next contract slot re-seeds). Behavior of `reset()` is
      // unchanged.
      const prevById = new Map<string, TodoItem>(items.map((it) => [it.id, it]));
      items = seeds.map((seed) => {
        const prev = prevById.get(seed.id);
        const preserveStatus =
          prev !== undefined
          && (
            prev.status === 'completed'
            || prev.status === 'skipped'
            || prev.status === 'cancelled'
            || prev.status === 'in_progress'
          );
        return {
          id: seed.id,
          subject: seed.subject,
          description: seed.description,
          status: preserveStatus ? prev.status : ('pending' as TodoStatus),
          // Preserve the note alongside the status (e.g. `cancelled`
          // items often carry a Worker-supplied reason that the user
          // should keep seeing across a refine-the-plan call). When
          // status is reset to `pending` (i.e. the prior status was
          // `failed`), the note is cleared — a pending item with a
          // stale `failed` note would mislead.
          ...(preserveStatus && prev.note !== undefined ? { note: prev.note } : {}),
          owner: seed.owner,
          sourceObligationIndex: seed.sourceObligationIndex,
          activeForm: seed.activeForm,
          // FEATURE_114 v0.7.36 — carry the optional evaluator hint from
          // seed to TodoItem. Slice 3 will wire `runDeterministicEvaluator`
          // to consume this on `pending → completed`.
          evaluator: seed.evaluator,
          // FEATURE_170 v0.7.41 — opaque metadata carried verbatim from seed.
          metadata: seed.metadata,
        };
      });
      recomputeCounterFromSeeds(seeds);
      // init always notifies — even an empty seed list represents an
      // intentional "the task is starting, here is the (empty) plan" event.
      notifyIfChanged(true);
    },
    updateStatus(id, status, note, activeForm): boolean {
      const idx = items.findIndex((it) => it.id === id);
      if (idx < 0) return false;
      const prev = items[idx]!;
      // Always replace the slot rather than mutate the existing object —
      // immutability is part of the contract: snapshots already handed to
      // event subscribers must not appear to change. When `note` is omitted
      // we preserve `prev.note` rather than erasing it; this matters when a
      // `failed` item carrying an Evaluator note is later re-tried by the
      // Generator via `updateStatus(id, 'in_progress')` with no note arg —
      // the previous failure context should remain attached to the item.
      // FEATURE_149 (v0.7.38): same preserve-vs-replace semantics for
      // `activeForm` — omitted preserves existing, supplied replaces.
      let next: TodoItem = { ...prev, status };
      if (note !== undefined) next = { ...next, note };
      if (activeForm !== undefined) next = { ...next, activeForm };
      // Honour the onChange "no-op writes do NOT fire" contract: when
      // status AND note AND activeForm are all unchanged this call is
      // semantically a no-op (e.g., the LLM emitted
      // `todo_update({id, status:'in_progress'})` a second time after the
      // first one already flipped it). Skip the notification to avoid
      // wasted React renders. We still return `true` because the id was
      // found — the tool-level contract reports success.
      if (
        next.status === prev.status
        && next.note === prev.note
        && next.activeForm === prev.activeForm
      ) {
        return true;
      }
      items = items.map((it, i) => (i === idx ? next : it));
      notifyIfChanged(true);
      return true;
    },
    add(seed): string {
      idCounter += 1;
      const id = `todo_${idCounter}`;
      const item: TodoItem = {
        id,
        subject: seed.subject,
        description: seed.description,
        status: seed.status === 'in_progress' ? 'in_progress' : 'pending',
        owner: seed.owner,
        sourceObligationIndex: seed.sourceObligationIndex,
        activeForm: seed.activeForm,
        evaluator: seed.evaluator,
        metadata: seed.metadata,
      };
      items = [...items, item];
      notifyIfChanged(true);
      return id;
    },
    patch(id, partial): boolean {
      const idx = items.findIndex((it) => it.id === id);
      if (idx < 0) return false;
      const prev = items[idx]!;
      // Build next item from the partial, omitting undefined keys so that
      // "field not specified" preserves the prior value (matches the
      // updateStatus preserve-vs-replace semantics already documented).
      //
      // v0.7.42 — `subject` and `description` are independent patch fields.
      // `subject` cannot be cleared to empty (it's the required row label);
      // `description` may be cleared by passing empty string. Both follow
      // preserve-when-undefined semantics.
      let next: TodoItem = { ...prev };
      if (partial.subject !== undefined) next = { ...next, subject: partial.subject };
      if (partial.description !== undefined) next = { ...next, description: partial.description };
      if (partial.activeForm !== undefined) next = { ...next, activeForm: partial.activeForm };
      if (partial.status !== undefined) next = { ...next, status: partial.status };
      if (partial.note !== undefined) next = { ...next, note: partial.note };
      if (partial.evaluator !== undefined) next = { ...next, evaluator: partial.evaluator };
      // metadata patch (v0.7.42 per-key delete):
      //   - `null` clears the whole bag.
      //   - object whose values are non-null shallow-merges as before.
      //   - object whose values include `null` deletes those keys from
      //     existing metadata (the only semantic change in v0.7.42).
      //   - `undefined` preserves.
      // When the merged bag ends up empty, drop the field entirely so
      // the JSON envelope stays compact (and downstream consumers can
      // use `metadata === undefined` as the "no metadata" test).
      if (partial.metadata === null) {
        next = { ...next, metadata: undefined };
      } else if (partial.metadata !== undefined) {
        const merged: Record<string, unknown> = { ...(prev.metadata ?? {}) };
        for (const [key, value] of Object.entries(partial.metadata)) {
          if (value === null) {
            delete merged[key];
          } else {
            merged[key] = value;
          }
        }
        next = {
          ...next,
          metadata: Object.keys(merged).length === 0 ? undefined : merged,
        };
      }
      // No-op detection: shallow-compare the fields we may have touched.
      // Skips onChange firing so React doesn't re-render on idempotent
      // patches (same as updateStatus does).
      const isNoop =
        next.subject === prev.subject
        && next.description === prev.description
        && next.activeForm === prev.activeForm
        && next.status === prev.status
        && next.note === prev.note
        && next.evaluator === prev.evaluator
        && next.metadata === prev.metadata;
      if (isNoop) return true;
      items = items.map((it, i) => (i === idx ? next : it));
      notifyIfChanged(true);
      return true;
    },
    remove(id): boolean {
      const idx = items.findIndex((it) => it.id === id);
      if (idx < 0) return false;
      items = items.filter((_, i) => i !== idx);
      notifyIfChanged(true);
      return true;
    },
    replace(next): void {
      items = next.map((it) => ({ ...it }));
      notifyIfChanged(true);
    },
    autoCompleteOnAccept(): number {
      let changed = 0;
      items = items.map((it) => {
        if (it.status === 'pending' || it.status === 'in_progress') {
          changed++;
          return { ...it, status: 'completed' as TodoStatus };
        }
        return it;
      });
      notifyIfChanged(changed > 0);
      return changed;
    },
    markInProgressFailed(note): number {
      let changed = 0;
      items = items.map((it) => {
        if (it.status === 'in_progress') {
          changed++;
          return { ...it, status: 'failed' as TodoStatus, note };
        }
        return it;
      });
      notifyIfChanged(changed > 0);
      return changed;
    },
    resetFailed(): number {
      let changed = 0;
      items = items.map((it) => {
        if (it.status === 'failed') {
          changed++;
          return { ...it, status: 'pending' as TodoStatus, note: undefined };
        }
        return it;
      });
      notifyIfChanged(changed > 0);
      return changed;
    },
    reset(): void {
      const wasNonEmpty = items.length > 0;
      items = [];
      notifyIfChanged(wasNonEmpty);
    },
  };
}
