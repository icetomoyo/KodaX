import { describe, expect, it } from "vitest";
import type { AskUserQuestionOptions } from "../../packages/coding/src/types.js";
import {
  getAskUserDialogTitle,
  resolveAskUserDefaultChoice,
  toSelectOptions,
} from "../../packages/repl/src/ui/utils/ask-user.js";

describe("ask-user helpers", () => {
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

  it("uses the LLM-provided question text directly for dialog title", () => {
    const options: AskUserQuestionOptions = {
      question: "Plan is complete. Start editing?",
      options: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
    };
    expect(getAskUserDialogTitle(options)).toBe("Plan is complete. Start editing?");
  });

  it("preserves labels and descriptions for Ink select dialogs", () => {
    const options: AskUserQuestionOptions = {
      question: "Choose",
      options: [
        {
          label: "Enter implementation",
          description: "Switch this session to accept-edits.",
          value: "accept-edits",
        },
        {
          label: "Stay in plan mode",
          description: "Keep the session read-only.",
          value: "stay-plan",
        },
      ],
    };
    expect(toSelectOptions(options.options)).toEqual([
      {
        label: "Enter implementation",
        description: "Switch this session to accept-edits.",
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
