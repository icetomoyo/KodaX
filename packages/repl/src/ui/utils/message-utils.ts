/**
 * Utilities for extracting message content for history rendering, copy, and previews.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
} from "@kodax-ai/agent";
import { ToolCallStatus, type CreatableHistoryItem, type ToolCall } from "../types.js";
import {
  sanitizeToolInput,
  stringifyToolReplayValue,
  truncateToolReplayText,
} from "./tool-sanitizer.js";

export type RestoredHistorySeed = (
  | { type: "user"; text: string; inputId?: string }
  | { type: "assistant"; text: string }
  | { type: "system"; text: string }
  | { type: "thinking"; text: string }
  | { type: "sidecar"; text: string; verdict?: "revise" | "blocked" }
  | { type: "task_completed"; text: string }
  | { type: "tool_summary"; text: string }
  | { type: "tool_group"; tools: KodaXSessionUiToolCall[] }
) & { timestamp?: number; outputId?: string };

/** Convert a RestoredHistorySeed to a CreatableHistoryItem. tool_summary / task_completed → event with icon. */
export function seedToHistoryItem(
  seed: RestoredHistorySeed,
): CreatableHistoryItem {
  if (seed.type === "tool_summary" || seed.type === "task_completed") {
    return {
      type: "event" as const,
      text: seed.text,
      icon: "tool",
      ...(seed.timestamp === undefined ? {} : { timestamp: seed.timestamp }),
    };
  }
  if (seed.type === "tool_group") {
    return {
      type: "tool_group",
      tools: seed.tools.map(toolCallSeedToHistoryToolCall),
      ...(seed.timestamp === undefined ? {} : { timestamp: seed.timestamp }),
    };
  }
  return seed;
}

const THINKING_OPEN_TAG = "[Thinking]";
const THINKING_CLOSE_TAG = "[/Thinking]";
const UNTITLED_SESSION_TITLE = "Untitled Session";
const SESSION_TITLE_MAX_LENGTH = 50;
const MESSAGE_PREVIEW_MAX_LENGTH = 60;
const TRUNCATION_SUFFIX = "...";
const CONTROL_PLANE_MARKERS = [
  "[Managed Task]",
  "[Managed Task Protocol Retry]",
  "Assigned native agent identity:",
  "Tool policy:",
  "Blocked tools:",
  "Allowed shell patterns:",
  "Dependency handoff artifacts:",
  "Dependency summary preview:",
  "Preferred agent:",
  "Read structured bundle first:",
  "Read human summary next:",
];
const CONTROL_PLANE_PATTERNS = [
  /(?:^|\n)You are the [^\n]+ role for a managed KodaX task\./,
  /(?:^|\n)Primary task:/,
  /(?:^|\n)Work intent:/,
  /(?:^|\n)Complexity:/,
  /(?:^|\n)Risk:/,
  /(?:^|\n)Harness:/,
  /(?:^|\n)Brainstorm required:/,
];
const LEGACY_THINKING_BLOCK_RE =
  /(^|\r?\n)\[Thinking\]\r?\n([\s\S]*?)\r?\n\[\/Thinking\](?=\r?\n|$)/g;
const INCOMPLETE_TOOL_ERROR = "Session ended before the tool completed.";

interface ToolResultSeed {
  status: KodaXSessionUiToolCallStatus;
  output?: string;
  error?: string;
}

function toolCallSeedToHistoryToolStatus(status: KodaXSessionUiToolCallStatus): ToolCallStatus {
  switch (status) {
    case "success":
      return ToolCallStatus.Success;
    case "error":
      return ToolCallStatus.Error;
    case "cancelled":
      return ToolCallStatus.Cancelled;
    case "awaiting_approval":
      return ToolCallStatus.AwaitingApproval;
    default: {
      const exhaustiveCheck: never = status;
      return exhaustiveCheck;
    }
  }
}

export function toolCallSeedToHistoryToolCall(tool: KodaXSessionUiToolCall): ToolCall {
  return {
    id: tool.id,
    name: tool.name,
    status: toolCallSeedToHistoryToolStatus(tool.status),
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.preview !== undefined ? { preview: tool.preview } : {}),
    ...(tool.output !== undefined ? { output: tool.output } : {}),
    ...(tool.error !== undefined ? { error: tool.error } : {}),
    startTime: tool.startTime ?? Date.now(),
    ...(tool.endTime !== undefined ? { endTime: tool.endTime } : {}),
  };
}

function findControlPlaneCutIndex(text: string): number {
  let cutIndex = -1;

  for (const marker of CONTROL_PLANE_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx >= 0 && (cutIndex === -1 || idx < cutIndex)) {
      cutIndex = idx;
    }
  }

  for (const pattern of CONTROL_PLANE_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index >= 0 && (cutIndex === -1 || match.index < cutIndex)) {
      cutIndex = match.index;
    }
  }

  return cutIndex;
}

function hasControlPlaneSignal(text: string): boolean {
  return CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker))
    || CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test(text));
}

function collectTextBlocks(content: readonly unknown[]): string[] {
  const textParts: string[] = [];

  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block
    ) {
      textParts.push(String(block.text));
    }
  }

  return textParts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultContentToString(content: unknown): string {
  if (typeof content === "string") {
    return truncateToolReplayText(content);
  }
  if (content === undefined) {
    return "";
  }
  try {
    return stringifyToolReplayValue(content) ?? "";
  } catch {
    return truncateToolReplayText(String(content));
  }
}

function inferToolResultSeed(block: Record<string, unknown>): ToolResultSeed {
  const content = toolResultContentToString(block.content);
  const trimmed = content.trimStart();
  const isError = block.is_error === true
    || trimmed.startsWith("[Tool Error]")
    || trimmed.startsWith("[Error]");
  const isCancelled = trimmed.startsWith("[Cancelled]")
    || trimmed.startsWith("[Blocked]");

  if (isError) {
    return { status: "error", error: content };
  }
  if (isCancelled) {
    return { status: "cancelled", error: content };
  }
  return { status: "success", output: content };
}

function collectToolResultSeeds(message: HistorySeedSourceMessage | undefined): Map<string, ToolResultSeed> {
  const results = new Map<string, ToolResultSeed>();
  if (!message || message.role !== "user" || !Array.isArray(message.content)) {
    return results;
  }

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      continue;
    }
    results.set(block.tool_use_id, inferToolResultSeed(block));
  }
  return results;
}

function buildToolCallSeed(
  block: Record<string, unknown>,
  toolResults: ReadonlyMap<string, ToolResultSeed>,
): KodaXSessionUiToolCall | undefined {
  if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") {
    return undefined;
  }

  const result = toolResults.get(block.id) ?? {
    status: "cancelled" as const,
    error: INCOMPLETE_TOOL_ERROR,
  };

  return {
    id: block.id,
    name: block.name,
    status: result.status,
    ...(block.input !== undefined ? { input: sanitizeToolInput(isRecord(block.input) ? block.input : {}) ?? {} } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

function extractAssistantTextOnly(content: string | readonly unknown[]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return collectTextBlocks(content).join("\n");
}

function pushSeed(
  items: RestoredHistorySeed[],
  type: Exclude<RestoredHistorySeed["type"], "tool_group">,
  text: string
): void {
  if (text.trim().length === 0) {
    return;
  }

  items.push({ type, text });
}

function stripLegacyTagBoundaryNewlines(text: string): string {
  return text.replace(/^\n+/, "").replace(/\n+$/, "");
}

function formatToolUseSummary(block: { name: string; input?: Record<string, unknown> }): string {
  const name = block.name;
  const input = block.input;
  if (!input) {
    return `⚡ ${name}`;
  }
  const hint = name === 'bash'
    ? truncateToolHint(String(input.command ?? ''))
    : name === 'read' || name === 'write' || name === 'edit'
      ? truncateToolHint(String(input.file_path ?? input.path ?? ''))
      : name === 'grep'
        ? truncateToolHint(String(input.pattern ?? ''))
        : name === 'glob'
          ? truncateToolHint(String(input.pattern ?? ''))
          : name === 'web_search' || name === 'web_fetch'
            ? truncateToolHint(String(input.query ?? input.url ?? ''))
            : undefined;
  return hint ? `⚡ ${name}(${hint})` : `⚡ ${name}`;
}

function truncateToolHint(value: string, max = 60): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function parseLegacyAssistantContent(content: string): RestoredHistorySeed[] {
  if (!content.includes(THINKING_OPEN_TAG) || !content.includes(THINKING_CLOSE_TAG)) {
    return content.trim().length > 0 ? [{ type: "assistant", text: content }] : [];
  }

  const items: RestoredHistorySeed[] = [];
  let cursor = 0;

  for (const match of content.matchAll(LEGACY_THINKING_BLOCK_RE)) {
    const matchIndex = match.index ?? -1;
    const boundaryPrefix = match[1] ?? "";
    const thinkingContent = match[2] ?? "";

    if (matchIndex < 0) {
      continue;
    }

    const blockStart = matchIndex + boundaryPrefix.length;
    pushSeed(
      items,
      "assistant",
      stripLegacyTagBoundaryNewlines(content.slice(cursor, blockStart))
    );
    pushSeed(items, "thinking", thinkingContent);
    cursor = matchIndex + match[0].length;
  }

  pushSeed(items, "assistant", stripLegacyTagBoundaryNewlines(content.slice(cursor)));
  if (items.length === 0) {
    return content.trim().length > 0 ? [{ type: "assistant", text: content }] : [];
  }
  return items;
}

function extractAssistantHistorySeeds(
  content: string | readonly unknown[],
  toolResults?: ReadonlyMap<string, ToolResultSeed>,
  identified = false,
): RestoredHistorySeed[] {
  if (typeof content === "string") {
    return identified ? (content.length > 0 ? [{ type: 'assistant', text: content }] : []) : parseLegacyAssistantContent(content);
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const items: RestoredHistorySeed[] = [];
  const textBuffer: string[] = [];
  const toolBuffer: KodaXSessionUiToolCall[] = [];

  const flushAssistantBuffer = () => {
    if (textBuffer.length === 0) {
      return;
    }

    if (identified) items.push({ type: 'assistant', text: textBuffer.join('') });
    else pushSeed(items, "assistant", textBuffer.join("\n"));
    textBuffer.length = 0;
  };

  const flushToolBuffer = () => {
    if (toolBuffer.length === 0) {
      return;
    }

    items.push({ type: "tool_group", tools: [...toolBuffer] });
    toolBuffer.length = 0;
  };

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") {
      continue;
    }

    switch (block.type) {
      case "text":
        flushToolBuffer();
        if ("text" in block) {
          textBuffer.push(String(block.text));
        }
        break;
      case "thinking":
        flushAssistantBuffer();
        flushToolBuffer();
        if ("thinking" in block) {
          const previous = items.at(-1);
          if (identified && previous?.type === 'thinking') previous.text += String(block.thinking);
          else if (identified) items.push({ type: 'thinking', text: String(block.thinking) });
          else pushSeed(items, "thinking", String(block.thinking));
        }
        break;
      case "tool_use":
        flushAssistantBuffer();
        if (toolResults) {
          const tool = buildToolCallSeed(block, toolResults);
          if (tool) {
            toolBuffer.push(tool);
          }
        } else if (typeof block.name === "string") {
          const summary = formatToolUseSummary({
            name: block.name,
            ...(isRecord(block.input) ? { input: block.input } : {}),
          });
          if (summary) {
            items.push({ type: "tool_summary", text: summary });
          }
        }
        break;
      case "tool_result":
      case "redacted_thinking":
        break;
      default:
        break;
    }
  }

  flushToolBuffer();
  flushAssistantBuffer();
  return items;
}

/**
 * Minimal message shape required to restore UI history items.
 */
export interface HistorySeedSourceMessage {
  outputId?: string;
  inputId?: string;
  role: KodaXMessage["role"];
  content: string | KodaXContentBlock[];
  timestamp?: string;
  _synthetic?: boolean;
  /**
   * Provenance marker persisted on host-injected messages. `'sidecar-verifier'`
   * tags the synthetic user message the Sidecar Verifier injects on a `revise`
   * verdict; `'agent-completed'` tags a synthetic actor-result notification.
   * Legacy `'task-completed'` values are still accepted while restoring older
   * sessions. Both render under their own identity instead of being swallowed
   * by the generic `_synthetic` skip.
   */
  _source?: string;
}

/**
 * Extract UI history seeds from a persisted message.
 * Assistant messages preserve thinking blocks as dedicated history items so
 * restored sessions render with the same styling as live thinking output.
 */
// Markers that identify internal managed task worker prompts (never user-visible).
const MANAGED_WORKER_PROMPT_MARKERS = [
  'You are the Scout role',
  'You are the Generator role',
  'You are the Planner role',
  'You are the Evaluator role',
];

// Protocol fenced blocks that should be stripped from assistant text during session restore.
const MANAGED_PROTOCOL_BLOCK_PATTERN = /\r?\n?\`\`\`kodax[\w-]*[\s\S]*?\`\`\`\s*/g;

function isManagedWorkerPrompt(text: string): boolean {
  return MANAGED_WORKER_PROMPT_MARKERS.some((marker) => text.includes(marker));
}

function stripManagedProtocolBlocks(text: string): string {
  return text.replace(MANAGED_PROTOCOL_BLOCK_PATTERN, '').trim();
}

function extractHistorySeedsFromMessageWithoutTimestamp(
  message: HistorySeedSourceMessage,
): RestoredHistorySeed[] {
  switch (message.role) {
    case "assistant": {
      const seeds = extractAssistantHistorySeeds(message.content, undefined, message.outputId !== undefined);
      if (message.outputId) return seeds;
      // Strip protocol blocks from assistant text; drop seeds that become empty.
      return seeds.flatMap((seed): RestoredHistorySeed[] => {
        if (seed.type !== "assistant") {
          return [seed];
        }
        const text = stripManagedProtocolBlocks(seed.text);
        // Drop empty + bare '...' placeholder seeds (legacy pre-fix sessions
        // persisted '...'); they must not restore as a fake assistant bubble.
        return text.length > 0 && text.trim() !== "..." ? [{ ...seed, text }] : [];
      });
    }
    case "user": {
      // Sidecar Verifier `revise` feedback is persisted as a synthetic user
      // message (_source: 'sidecar-verifier') so the Worker reanimates on it.
      // On restore it must render under the Sidecar identity — not as a user
      // bubble, and not dropped by the generic _synthetic skip below. Only
      // `revise` is ever persisted this way (accept injects no message;
      // blocked / budget-exhausted target the user, not the main agent), so the
      // restored verdict is always `revise`.
      if (message._source === "sidecar-verifier") {
        const sidecarText = extractTextContent(message.content).trim();
        return sidecarText
          ? [{ type: "sidecar", text: sidecarText, verdict: "revise" }]
          : [];
      }
      // Actor results are synthetic transcript messages. A headless SDK host
      // (no uiHistory) must recover them at their transcript position instead of
      // losing them to the generic _synthetic skip below. Accept the old marker
      // for persisted sessions created before Actor unification.
      if (message._source === "agent-completed" || message._source === "task-completed") {
        const completedText = extractTextContent(message.content).trim();
        return completedText ? [{ type: "task_completed", text: completedText }] : [];
      }
      // Skip synthetic messages (auto-continue, retry prompts injected by the system).
      if (message._synthetic) {
        return [];
      }
      const content = extractTextContent(message.content);
      // Skip internal worker prompts (Scout/Generator/Planner/Evaluator role instructions).
      if (content.trim().length === 0 || isManagedWorkerPrompt(content)) {
        return [];
      }
      return [{ type: "user", text: content }];
    }
    case "system": {
      // ISSUE_<TBD> (v0.7.37+): system messages in KodaX are LLM-internal
      // scaffolding (Scout/Generator/Planner/Evaluator role-prompts,
      // capability-sections, AMA controller metadata, repo-intelligence
      // snapshots) — never user-facing. On `kodax -c` / session restore,
      // re-rendering these as "System [HH:MM]" transcript bubbles leaks
      // the entire prior task's role-prompt to the user. Filter them out
      // entirely. Live-session user-visible banners go through
      // `addHistoryItem` directly, not this restore path.
      return [];
    }
    default:
      return [];
  }
}

function withMessageTimestamp(
  seeds: readonly RestoredHistorySeed[],
  timestamp: string | undefined,
): RestoredHistorySeed[] {
  if (timestamp === undefined) return [...seeds];
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || parsed < 0) return [...seeds];
  return seeds.map((seed) => ({ ...seed, timestamp: parsed }));
}

export function extractHistorySeedsFromMessage(
  message: HistorySeedSourceMessage,
): RestoredHistorySeed[] {
  return withMessageTimestamp(extractHistorySeedsFromMessageWithoutTimestamp(message), message.timestamp)
    .map(seed => seed.type === "user" && message.inputId !== undefined
      ? { ...seed, inputId: message.inputId }
      : message.outputId && (seed.type === 'assistant' || seed.type === 'thinking')
        ? { ...seed, outputId: message.outputId } : seed);
}

export function extractHistorySeedsFromMessages(
  messages: readonly HistorySeedSourceMessage[],
): RestoredHistorySeed[] {
  const seeds: RestoredHistorySeed[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    if (message.role === "assistant") {
      const toolResults = collectToolResultSeeds(messages[index + 1]);
      const assistantSeeds = withMessageTimestamp(
        extractAssistantHistorySeeds(message.content, toolResults, message.outputId !== undefined),
        message.timestamp,
      );
      seeds.push(
        ...assistantSeeds
          .map((seed) => (
            message.outputId && (seed.type === 'assistant' || seed.type === 'thinking')
              ? { ...seed, outputId: message.outputId }
              : seed.type === "assistant"
              ? { ...seed, text: stripManagedProtocolBlocks(seed.text) }
              : seed
          ))
          // Drop empty + bare '...' placeholder assistant seeds (legacy
          // pre-fix sessions); they must not restore as a fake assistant bubble.
          .filter((seed) => seed.type !== "assistant" || (seed.text.length > 0 && (message.outputId !== undefined || seed.text.trim() !== "..."))),
      );
      continue;
    }

    seeds.push(...extractHistorySeedsFromMessage(message));
  }

  return seeds;
}

/**
 * Extract plain text from message content.
 * Thinking/tool blocks are omitted so callers get only visible assistant text.
 */
export function extractTextContent(content: string | readonly unknown[]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return collectTextBlocks(content).join("\n");
}

function formatSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return UNTITLED_SESSION_TITLE;
  }

  return normalized.length > SESSION_TITLE_MAX_LENGTH
    ? `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH)}${TRUNCATION_SUFFIX}`
    : normalized;
}

/**
 * A user message whose content is ONLY tool_result block(s) — the trailing
 * turn that legitimately follows the final assistant answer.
 */
function isPureToolResultUserMessage(message: KodaXMessage): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (b) => !!b && typeof b === "object" && "type" in b && (b as { type: string }).type === "tool_result",
  );
}

/**
 * Extract the MOST-RECENT assistant text from a message list. We skip only a
 * trailing pure-tool_result user turn (the answer sits just before it); any
 * other trailing message — a normal user prompt or system — stops the search
 * and yields "". A bare '...' placeholder (legacy) or empty marker also yields
 * "". This must NOT punch back to an earlier turn's answer: in a resumed
 * session that earlier turn answered a DIFFERENT question, so resurfacing it
 * would mislabel a stale answer as the current reply.
 */
export function extractLastAssistantText(messages: KodaXMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) {
      continue;
    }
    if (msg.role === "assistant") {
      const content = extractAssistantTextOnly(msg.content);
      return content && content.trim() !== "..." ? content : "";
    }
    if (isPureToolResultUserMessage(msg)) {
      continue;
    }
    return "";
  }

  return "";
}

/**
 * Prefer the final assistant message stored in context over the streamed buffer.
 * This keeps UI history aligned with persisted messages and /copy output.
 */
export function resolveAssistantHistoryText(
  messages: KodaXMessage[],
  streamedText: string
): string {
  return extractLastAssistantText(messages) || streamedText.trim();
}

/**
 * Resolve the final assistant text for a completed round.
 * Prefer persisted assistant content first, then streamed text,
 * and only fall back to managed-task metadata summaries when no
 * full assistant body is available.
 */
export function resolveCompletedAssistantText(
  messages: KodaXMessage[],
  streamedText: string,
  managedSummary?: string,
  lastText?: string
): string {
  const candidates = [
    extractLastAssistantText(messages),
    streamedText.trim(),
    managedSummary?.trim() ?? "",
    lastText?.trim() ?? "",
  ];
  for (const candidate of candidates) {
    const sanitized = sanitizeUserFacingAssistantText(candidate);
    if (sanitized) {
      return sanitized;
    }
  }
  return "";
}

export function sanitizeUserFacingAssistantText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  // A bare empty-content placeholder ('...' from legacy pre-fix sessions) is
  // not a real reply. New sessions use an empty text block (caught above).
  if (trimmed === "...") {
    return "";
  }

  const cutIndex = findControlPlaneCutIndex(trimmed);

  if (cutIndex === 0) {
    return "";
  }

  return (cutIndex > 0 ? trimmed.slice(0, cutIndex) : trimmed).trim();
}

export function isControlPlaneOnlyAssistantText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0
    && sanitizeUserFacingAssistantText(trimmed).length === 0
    && hasControlPlaneSignal(trimmed);
}

/**
 * Extract a session title from the first user message.
 */
export function extractTitle(messages: KodaXMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const content = firstUser ? extractTextContent(firstUser.content) : "";
  return formatSessionTitle(content);
}

/**
 * Format a single-line preview for session lists.
 */
export function formatMessagePreview(
  content: string,
  maxLength = MESSAGE_PREVIEW_MAX_LENGTH
): string {
  const preview = content.replace(/\n/g, " ");
  const ellipsis = preview.length > maxLength ? TRUNCATION_SUFFIX : "";
  return preview.slice(0, maxLength) + ellipsis;
}
