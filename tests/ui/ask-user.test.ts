import { describe, expect, it } from "vitest";
import type { AskUserQuestionOptions } from "../../packages/coding/src/types.js";
import {
  getAskUserDialogTitle,
  isPlanHandoffRequest,
  resolveAskUserDefaultChoice,
  shouldSwitchToAcceptEdits,
  toSelectOptions,
} from "../../packages/repl/src/ui/utils/ask-user.js";

function createPlanHandoffOptions(): AskUserQuestionOptions {
  return {
    question: "Plan is complete. Start editing?",
    options: [
      {
        label: "Enter implementation",
        description: "Switch this session to accept-edits and continue.",
        value: "accept-edits",
      },
      {
        label: "Stay in plan mode",
        description: "Keep the session read-only.",
        value: "stay-plan",
      },
    ],
    default: "stay-plan",
    intent: "plan-handoff",
    targetMode: "accept-edits",
    scope: "session",
    resumeBehavior: "continue",
  };
}

describe("ask-user plan handoff helpers", () => {
  it("recognizes supported plan handoff requests", () => {
    expect(isPlanHandoffRequest(createPlanHandoffOptions())).toBe(true);
  });

  it("keeps generic ask_user_question requests generic", () => {
    expect(
      isPlanHandoffRequest({
        question: "Choose one",
        options: [{ label: "A", value: "a" }],
      }),
    ).toBe(false);
  });

  it("defaults to the first option (accept) for plan handoff on empty Enter", () => {
    expect(resolveAskUserDefaultChoice(createPlanHandoffOptions())).toBe("accept-edits");
  });

  it("prefers an explicit cancel option when dismissing generic questions", () => {
    expect(
      resolveAskUserDefaultChoice({
        question: "Proceed?",
        options: [
          { label: "Apply", value: "apply" },
          { label: "Cancel", value: "cancel" },
        ],
      }),
    ).toBe("cancel");
  });

  it("returns an empty choice when dismissing generic questions without cancel", () => {
    expect(
      resolveAskUserDefaultChoice({
        question: "Proceed?",
        options: [
          { label: "Apply", value: "apply" },
          { label: "Manual edit", value: "manual" },
        ],
        default: "apply",
      }),
    ).toBe("");
  });

  it("switches to accept-edits only for supported plan handoff approvals", () => {
    const options = createPlanHandoffOptions();

    expect(shouldSwitchToAcceptEdits("plan", options, "accept-edits")).toBe(true);
    expect(shouldSwitchToAcceptEdits("accept-edits", options, "accept-edits")).toBe(false);
    expect(shouldSwitchToAcceptEdits("plan", options, "stay-plan")).toBe(false);
  });

  it("uses the LLM-provided question text directly for dialog title", () => {
    expect(getAskUserDialogTitle(createPlanHandoffOptions())).toBe("Plan is complete. Start editing?");
  });

  it("preserves labels and descriptions for Ink select dialogs", () => {
    expect(toSelectOptions(createPlanHandoffOptions().options)).toEqual([
      {
        label: "Enter implementation",
        description: "Switch this session to accept-edits and continue.",
        value: "accept-edits",
      },
      {
        label: "Stay in plan mode",
        description: "Keep the session read-only.",
        value: "stay-plan",
      },
    ]);
  });
});
