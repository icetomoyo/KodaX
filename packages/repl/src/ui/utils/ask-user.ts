import type { AskUserQuestionOptions } from "@kodax/coding";

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

export function toSelectOptions(
  options: AskUserQuestionOptions["options"],
): SelectOption[] {
  if (!options) return [];
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description,
  }));
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
  if (!options.options || options.options.length === 0) return "";

  const cancelOption = options.options.find((option) => {
    const label = option.label.trim().toLowerCase();
    const value = option.value.trim().toLowerCase();
    return label === "cancel" || value === "cancel";
  });

  return cancelOption?.value ?? "";
}
