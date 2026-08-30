/**
 * View-model status-bar tests — FEATURE_092 phase 2b.8 engine-indicator format.
 *
 * Pins the live Ink permission-mode text format. Classic uses
 * command/startup text surfaces rather than a second cursor-managed StatusBar.
 */

import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import type { StatusBarProps } from "../types.js";
import { buildStatusBarViewModel, getStatusBarText } from "./status-bar.js";

const baseProps = (overrides: Partial<StatusBarProps> = {}): StatusBarProps => ({
  sessionId: "s1",
  permissionMode: "auto",
  agentMode: "ama",
  provider: "kimi-code",
  model: "kimi-for-coding",
  thinking: false,
  reasoningMode: "off",
  reasoningCapability: "-",
  showBusyStatus: false,
  isCompacting: false,
  isThinkingActive: false,
  thinkingCharCount: 0,
  toolInputCharCount: 0,
  toolInputContent: "",
  activeToolCount: 0,
  ...overrides,
});

describe("status-bar (Ink view-model) reasoning effort display", () => {
  it("renders effort-first status instead of internal capability letters", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      reasoningMode: "auto",
      effort: "high",
      reasoningCapability: "E",
    }));

    expect(viewModel.segments.find((segment) => segment.id === "reasoning-mode")?.text)
      .toBe("high");
    expect(viewModel.segments.some((segment) => segment.id === "reasoning-effort"))
      .toBe(false);
    expect(viewModel.text).not.toContain("/E");
    expect(viewModel.text).not.toContain("effort:high");
  });

  it("uses resolved configured-to-effective labels when supplied", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      reasoningMode: "auto",
      effort: "xhigh",
      reasoningEffortLabel: "xhigh->max",
      reasoningCapability: "E",
    }));

    expect(viewModel.segments.find((segment) => segment.id === "reasoning-mode")?.text)
      .toBe("xhigh->max");
    expect(viewModel.text).not.toContain("/E");
  });

  it("shows off for the internal none effort", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      reasoningMode: "off",
      effort: "none",
    }));

    expect(viewModel.segments.find((segment) => segment.id === "reasoning-mode")?.text)
      .toBe("off");
  });

  it("dims the reasoning segment when a configured effort folds to off", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      reasoningMode: "auto",
      effort: "minimal",
      reasoningEffortLabel: "minimal->off",
    }));

    const segment = viewModel.segments.find((s) => s.id === "reasoning-mode");
    expect(segment?.text).toBe("minimal->off");
    // Effective tier is 'off' → the segment must read as disabled (dim), not the
    // cyan/magenta that would imply thinking is still active.
    expect(segment?.color).toBe("dim");
  });
});

describe("status-bar context pressure", () => {
  it("uses physical capacity for the default capacity-driven policy", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      contextUsage: {
        currentTokens: 164_000,
        contextWindow: 200_000,
        triggerPercent: 100,
        reservedResponseTokens: 32_000,
      },
    }));

    expect(viewModel.segments.find((segment) => segment.id === "context-usage")?.color)
      .toBe("red");
  });

  it("keeps an explicit early trigger as the lower pressure threshold", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      contextUsage: {
        currentTokens: 151_000,
        contextWindow: 200_000,
        triggerPercent: 75,
        reservedResponseTokens: 32_000,
      },
    }));

    expect(viewModel.segments.find((segment) => segment.id === "context-usage")?.color)
      .toBe("red");
  });
});

describe("status-bar Learning Center segment", () => {
  it("appends one compact non-zero segment after context usage", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      contextUsage: {
        currentTokens: 10_000,
        contextWindow: 200_000,
        triggerPercent: 100,
      },
      learning: { ready: 1, newlyActive: 2, attention: 1, active: 6, revision: 4 },
    }));
    const contextIndex = viewModel.segments.findIndex((segment) => segment.id === "context-usage");
    const learningIndex = viewModel.segments.findIndex((segment) => segment.id === "learning");
    expect(viewModel.segments[learningIndex]).toMatchObject({ text: "Learn:1R/2N/1!", tone: "warning" });
    expect(learningIndex).toBe(contextIndex + 1);
  });

  it("hides inventory-only and zero snapshots", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      learning: { ready: 0, newlyActive: 0, attention: 0, active: 6, revision: 1 },
    }));
    expect(viewModel.segments.some((segment) => segment.id === "learning")).toBe(false);
  });
});

describe("status-bar (Ink view-model) — canonical permission profiles", () => {
  it("renders Auto[LLM] for the single Auto policy", () => {
    const text = getStatusBarText(baseProps({ permissionMode: "auto" }));
    expect(text).toContain("Auto[LLM]");
    // Title-Case short label — not the raw lowercase 'auto', not all-uppercase 'AUTO'
    expect(text).not.toMatch(/\bauto\b/);
    expect(text).not.toMatch(/\bAUTO\b/);
  });

  it("renders Auto[LLM] for the deprecated auto-in-project alias too (folds into canonical short label)", () => {
    const text = getStatusBarText(
      baseProps({ permissionMode: "auto-in-project" }),
    );
    // Deprecation notice already fired at startup; status bar shows 'Auto'
    // for both the canonical and deprecated spelling, no need to re-litigate.
    expect(text).toContain("Auto[LLM]");
    expect(text).not.toContain("auto-in-project");
    expect(text).not.toContain("Auto-In-Project");
  });

  it("renders Title-Case short labels for non-auto modes", () => {
    const planText = getStatusBarText(baseProps({ permissionMode: "plan" }));
    expect(planText).toContain("Plan");
    expect(planText).not.toMatch(/\bplan\b/);
    expect(planText).not.toMatch(/\bPLAN\b/);

    const editsText = getStatusBarText(baseProps({ permissionMode: "accept-edits" }));
    expect(editsText).toContain("Edits");
    // 'accept-edits' raw / 'ACCEPT-EDITS' uppercase / 'Accept-Edits' Title-Case-with-hyphen
    // are all wrong — short label collapses to 'Edits'.
    expect(editsText).not.toContain("accept-edits");
    expect(editsText).not.toContain("ACCEPT-EDITS");
    expect(editsText).not.toContain("Accept-Edits");

    const fullAccessText = getStatusBarText(baseProps({ permissionMode: "full-access" }));
    expect(fullAccessText).toContain("Full Access");
    expect(fullAccessText).not.toContain("full-access");
  });

  it("does NOT render reviewer suffix outside Auto", () => {
    const planText = getStatusBarText(baseProps({ permissionMode: "plan" }));
    expect(planText).not.toContain("[RULES]");
    expect(planText).not.toContain("[LLM]");
  });

  it("renders AMA as the managed-agent label", () => {
    const text = getStatusBarText(baseProps({ agentMode: "ama" }));
    expect(text).toContain("KodaX - AMA");
  });

  it("uses the absolute trigger when it is lower than the percentage", () => {
    const viewModel = buildStatusBarViewModel(baseProps({
      contextUsage: {
        currentTokens: 121_000,
        contextWindow: 200_000,
        triggerPercent: 75,
        triggerTokens: 120_000,
        reservedResponseTokens: 32_000,
      },
    }));

    expect(viewModel.segments.find((segment) => segment.id === "context-usage")?.color).toBe("red");
  });
});

describe("status-bar (Ink view-model) — surface-status integration", () => {
  it("renders the canonical Auto label without engine state plumbing", async () => {
    const { buildSurfaceStatusBarProps } = await import("./surface-status.js");
    const props = buildSurfaceStatusBarProps({
      sessionId: "s1",
      permissionMode: "auto",
      agentMode: "ama",
      provider: "kimi-code",
      model: "kimi-for-coding",
      reasoningMode: "off",
      reasoningCapability: "-",
      isTranscriptMode: false,
      streamingState: {
        isThinking: false,
        thinkingCharCount: 0,
        activeToolCalls: [{ status: ToolCallStatus.Executing }],
        toolInputCharCount: 0,
        toolInputContent: "",
        isCompacting: false,
      },
      isLoading: false,
    });
    const text = getStatusBarText(props);
    expect(text).toContain("Auto[LLM]");
  });
});
