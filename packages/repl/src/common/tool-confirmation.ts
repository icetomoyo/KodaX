import { isBashReadCommand, isBashWriteCommand } from "../permission/permission.js";
import { t } from "./i18n.js";

const SUMMARY_MAX_LENGTH = 100;
const NETWORK_COMMAND_PATTERN = /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i;
const DELETE_COMMAND_PATTERN = /\b(rm|del|erase|remove-item|rmdir|rd|git clean)\b/i;
const ENVIRONMENT_COMMAND_PATTERN = /\b(npm|pnpm|yarn|pip|choco|winget)\s+(install|add|remove|uninstall|update|upgrade|ci)\b/i;
const FILE_MODIFY_COMMAND_PATTERN = /\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|cp|mv|copy|move|ren|touch)\b/i;

export interface ToolConfirmationField {
  label: "Reason" | "Intent" | "Target" | "Scope" | "Risk" | "Summary";
  value: string;
}

export interface ToolConfirmationDisplay {
  title: string;
  fields: ToolConfirmationField[];
  details: string[];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pushField(
  fields: ToolConfirmationField[],
  label: ToolConfirmationField["label"],
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  fields.push({ label, value });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const headLength = Math.ceil((maxLength - 3) / 2);
  const tailLength = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, headLength)}...${value.slice(value.length - tailLength)}`;
}

function maskSensitiveSegments(value: string): string {
  let masked = value;

  masked = masked.replace(
    /\b(authorization\s*:\s*bearer\s+)([^\s'"]+)/gi,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
  );
  masked = masked.replace(
    /\b((?:authorization|cookie)\s*:\s*)([^'"]+)/gi,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
  );
  masked = masked.replace(
    /\b(bearer\s+)([^\s'"]+)/gi,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
  );
  masked = masked.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie|session)\b(\s*[:=]\s*)(['"]?)([^'"\s]+)(\3)/gi,
    (_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}[REDACTED]${quote}`,
  );
  masked = masked.replace(
    /(--(?:api-key|token|secret|password|cookie)\s+)(\S+)/gi,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
  );
  masked = masked.replace(
    /((?:-u|--user)\s+)(\S+)/gi,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
  );

  return masked;
}

function summarizeCommand(command: string): string {
  return truncateMiddle(maskSensitiveSegments(normalizeWhitespace(command)), SUMMARY_MAX_LENGTH);
}

function classifyShellIntent(command: string): string {
  if (isBashReadCommand(command)) {
    return t("intent.read");
  }
  if (DELETE_COMMAND_PATTERN.test(command)) {
    return t("intent.delete");
  }
  if (ENVIRONMENT_COMMAND_PATTERN.test(command)) {
    return t("intent.deps");
  }
  if (isBashWriteCommand(command) || FILE_MODIFY_COMMAND_PATTERN.test(command)) {
    return t("intent.modify");
  }
  return t("intent.execute");
}

function classifyShellRisks(command: string): string[] {
  const risks: string[] = [];

  if (DELETE_COMMAND_PATTERN.test(command)) {
    risks.push(t("risk.destructive"));
  } else if (ENVIRONMENT_COMMAND_PATTERN.test(command)) {
    risks.push(t("risk.deps"));
  } else if (isBashWriteCommand(command) || FILE_MODIFY_COMMAND_PATTERN.test(command)) {
    risks.push(t("risk.modify"));
  } else if (!isBashReadCommand(command)) {
    risks.push(t("risk.unknown"));
  }

  if (NETWORK_COMMAND_PATTERN.test(command)) {
    risks.push(t("risk.network"));
  }

  return risks;
}

const FIELD_LABEL_KEYS: Record<ToolConfirmationField["label"], string> = {
  Reason: "field.reason",
  Intent: "field.intent",
  Target: "field.target",
  Scope: "field.scope",
  Risk: "field.risk",
  Summary: "field.summary",
};

function localizeFieldLabel(label: ToolConfirmationField["label"]): string {
  return t(FIELD_LABEL_KEYS[label] as Parameters<typeof t>[0]);
}

/**
 * FEATURE_074: truncate a long plan for dialog display.
 *
 * Strategy: show head + tail with an ellipsis notice in the middle. Missing the
 * middle of a plan is recoverable — missing the tail (where the final verdict /
 * last step typically lives) is not, because the user can't tell if the plan
 * actually reaches a terminal state.
 *
 * FEATURE_075 removed the head+tail truncation: InkREPL renders the full plan
 * in a scrollable DialogSurface panel, and readline relies on native terminal
 * scroll. LLM-first prompt constraint in the exit_plan_mode tool description
 * keeps plans within ~40 lines as the primary defense.
 */

function buildDisplayFromFields(title: string, fields: ToolConfirmationField[]): ToolConfirmationDisplay {
  return {
    title,
    fields,
    details: fields.map((field) => `${localizeFieldLabel(field.label)}: ${field.value}`),
  };
}

export function buildToolConfirmationDisplay(
  tool: string,
  input: Record<string, unknown>,
): ToolConfirmationDisplay {
  if (tool === "confirm") {
    const message = readString(input._message);
    if (message) {
      return buildDisplayFromFields(message, []);
    }
  }

  // FEATURE_074/075: render the finalized plan so the user can read it before approving.
  //
  // Readline: receives the full plan as details (native terminal scroll handles
  // arbitrary length).
  //
  // InkREPL: ignores details for this tool; DialogSurface.planContent renders
  // the plan in a scrollable panel with approval buttons pinned (FEATURE_075).
  if (tool === "exit_plan_mode") {
    const plan = readString(input.plan);
    const title = "Approve plan? (exits plan mode → accept-edits)";
    if (plan) {
      return {
        title,
        fields: [],
        details: plan.split("\n"),
      };
    }
    return buildDisplayFromFields(title, []);
  }

  const fields: ToolConfirmationField[] = [];
  const path = readString(input.path);
  const command = readString(input.command);
  const reason = readString(input._reason) ?? readString(input.justification);
  const scope = input._outsideProject === true
    ? t("scope.outside")
    : input._alwaysConfirm === true
      ? t("scope.protected")
      : undefined;

  pushField(fields, "Reason", reason);

  switch (tool) {
    case "bash":
    case "shell_command": {
      if (command) {
        pushField(fields, "Intent", classifyShellIntent(command));
        pushField(fields, "Scope", scope);
        const risks = classifyShellRisks(command);
        if (risks.length > 0) {
          pushField(fields, "Risk", risks.join("; "));
        }
        pushField(fields, "Summary", summarizeCommand(command));
      } else {
        pushField(fields, "Scope", scope);
      }
      return buildDisplayFromFields(
        tool === "bash" ? t("tool.bash.title") : t("tool.shell.title"),
        fields,
      );
    }
    case "write":
      pushField(fields, "Intent", t("intent.write_file"));
      pushField(fields, "Target", path);
      pushField(fields, "Scope", scope);
      return buildDisplayFromFields(t("tool.write.title"), fields);
    case "edit":
      pushField(fields, "Intent", t("intent.edit_file"));
      pushField(fields, "Target", path);
      pushField(fields, "Scope", scope);
      return buildDisplayFromFields(t("tool.edit.title"), fields);
    default:
      pushField(fields, "Intent", t("intent.use_tool", { tool }));
      pushField(fields, "Target", path);
      pushField(fields, "Scope", scope);
      if (command) {
        pushField(fields, "Summary", summarizeCommand(command));
      }
      return buildDisplayFromFields(t("tool.generic.title", { tool }), fields);
  }
}

export function buildToolConfirmationPrompt(
  tool: string,
  input: Record<string, unknown>,
): string {
  const display = buildToolConfirmationDisplay(tool, input);
  return display.details.length > 0
    ? `${display.title}\n${display.details.join("\n")}`
    : display.title;
}
