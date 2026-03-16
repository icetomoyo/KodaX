import { describe, expect, it } from "vitest";
import {
  calculateInputPromptRows,
  calculateViewportBudget,
} from "./viewport-budget.js";

describe("viewport-budget", () => {
  it("grows the input area for wrapped multiline input", () => {
    const singleLine = calculateInputPromptRows("hello", 80);
    const multiLine = calculateInputPromptRows("hello\nworld\nthis is a longer line that wraps across the viewport", 30);

    expect(multiLine).toBeGreaterThan(singleLine);
  });

  it("accounts for suggestions, help, status, and confirm dialog", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "hello world",
      suggestionsReserved: true,
      showHelp: true,
      statusBarText: "KodaX | PLAN | auto/B | session123 * Read | openai/gpt | 10.0k/200.0k #####----- 5%",
      confirmPrompt: "Apply changes?",
      confirmInstruction: "Press (y) yes, (n) no",
    });

    expect(budget.suggestionsRows).toBe(8);
    expect(budget.helpRows).toBeGreaterThanOrEqual(2);
    expect(budget.statusRows).toBeGreaterThanOrEqual(1);
    expect(budget.confirmRows).toBeGreaterThanOrEqual(5);
    expect(budget.messageRows).toBeGreaterThan(0);
  });

  it("accounts for queued inline input feedback", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 60,
      inputText: "",
      pendingInputSummary: "Queued 2 follow-ups. Latest: check tests too (Esc removes latest)",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(budget.pendingInputRows).toBeGreaterThan(0);
    expect(budget.messageRows).toBeGreaterThan(0);
  });

  it("clamps select dialog options and keeps message rows positive", () => {
    const budget = calculateViewportBudget({
      terminalRows: 16,
      terminalWidth: 50,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status bar content that wraps on narrow terminals",
      uiRequest: {
        kind: "select",
        title: "Choose an option",
        options: Array.from({ length: 8 }, (_, index) => ({
          label: `Option ${index + 1}`,
          description: "description",
        })),
        buffer: "",
      },
    });

    expect(budget.visibleSelectOptions).toBe(5);
    expect(budget.uiRequestRows).toBeGreaterThan(0);
    expect(budget.messageRows).toBeGreaterThan(0);
  });
});
