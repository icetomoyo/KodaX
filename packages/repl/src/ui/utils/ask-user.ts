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
  if (isPlanHandoffRequest(options)) {
    return "Plan complete. Switch this session to accept-edits and continue?";
  }

  return options.question;
}

export function resolveAskUserDismissChoice(
  options: AskUserQuestionOptions,
): string {
  if (isPlanHandoffRequest(options)) {
    const fallbackOption = options.options.find(
      (option) => option.value !== options.targetMode,
    );
    return (
      options.default ??
      fallbackOption?.value ??
      options.options[0]?.value ??
      ""
    );
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
  return (
    currentMode === "plan" &&
    isPlanHandoffRequest(options) &&
    selectedValue === options.targetMode
  );
}
