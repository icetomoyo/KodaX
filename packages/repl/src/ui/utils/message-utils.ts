/**
 * Utilities for extracting message content for history rendering, copy, and previews.
 */

import type { KodaXContentBlock, KodaXMessage } from "@kodax/coding";

export type RestoredHistorySeed =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "system"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_summary"; text: string };

/** Convert a RestoredHistorySeed to a CreatableHistoryItem. tool_summary → event with icon. */
export function seedToHistoryItem(
  seed: RestoredHistorySeed,
): { type: "user"; text: string } | { type: "assistant"; text: string } | { type: "system"; text: string } | { type: "thinking"; text: string } | { type: "event"; text: string; icon: string } {
  if (seed.type === "tool_summary") {
    return { type: "event" as const, text: seed.text, icon: "tool" };
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
  type: RestoredHistorySeed["type"],
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

function extractAssistantHistorySeeds(content: string | readonly unknown[]): RestoredHistorySeed[] {
  if (typeof content === "string") {
    return parseLegacyAssistantContent(content);
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const items: RestoredHistorySeed[] = [];
  const textBuffer: string[] = [];

  const flushAssistantBuffer = () => {
    if (textBuffer.length === 0) {
      return;
    }

    pushSeed(items, "assistant", textBuffer.join("\n"));
    textBuffer.length = 0;
  };

  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      continue;
    }

    switch (block.type) {
      case "text":
        if ("text" in block) {
          textBuffer.push(String(block.text));
        }
        break;
      case "thinking":
        flushAssistantBuffer();
        if ("thinking" in block) {
          pushSeed(items, "thinking", String(block.thinking));
        }
        break;
      case "tool_use":
        flushAssistantBuffer();
        if ("name" in block) {
          const summary = formatToolUseSummary(block as { name: string; input?: Record<string, unknown> });
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

  flushAssistantBuffer();
  return items;
}

/**
 * Minimal message shape required to restore UI history items.
 */
export interface HistorySeedSourceMessage {
  role: KodaXMessage["role"];
  content: string | KodaXContentBlock[];
  _synthetic?: boolean;
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

export function extractHistorySeedsFromMessage(message: HistorySeedSourceMessage): RestoredHistorySeed[] {
  switch (message.role) {
    case "assistant": {
      const seeds = extractAssistantHistorySeeds(message.content);
      // Strip protocol blocks from assistant text; drop seeds that become empty.
      return seeds
        .map((seed) => ({ ...seed, text: stripManagedProtocolBlocks(seed.text) }))
        .filter((seed) => seed.text.length > 0);
    }
    case "user": {
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
      const content = extractTextContent(message.content);
      return content.trim().length > 0 ? [{ type: "system", text: content }] : [];
    }
    default:
      return [];
  }
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
 * Extract the last assistant text from a message list.
 */
export function extractLastAssistantText(messages: KodaXMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") {
      continue;
    }

    const content = extractAssistantTextOnly(msg.content);
    if (content) {
      return content;
    }
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
