import { isBashReadCommand, isBashWriteCommand } from "../permission/permission.js";

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
    return "Read project files";
  }
  if (DELETE_COMMAND_PATTERN.test(command)) {
    return "Delete files";
  }
  if (ENVIRONMENT_COMMAND_PATTERN.test(command)) {
    return "Modify dependencies or environment";
  }
  if (isBashWriteCommand(command) || FILE_MODIFY_COMMAND_PATTERN.test(command)) {
    return "Modify files";
  }
  return "Execute command";
}

function classifyShellRisks(command: string): string[] {
  const risks: string[] = [];

  if (DELETE_COMMAND_PATTERN.test(command)) {
    risks.push("Destructive change");
  } else if (ENVIRONMENT_COMMAND_PATTERN.test(command)) {
    risks.push("May change dependencies or local tools");
  } else if (isBashWriteCommand(command) || FILE_MODIFY_COMMAND_PATTERN.test(command)) {
    risks.push("May modify files");
  } else if (!isBashReadCommand(command)) {
    risks.push("Command effects depend on its arguments");
  }

  if (NETWORK_COMMAND_PATTERN.test(command)) {
    risks.push("May access network");
  }

  return risks;
}

function buildDisplayFromFields(title: string, fields: ToolConfirmationField[]): ToolConfirmationDisplay {
  return {
    title,
    fields,
    details: fields.map((field) => `${field.label}: ${field.value}`),
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

  const fields: ToolConfirmationField[] = [];
  const path = readString(input.path);
  const command = readString(input.command);
  const reason = readString(input._reason) ?? readString(input.justification);
  const scope = input._outsideProject === true
    ? "Outside project"
    : input._alwaysConfirm === true
      ? "Protected path"
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
        tool === "bash" ? "Execute bash command?" : "Execute shell command?",
        fields,
      );
    }
    case "write":
      pushField(fields, "Intent", "Write file");
      pushField(fields, "Target", path);
      pushField(fields, "Scope", scope);
      return buildDisplayFromFields("Write to file?", fields);
    case "edit":
      pushField(fields, "Intent", "Edit file");
      pushField(fields, "Target", path);
      pushField(fields, "Scope", scope);
      return buildDisplayFromFields("Edit file?", fields);
    default:
      pushField(fields, "Intent", `Use ${tool}`);
      pushField(fields, "Target", path);
      pushField(fields, "Scope", scope);
      if (command) {
        pushField(fields, "Summary", summarizeCommand(command));
      }
      return buildDisplayFromFields(`Execute ${tool}?`, fields);
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
