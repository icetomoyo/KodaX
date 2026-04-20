import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildToolConfirmationDisplay,
  buildToolConfirmationPrompt,
} from "./tool-confirmation.js";
import { setLocale } from "./i18n.js";

describe("tool-confirmation", () => {
  beforeEach(() => {
    setLocale("en");
  });
  afterEach(() => {
    setLocale("en");
  });

  it("shows intent and a bounded summary for read-only shell commands", () => {
    const command = "git diff -- packages/repl/src/ui/InkREPL.tsx packages/repl/src/ui/utils/transcript-layout.ts packages/repl/src/ui/utils/live-streaming.ts packages/repl/src/ui/components/MessageList.tsx";
    const prompt = buildToolConfirmationPrompt("bash", { command });

    expect(prompt).toContain("Execute bash command?");
    expect(prompt).toContain("Intent: Read project files");
    expect(prompt).toContain("Summary:");
    expect(prompt).not.toContain(`Summary: ${command}`);
  });

  it("classifies write-like shell commands conservatively and shows risks", () => {
    const command = "Remove-Item .\\\\tmp\\\\artifact.txt";
    const display = buildToolConfirmationDisplay("shell_command", { command });

    expect(display.title).toBe("Execute shell command?");
    expect(display.details).toContain("Intent: Delete files");
    expect(display.details).toContain("Risk: Destructive change");
  });

  it("shows target and scope for file writes", () => {
    const display = buildToolConfirmationDisplay("write", {
      path: "C:\\\\tmp\\\\note.txt",
      _outsideProject: true,
    });

    expect(display.title).toBe("Write to file?");
    expect(display.details).toContain("Intent: Write file");
    expect(display.details).toContain("Target: C:\\\\tmp\\\\note.txt");
    expect(display.details).toContain("Scope: Outside project");
  });

  it("masks secrets in command summaries", () => {
    const command = "curl -H \"Authorization: Token super-secret-token\" -H \"Cookie: session=abc\" -u alice:supersecret --api-key topsecret x";
    const prompt = buildToolConfirmationPrompt("shell_command", { command });

    expect(prompt).toContain("Summary:");
    expect(prompt).toContain("Authorization: [REDACTED]");
    expect(prompt).toContain("Cookie: [REDACTED]");
    expect(prompt).toContain("-u [REDACTED]");
    expect(prompt).toContain("--api-key [REDACTED]");
    expect(prompt).not.toContain("super-secret-token");
    expect(prompt).not.toContain("topsecret");
    expect(prompt).not.toContain("session=abc");
    expect(prompt).not.toContain("alice:supersecret");
  });

  it("renders exit_plan_mode plan as individual detail lines (FEATURE_074)", () => {
    const plan = [
      "Step 1: Refactor auth module",
      "Step 2: Update tests",
      "Step 3: Deploy to staging",
    ].join("\n");
    const display = buildToolConfirmationDisplay("exit_plan_mode", { plan });

    expect(display.title).toContain("Approve plan");
    expect(display.details).toEqual([
      "Step 1: Refactor auth module",
      "Step 2: Update tests",
      "Step 3: Deploy to staging",
    ]);
  });

  it("FEATURE_075: exit_plan_mode preserves full plan lines (no head+tail truncation)", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Step ${i + 1}: action ${i + 1}`);
    const plan = lines.join("\n");
    const display = buildToolConfirmationDisplay("exit_plan_mode", { plan });

    // All 60 lines preserved verbatim for readline native scroll;
    // InkREPL renders them in a scrollable DialogSurface panel.
    expect(display.details).toHaveLength(60);
    expect(display.details[0]).toBe("Step 1: action 1");
    expect(display.details[59]).toBe("Step 60: action 60");
    // No truncation notice should be injected.
    expect(display.details.some((line) => line.includes("more lines hidden"))).toBe(false);
  });

  it("falls back to title-only when exit_plan_mode plan is empty (FEATURE_074)", () => {
    const display = buildToolConfirmationDisplay("exit_plan_mode", { plan: "" });
    expect(display.title).toContain("Approve plan");
    expect(display.details).toEqual([]);
  });

  it("localizes confirmation display to Chinese", () => {
    setLocale("zh");

    const prompt = buildToolConfirmationPrompt("bash", { command: "ls" });
    expect(prompt).toContain("执行 bash 命令？");
    expect(prompt).toContain("意图: 读取项目文件");

    const display = buildToolConfirmationDisplay("write", {
      path: "/tmp/a.txt",
      _outsideProject: true,
    });
    expect(display.title).toBe("写入文件？");
    expect(display.details).toContain("意图: 写入文件");
    expect(display.details).toContain("范围: 项目外部");
  });
});
