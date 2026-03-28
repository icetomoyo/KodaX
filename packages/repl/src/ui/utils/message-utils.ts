/**
 * Utilities for extracting message content for history rendering, copy, and previews.
 */

import type { KodaXContentBlock, KodaXMessage } from "@kodax/coding";

export type RestoredHistorySeed =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "system"; text: string }
  | { type: "thinking"; text: string };

const THINKING_OPEN_TAG = "[Thinking]";
const THINKING_CLOSE_TAG = "[/Thinking]";
const UNTITLED_SESSION_TITLE = "Untitled Session";
const SESSION_TITLE_MAX_LENGTH = 50;
const MESSAGE_PREVIEW_MAX_LENGTH = 60;
const TRUNCATION_SUFFIX = "...";
const LEGACY_THINKING_BLOCK_RE =
  /(^|\r?\n)\[Thinking\]\r?\n([\s\S]*?)\r?\n\[\/Thinking\](?=\r?\n|$)/g;

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
}

/**
 * Extract UI history seeds from a persisted message.
 * Assistant messages preserve thinking blocks as dedicated history items so
 * restored sessions render with the same styling as live thinking output.
 */
export function extractHistorySeedsFromMessage(message: HistorySeedSourceMessage): RestoredHistorySeed[] {
  switch (message.role) {
    case "assistant":
      return extractAssistantHistorySeeds(message.content);
    case "user": {
      const content = extractTextContent(message.content);
      return content.trim().length > 0 ? [{ type: "user", text: content }] : [];
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
  return resolveAssistantHistoryText(messages, streamedText)
    || managedSummary?.trim()
    || lastText?.trim()
    || "";
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
