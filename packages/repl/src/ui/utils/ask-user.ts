import type { AskUserQuestionOptions } from "@kodax/coding";
import type { PermissionMode } from "../../permission/types.js";

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

export function toSelectOptions(
  options: AskUserQuestionOptions["options"],
): SelectOption[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description,
  }));
}

export function isPlanHandoffRequest(
  options: AskUserQuestionOptions,
): boolean {
  return (
    options.intent === "plan-handoff" &&
    options.targetMode === "accept-edits" &&
    options.scope === "session" &&
    options.resumeBehavior === "continue"
  );
}

export function getAskUserDialogTitle(
  options: AskUserQuestionOptions,
): string {
  // Use the LLM-provided question text directly — it matches the user's language.
  return options.question;
}

export function resolveAskUserDefaultChoice(
  options: AskUserQuestionOptions,
): string {
  // Plan-handoff: empty Enter defaults to the FIRST option (accept/switch),
  // not the last (cancel). This matches user expectation: press Enter to confirm.
  if (isPlanHandoffRequest(options)) {
    return options.options[0]?.value ?? "";
  }

  const cancelOption = options.options.find((option) => {
    const label = option.label.trim().toLowerCase();
    const value = option.value.trim().toLowerCase();
    return label === "cancel" || value === "cancel";
  });

  return cancelOption?.value ?? "";
}

export function shouldSwitchToAcceptEdits(
  currentMode: PermissionMode,
  options: AskUserQuestionOptions,
  selectedValue: string,
): boolean {
  if (currentMode !== "plan" || !isPlanHandoffRequest(options)) {
    return false;
  }

  // Case 1: An option has value === targetMode ("accept-edits").
  // The LLM correctly set the accept option's value. Strict match.
  if (options.options.some((o) => o.value === options.targetMode)) {
    return selectedValue === options.targetMode;
  }

  // Case 2: LLM used arbitrary values (value falls back to label text).
  // Plan-handoff is a confirmation: switch unless the user picked the
  // dismiss (last) option.  Convention: accept = first, cancel = last.
  const lastOption = options.options[options.options.length - 1];
  return selectedValue !== (lastOption?.value ?? "");
}
