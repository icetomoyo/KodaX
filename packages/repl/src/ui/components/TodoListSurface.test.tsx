/**
 * Hermetic Ink render tests for TodoListSurface (FEATURE_097, v0.7.34).
 * No LLM calls. Tests rendering behavior, hide-when-not-renderable,
 * symbol output, and counter formatting.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import type { TodoItem } from "@kodax/coding";

import { TodoListSurface } from "./TodoListSurface.js";
import {
  buildTodoPlanViewModel,
  POST_COMPLETION_LINGER_MS,
} from "../view-models/todo-plan.js";

function makeItem(
  id: string,
  content: string,
  status: TodoItem["status"] = "pending",
  note?: string,
): TodoItem {
  return { id, content, status, note };
}

const NOW = 1_700_000_000_000;

describe("TodoListSurface", () => {
  it("returns null when viewModel.shouldRender is false", () => {
    // Single item — below MIN_ITEMS_TO_RENDER threshold.
    const vm = buildTodoPlanViewModel([makeItem("todo_1", "lone")], {
      now: NOW,
      lastAllCompletedAt: null,
    });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    expect(lastFrame()).toBe("");
  });

  it("returns null after the 5s post-completion linger elapses", () => {
    const items = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "completed"),
      makeItem("todo_3", "C", "completed"),
    ];
    const vm = buildTodoPlanViewModel(items, {
      now: NOW,
      lastAllCompletedAt: NOW - POST_COMPLETION_LINGER_MS - 1,
    });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    expect(lastFrame()).toBe("");
  });

  it("renders the counter line in 'X/Y completed' format", () => {
    const items = [
      makeItem("todo_1", "A", "completed"),
      makeItem("todo_2", "B", "in_progress"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    expect(lastFrame()).toContain("1/3 completed");
  });

  it("renders item rows with the right symbols", () => {
    const items = [
      makeItem("todo_1", "Locate test fixtures", "completed"),
      makeItem("todo_2", "Run migration tests", "in_progress"),
      makeItem("todo_3", "Update type definitions", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓"); // completed
    expect(frame).toContain("●"); // in_progress
    expect(frame).toContain("☐"); // pending
    expect(frame).toContain("Locate test fixtures");
    expect(frame).toContain("Run migration tests");
    expect(frame).toContain("Update type definitions");
  });

  it("renders the gutter prefix (▏) on every row", () => {
    const items = [
      makeItem("todo_1", "A", "in_progress"),
      makeItem("todo_2", "B", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    // Expect the gutter to appear once per row (2 rows here).
    const occurrences = (frame.match(/▏/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("shows the failed-note suffix in failed-row text", () => {
    const items = [
      makeItem("todo_1", "Run migration", "failed", "Evaluator requested revision"),
      makeItem("todo_2", "Update types", "pending"),
      makeItem("todo_3", "Verify e2e", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("Run migration");
    expect(frame).toContain("Evaluator requested revision");
  });

  it("renders summary fold rows when the list is long", () => {
    const items: TodoItem[] = Array.from({ length: 12 }, (_, i) => {
      let status: TodoItem["status"] = "pending";
      if (i < 4) status = "completed";
      if (i === 5) status = "in_progress";
      return makeItem(`todo_${i + 1}`, `Step ${i + 1}`, status);
    });
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    // Top fold present.
    expect(frame).toMatch(/\d+ done/);
    // Bottom fold present.
    expect(frame).toMatch(/\+\d+ more/);
  });

  it("active row text matches the in_progress item content", () => {
    const items = [
      makeItem("todo_1", "First", "completed"),
      makeItem("todo_2", "Second", "in_progress"),
      makeItem("todo_3", "Third", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Second");
  });

  it("counter renders 0/N when no item has completed yet", () => {
    const items = [
      makeItem("todo_1", "A", "in_progress"),
      makeItem("todo_2", "B", "pending"),
      makeItem("todo_3", "C", "pending"),
    ];
    const vm = buildTodoPlanViewModel(items, { now: NOW, lastAllCompletedAt: null });
    const { lastFrame } = render(<TodoListSurface viewModel={vm} />);
    expect(lastFrame()).toContain("0/3 completed");
  });
});
