/**
 * Todo Plan View-Model — FEATURE_097 (v0.7.34).
 *
 * Pure transform from `TodoList` (the canonical store snapshot) to a
 * render-ready set of rows for `TodoListSurface.tsx`. All display
 * decisions live here so the component layer is a thin renderer.
 *
 * Design rules (per docs/features/v0.7.34.md §"View-Model"):
 *   - Max visible rows = 6 (hard cap, includes optional summary rows).
 *   - Anchor = first in_progress, else first pending, else last
 *     completed/terminal.
 *   - Window: anchor-1 prev, anchor, anchor+2 next (default).
 *   - Top fold: when there are unshown completed items above the
 *     window, insert a `✓ N done` summary row.
 *   - Bottom fold: when there are unshown pending items below the
 *     window, insert a `☐ +N more` summary row.
 *   - Failed-item priority: surface the most recent failed item even
 *     if it would fall outside the window (replaces the nearest
 *     pending slot inside the window).
 *   - shouldRender = totalCount >= 2 AND not within the post-completion
 *     5 s linger window. Below 2, the surface stays hidden — Claude
 *     Code's "task too simple to need a list" stance.
 */

import type { TodoItem } from "@kodax/coding";

export const MAX_VISIBLE_ROWS = 6;
/** 5-second linger before the surface auto-hides after the last item closes. */
export const POST_COMPLETION_LINGER_MS = 5_000;
/** Below this many items, the surface never renders. */
export const MIN_ITEMS_TO_RENDER = 2;

export type TodoRowKind = "item" | "summary_done" | "summary_pending";
export type TodoSymbolColor =
  | "dim"
  | "cyan"
  | "green"
  | "red"
  | "gray";

export interface TodoRow {
  readonly kind: TodoRowKind;
  /** Present only when kind === "item". */
  readonly id?: string;
  readonly symbol: string;
  readonly symbolColor: TodoSymbolColor;
  /** Visible row text. For "item" rows, this is `content` plus optional note for failed. */
  readonly text: string;
  /** True only on the in_progress item. UI uses bold/cyan accent. */
  readonly isActive: boolean;
}

export interface TodoPlanViewModel {
  /** False when the surface should stay hidden (too few items, post-linger, etc.). */
  readonly shouldRender: boolean;
  /** At most MAX_VISIBLE_ROWS rows, summary rows included. */
  readonly rows: readonly TodoRow[];
  /** Numerator of the "X / Y completed" indicator (counts terminal-success only). */
  readonly completedCount: number;
  /** Denominator of the indicator. */
  readonly totalCount: number;
}

export interface BuildTodoPlanOptions {
  /** Current epoch ms — used to evaluate the linger window. */
  readonly now: number;
  /**
   * The epoch ms at which all items first reached a terminal state.
   * Caller sets this when the last in_progress / pending flips, and
   * resets it back to `null` if any item leaves the terminal set
   * (e.g., Evaluator revise marks something failed mid-linger).
   */
  readonly lastAllCompletedAt: number | null;
}

const SYMBOL_PENDING = "☐"; // ☐
const SYMBOL_IN_PROGRESS = "●"; // ●
const SYMBOL_COMPLETED = "✓"; // ✓
const SYMBOL_FAILED = "✗"; // ✗
const SYMBOL_SKIPPED = "⊘"; // ⊘

function symbolForStatus(status: TodoItem["status"]): {
  symbol: string;
  color: TodoSymbolColor;
} {
  switch (status) {
    case "in_progress":
      return { symbol: SYMBOL_IN_PROGRESS, color: "cyan" };
    case "completed":
      return { symbol: SYMBOL_COMPLETED, color: "green" };
    case "failed":
      return { symbol: SYMBOL_FAILED, color: "red" };
    case "skipped":
      return { symbol: SYMBOL_SKIPPED, color: "gray" };
    case "pending":
    default:
      return { symbol: SYMBOL_PENDING, color: "dim" };
  }
}

function isTerminal(status: TodoItem["status"]): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

/** Item is "settled" when caller wants the linger timer to advance. */
function allItemsTerminal(items: readonly TodoItem[]): boolean {
  return items.length > 0 && items.every((it) => isTerminal(it.status));
}

function pickAnchorIndex(items: readonly TodoItem[]): number {
  // Priority 1: first in_progress.
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.status === "in_progress") return i;
  }
  // Priority 2: first pending.
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.status === "pending") return i;
  }
  // Priority 3: last completed (so the user sees the final state during linger).
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.status === "completed") return i;
  }
  // Fallback: 0.
  return 0;
}

function buildItemRow(item: TodoItem): TodoRow {
  const { symbol, color } = symbolForStatus(item.status);
  const text = item.status === "failed" && item.note
    ? `${item.content} (${item.note})`
    : item.content;
  return {
    kind: "item",
    id: item.id,
    symbol,
    symbolColor: color,
    text,
    isActive: item.status === "in_progress",
  };
}

function buildDoneSummary(count: number): TodoRow {
  return {
    kind: "summary_done",
    symbol: SYMBOL_COMPLETED,
    symbolColor: "green",
    text: `${count} done`,
    isActive: false,
  };
}

function buildPendingSummary(count: number): TodoRow {
  return {
    kind: "summary_pending",
    symbol: SYMBOL_PENDING,
    symbolColor: "dim",
    text: `+${count} more`,
    isActive: false,
  };
}

/**
 * Pick the most recent failed item that is NOT already in the window.
 * "Most recent" is taken as highest index, since Scout's seed order
 * mirrors `executionObligations` order and later items are completed
 * later. Returns -1 when no out-of-window failed item exists.
 */
function pickFailedToPromote(
  items: readonly TodoItem[],
  inWindow: ReadonlySet<number>,
): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.status === "failed" && !inWindow.has(i)) {
      return i;
    }
  }
  return -1;
}

interface WindowDecision {
  readonly visibleIdx: ReadonlyArray<number>;
  readonly hiddenCompletedCount: number;
  readonly hiddenPendingCount: number;
}

/**
 * Compute the indices of items to show in the visible window. Default
 * layout: 1 row before anchor, anchor itself, 2 rows after anchor.
 * Adjust at edges so we always emit up to 4 item rows.
 */
function decideWindow(
  items: readonly TodoItem[],
  anchorIdx: number,
): WindowDecision {
  const total = items.length;
  if (total === 0) {
    return { visibleIdx: [], hiddenCompletedCount: 0, hiddenPendingCount: 0 };
  }
  // Default window — 4 item rows leaves 2 row budget for summary folds.
  const ITEMS_BUDGET = 4;
  let start = Math.max(0, anchorIdx - 1);
  let end = Math.min(total, start + ITEMS_BUDGET); // exclusive
  // Anchor at end of list — pull start back so we still fit ITEMS_BUDGET.
  if (end - start < ITEMS_BUDGET && start > 0) {
    start = Math.max(0, end - ITEMS_BUDGET);
  }
  // Anchor at start — extend forward.
  if (end - start < ITEMS_BUDGET && end < total) {
    end = Math.min(total, start + ITEMS_BUDGET);
  }
  const visibleIdx: number[] = [];
  for (let i = start; i < end; i++) visibleIdx.push(i);
  // Count hidden splits.
  let hiddenCompleted = 0;
  let hiddenPending = 0;
  for (let i = 0; i < start; i++) {
    if (items[i]!.status === "completed") hiddenCompleted++;
  }
  for (let i = end; i < total; i++) {
    const status = items[i]!.status;
    if (status === "pending" || status === "in_progress") hiddenPending++;
  }
  return {
    visibleIdx,
    hiddenCompletedCount: hiddenCompleted,
    hiddenPendingCount: hiddenPending,
  };
}

export function buildTodoPlanViewModel(
  items: readonly TodoItem[],
  opts: BuildTodoPlanOptions,
): TodoPlanViewModel {
  const totalCount = items.length;
  const completedCount = items.reduce(
    (acc, it) => (it.status === "completed" ? acc + 1 : acc),
    0,
  );
  const baseVm = (rows: readonly TodoRow[], render: boolean): TodoPlanViewModel => ({
    shouldRender: render,
    rows,
    completedCount,
    totalCount,
  });

  // Below threshold — surface stays hidden regardless of state.
  if (totalCount < MIN_ITEMS_TO_RENDER) {
    return baseVm([], false);
  }

  // Post-completion linger: if every item is terminal AND the linger
  // window has elapsed, hide the surface.
  if (allItemsTerminal(items) && opts.lastAllCompletedAt !== null) {
    const elapsed = opts.now - opts.lastAllCompletedAt;
    if (elapsed >= POST_COMPLETION_LINGER_MS) {
      return baseVm([], false);
    }
  }

  const anchorIdx = pickAnchorIndex(items);
  const window = decideWindow(items, anchorIdx);
  const visibleSet = new Set(window.visibleIdx);

  // Failed-item priority: if the most-recent failed item isn't
  // already in the window, insert it at the back of the window
  // (replacing a pending slot, not the anchor).
  const promotedFailedIdx = pickFailedToPromote(items, visibleSet);
  let visibleIdx: number[] = [...window.visibleIdx];
  let hiddenCompletedCount = window.hiddenCompletedCount;
  let hiddenPendingCount = window.hiddenPendingCount;
  if (promotedFailedIdx >= 0) {
    // Find the last pending slot to swap out — never replace the anchor.
    let swapAt = -1;
    for (let i = visibleIdx.length - 1; i >= 0; i--) {
      const idx = visibleIdx[i]!;
      if (idx === anchorIdx) continue;
      if (items[idx]!.status === "pending") {
        swapAt = i;
        break;
      }
    }
    if (swapAt >= 0) {
      const evicted = visibleIdx[swapAt]!;
      visibleIdx[swapAt] = promotedFailedIdx;
      // Adjust hidden counts: the evicted pending now hides; the
      // promoted failed leaves the hidden side.
      hiddenPendingCount += 1;
      // Re-sort visibleIdx so summary fold logic stays straightforward.
      visibleIdx.sort((a, b) => a - b);
      // Recount hidden completed (might shift if promotedFailedIdx
      // sits earlier than the original window start).
      const earliestVisible = visibleIdx[0]!;
      let recountedCompleted = 0;
      for (let i = 0; i < earliestVisible; i++) {
        if (items[i]!.status === "completed") recountedCompleted++;
      }
      hiddenCompletedCount = recountedCompleted;
      // (Use the variable so the linter does not complain — value is
      // already implicit in `visibleIdx`.)
      void evicted;
    }
  }

  const rows: TodoRow[] = [];
  if (hiddenCompletedCount > 0) {
    rows.push(buildDoneSummary(hiddenCompletedCount));
  }
  for (const idx of visibleIdx) {
    rows.push(buildItemRow(items[idx]!));
  }
  if (hiddenPendingCount > 0) {
    rows.push(buildPendingSummary(hiddenPendingCount));
  }
  // Hard cap. Trim from the back of the item rows (keep folds for context).
  if (rows.length > MAX_VISIBLE_ROWS) {
    // Remove non-anchor item rows from the bottom until we fit.
    while (rows.length > MAX_VISIBLE_ROWS) {
      // Find last "item" row that is not active (the anchor) and pop it.
      let removed = false;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (r.kind === "item" && !r.isActive) {
          rows.splice(i, 1);
          // Increment the bottom summary count if present, else add one.
          const last = rows[rows.length - 1];
          if (last && last.kind === "summary_pending") {
            // Replace last summary with incremented count.
            const m = /\+(\d+) more/.exec(last.text);
            const n = m ? Number.parseInt(m[1]!, 10) + 1 : 1;
            rows[rows.length - 1] = buildPendingSummary(n);
          } else {
            rows.push(buildPendingSummary(1));
          }
          removed = true;
          break;
        }
      }
      if (!removed) break; // safety
    }
  }
  return baseVm(rows, true);
}

/**
 * Helper for the host component: returns true when every item is in a
 * terminal state. Caller uses this to decide when to start /reset the
 * 5 s linger timer.
 */
export function isPlanFullyClosed(items: readonly TodoItem[]): boolean {
  return allItemsTerminal(items);
}
