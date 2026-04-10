import { ToolCallStatus, type ToolCall } from "../types.js";

type ToolInputValue = Record<string, unknown> | string | undefined;

export type ToolSummaryGroup = {
  tool: ToolCall;
  count: number;
};

export type ToolExplanationTone = "error" | "accent" | "primary" | "dim";

function truncateValue(value: string, maxLength = 120): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function extractFirstMeaningfulLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function splitDisplayToolName(toolName: string): { rolePrefix?: string; toolLabel: string } {
  const match = toolName.match(/^\[([^\]]+)\]\s+(.*)$/);
  if (!match) {
    return { toolLabel: toolName };
  }

  const role = match[1]?.trim();
  const rawLabel = match[2]?.trim() ?? toolName;
  const duplicatePrefixPattern = new RegExp(`^${role?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i");
  const toolLabel = rawLabel.replace(duplicatePrefixPattern, "").trim();

  return {
    rolePrefix: role ? `[${role}]` : undefined,
    toolLabel: toolLabel || rawLabel,
  };
}

function normalizeDisplayToolName(toolName: string): string {
  const { rolePrefix, toolLabel } = splitDisplayToolName(toolName);
  return rolePrefix ? `${rolePrefix} ${toolLabel}` : toolLabel;
}

function stripRolePrefix(toolName: string): string {
  return splitDisplayToolName(toolName).toolLabel;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readFirstString(record: Record<string, unknown> | undefined, ...fieldNames: string[]): string | undefined {
  for (const fieldName of fieldNames) {
    const value = readString(record?.[fieldName]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function extractPreview(input: ToolInputValue): string | undefined {
  if (typeof input === "string") {
    return input.trim() || undefined;
  }
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  return readString(record.preview) ?? undefined;
}

function parsePreviewRecord(preview: string | undefined): Record<string, unknown> | undefined {
  if (!preview) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(preview));
  } catch {
    return undefined;
  }
}

function extractFieldFromPreview(preview: string | undefined, fieldName: string): string | undefined {
  if (!preview) {
    return undefined;
  }
  const match = preview.match(new RegExp(`"${fieldName}"\\s*:\\s*"([^"]+)`));
  return match?.[1]?.trim() || undefined;
}

function extractNumberFromPreview(preview: string | undefined, fieldName: string): number | undefined {
  if (!preview) {
    return undefined;
  }
  const match = preview.match(new RegExp(`"${fieldName}"\\s*:\\s*(\\d+)`));
  return match?.[1] ? Number(match[1]) : undefined;
}

function extractPathsFromPreview(preview: string | undefined): string[] | undefined {
  if (!preview) {
    return undefined;
  }
  const listMatch = preview.match(/"paths"\s*:\s*\[([^\]]*)/);
  if (!listMatch?.[1]) {
    return undefined;
  }
  const paths = Array.from(listMatch[1].matchAll(/"([^"]+)"/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  return paths.length > 0 ? paths : undefined;
}

function resolveInputRecord(input: ToolInputValue): {
  record?: Record<string, unknown>;
  preview?: string;
} {
  const preview = extractPreview(input);
  if (typeof input === "string") {
    return {
      record: parsePreviewRecord(preview),
      preview,
    };
  }

  const inputRecord = asRecord(input);
  const parsedPreviewRecord = parsePreviewRecord(preview);
  if (!inputRecord) {
    return {
      record: parsedPreviewRecord,
      preview,
    };
  }

  if (parsedPreviewRecord) {
    return {
      record: {
        ...inputRecord,
        ...parsedPreviewRecord,
      },
      preview,
    };
  }

  return {
    record: inputRecord,
    preview,
  };
}

function pushPathSummary(
  parts: string[],
  record: Record<string, unknown> | undefined,
  preview: string | undefined,
  preferPathsArray = false,
): void {
  const explicitPath = readFirstString(record, "path", "target_path", "targetPath")
    ?? extractFieldFromPreview(preview, "path")
    ?? extractFieldFromPreview(preview, "target_path")
    ?? extractFieldFromPreview(preview, "targetPath");
  const paths = readStringArray(record?.paths) ?? extractPathsFromPreview(preview);

  if (preferPathsArray && paths?.length) {
    if (paths.length === 1) {
      parts.push(truncateValue(paths[0]));
    } else {
      parts.push(`${paths.length} files`);
    }
    return;
  }

  if (explicitPath) {
    parts.push(truncateValue(explicitPath));
    return;
  }

  if (paths?.length) {
    if (paths.length === 1) {
      parts.push(truncateValue(paths[0]));
    } else {
      parts.push(`${paths.length} files`);
    }
  }
}

function pushNumericSummary(parts: string[], label: string, value: number | undefined): void {
  if (value !== undefined) {
    parts.push(`${label}=${value}`);
  }
}

function pushRangeSummary(
  parts: string[],
  record: Record<string, unknown> | undefined,
  preview: string | undefined,
): void {
  const baseRef = readFirstString(record, "baseRef", "base_ref")
    ?? extractFieldFromPreview(preview, "baseRef")
    ?? extractFieldFromPreview(preview, "base_ref");
  const targetRef = readFirstString(record, "targetRef", "target_ref")
    ?? extractFieldFromPreview(preview, "targetRef")
    ?? extractFieldFromPreview(preview, "target_ref");

  if (baseRef && targetRef) {
    parts.push(truncateValue(`${baseRef}...${targetRef}`, 88));
  }
}

function summarizeToolDetails(toolName: string, input: ToolInputValue): string[] {
  const { record, preview } = resolveInputRecord(input);
  const baseToolName = stripRolePrefix(toolName).toLowerCase();
  const parts: string[] = [];

  if (baseToolName.includes("changed_diff_bundle")) {
    const paths = readStringArray(record?.paths) ?? extractPathsFromPreview(preview);
    if (paths?.length) {
      parts.push(paths.length === 1 ? truncateValue(paths[0]) : `${paths.length} files`);
      if (paths.length > 1) {
        parts.push(truncateValue(paths[0]));
      }
    } else {
      pushPathSummary(parts, record, preview, true);
    }
    const limit = readNumber(record?.limit_per_path)
      ?? readNumber(record?.limitPerPath)
      ?? extractNumberFromPreview(preview, "limit_per_path")
      ?? extractNumberFromPreview(preview, "limitPerPath");
    if (limit !== undefined) {
      parts.push(`limit=${limit}`);
    }
    pushRangeSummary(parts, record, preview);
    return parts;
  }

  if (baseToolName.includes("changed_diff")) {
    pushPathSummary(parts, record, preview);
    pushNumericSummary(
      parts,
      "offset",
      readNumber(record?.offset) ?? extractNumberFromPreview(preview, "offset"),
    );
    pushNumericSummary(
      parts,
      "limit",
      readNumber(record?.limit) ?? extractNumberFromPreview(preview, "limit"),
    );
    pushRangeSummary(parts, record, preview);
    return parts;
  }

  if (baseToolName === "read" || baseToolName.includes("read_")) {
    pushPathSummary(parts, record, preview);
    pushNumericSummary(
      parts,
      "offset",
      readNumber(record?.offset) ?? extractNumberFromPreview(preview, "offset"),
    );
    pushNumericSummary(
      parts,
      "limit",
      readNumber(record?.limit) ?? extractNumberFromPreview(preview, "limit"),
    );
    return parts;
  }

  if (baseToolName.includes("changed_scope")) {
    pushPathSummary(parts, record, preview, true);
    pushRangeSummary(parts, record, preview);
    return parts;
  }

  if (baseToolName.includes("repo_overview")) {
    pushPathSummary(parts, record, preview);
    return parts;
  }

  if (baseToolName.includes("bash") || baseToolName.includes("shell_command")) {
    const command = readFirstString(record, "command")
      ?? extractFieldFromPreview(preview, "command");
    if (command) {
      parts.push(`cmd=${truncateValue(command, 140)}`);
    }
    return parts;
  }

  if (baseToolName === "glob" || baseToolName.includes("glob_")) {
    const pattern = readFirstString(record, "pattern")
      ?? extractFieldFromPreview(preview, "pattern");
    const scope = readFirstString(record, "path", "root", "directory", "cwd")
      ?? extractFieldFromPreview(preview, "path")
      ?? extractFieldFromPreview(preview, "root")
      ?? extractFieldFromPreview(preview, "directory")
      ?? extractFieldFromPreview(preview, "cwd");
    if (pattern) {
      parts.push(`pattern=${truncateValue(pattern, 96)}`);
    }
    if (scope) {
      parts.push(truncateValue(scope));
    }
    return parts;
  }

  if (baseToolName === "grep" || baseToolName.includes("grep_")) {
    const pattern = readFirstString(record, "pattern", "query")
      ?? extractFieldFromPreview(preview, "pattern")
      ?? extractFieldFromPreview(preview, "query");
    const scope = readFirstString(record, "path", "root", "directory", "cwd")
      ?? extractFieldFromPreview(preview, "path")
      ?? extractFieldFromPreview(preview, "root")
      ?? extractFieldFromPreview(preview, "directory")
      ?? extractFieldFromPreview(preview, "cwd");
    if (pattern) {
      parts.push(`pattern=${truncateValue(pattern, 96)}`);
    }
    if (scope) {
      parts.push(truncateValue(scope));
    }
    return parts;
  }

  if (baseToolName === "web_fetch") {
    const url = readFirstString(record, "url")
      ?? extractFieldFromPreview(preview, "url");
    const providerId = readFirstString(record, "provider_id", "providerId")
      ?? extractFieldFromPreview(preview, "provider_id")
      ?? extractFieldFromPreview(preview, "providerId");
    const capabilityId = readFirstString(record, "capability_id", "capabilityId")
      ?? extractFieldFromPreview(preview, "capability_id")
      ?? extractFieldFromPreview(preview, "capabilityId");
    if (url) {
      parts.push(truncateValue(url, 120));
    }
    if (providerId) {
      parts.push(`provider=${truncateValue(providerId, 48)}`);
    }
    if (capabilityId) {
      parts.push(`cap=${truncateValue(capabilityId, 48)}`);
    }
    return parts;
  }

  if (baseToolName === "mcp_describe" || baseToolName === "mcp_read_resource") {
    const id = readFirstString(record, "id")
      ?? extractFieldFromPreview(preview, "id");
    if (id) {
      parts.push(truncateValue(id, 120));
    }
    return parts;
  }

  if (baseToolName === "mcp_call") {
    const id = readFirstString(record, "id")
      ?? extractFieldFromPreview(preview, "id");
    const argsRecord = asRecord(record?.args);
    const argCount = argsRecord ? Object.keys(argsRecord).length : undefined;
    if (id) {
      parts.push(truncateValue(id, 120));
    }
    if (argCount !== undefined) {
      parts.push(`args=${argCount}`);
    }
    return parts;
  }

  if (baseToolName === "mcp_search") {
    const query = readFirstString(record, "query")
      ?? extractFieldFromPreview(preview, "query");
    const server = readFirstString(record, "server")
      ?? extractFieldFromPreview(preview, "server");
    const kind = readFirstString(record, "kind")
      ?? extractFieldFromPreview(preview, "kind");
    const limit = readNumber(record?.limit)
      ?? extractNumberFromPreview(preview, "limit");
    if (query) {
      parts.push(`query=${truncateValue(query, 96)}`);
    }
    if (server) {
      parts.push(`server=${truncateValue(server, 48)}`);
    }
    if (kind) {
      parts.push(`kind=${kind}`);
    }
    if (limit !== undefined) {
      parts.push(`limit=${limit}`);
    }
    return parts;
  }

  if (baseToolName === "web_search" || baseToolName === "code_search" || baseToolName === "semantic_lookup") {
    const query = readFirstString(record, "query", "pattern")
      ?? extractFieldFromPreview(preview, "query")
      ?? extractFieldFromPreview(preview, "pattern");
    const scope = readFirstString(record, "path", "target_path", "targetPath")
      ?? extractFieldFromPreview(preview, "path")
      ?? extractFieldFromPreview(preview, "target_path")
      ?? extractFieldFromPreview(preview, "targetPath");
    const providerId = readFirstString(record, "provider_id", "providerId")
      ?? extractFieldFromPreview(preview, "provider_id")
      ?? extractFieldFromPreview(preview, "providerId");
    const limit = readNumber(record?.limit)
      ?? extractNumberFromPreview(preview, "limit");
    if (query) {
      parts.push(`query=${truncateValue(query, 96)}`);
    }
    if (scope) {
      parts.push(truncateValue(scope, 72));
    }
    if (providerId) {
      parts.push(`provider=${truncateValue(providerId, 48)}`);
    }
    if (limit !== undefined) {
      parts.push(`limit=${limit}`);
    }
    return parts;
  }

  pushPathSummary(parts, record, preview, true);
  pushNumericSummary(
    parts,
    "offset",
    readNumber(record?.offset) ?? extractNumberFromPreview(preview, "offset"),
  );
  pushNumericSummary(
    parts,
    "limit",
    readNumber(record?.limit) ?? extractNumberFromPreview(preview, "limit"),
  );
  return parts;
}

function extractChangedDiffRange(output: string): string | undefined {
  const match = output.match(/Showing diff lines\s+(\d+)-(\d+)\s+of\s+(\d+)/i);
  if (!match) {
    return undefined;
  }
  return `${match[1]}-${match[2]}/${match[3]}`;
}

function extractDiffPreviewLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("@@"));
}

function formatChangedDiffExplanation(output: string): string[] {
  const lines: string[] = [];
  const range = extractChangedDiffRange(output);
  if (range) {
    const [window, total] = range.split("/");
    lines.push(total ? `Diff range: ${window} of ${total}` : `Diff range: ${range}`);
  }

  const preview = extractDiffPreviewLine(output);
  if (preview) {
    lines.push(`Preview: ${truncateValue(preview, 220)}`);
  }

  return lines;
}

function formatChangedDiffBundleExplanation(output: string): string[] {
  const lines: string[] = [];
  const fileCountMatch = output.match(/^Changed diff bundle for\s+(\d+)\s+file\(s\)/im);
  if (fileCountMatch?.[1]) {
    const count = Number(fileCountMatch[1]);
    if (Number.isFinite(count) && count > 0) {
      lines.push(`Bundle: ${count === 1 ? "1 file" : `${count} files`}`);
    }
  }

  const firstPathMatch = output.match(/^===\s+(.+?)\s+===/m);
  if (firstPathMatch?.[1]) {
    lines.push(`First file: ${truncateValue(firstPathMatch[1].trim(), 220)}`);
  }

  return lines;
}

function summarizeToolOutputDetails(toolName: string, output: string | undefined): string[] {
  if (!output) {
    return [];
  }

  const baseToolName = stripRolePrefix(toolName).toLowerCase();
  const parts: string[] = [];

  if (baseToolName.includes("changed_diff_bundle")) {
    const fileCountMatch = output.match(/^Changed diff bundle for\s+(\d+)\s+file\(s\)/im);
    if (fileCountMatch?.[1]) {
      const count = Number(fileCountMatch[1]);
      if (Number.isFinite(count) && count > 0) {
        parts.push(count === 1 ? "1 file" : `${count} files`);
      }
    }
    const firstPathMatch = output.match(/^===\s+(.+?)\s+===/m);
    if (firstPathMatch?.[1]) {
      parts.push(truncateValue(firstPathMatch[1].trim()));
    }
    return parts;
  }

  if (baseToolName.includes("changed_diff")) {
    const pathMatch = output.match(/^Changed diff for\s+(.+)$/im);
    if (pathMatch?.[1]) {
      parts.push(truncateValue(pathMatch[1].trim()));
    }
    const range = extractChangedDiffRange(output);
    if (range) {
      parts.push(range);
    }
    return parts;
  }

  if (baseToolName === "read" || baseToolName.includes("read_")) {
    const pathMatch = output.match(/^Reading\s+(.+)$/im);
    if (pathMatch?.[1]) {
      parts.push(truncateValue(pathMatch[1].trim()));
    }
    return parts;
  }

  return [];
}

function formatToolDetailSummary(toolName: string, details: string[]): string {
  const normalizedToolName = normalizeDisplayToolName(toolName);
  return details.length > 0
    ? `${normalizedToolName} - ${details.join(" - ")}`
    : normalizedToolName;
}

function formatDuration(startTime: number, endTime?: number): string | undefined {
  if (!endTime) {
    return undefined;
  }
  const ms = endTime - startTime;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatToolStatusDetail(tool: ToolCall): string | undefined {
  switch (tool.status) {
    case ToolCallStatus.Scheduled:
      return "scheduled";
    case ToolCallStatus.Validating:
      return "validating";
    case ToolCallStatus.AwaitingApproval:
      return "awaiting approval";
    case ToolCallStatus.Executing:
      return "running";
    case ToolCallStatus.Error:
      return "failed";
    case ToolCallStatus.Cancelled:
      return "cancelled";
    default:
      return undefined;
  }
}

function formatToolProgressExplanation(tool: ToolCall): string[] {
  switch (tool.status) {
    case ToolCallStatus.Scheduled:
      return ["Queued: waiting to start"];
    case ToolCallStatus.Validating:
      return ["Validating: checking inputs and policy"];
    case ToolCallStatus.AwaitingApproval:
      return ["Waiting: approval required before execution"];
    case ToolCallStatus.Executing:
      return tool.progress !== undefined
        ? [`Progress: ${tool.progress}% complete`]
        : ["Running: waiting for tool output"];
    case ToolCallStatus.Cancelled:
      return ["Cancelled before completion"];
    default:
      return [];
  }
}

export function resolveToolExplanationTone(line: string): ToolExplanationTone {
  if (line.startsWith("Error:")) {
    return "error";
  }
  if (line.startsWith("Waiting:")) {
    return "accent";
  }
  if (line.startsWith("Progress:") || line.startsWith("Running:")) {
    return "primary";
  }
  return "dim";
}

export function formatToolFailureExplanation(tool: ToolCall): string[] {
  const errorLine = extractFirstMeaningfulLine(tool.error);
  const outputLine = typeof tool.output === "string"
    ? extractFirstMeaningfulLine(tool.output)
    : undefined;
  const lines: string[] = [];

  if (errorLine) {
    lines.push(`Error: ${truncateValue(errorLine, 220)}`);
  }

  if (
    tool.status === ToolCallStatus.Error
    && outputLine
    && (!errorLine || outputLine.toLowerCase() !== errorLine.toLowerCase())
  ) {
    lines.push(`Last output: ${truncateValue(outputLine, 220)}`);
  }

  return lines;
}

export function formatToolResultExplanation(tool: ToolCall): string[] {
  if (typeof tool.output !== "string" || !tool.output.trim()) {
    return formatToolProgressExplanation(tool);
  }

  const baseToolName = stripRolePrefix(tool.name).toLowerCase();
  if (tool.status === ToolCallStatus.Error) {
    return formatToolFailureExplanation(tool);
  }

  if (tool.status !== ToolCallStatus.Success) {
    return formatToolProgressExplanation(tool);
  }

  if (baseToolName.includes("changed_diff_bundle")) {
    return formatChangedDiffBundleExplanation(tool.output);
  }

  if (baseToolName.includes("changed_diff")) {
    return formatChangedDiffExplanation(tool.output);
  }

  return [];
}

export function formatToolSummary(toolName: string, input?: ToolInputValue): string {
  return formatToolDetailSummary(toolName, summarizeToolDetails(toolName, input));
}

export function formatToolCallInlineText(tool: ToolCall): string {
  const outputDetails = typeof tool.output === "string"
    ? summarizeToolOutputDetails(tool.name, tool.output)
    : [];
  const summary = outputDetails.length > 0
    ? formatToolDetailSummary(tool.name, outputDetails)
    : formatToolSummary(tool.name, tool.input);
  const statusDetail = formatToolStatusDetail(tool);
  const duration = formatDuration(tool.startTime, tool.endTime);
  const progress = tool.status === ToolCallStatus.Executing && tool.progress !== undefined
    ? `${tool.progress}%`
    : undefined;
  const suffixParts = [statusDetail, progress, duration].filter(Boolean);
  return suffixParts.length > 0 ? `${summary} (${suffixParts.join(" - ")})` : summary;
}

export function collapseToolCalls(tools: readonly ToolCall[]): ToolSummaryGroup[] {
  const groups = new Map<string, ToolSummaryGroup>();

  for (const tool of tools) {
    const outputDetails = typeof tool.output === "string"
      ? summarizeToolOutputDetails(tool.name, tool.output)
      : [];
    const summary = outputDetails.length > 0
      ? formatToolDetailSummary(tool.name, outputDetails)
      : formatToolSummary(tool.name, tool.input);
    const key = `${summary}|${tool.error ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.tool = tool;
      existing.count += 1;
    } else {
      groups.set(key, { tool, count: 1 });
    }
  }

  return [...groups.values()];
}

export function formatCollapsedToolInlineText(group: ToolSummaryGroup): string {
  const inlineText = formatToolCallInlineText(group.tool);
  return group.count > 1 ? `${inlineText} x${group.count}` : inlineText;
}

export function formatLiveToolLabel(
  toolName: string,
  toolInputContent: string,
  toolInputCharCount: number,
): string {
  const summary = formatToolSummary(toolName, toolInputContent);
  if (summary !== normalizeDisplayToolName(toolName)) {
    return `[Tools] ${summary}`;
  }
  if (toolInputCharCount > 0) {
    return `[Tools] ${normalizeDisplayToolName(toolName)} (${toolInputCharCount} chars)`;
  }
  return `[Tools] ${normalizeDisplayToolName(toolName)}`;
}
