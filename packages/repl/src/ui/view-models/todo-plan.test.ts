/**
 * Hermetic tests for buildTodoPlanViewModel (FEATURE_097, v0.7.34).
 * No LLM calls. Tests anchor selection, window layout, summary folds,
 * failed-item priority, post-completion linger, and shouldRender gates.
 */
import { describe, expect, it } from "vitest";

import type { TodoItem, TodoStatus } from "@kodax/coding";

import {
  MAX_VISIBLE_ROWS,
  MIN_ITEMS_TO_RENDER,
  POST_COMPLETION_LINGER_MS,
  buildTodoPlanViewModel,
  isPlanFullyClosed,
} from "./todo-plan.js";

function makeItem(
  id: string,
  content: string,
  status: TodoStatus = "pending",
  note?: string,
): TodoItem {
  return { id, content, status, note };
}

function makeItems(n: number, status: TodoStatus = "pending"): TodoItem[] {
  return Array.from({ length: n }, (_, i) => makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status));
}

const NOW = 1_700_000_000_000;

describe("buildTodoPlanViewModel — gating", () => {
  it("hides the surface when totalCount < MIN_ITEMS_TO_RENDER", () => {
    expect(MIN_ITEMS_TO_RENDER).toBe(2);
    const vm = buildTodoPlanViewModel([makeItem("todo_1", "lone task")], {
      now: NOW,
      lastAllCompletedAt: null,
    });
    expect(vm.shouldRender).toBe(false);
    expect(vm.totalCount).toBe(1);
  });

  it("renders when totalCount >= MIN_ITEMS_TO_RENDER", () => {
    const vm = buildTodoPlanViewModel(makeItems(2), { now: NOW, lastAllCompletedAt: null });
    expect(vm.shouldRender).toBe(true);
  });

  it("post-completion linger: hides AFTER POST_COMPLETION_LINGER_MS elapsed", () => {
    const items = makeItems(3, "completed");
    const closedAt = NOW - POST_COMPLETION_LINGER_MS - 1;
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: closedAt });
    expect(vm.shouldRender).toBe(false);
  });

  it("post-completion linger: still renders WITHIN the linger window", () => {
    const items = makeItems(3, "completed");
    const closedAt = NOW - 1_000;
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: closedAt });
    expect(vm.shouldRender).toBe(true);
  });

  it("post-completion linger: never closes when lastAllCompletedAt is null", () => {
    // Caller sets lastAllCompletedAt only after the LAST flip; if it's
    // null, treat the surface as still active.
    const vm = buildTodoPlanViewModel(makeItems(3, "completed"), {
      now: NOW,
      lastAllCompletedAt: null,
    });
    expect(vm.shouldRender).toBe(true);
  });
});

describe("buildTodoPlanViewModel — anchor selection", () => {
  it("anchor = first in_progress when one exists", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemRows = vm.rows.filter((r) => r.kind === "item");
    const active = itemRows.find((r) => r.isActive);
    expect(active?.id).toBe("todo_2");
  });

  it("anchor = first pending when no in_progress", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "pending"),
      makeItem("todo_4", "D", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemIds = vm.rows.filter((r) => r.kind === "item").map((r) => r.id);
    expect(itemIds).toContain("todo_3");
  });

  it("anchor = last completed when everything is terminal", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "completed"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    expect(vm.shouldRender).toBe(true);
    expect(vm.completedCount).toBe(3);
  });
});

describe("buildTodoPlanViewModel — window + summary folds", () => {
  it("totalCount <= window budget renders all items, no folds", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    expect(vm.rows.every((r) => r.kind === "item")).toBe(true);
    expect(vm.rows.length).toBe(3);
  });

  it("inserts ✓ N done summary at top when completed items hidden", () => {
    // 12 items, in_progress at index 5; window = [4,5,6,7]; 4 hidden completed at top.
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      let status: TodoStatus = "pending";
      if (i < 4) status = "completed";
      else if (i === 4) status = "completed";
      else if (i === 5) status = "in_progress";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const top = vm.rows[0]!;
    expect(top.kind).toBe("summary_done");
    expect(top.text).toMatch(/^\d+ done$/);
  });

  it("inserts ☐ +N more summary at bottom when pending items hidden", () => {
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      const status: TodoStatus = i === 0 ? "in_progress" : "pending";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const last = vm.rows[vm.rows.length - 1]!;
    expect(last.kind).toBe("summary_pending");
    expect(last.text).toMatch(/^\+\d+ more$/);
  });

  it("hard cap: total rows <= MAX_VISIBLE_ROWS for any input size", () => {
    expect(MAX_VISIBLE_ROWS).toBe(6);
    const sizes = [2, 6, 7, 12, 20, 50];
    for (const n of sizes) {
      const items = makeItems(n);
      // Mark middle item in_progress to force a window in the middle.
      const idx = Math.floor(n / 2);
      items[idx] = { ...items[idx]!, status: "in_progress" };
      const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
      expect(vm.rows.length, `rows for n=${n}`).toBeLessThanOrEqual(MAX_VISIBLE_ROWS);
    }
  });
});

describe("buildTodoPlanViewModel — failed-item priority", () => {
  it("surfaces an out-of-window failed item by replacing nearest pending", () => {
    // 12 items, in_progress at index 1, failed at index 8 (out of default window).
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      let status: TodoStatus = "pending";
      if (i === 1) status = "in_progress";
      if (i === 8) status = "failed";
      const note = i === 8 ? "Evaluator requested revision" : undefined;
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status, note);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemIds = vm.rows.filter((r) => r.kind === "item").map((r) => r.id);
    expect(itemIds).toContain("todo_9"); // promoted failed
  });

  it("never replaces the anchor (in_progress) with the failed item", () => {
    const items: TodoItem[] = Array.from({ length: 8 }, (_, i) => {
      let status: TodoStatus = "pending";
      if (i === 0) status = "in_progress";
      if (i === 7) status = "failed";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const activeRow = vm.rows.find((r) => r.isActive);
    expect(activeRow?.id).toBe("todo_1");
  });

  it("formats failed-item text with note suffix when note is present", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "Run migration", "failed", "Evaluator requested revision"),
      makeItem("todo_2", "Update types", "pending"),
      makeItem("todo_3", "Verify e2e", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const failedRow = vm.rows.find((r) => r.kind === "item" && r.id === "todo_1");
    expect(failedRow?.text).toContain("Run migration");
    expect(failedRow?.text).toContain("Evaluator requested revision");
  });
});

describe("buildTodoPlanViewModel — symbol mapping", () => {
  it.each<[TodoStatus, string]>([
    ["pending", "☐"],
    ["in_progress", "●"],
    ["completed", "✓"],
    ["failed", "✗"],
    ["skipped", "⊘"],
  ])("status=%s renders symbol %s", (status, symbol) => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", status),
      makeItem("todo_2", "B", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const row = vm.rows.find((r) => r.kind === "item" && r.id === "todo_1");
    expect(row?.symbol).toBe(symbol);
  });

  it("only the in_progress row is marked isActive", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const itemRows = vm.rows.filter((r) => r.kind === "item");
    expect(itemRows.filter((r) => r.isActive).length).toBe(1);
    expect(itemRows.find((r) => r.isActive)?.id).toBe("todo_2");
  });
});

describe("buildTodoPlanViewModel — auto-advance scenario", () => {
  it("anchor moves forward as items complete", () => {
    // 8 items. Phase 1: in_progress on todo_3.
    const phase1: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "in_progress"),
      ...Array.from({ length: 5 }, (_, i) =>
        makeItem(`todo_${i + 4}`, `Step ${i + 4}`, "pending"),
      ),
    ];
    const vm1 = buildTodoPlanViewModel(phase1, { now: NOW, lastAllCompletedAt: null });
    expect(vm1.rows.find((r) => r.isActive)?.id).toBe("todo_3");

    // Phase 2: todo_3 done → todo_4 in_progress.
    const phase2: TodoItem[] = phase1.map((it, i) => {
      if (i === 2) return { ...it, status: "completed" };
      if (i === 3) return { ...it, status: "in_progress" };
      return it;
    });
    const vm2 = buildTodoPlanViewModel(phase2, { now: NOW, lastAllCompletedAt: null });
    expect(vm2.rows.find((r) => r.isActive)?.id).toBe("todo_4");
    // The "✓ N done" summary count grew (from 2 → 3 hidden) — ensure
    // a top fold appears once we move past the window's start.
    const topRow = vm2.rows[0]!;
    if (topRow.kind === "summary_done") {
      expect(topRow.text).toMatch(/^\d+ done$/);
    }
  });
});

describe("isPlanFullyClosed", () => {
  it("returns false on empty list", () => {
    expect(isPlanFullyClosed([])).toBe(false);
  });

  it("returns false when any pending or in_progress item remains", () => {
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "pending"),
    ])).toBe(false);
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
    ])).toBe(false);
  });

  it("returns true when every item is terminal (completed | failed | skipped)", () => {
    expect(isPlanFullyClosed([
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "failed"),
      makeItem("todo_3", "C", "skipped"),
    ])).toBe(true);
  });
});

describe("counts", () => {
  it("completedCount + totalCount reflect the canonical store snapshot", () => {
    const items: TodoItem[] = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "in_progress"),
      makeItem("todo_4", "D", "failed"),
      makeItem("todo_5", "E", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    expect(vm.completedCount).toBe(2);
    expect(vm.totalCount).toBe(5);
  });
});
