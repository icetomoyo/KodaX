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
      footerHeaderText: "native_vt | verbose | fullscreen",
      suggestionsReserved: true,
      showHelp: true,
      statusNoticeSummary: "Search: planner",
      statusBarText: "KodaX | PLAN | auto/B | session123 * Read | openai/gpt | 10.0k/200.0k #####----- 5%",
      confirmPrompt: "Apply changes?",
      confirmInstruction: "Press (y) yes, (n) no",
    });

    expect(budget.headerRows).toBeGreaterThanOrEqual(1);
    expect(budget.suggestionsRows).toBe(8);
    expect(budget.helpRows).toBeGreaterThanOrEqual(2);
    expect(budget.statusNoticeRows).toBeGreaterThanOrEqual(1);
    expect(budget.statusRows).toBeGreaterThanOrEqual(1);
    expect(budget.confirmRows).toBeGreaterThanOrEqual(5);
    expect(budget.footerRows).toBeGreaterThan(0);
    expect(budget.slots.find((slot) => slot.name === "footer")?.rows).toBe(budget.footerRows);
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

  it("reserves footer space for header and status notice surfaces", () => {
    const withoutSurfaces = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 48,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const withSurfaces = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 48,
      inputText: "",
      footerHeaderText: "native_vt | compact | fullscreen",
      statusNoticeSummary: "Search: planner",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(withSurfaces.headerRows).toBeGreaterThan(0);
    expect(withSurfaces.statusNoticeRows).toBeGreaterThan(0);
    expect(withSurfaces.footerRows).toBeGreaterThan(withoutSurfaces.footerRows);
    expect(withSurfaces.messageRows).toBeLessThan(withoutSurfaces.messageRows);
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

  it("can drop reserved suggestion space while still accounting for the review hint", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
      reviewHint: "Reviewing history - live updates paused | Esc/End/Ctrl+Y/Alt+Z resume",
    });

    expect(budget.suggestionsRows).toBe(0);
    expect(budget.reviewHintRows).toBeGreaterThan(0);
    expect(budget.messageRows).toBeGreaterThan(0);
  });

  it("accounts for the AMA work strip without collapsing message rows", () => {
    const withoutStrip = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const withStrip = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      workStripText: "Validating 3 findings",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(withStrip.workStripRows).toBeGreaterThan(0);
    expect(withStrip.reservedBottomRows).toBeGreaterThan(withoutStrip.reservedBottomRows);
    expect(withStrip.messageRows).toBeLessThan(withoutStrip.messageRows);
    expect(withStrip.messageRows).toBeGreaterThan(0);
  });

  it("tracks overlay rows separately when suggestions and dialogs use overlay mode", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: true,
      suggestionsMode: "overlay",
      dialogMode: "overlay",
      showHelp: false,
      statusBarText: "status",
      confirmPrompt: "Apply changes?",
      confirmInstruction: "Press y to confirm",
      historySearch: {
        query: "planner",
        selectedExcerpt: "Planner is active in this transcript entry",
        matchCount: 3,
      },
    });

    expect(budget.overlayRows).toBeGreaterThan(0);
    expect(budget.footerRows).toBe(budget.inputRows);
    expect(budget.historySearchRows).toBeGreaterThan(0);
    expect(budget.slots.find((slot) => slot.name === "overlay")?.rows).toBe(budget.overlayRows);
  });
});
