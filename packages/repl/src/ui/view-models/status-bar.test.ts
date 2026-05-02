/**
 * View-model status-bar tests — FEATURE_092 phase 2b.8 engine-indicator format.
 *
 * Mirrors the readline-surface coverage in
 * `packages/repl/src/interactive/status-bar.test.ts` so both UIs are pinned
 * to the same `Auto[LLM]` / `Auto[RULES]` text format. Drift between the two
 * surfaces is the kind of bug status-bar tests exist to catch.
 */

import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import type { StatusBarProps } from "../types.js";
import { getStatusBarText } from "./status-bar.js";

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

describe("status-bar (Ink view-model) — auto-mode engine indicator (FEATURE_092 phase 2b.8)", () => {
  it("renders Auto[LLM] when permissionMode=auto and engine=llm", () => {
    const text = getStatusBarText(baseProps({ permissionMode: "auto", autoModeEngine: "llm" }));
    expect(text).toContain("Auto[LLM]");
    // Title-Case short label — not the raw lowercase 'auto', not all-uppercase 'AUTO'
    expect(text).not.toMatch(/\bauto\b/);
    expect(text).not.toMatch(/\bAUTO\b/);
  });

  it("renders Auto[RULES] when engine=rules (downgraded)", () => {
    const text = getStatusBarText(baseProps({ permissionMode: "auto", autoModeEngine: "rules" }));
    expect(text).toContain("Auto[RULES]");
  });

  it("renders Auto[LLM] for the deprecated auto-in-project alias too (folds into canonical short label)", () => {
    const text = getStatusBarText(
      baseProps({ permissionMode: "auto-in-project", autoModeEngine: "llm" }),
    );
    // Deprecation notice already fired at startup; status bar shows 'Auto'
    // for both the canonical and deprecated spelling, no need to re-litigate.
    expect(text).toContain("Auto[LLM]");
    expect(text).not.toContain("auto-in-project");
    expect(text).not.toContain("Auto-In-Project");
  });

  it("falls back to bare 'Auto' when autoModeEngine is undefined", () => {
    const text = getStatusBarText(baseProps({ permissionMode: "auto" }));
    expect(text).toContain("Auto");
    expect(text).not.toContain("[LLM]");
    expect(text).not.toContain("[RULES]");
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
  });

  it("does NOT render engine suffix outside auto modes (gating is on the mode)", () => {
    // Even if autoModeEngine somehow leaks in, the mode gate prevents the
    // suffix from rendering — same belt-and-suspenders the readline path uses.
    const planText = getStatusBarText(
      baseProps({ permissionMode: "plan", autoModeEngine: "rules" }),
    );
    expect(planText).not.toContain("[RULES]");
    expect(planText).not.toContain("[LLM]");
  });
});

describe("status-bar (Ink view-model) — surface-status integration", () => {
  it("autoModeEngine flows through buildSurfaceStatusBarProps to the view-model", async () => {
    // Real shape: buildSurfaceStatusBarProps fills StatusBarProps, view-model
    // reads it. Verifies no field-name drift between the two layers.
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
      autoModeEngine: "rules",
    });
    expect(props.autoModeEngine).toBe("rules");
    const text = getStatusBarText(props);
    expect(text).toContain("Auto[RULES]");
  });
});
