import type { HistoryItem, HistoryItemToolGroup } from "../types.js";

export interface TranscriptSearchMatch {
  itemId: string;
  itemIndex: number;
  excerpt: string;
}

export interface TranscriptSearchIndexEntry {
  itemId: string;
  itemIndex: number;
  searchText: string;
}

export interface TranscriptSelectionSummary {
  summary: string;
  kindLabel: string;
}

function buildSearchText(item: HistoryItem): string {
  switch (item.type) {
    case "tool_group":
      return item.tools
        .map((tool) => {
          const parts = [tool.name];
          if (typeof tool.output === "string") {
            parts.push(tool.output);
          }
          if (tool.error) {
            parts.push(tool.error);
          }
          return parts.join("\n");
        })
        .join("\n");
    case "assistant":
    case "user":
    case "system":
    case "thinking":
    case "error":
    case "info":
    case "hint":
      return item.text;
    default:
      return "";
  }
}

function buildExcerpt(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const lowerText = normalized.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);
  if (matchIndex === -1) {
    return normalized.slice(0, 120);
  }

  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(normalized.length, matchIndex + query.length + 60);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

export function searchTranscriptItems(
  items: HistoryItem[],
  query: string,
): TranscriptSearchMatch[] {
  return searchTranscriptIndex(createTranscriptSearchIndex(items), query);
}

export function createTranscriptSearchIndex(
  items: HistoryItem[],
): TranscriptSearchIndexEntry[] {
  return items.map((item, itemIndex) => ({
    itemId: item.id,
    itemIndex,
    searchText: buildSearchText(item),
  }));
}

export function searchTranscriptIndex(
  index: TranscriptSearchIndexEntry[],
  query: string,
): TranscriptSearchMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return index.flatMap((entry) => {
    const text = entry.searchText;
    if (!text.toLowerCase().includes(normalizedQuery)) {
      return [];
    }
    return [{
      itemId: entry.itemId,
      itemIndex: entry.itemIndex,
      excerpt: buildExcerpt(text, query.trim()),
    }];
  });
}

export function stepTranscriptSearchMatch(
  matchCount: number,
  currentMatchIndex: number,
  direction: "prev" | "next",
): number {
  if (matchCount <= 0) {
    return 0;
  }

  if (currentMatchIndex < 0) {
    return direction === "next" ? 0 : matchCount - 1;
  }

  if (direction === "next") {
    return (currentMatchIndex + 1) % matchCount;
  }

  return currentMatchIndex <= 0 ? matchCount - 1 : currentMatchIndex - 1;
}

export function buildTranscriptSearchSummary(
  matches: TranscriptSearchMatch[],
  currentMatchIndex: number,
): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  if (currentMatchIndex < 0) {
    return `${matches.length} transcript matches`;
  }

  const safeIndex = Math.min(Math.max(currentMatchIndex, 0), matches.length - 1);
  return `${safeIndex + 1}/${matches.length} transcript matches`;
}

export function resolveTranscriptSearchMatchIndex(
  index: TranscriptSearchIndexEntry[],
  matches: TranscriptSearchMatch[],
  anchorItemId: string | undefined,
): number {
  if (matches.length === 0) {
    return 0;
  }

  if (!anchorItemId) {
    return 0;
  }

  const exactMatchIndex = matches.findIndex((match) => match.itemId === anchorItemId);
  if (exactMatchIndex >= 0) {
    return exactMatchIndex;
  }

  const anchorIndex = index.find((entry) => entry.itemId === anchorItemId)?.itemIndex;
  if (anchorIndex === undefined) {
    return 0;
  }

  const nextMatchIndex = matches.findIndex((match) => match.itemIndex >= anchorIndex);
  return nextMatchIndex >= 0 ? nextMatchIndex : 0;
}

export function summarizeTranscriptItem(item: HistoryItem | undefined): string | undefined {
  if (!item) {
    return undefined;
  }

  switch (item.type) {
    case "assistant":
      return "Assistant response";
    case "user":
      return "User prompt";
    case "system":
      return "System note";
    case "thinking":
      return "Thinking trace";
    case "tool_group":
      return summarizeToolGroup(item);
    case "error":
      return "Error entry";
    case "info":
      return "Info note";
    case "hint":
      return "Hint";
    default:
      return "Transcript entry";
  }
}

export function buildTranscriptSelectionSummary(
  item: HistoryItem | undefined,
): TranscriptSelectionSummary | undefined {
  if (!item) {
    return undefined;
  }

  switch (item.type) {
    case "assistant":
      return { summary: "Assistant response", kindLabel: "assistant" };
    case "user":
      return { summary: "User prompt", kindLabel: "user" };
    case "system":
      return { summary: "System note", kindLabel: "system" };
    case "thinking":
      return { summary: "Thinking trace", kindLabel: "thinking" };
    case "tool_group":
      return { summary: summarizeToolGroup(item), kindLabel: "tool" };
    case "error":
      return { summary: "Error entry", kindLabel: "error" };
    case "info":
      return { summary: "Info note", kindLabel: "info" };
    case "hint":
      return { summary: "Hint", kindLabel: "hint" };
    default:
      return { summary: "Transcript entry", kindLabel: "entry" };
  }
}

function summarizeToolGroup(item: HistoryItemToolGroup): string {
  if (item.tools.length === 1) {
    return `Tool call: ${item.tools[0]?.name ?? "tool"}`;
  }
  return `Tool group: ${item.tools.length} calls`;
}

export function getSelectableTranscriptItemIds(items: HistoryItem[]): string[] {
  return items.map((item) => item.id);
}

export function moveTranscriptSelection(
  itemIds: string[],
  currentItemId: string | undefined,
  direction: "prev" | "next",
): string | undefined {
  if (itemIds.length === 0) {
    return undefined;
  }

  if (!currentItemId) {
    return direction === "next" ? itemIds[0] : itemIds[itemIds.length - 1];
  }

  const currentIndex = itemIds.indexOf(currentItemId);
  if (currentIndex === -1) {
    return direction === "next" ? itemIds[0] : itemIds[itemIds.length - 1];
  }

  if (direction === "next") {
    return itemIds[Math.min(itemIds.length - 1, currentIndex + 1)];
  }
  return itemIds[Math.max(0, currentIndex - 1)];
}

export function buildTranscriptCopyText(item: HistoryItem | undefined): string | undefined {
  if (!item) {
    return undefined;
  }

  switch (item.type) {
    case "tool_group":
      return item.tools
        .map((tool) => {
          const parts = [`Tool: ${tool.name}`, `Status: ${tool.status}`];
          if (tool.input) {
            parts.push(`Input: ${JSON.stringify(tool.input)}`);
          }
          if (typeof tool.output === "string" && tool.output.trim()) {
            parts.push(`Output: ${tool.output}`);
          }
          if (tool.error) {
            parts.push(`Error: ${tool.error}`);
          }
          return parts.join("\n");
        })
        .join("\n\n");
    case "assistant":
    case "user":
    case "system":
    case "thinking":
    case "error":
    case "info":
    case "hint":
      return item.text;
    default:
      return undefined;
  }
}

export function buildTranscriptToolInputCopyText(
  item: HistoryItem | undefined,
): string | undefined {
  if (!item || item.type !== "tool_group") {
    return undefined;
  }

  const serializedTools = item.tools
    .map((tool) => {
      if (!tool.input) {
        return undefined;
      }

      const normalizedInput = typeof tool.input === "string"
        ? tool.input
        : JSON.stringify(tool.input, null, 2);
      if (!normalizedInput?.trim()) {
        return undefined;
      }

      return [`Tool: ${tool.name}`, normalizedInput].join("\n");
    })
    .filter((value): value is string => Boolean(value));

  return serializedTools.length > 0 ? serializedTools.join("\n\n") : undefined;
}
