import type {
  KodaXMessage,
  KodaXSessionUiHistoryItem,
} from "@kodax-ai/agent";
import type { CreatableHistoryItem } from "../types.js";
import {
  extractHistorySeedsFromMessages,
  seedToHistoryItem,
  toolCallSeedToHistoryToolCall,
} from "./message-utils.js";

const MAX_PERSISTED_UI_HISTORY_ITEMS = 150;
const MAX_PERSISTED_UI_HISTORY_ROUNDS = 50;

export interface RestoreHistoryItemsFromSessionInput {
  messages: readonly KodaXMessage[];
  uiHistory?: readonly KodaXSessionUiHistoryItem[];
}

function trimHistoryWindow<T extends { readonly type: string }>(
  items: readonly T[],
): T[] {
  if (items.length === 0) return [];

  const userIndices: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type === "user") userIndices.push(index);
  }

  let trimmed = [...items];
  if (userIndices.length > MAX_PERSISTED_UI_HISTORY_ROUNDS) {
    const startIndex = userIndices[userIndices.length - MAX_PERSISTED_UI_HISTORY_ROUNDS] ?? 0;
    trimmed = items.slice(startIndex);
  }
  if (trimmed.length <= MAX_PERSISTED_UI_HISTORY_ITEMS) return [...trimmed];

  const windowed = trimmed.slice(-MAX_PERSISTED_UI_HISTORY_ITEMS);
  const firstUserIndex = windowed.findIndex((item) => item.type === "user");
  return firstUserIndex > 0 ? windowed.slice(firstUserIndex) : windowed;
}

export function trimPersistedUiHistorySnapshot(
  items: readonly KodaXSessionUiHistoryItem[],
): KodaXSessionUiHistoryItem[] {
  return trimHistoryWindow(items);
}

export function normalizePersistedUiHistory(
  items: readonly KodaXSessionUiHistoryItem[] | undefined,
): KodaXSessionUiHistoryItem[] | undefined {
  if (!items) {
    return undefined;
  }

  return trimPersistedUiHistorySnapshot(items);
}

function toCreatableTextHistoryItem(
  item: Exclude<KodaXSessionUiHistoryItem, { type: "tool_group" }>,
): CreatableHistoryItem {
  const timestamp = item.timestamp === undefined ? {} : { timestamp: item.timestamp };
  const presentationOnly = item.presentationOnly === true
    ? { isSessionUiOnly: true as const }
    : {};
  switch (item.type) {
    case "assistant":
      return {
        type: "assistant",
        text: item.text,
        ...timestamp,
        ...presentationOnly,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        text: item.text,
        ...timestamp,
        ...presentationOnly,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "event":
      return {
        type: "event",
        text: item.text,
        ...timestamp,
        ...presentationOnly,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "info":
      return {
        type: "info",
        text: item.text,
        ...timestamp,
        ...presentationOnly,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "user":
      return { type: "user", text: item.text, ...timestamp, ...presentationOnly };
    case "system":
      return { type: "system", text: item.text, ...timestamp, ...presentationOnly };
    case "error":
      return { type: "error", text: item.text, ...timestamp, ...presentationOnly };
    case "hint":
      return { type: "hint", text: item.text, ...timestamp, ...presentationOnly };
    case "sidecar": {
      // The icon slot carries the encoded verdict/delivery (see toPersistedUiHistoryItem).
      const encoded = item.icon;
      if (encoded === "budget-exhausted") {
        return {
          type: "sidecar",
          text: item.text,
          delivery: "budget-exhausted",
          ...timestamp,
          ...presentationOnly,
        };
      }
      const verdict = encoded === "blocked" ? "blocked" : "revise";
      return { type: "sidecar", text: item.text, verdict, ...timestamp, ...presentationOnly };
    }
  }
}

function persistedUiHistoryItemToCreatableHistoryItem(
  item: KodaXSessionUiHistoryItem,
): CreatableHistoryItem | undefined {
  if (item.type !== "tool_group") {
    return toCreatableTextHistoryItem(item);
  }

  const tools = item.tools.map(toolCallSeedToHistoryToolCall);
  return tools.length > 0
    ? {
        type: "tool_group",
        tools,
        ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
      }
    : undefined;
}

function dedupeToolGroups(
  items: readonly CreatableHistoryItem[],
): CreatableHistoryItem[] {
  const seenToolIds = new Set<string>();
  const result: CreatableHistoryItem[] = [];
  for (const item of items) {
    if (item.type !== "tool_group") {
      result.push(item);
      continue;
    }
    const tools = item.tools.filter((tool) => {
      if (seenToolIds.has(tool.id)) return false;
      seenToolIds.add(tool.id);
      return true;
    });
    if (tools.length > 0) result.push({ ...item, tools });
  }
  return result;
}

function matchesTimestampSource(
  item: CreatableHistoryItem,
  candidate: CreatableHistoryItem,
): boolean {
  if (item.type !== candidate.type) return false;
  if (item.type === "tool_group" && candidate.type === "tool_group") {
    return item.tools.map((tool) => tool.id).join("\n")
      === candidate.tools.map((tool) => tool.id).join("\n");
  }
  if (item.type === "tool_group" || candidate.type === "tool_group") return false;
  const itemText = item.text.trim();
  const candidateText = candidate.text.trim();
  return itemText === candidateText
    || hasDisplayPrefix(itemText, candidateText)
    || hasDisplayPrefix(candidateText, itemText);
}

function hasDisplayPrefix(displayText: string, sourceText: string): boolean {
  if (!displayText.endsWith(sourceText)) return false;
  const prefix = displayText.slice(0, -sourceText.length);
  return /^\[[^\]\r\n]+\]\s+$/.test(prefix);
}

function alignCanonicalTextItems(
  persistedItems: readonly CreatableHistoryItem[],
  derivedItems: readonly CreatableHistoryItem[],
): ReadonlyMap<number, number> {
  const anchors = new Map<number, number>();
  let persistedCursor = persistedItems.length - 1;
  // uiHistory can be a bounded suffix of the canonical transcript. Match
  // backwards so repeated queries/answers bind to their latest canonical
  // occurrence instead of an older round.
  for (let derivedIndex = derivedItems.length - 1; derivedIndex >= 0; derivedIndex -= 1) {
    const derived = derivedItems[derivedIndex];
    if (!derived || derived.type === "tool_group") continue;
    for (let index = persistedCursor; index >= 0; index -= 1) {
      const persisted = persistedItems[index];
      if (!persisted || persisted.type === "tool_group") continue;
      if (!matchesTimestampSource(persisted, derived)) continue;
      anchors.set(derivedIndex, index);
      persistedCursor = index - 1;
      break;
    }
  }
  return anchors;
}

function overlayCanonicalTextItem(
  canonical: CreatableHistoryItem,
  persisted: CreatableHistoryItem,
): CreatableHistoryItem {
  if (canonical.type === "tool_group" || persisted.type === "tool_group") return canonical;
  const timestamp = persisted.timestamp ?? canonical.timestamp;
  const withTimestamp = timestamp === undefined ? {} : { timestamp };
  switch (canonical.type) {
    case "assistant":
    case "thinking":
      return {
        ...canonical,
        ...withTimestamp,
        ...(persisted.type === canonical.type && persisted.compactText
          ? { compactText: persisted.compactText }
          : {}),
      };
    case "event":
    case "info":
      return {
        ...canonical,
        ...withTimestamp,
        ...(persisted.type === canonical.type && persisted.icon ? { icon: persisted.icon } : {}),
        ...(persisted.type === canonical.type && persisted.compactText
          ? { compactText: persisted.compactText }
          : {}),
      };
    case "sidecar":
      return persisted.type === "sidecar"
        ? { ...canonical, ...withTimestamp, verdict: persisted.verdict, delivery: persisted.delivery }
        : canonical;
    default:
      return { ...canonical, ...withTimestamp };
  }
}

function isLegacyToolSummary(
  item: CreatableHistoryItem,
  canonicalItems: readonly CreatableHistoryItem[],
  previousCanonicalIndex: number | undefined,
  nextCanonicalIndex: number | undefined,
): boolean {
  if (item.type !== "event" || item.icon !== "tool") return false;
  const summary = item.text.trimStart();
  if (!summary.startsWith("⚙")) return false;
  if (previousCanonicalIndex === undefined && nextCanonicalIndex === undefined) return false;
  const call = summary.slice(1).trimStart();
  const startIndex = previousCanonicalIndex === undefined ? 0 : previousCanonicalIndex + 1;
  const endIndex = nextCanonicalIndex ?? canonicalItems.length;
  return canonicalItems.slice(startIndex, endIndex).some((candidate) => (
    candidate.type === "tool_group"
    && candidate.tools.some((tool) => (
      call === tool.name
      || call.startsWith(`${tool.name}(`)
      || call.startsWith(`${tool.name} `)
    ))
  ));
}

type CreatableToolGroup = Extract<CreatableHistoryItem, { type: "tool_group" }>;
type PersistedToolOverlay = {
  tool: CreatableToolGroup["tools"][number];
  timestamp?: number;
};

function collectPersistedTools(
  items: readonly CreatableHistoryItem[],
): ReadonlyMap<string, PersistedToolOverlay> {
  const toolsById = new Map<string, PersistedToolOverlay>();
  for (const item of items) {
    if (item.type !== "tool_group") continue;
    for (const tool of item.tools) {
      if (!toolsById.has(tool.id)) toolsById.set(tool.id, { tool, timestamp: item.timestamp });
    }
  }
  return toolsById;
}

function collectCanonicalToolIds(
  items: readonly CreatableHistoryItem[],
): ReadonlySet<string> {
  const toolIds = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool_group") continue;
    for (const tool of item.tools) toolIds.add(tool.id);
  }
  return toolIds;
}

function alignCanonicalWindow(
  persistedItems: readonly CreatableHistoryItem[],
  fullDerivedItems: readonly CreatableHistoryItem[],
  windowStartIndex: number,
): {
  anchors: ReadonlyMap<number, number>;
  outOfWindowPersistedIndices: ReadonlySet<number>;
} {
  const anchors = new Map<number, number>();
  const outOfWindowPersistedIndices = new Set<number>();
  const fullAnchors = alignCanonicalTextItems(persistedItems, fullDerivedItems);
  for (const [derivedIndex, persistedIndex] of fullAnchors) {
    if (derivedIndex < windowStartIndex) {
      outOfWindowPersistedIndices.add(persistedIndex);
    } else {
      anchors.set(derivedIndex - windowStartIndex, persistedIndex);
    }
  }
  return { anchors, outOfWindowPersistedIndices };
}

function buildCanonicalItems(
  persistedItems: readonly CreatableHistoryItem[],
  derivedItems: readonly CreatableHistoryItem[],
  anchors: ReadonlyMap<number, number>,
  persistedTools: ReadonlyMap<string, PersistedToolOverlay>,
): CreatableHistoryItem[] {
  return derivedItems.map((item, index): CreatableHistoryItem => {
    if (item.type !== "tool_group") {
      const persistedIndex = anchors.get(index);
      const persisted = persistedIndex === undefined ? undefined : persistedItems[persistedIndex];
      return persisted ? overlayCanonicalTextItem(item, persisted) : item;
    }
    const tools = item.tools.map((tool) => persistedTools.get(tool.id)?.tool ?? tool);
    const timestamp = tools
      .map((tool) => persistedTools.get(tool.id)?.timestamp)
      .find((candidate) => candidate !== undefined) ?? item.timestamp;
    return { ...item, tools, ...(timestamp === undefined ? {} : { timestamp }) };
  });
}

function invertAnchors(
  anchors: ReadonlyMap<number, number>,
): ReadonlyMap<number, number> {
  const persistedIndexToDerived = new Map<number, number>();
  for (const [derivedIndex, persistedIndex] of anchors) {
    persistedIndexToDerived.set(persistedIndex, derivedIndex);
  }
  return persistedIndexToDerived;
}

function nextDerivedAnchors(
  persistedLength: number,
  persistedIndexToDerived: ReadonlyMap<number, number>,
): readonly (number | undefined)[] {
  const nextAnchors: Array<number | undefined> = new Array(persistedLength);
  let nextDerivedIndex: number | undefined;
  for (let index = persistedLength - 1; index >= 0; index -= 1) {
    const anchored = persistedIndexToDerived.get(index);
    if (anchored === undefined) nextAnchors[index] = nextDerivedIndex;
    else nextDerivedIndex = anchored;
  }
  return nextAnchors;
}

function markUiOnlyItem(
  item: CreatableHistoryItem,
  canonicalToolIds: ReadonlySet<string>,
  allowOrdinaryText: boolean,
): CreatableHistoryItem | undefined {
  if (item.type === "tool_group") {
    const tools = item.tools.filter((tool) => !canonicalToolIds.has(tool.id));
    return tools.length > 0 ? { ...item, tools, isSessionUiOnly: true } : undefined;
  }
  const isOrdinaryText = item.type === "assistant"
    || item.type === "thinking"
    || (item.type === "user" && !item.text.trimStart().startsWith("/"));
  return isOrdinaryText && !allowOrdinaryText && item.isSessionUiOnly !== true
    ? undefined
    : { ...item, isSessionUiOnly: true };
}

function collectUiOnlyInsertions(
  persistedItems: readonly CreatableHistoryItem[],
  anchors: ReadonlyMap<number, number>,
  excludedIndices: ReadonlySet<number>,
  canonicalItems: readonly CreatableHistoryItem[],
  canonicalToolIds: ReadonlySet<string>,
  allowOrdinaryText: boolean,
): ReadonlyMap<number, readonly CreatableHistoryItem[]> {
  const persistedToDerived = invertAnchors(anchors);
  const nextAnchors = nextDerivedAnchors(persistedItems.length, persistedToDerived);
  const lastAnchorIndex = Math.max(-1, ...persistedToDerived.keys());
  const insertions = new Map<number, CreatableHistoryItem[]>();
  let previousDerivedIndex: number | undefined;

  for (let index = 0; index < persistedItems.length; index += 1) {
    const anchoredDerivedIndex = persistedToDerived.get(index);
    if (anchoredDerivedIndex !== undefined) {
      previousDerivedIndex = anchoredDerivedIndex;
      continue;
    }
    const item = persistedItems[index];
    if (!item || excludedIndices.has(index)) continue;
    const nextDerivedIndex = nextAnchors[index];
    if (isLegacyToolSummary(item, canonicalItems, previousDerivedIndex, nextDerivedIndex)) continue;
    const uiOnly = markUiOnlyItem(item, canonicalToolIds, allowOrdinaryText);
    if (!uiOnly) continue;
    const boundary = anchors.size === 0 || index > lastAnchorIndex
      ? canonicalItems.length
      : previousDerivedIndex === undefined
        ? nextDerivedIndex ?? 0
        : previousDerivedIndex + 1;
    const boundaryItems = insertions.get(boundary) ?? [];
    boundaryItems.push(uiOnly);
    insertions.set(boundary, boundaryItems);
  }
  return insertions;
}

function mergeAtCanonicalBoundaries(
  canonicalItems: readonly CreatableHistoryItem[],
  insertions: ReadonlyMap<number, readonly CreatableHistoryItem[]>,
): CreatableHistoryItem[] {
  const merged: CreatableHistoryItem[] = [];
  for (let boundary = 0; boundary <= canonicalItems.length; boundary += 1) {
    merged.push(...(insertions.get(boundary) ?? []));
    const canonical = canonicalItems[boundary];
    if (canonical) merged.push(canonical);
  }
  return merged;
}

function enrichCanonicalUiHistory(
  persistedItems: readonly CreatableHistoryItem[],
  derivedItems: readonly CreatableHistoryItem[],
  fullDerivedItems: readonly CreatableHistoryItem[],
  windowStartIndex: number,
  allowOrdinaryText: boolean,
): CreatableHistoryItem[] {
  const alignment = alignCanonicalWindow(persistedItems, fullDerivedItems, windowStartIndex);
  const canonicalItems = buildCanonicalItems(
    persistedItems,
    derivedItems,
    alignment.anchors,
    collectPersistedTools(persistedItems),
  );
  const insertions = collectUiOnlyInsertions(
    persistedItems,
    alignment.anchors,
    alignment.outOfWindowPersistedIndices,
    canonicalItems,
    collectCanonicalToolIds(fullDerivedItems),
    allowOrdinaryText,
  );
  return mergeAtCanonicalBoundaries(canonicalItems, insertions);
}

export function restoreHistoryItemsFromSession(
  input: RestoreHistoryItemsFromSessionInput,
): CreatableHistoryItem[] {
  const persistedHistory = normalizePersistedUiHistory(input.uiHistory);
  const hasPersistedUiHistory = Boolean(persistedHistory?.length);
  const fullDerivedItems = extractHistorySeedsFromMessages(input.messages)
    .filter((seed) => !hasPersistedUiHistory || seed.type !== "task_completed")
    .map(seedToHistoryItem);
  const derivedItems = trimHistoryWindow(fullDerivedItems);
  if (!persistedHistory || persistedHistory.length === 0) {
    return dedupeToolGroups(derivedItems);
  }

  const persistedItems = dedupeToolGroups(persistedHistory
    .map(persistedUiHistoryItemToCreatableHistoryItem)
    .filter((item): item is CreatableHistoryItem => Boolean(item)));

  const firstWindowItem = derivedItems[0];
  const windowStartIndex = firstWindowItem === undefined
    ? fullDerivedItems.length
    : fullDerivedItems.indexOf(firstWindowItem);
  return dedupeToolGroups(enrichCanonicalUiHistory(
    persistedItems,
    derivedItems,
    fullDerivedItems,
    windowStartIndex,
    input.messages.length === 0,
  ));
}
