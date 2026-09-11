import { randomUUID } from "node:crypto";
import {
  COMPACTED_HISTORY_RECOVERY_GUIDANCE,
  COMPACTION_SUMMARY_PREFIX
} from "file:///C:/Works/GitProj/KodaX-AI/KodaX/packages/agent/dist/session-lineage/compaction/compaction.js";
import { isPostCompactAttachment } from "file:///C:/Works/GitProj/KodaX-AI/KodaX/packages/agent/dist/session-lineage/compaction/post-compact.js";
const ENTRY_ID_LENGTH = 12;
const MAX_BRANCH_SUMMARY_LENGTH = 600;
const messageFingerprintCache = /* @__PURE__ */ new WeakMap();
const messageProvenanceSourceIds = /* @__PURE__ */ new WeakMap();
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `
</summary>`;
function cloneMessage(message) {
  return message;
}
function cloneJsonValue(value) {
  if (value === void 0) {
    return value;
  }
  return structuredClone(value);
}
function cloneMemorySeed(value) {
  if (value === void 0) {
    return value;
  }
  return structuredClone(value);
}
function normalizeCompactionDetails(value) {
  if (value === void 0) {
    return value;
  }
  if (typeof value === "object" && value !== null && "readFiles" in value && Array.isArray(value.readFiles) && "modifiedFiles" in value && Array.isArray(value.modifiedFiles)) {
    return {
      readFiles: [...value.readFiles],
      modifiedFiles: [...value.modifiedFiles]
    };
  }
  return structuredClone(value);
}
function cloneEntry(entry) {
  switch (entry.type) {
    case "message":
      return { ...entry };
    case "compaction":
      return {
        ...entry,
        details: cloneJsonValue(entry.details),
        memorySeed: cloneMemorySeed(entry.memorySeed)
      };
    case "branch_summary":
      return {
        ...entry,
        details: cloneJsonValue(entry.details)
      };
    case "label":
      return { ...entry };
    case "archive_marker":
      return { ...entry };
    case "rewind_marker":
      return { ...entry };
    case "client_notice":
      return {
        ...entry,
        payload: cloneJsonValue(entry.payload)
      };
    case "memory_outcome_digest":
      return { ...entry, digest: structuredClone(entry.digest) };
    case "memory_review_receipt":
      return { ...entry, proposalIds: [...entry.proposalIds] };
    case "goal":
      return { ...entry };
    default: {
      const exhaustiveCheck = entry;
      return exhaustiveCheck;
    }
  }
}
function isMessageEntry(entry) {
  return entry.type === "message";
}
function isLabelEntry(entry) {
  return entry.type === "label";
}
function isNavigableEntry(entry) {
  return entry.type !== "label" && entry.type !== "goal" && entry.type !== "client_notice" && entry.type !== "memory_outcome_digest" && entry.type !== "memory_review_receipt" && entry.type !== "rewind_marker";
}
function serializeMessageContent(content) {
  return typeof content === "string" ? `text:${content}` : `json:${JSON.stringify(content)}`;
}
function getMessageFingerprint(message) {
  const cached = messageFingerprintCache.get(message);
  if (cached) {
    return cached;
  }
  const synthetic = message._synthetic === true ? "synthetic" : "real";
  const fingerprint = `${message.role}:${synthetic}:${serializeMessageContent(message.content)}`;
  messageFingerprintCache.set(message, fingerprint);
  return fingerprint;
}
function messagesEqual(left, right) {
  if (left === right) return true;
  return getMessageFingerprint(left) === getMessageFingerprint(right);
}
function generateEntryId(prefix = "entry") {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, ENTRY_ID_LENGTH)}`;
}
function logicalIdForEntry(entry) {
  return entry.logicalId ?? entry.id;
}
function recordMessageProvenanceSource(message, entry) {
  const sourceIds = messageProvenanceSourceIds.get(message) ?? /* @__PURE__ */ new Set();
  sourceIds.add(entry.id);
  messageProvenanceSourceIds.set(message, sourceIds);
}
function getSessionMessageEntryId(message) {
  const sourceIds = messageProvenanceSourceIds.get(message);
  if (sourceIds?.size !== 1) return void 0;
  return sourceIds.values().next().value;
}
function entryOwnsCompactionMessage(entry, message) {
  return entry.type === "message" ? entry.message === message || messageProvenanceSourceIds.get(message)?.has(entry.id) === true : messageProvenanceSourceIds.get(message)?.has(entry.id) === true;
}
function inheritCompactionMessageProvenance(entries, existingIds, sourceEntries) {
  const clones = entries.filter((entry) => entry.type === "message" && !existingIds.has(entry.id));
  const sourcesByCloneId = /* @__PURE__ */ new Map();
  let sourceLimit = sourceEntries.length;
  for (let cloneIndex = clones.length - 1; cloneIndex >= 0; cloneIndex -= 1) {
    let sourceIndex = sourceLimit - 1;
    while (sourceIndex >= 0 && !entryOwnsCompactionMessage(sourceEntries[sourceIndex], clones[cloneIndex].message)) {
      sourceIndex -= 1;
    }
    if (sourceIndex < 0) continue;
    sourcesByCloneId.set(clones[cloneIndex].id, sourceEntries[sourceIndex]);
    sourceLimit = sourceIndex;
  }
  return entries.map((entry) => {
    const source = sourcesByCloneId.get(entry.id);
    return source ? {
      ...entry,
      logicalId: logicalIdForEntry(source),
      sourceEntryId: source.id
    } : entry;
  });
}
function cloneLineage(lineage) {
  return {
    version: 2,
    activeEntryId: lineage?.activeEntryId ?? null,
    entries: lineage?.entries ? [...lineage.entries] : []
  };
}
function createSummaryContextMessage(summary, prefix, suffix) {
  const isCompactionCheckpoint = prefix === COMPACTION_SUMMARY_PREFIX && suffix === COMPACTED_HISTORY_RECOVERY_GUIDANCE;
  return {
    role: "user",
    content: `${prefix}${summary}${suffix}`,
    ...isCompactionCheckpoint ? { _synthetic: true, _source: "compaction-checkpoint" } : {}
  };
}
function getContextMessagesForEntry(entry) {
  switch (entry.type) {
    case "message":
      return [cloneMessage(entry.message)];
    case "compaction":
      if (entry.reason === "rewind") {
        return [];
      }
      {
        const message = createSummaryContextMessage(
          entry.summary,
          COMPACTION_SUMMARY_PREFIX,
          COMPACTED_HISTORY_RECOVERY_GUIDANCE
        );
        recordMessageProvenanceSource(message, entry);
        return [message];
      }
    case "branch_summary": {
      const message = createSummaryContextMessage(
        entry.summary,
        BRANCH_SUMMARY_PREFIX,
        BRANCH_SUMMARY_SUFFIX
      );
      recordMessageProvenanceSource(message, entry);
      return [message];
    }
    case "archive_marker":
      return [];
    // context-silent: archived content is not part of LLM context
    default: {
      const exhaustiveCheck = entry;
      return exhaustiveCheck;
    }
  }
}
function getChildrenMap(entries) {
  const children = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const bucket = children.get(entry.parentId) ?? [];
    bucket.push(entry);
    children.set(entry.parentId, bucket);
  }
  return children;
}
function getNavigableEntryMap(lineage, checkpoint) {
  const byId = /* @__PURE__ */ new Map();
  for (let index = 0; index < lineage.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = lineage.entries[index];
    if (isNavigableEntry(entry)) {
      byId.set(entry.id, entry);
    }
  }
  return byId;
}
function getResolvedLabels(lineage, checkpoint) {
  const labels = /* @__PURE__ */ new Map();
  for (let index = 0; index < lineage.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = lineage.entries[index];
    if (!isLabelEntry(entry)) {
      continue;
    }
    if (entry.label && entry.label.trim()) {
      labels.set(entry.targetId, entry.label.trim());
    } else {
      labels.delete(entry.targetId);
    }
  }
  return labels;
}
function entryMatchesContextMessage(entry, message) {
  if (entry.type === "compaction" && entry.reason !== "rewind" && typeof message.content === "string" && (message.content === `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTED_HISTORY_RECOVERY_GUIDANCE}` || message.content === `${COMPACTION_SUMMARY_PREFIX}${entry.summary}`) && (message.role === "system" || message.role === "user" && message._synthetic === true && message._source === "compaction-checkpoint")) {
    return true;
  }
  const rendered = getContextMessagesForEntry(entry);
  return rendered.length === 1 && messagesEqual(rendered[0], message);
}
function getTextPreview(message) {
  if (typeof message.content === "string") {
    return message.content.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(message.content)) {
    const text = message.content.map((block) => {
      if (typeof block === "object" && block !== null && "type" in block && "text" in block && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    }).join(" ").replace(/\s+/g, " ").trim();
    return text || "[complex content]";
  }
  return "[complex content]";
}
function truncateText(text, maxLength = 120) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
function summarizeBranchEntries(entries) {
  const goal = entries.find(
    (entry) => entry.type === "message" && entry.message.role === "user"
  );
  const userFollowUps = entries.filter(
    (entry) => entry.type === "message" && entry.message.role === "user" && entry.id !== goal?.id
  ).map((entry) => truncateText(getTextPreview(entry.message), 90));
  const assistantUpdates = entries.filter(
    (entry) => entry.type === "message" && entry.message.role === "assistant"
  ).map((entry) => truncateText(getTextPreview(entry.message), 90));
  const nestedSummaries = entries.filter((entry) => entry.type === "branch_summary" || entry.type === "compaction").map((entry) => truncateText(entry.summary.replace(/\s+/g, " ").trim(), 90));
  const latestEntry = entries[entries.length - 1];
  const latestState = latestEntry ? truncateText(getTextPreview(getContextMessagesForEntry(latestEntry)[0] ?? {
    role: "user",
    content: latestEntry.type
  }), 120) : void 0;
  const highlights = [
    ...assistantUpdates.slice(-2),
    ...userFollowUps.slice(-1),
    ...nestedSummaries.slice(-1)
  ].filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
  const lines = [
    "The user explored a different conversation branch before returning here.",
    "",
    `Goal: ${truncateText(goal ? getTextPreview(goal.message) : "Explore an alternate approach from this branch point.", 120)}`
  ];
  if (highlights.length > 0) {
    lines.push("");
    lines.push("Highlights:");
    for (const item of highlights.slice(0, 4)) {
      lines.push(`- ${item}`);
    }
  }
  if (latestState) {
    lines.push("");
    lines.push(`Latest state: ${latestState}`);
  }
  return truncateText(lines.join("\n"), MAX_BRANCH_SUMMARY_LENGTH);
}
function getCommonAncestorId(lineage, leftId, rightId) {
  const leftPath = getSessionLineagePath(lineage, leftId);
  const rightPath = getSessionLineagePath(lineage, rightId);
  let commonAncestorId = null;
  const limit = Math.min(leftPath.length, rightPath.length);
  for (let index = 0; index < limit; index += 1) {
    if (leftPath[index]?.id !== rightPath[index]?.id) {
      break;
    }
    commonAncestorId = leftPath[index]?.id ?? null;
  }
  return commonAncestorId;
}
function getBranchSegment(lineage, ancestorId, leafId) {
  const path = getSessionLineagePath(lineage, leafId);
  if (!ancestorId) {
    return path;
  }
  const ancestorIndex = path.findIndex((entry) => entry.id === ancestorId);
  if (ancestorIndex === -1) {
    return path;
  }
  return path.slice(ancestorIndex + 1);
}
function recordActiveContextProvenance(lineage, messages) {
  let messageIndex = 0;
  for (const entry of getSessionLineagePath(lineage)) {
    for (const _rendered of getContextMessagesForEntry(entry)) {
      const message = messages[messageIndex];
      if (message !== void 0) recordMessageProvenanceSource(message, entry);
      messageIndex += 1;
    }
    if (entry.type === "compaction" && entry.reason !== "rewind") {
      messageIndex += entry.postCompactAttachments?.length ?? 0;
    }
  }
}
function createSessionLineage(messages, previous) {
  const lineage = cloneLineage(previous);
  const navigableEntries = lineage.entries.filter(isNavigableEntry);
  const children = getChildrenMap(navigableEntries);
  const priorActiveMessages = previous === void 0 ? void 0 : getSessionMessagesFromLineage(previous);
  const extendsPriorActivePath = previous !== void 0 && priorActiveMessages !== void 0 && priorActiveMessages.length <= messages.length && priorActiveMessages.every((message, index) => messagesEqual(message, messages[index]));
  const messageOffset = extendsPriorActivePath ? priorActiveMessages.length : 0;
  let parentId = extendsPriorActivePath && previous !== void 0 ? previous.activeEntryId : null;
  let activeEntryId = parentId;
  if (extendsPriorActivePath && previous !== void 0) {
    recordActiveContextProvenance(previous, messages.slice(0, messageOffset));
  }
  for (let index = messageOffset; index < messages.length; index += 1) {
    const message = messages[index];
    if (isPostCompactAttachment(message)) continue;
    const existing = extendsPriorActivePath ? void 0 : [...children.get(parentId) ?? []].reverse().find((entry2) => entryMatchesContextMessage(entry2, message));
    if (existing) {
      recordMessageProvenanceSource(message, existing);
      activeEntryId = existing.id;
      parentId = existing.id;
      continue;
    }
    const entryId = generateEntryId();
    const entry = {
      type: "message",
      id: entryId,
      parentId,
      logicalId: entryId,
      // Prefer the message's own finalize-time timestamp so a whole managed task
      // (accounted in one synchronous batch here) no longer collapses to a single
      // save-time millisecond. Falls back to accounting-time when absent (old
      // sessions / not-yet-stamped paths) — the fingerprint (role:synthetic:
      // content) ignores timestamp, so this never affects resume dedup.
      timestamp: message.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
      message: cloneMessage(message)
    };
    lineage.entries.push(entry);
    recordMessageProvenanceSource(message, entry);
    const bucket = children.get(parentId) ?? [];
    bucket.push(entry);
    children.set(parentId, bucket);
    activeEntryId = entry.id;
    parentId = entry.id;
  }
  lineage.activeEntryId = activeEntryId;
  return lineage;
}
function getSessionLineagePath(lineage, targetId = lineage.activeEntryId, checkpoint) {
  if (!targetId) {
    return [];
  }
  const byId = getNavigableEntryMap(lineage, checkpoint);
  const path = [];
  const visited = /* @__PURE__ */ new Set();
  let current = byId.get(targetId);
  let traversed = 0;
  while (current) {
    if (traversed > 0 && traversed % 256 === 0) checkpoint?.();
    if (visited.has(current.id)) {
      break;
    }
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : void 0;
    traversed += 1;
  }
  checkpoint?.();
  return path.reverse();
}
function getSessionMessagesFromLineage(lineage, targetId = lineage.activeEntryId) {
  const messages = [];
  for (const entry of getSessionLineagePath(lineage, targetId)) {
    for (const message of getContextMessagesForEntry(entry)) {
      messages.push(cloneMessage(message));
    }
    if (entry.type === "compaction" && entry.reason !== "rewind" && entry.postCompactAttachments && entry.postCompactAttachments.length > 0) {
      for (const message of entry.postCompactAttachments) {
        messages.push(cloneMessage(message));
      }
    }
  }
  return messages;
}
function resolveSessionLineageTarget(lineage, selector, checkpoint) {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    return void 0;
  }
  const byId = getNavigableEntryMap(lineage, checkpoint);
  const direct = byId.get(normalizedSelector);
  if (direct && direct.type !== "archive_marker") {
    return direct;
  }
  const labels = getResolvedLabels(lineage, checkpoint);
  const labeledTargetId = [...labels.entries()].find(([, label]) => label === normalizedSelector)?.[0];
  if (!labeledTargetId) return void 0;
  const labeledTarget = byId.get(labeledTargetId);
  return labeledTarget && labeledTarget.type !== "archive_marker" ? labeledTarget : void 0;
}
function setSessionLineageActiveEntry(lineage, selector, options = {}) {
  const target = resolveSessionLineageTarget(lineage, selector);
  if (!target) {
    return null;
  }
  const entries = lineage.entries.map(cloneEntry);
  let activeEntryId = target.id;
  if (options.summarizeCurrentBranch && lineage.activeEntryId && lineage.activeEntryId !== target.id) {
    const commonAncestorId = getCommonAncestorId(
      lineage,
      lineage.activeEntryId,
      target.id
    );
    const abandonedEntries = getBranchSegment(
      lineage,
      commonAncestorId,
      lineage.activeEntryId
    );
    if (abandonedEntries.length > 0) {
      const summaryEntryId = generateEntryId();
      const summaryEntry = {
        type: "branch_summary",
        id: summaryEntryId,
        parentId: target.id,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        logicalId: summaryEntryId,
        fromId: lineage.activeEntryId,
        summary: summarizeBranchEntries(abandonedEntries),
        details: {
          commonAncestorId,
          abandonedEntryIds: abandonedEntries.map((entry) => entry.id),
          abandonedEntryCount: abandonedEntries.length
        }
      };
      entries.push(summaryEntry);
      activeEntryId = summaryEntry.id;
    }
  }
  return {
    version: 2,
    activeEntryId,
    entries
  };
}
function appendSessionLineageLabel(lineage, selector, label) {
  const target = resolveSessionLineageTarget(lineage, selector);
  if (!target) {
    return null;
  }
  const normalizedLabel = label?.trim();
  const entries = lineage.entries.map(cloneEntry);
  const entryId = generateEntryId("label");
  entries.push({
    type: "label",
    id: entryId,
    parentId: lineage.activeEntryId,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    logicalId: entryId,
    targetId: target.id,
    label: normalizedLabel || void 0
  });
  return {
    version: 2,
    activeEntryId: lineage.activeEntryId,
    entries
  };
}
function applySessionCompaction(lineage, compactedMessages, anchor, postCompactAttachments = []) {
  const sourceEntries = lineage ? getSessionLineagePath(lineage) : [];
  const base = cloneLineage(lineage);
  const compactionEntryId = generateEntryId();
  const compactionEntry = {
    type: "compaction",
    id: compactionEntryId,
    parentId: null,
    logicalId: compactionEntryId,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    summary: anchor.summary,
    tokensBefore: anchor.tokensBefore,
    tokensAfter: anchor.tokensAfter,
    artifactLedgerId: anchor.artifactLedgerId,
    reason: anchor.reason,
    details: normalizeCompactionDetails(anchor.details),
    memorySeed: cloneMemorySeed(anchor.memorySeed),
    postCompactAttachments: postCompactAttachments.length > 0 ? postCompactAttachments : void 0
  };
  base.entries.push(compactionEntry);
  base.activeEntryId = compactionEntryId;
  let keptMessages = compactedMessages.some(isPostCompactAttachment) ? compactedMessages.filter((m) => !isPostCompactAttachment(m)) : compactedMessages;
  const seenSystemContent = /* @__PURE__ */ new Set();
  const filteredForDedup = [];
  let droppedDups = 0;
  for (const m of keptMessages) {
    if (m.role === "system" && typeof m.content === "string") {
      if (seenSystemContent.has(m.content)) {
        droppedDups++;
        continue;
      }
      seenSystemContent.add(m.content);
    }
    filteredForDedup.push(m);
  }
  if (droppedDups > 0) {
    keptMessages = filteredForDedup;
  }
  const existingIds = new Set(base.entries.map((entry) => entry.id));
  const next = createSessionLineage(keptMessages, base);
  const entriesWithProvenance = inheritCompactionMessageProvenance(
    next.entries,
    existingIds,
    sourceEntries
  );
  const nextWithProvenance = {
    ...next,
    entries: entriesWithProvenance
  };
  const activePath = getSessionLineagePath(nextWithProvenance);
  const compactionIndex = activePath.findIndex((entry) => entry.id === compactionEntryId);
  const firstKeptEntryId = compactionIndex >= 0 ? activePath[compactionIndex + 1]?.id : void 0;
  const result = {
    ...nextWithProvenance,
    entries: nextWithProvenance.entries.map((entry) => entry.id === compactionEntryId ? {
      ...entry,
      firstKeptEntryId
    } : entry)
  };
  return result;
}
function applyLineageTruncation(lineage, trimmedMessages) {
  return createSessionLineage(trimmedMessages, lineage);
}
function evictOldIslandMessageContent(lineage) {
  if (!lineage.activeEntryId || lineage.entries.length === 0) {
    return lineage;
  }
  const byId = new Map(lineage.entries.map((e) => [e.id, e]));
  let activeRootId = null;
  let cur = byId.get(lineage.activeEntryId);
  while (cur) {
    activeRootId = cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : void 0;
  }
  const currentIsland = /* @__PURE__ */ new Set();
  if (activeRootId) {
    const childrenOf = /* @__PURE__ */ new Map();
    for (const entry of lineage.entries) {
      if (entry.parentId) {
        const bucket = childrenOf.get(entry.parentId) ?? [];
        bucket.push(entry.id);
        childrenOf.set(entry.parentId, bucket);
      }
    }
    const queue = [activeRootId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (currentIsland.has(id)) continue;
      currentIsland.add(id);
      for (const childId of childrenOf.get(id) ?? []) {
        queue.push(childId);
      }
    }
  }
  let changed = false;
  const evicted = lineage.entries.map((entry) => {
    if (currentIsland.has(entry.id)) return entry;
    if (entry.type === "message") {
      changed = true;
      return {
        ...entry,
        message: {
          role: entry.message.role,
          content: [{ type: "text", text: "[compacted]" }]
        }
      };
    }
    if (entry.type === "compaction" && entry.postCompactAttachments?.length) {
      changed = true;
      return {
        ...entry,
        postCompactAttachments: void 0
      };
    }
    return entry;
  });
  return changed ? { ...lineage, entries: evicted } : lineage;
}
function cloneForkableEntry(entry, parentId) {
  const entryId = generateEntryId();
  const base = {
    id: entryId,
    parentId,
    timestamp: entry.timestamp,
    logicalId: logicalIdForEntry(entry),
    sourceEntryId: entry.id
  };
  switch (entry.type) {
    case "message":
      return {
        ...base,
        type: "message",
        // Fork creates a genuinely independent branch — deep-clone the
        // message so modifications in one branch don't affect the other.
        message: structuredClone(entry.message)
      };
    case "compaction":
      return {
        ...base,
        type: "compaction",
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
        tokensAfter: entry.tokensAfter,
        artifactLedgerId: entry.artifactLedgerId,
        reason: entry.reason,
        details: cloneJsonValue(entry.details),
        memorySeed: cloneMemorySeed(entry.memorySeed),
        // FEATURE_072: fork carries attachments to the new branch so the
        // forked leaf's derived view includes the ledger + file context
        // that existed at the fork point.
        postCompactAttachments: entry.postCompactAttachments ? entry.postCompactAttachments.map((m) => structuredClone(m)) : void 0
      };
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        summary: entry.summary,
        fromId: entry.fromId,
        details: cloneJsonValue(entry.details)
      };
    case "archive_marker":
      return {
        ...base,
        type: "archive_marker",
        archiveBatchId: entry.archiveBatchId,
        archivedEntryCount: entry.archivedEntryCount,
        summary: entry.summary
      };
    default: {
      const exhaustiveCheck = entry;
      return exhaustiveCheck;
    }
  }
}
function isToolResultOnlyUserMessage(message) {
  return message.role === "user" && Array.isArray(message.content) && message.content.length > 0 && message.content.every((block) => block.type === "tool_result");
}
function isRealUserPromptEntry(entry) {
  return entry.type === "message" && entry.message.role === "user" && entry.message._synthetic !== true && !isToolResultOnlyUserMessage(entry.message);
}
function findPreviousUserEntryId(lineage) {
  const entries = getSessionLineagePath(lineage);
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && isRealUserPromptEntry(entry)) {
      found++;
      if (found === 2) {
        return entry.id;
      }
    }
  }
  return null;
}
function rewindSessionLineage(lineage, targetEntryId) {
  const target = getNavigableEntryMap(lineage).get(targetEntryId);
  if (!target || target.type === "archive_marker" || target.type === "compaction" && target.reason === "rewind") {
    return null;
  }
  const entries = lineage.entries;
  const targetIndex = entries.findIndex((e) => e.id === target.id);
  if (targetIndex < 0) {
    return null;
  }
  const keptEntries = entries.slice(0, targetIndex + 1);
  const truncatedCount = entries.length - targetIndex - 1;
  const rewindEntryId = generateEntryId();
  const rewindEntry = {
    type: "rewind_marker",
    id: rewindEntryId,
    parentId: target.id,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    logicalId: rewindEntryId,
    targetId: target.id,
    ...lineage.activeEntryId ? { fromId: lineage.activeEntryId } : {},
    truncatedCount,
    summary: `Rewound to entry ${target.id} (truncated ${truncatedCount} entries)`
  };
  return {
    version: 2,
    activeEntryId: target.id,
    entries: [...keptEntries, rewindEntry]
  };
}
function forkSessionLineage(lineage, selector, checkpoint) {
  const target = selector ? resolveSessionLineageTarget(lineage, selector, checkpoint) : lineage.activeEntryId ? resolveSessionLineageTarget(lineage, lineage.activeEntryId, checkpoint) : void 0;
  if (!target) {
    return null;
  }
  const path = getSessionLineagePath(lineage, target.id, checkpoint);
  const idMap = /* @__PURE__ */ new Map();
  const entries = [];
  let parentId = null;
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = path[index];
    const cloned = cloneForkableEntry(entry, parentId);
    entries.push(cloned);
    idMap.set(entry.id, cloned.id);
    parentId = cloned.id;
  }
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const source = path[index];
    const cloned = entries[index];
    if (source.type === "compaction" && cloned.type === "compaction" && source.firstKeptEntryId !== void 0) {
      const firstKeptEntryId = idMap.get(source.firstKeptEntryId);
      entries[index] = { ...cloned, firstKeptEntryId };
    }
    if (source.type === "branch_summary" && cloned.type === "branch_summary") {
      entries[index] = {
        ...cloned,
        ...source.fromId !== void 0 ? { fromId: idMap.get(source.fromId) ?? source.fromId } : {}
      };
    }
  }
  const labels = getResolvedLabels(lineage, checkpoint);
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = path[index];
    const label = labels.get(entry.id);
    const targetId = idMap.get(entry.id);
    if (!label || !targetId) {
      continue;
    }
    const labelEntryId = generateEntryId("label");
    const labelEntry = {
      type: "label",
      id: labelEntryId,
      parentId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      logicalId: labelEntryId,
      targetId,
      label
    };
    entries.push(labelEntry);
    parentId = labelEntry.id;
  }
  const sourceLatestGoal = findLatestGoalOnPath(lineage, path, checkpoint);
  if (sourceLatestGoal && sourceLatestGoal.goal) {
    const goalEntryId = generateEntryId("goal");
    const carriedGoalEntry = {
      type: "goal",
      id: goalEntryId,
      parentId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      logicalId: logicalIdForEntry(sourceLatestGoal),
      sourceEntryId: sourceLatestGoal.id,
      goal: sourceLatestGoal.goal,
      // Reuse the source event ('created' / 'updated' / 'paused' / etc.)
      // so the fork's transcript honestly reflects the goal's last state
      // at fork time, rather than fabricating a 'created' event.
      event: sourceLatestGoal.event
    };
    entries.push(carriedGoalEntry);
  }
  return {
    version: 2,
    activeEntryId: idMap.get(target.id) ?? null,
    entries
  };
}
function findLatestGoalOnPath(lineage, path, checkpoint) {
  if (path.length === 0) return null;
  const pathIds = /* @__PURE__ */ new Set();
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    pathIds.add(path[index].id);
  }
  let latest = null;
  for (let i = lineage.entries.length - 1; i >= 0; i--) {
    const scanned = lineage.entries.length - 1 - i;
    if (scanned > 0 && scanned % 256 === 0) checkpoint?.();
    const entry = lineage.entries[i];
    if (entry.type !== "goal") continue;
    if (entry.parentId === null || !pathIds.has(entry.parentId)) continue;
    if (latest === null) {
      latest = entry;
      continue;
    }
    if (entry.timestamp > latest.timestamp) {
      latest = entry;
    }
  }
  return latest;
}
function buildSessionTree(lineage) {
  const entries = lineage.entries.filter(isNavigableEntry);
  const labels = getResolvedLabels(lineage);
  const activePathIds = new Set(getSessionLineagePath(lineage).map((entry) => entry.id));
  const nodeMap = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    nodeMap.set(entry.id, {
      entry: cloneEntry(entry),
      children: [],
      label: labels.get(entry.id),
      active: activePathIds.has(entry.id)
    });
  }
  const roots = [];
  for (const entry of entries) {
    const node = nodeMap.get(entry.id);
    if (!node) {
      continue;
    }
    if (!entry.parentId) {
      roots.push(node);
      continue;
    }
    const parent = nodeMap.get(entry.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
function countActiveLineageMessages(lineage) {
  return getSessionMessagesFromLineage(lineage).length;
}
function archiveOldIslands(lineage) {
  if (!lineage.activeEntryId || lineage.entries.length === 0) {
    return { slimmedLineage: lineage, archivedEntries: [], archivedCount: 0, archiveBatchId: "" };
  }
  const byId = new Map(lineage.entries.map((e) => [e.id, e]));
  const preserved = /* @__PURE__ */ new Set();
  function preserveAncestorChain(entryId) {
    let cur2 = byId.get(entryId);
    while (cur2 && !preserved.has(cur2.id)) {
      preserved.add(cur2.id);
      cur2 = cur2.parentId ? byId.get(cur2.parentId) : void 0;
    }
  }
  let activeRootId = null;
  let cur = byId.get(lineage.activeEntryId);
  while (cur) {
    activeRootId = cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : void 0;
  }
  const childrenOf = /* @__PURE__ */ new Map();
  for (const entry of lineage.entries) {
    if (entry.parentId) {
      const bucket = childrenOf.get(entry.parentId) ?? [];
      bucket.push(entry.id);
      childrenOf.set(entry.parentId, bucket);
    }
  }
  if (activeRootId) {
    const queue = [activeRootId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (preserved.has(id)) continue;
      preserved.add(id);
      for (const childId of childrenOf.get(id) ?? []) {
        queue.push(childId);
      }
    }
  }
  for (const entry of lineage.entries) {
    if (entry.type === "label") {
      preserveAncestorChain(entry.targetId);
    }
  }
  for (const entry of lineage.entries) {
    if (entry.type !== "message") {
      preserved.add(entry.id);
    }
  }
  for (const entry of lineage.entries) {
    if (entry.type !== "message" && entry.parentId) {
      preserveAncestorChain(entry.parentId);
    }
  }
  const referencedByRetained = collectReferencedByRetained(lineage, preserved, byId);
  const toArchive = [];
  const toArchiveIds = /* @__PURE__ */ new Set();
  for (const entry of lineage.entries) {
    if (!preserved.has(entry.id) && !referencedByRetained.has(entry.id)) {
      toArchive.push(entry);
      toArchiveIds.add(entry.id);
    }
  }
  if (toArchive.length === 0) {
    return { slimmedLineage: lineage, archivedEntries: [], archivedCount: 0, archiveBatchId: "" };
  }
  const archiveBatchId = `batch_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const islandGroups = /* @__PURE__ */ new Map();
  for (const entry of toArchive) {
    let root = entry;
    let walk = entry.parentId ? byId.get(entry.parentId) : void 0;
    while (walk && toArchiveIds.has(walk.id)) {
      root = walk;
      walk = walk.parentId ? byId.get(walk.parentId) : void 0;
    }
    const bucket = islandGroups.get(root.id) ?? [];
    bucket.push(entry);
    islandGroups.set(root.id, bucket);
  }
  const markers = [];
  for (const [rootId, entries] of islandGroups) {
    const firstEntry = entries[0];
    const msgEntries = entries.filter((e) => e.type === "message");
    const preview = extractArchivePreview(msgEntries);
    const groupRoot = byId.get(rootId);
    const nearestPreservedParent = groupRoot?.parentId && (preserved.has(groupRoot.parentId) || referencedByRetained.has(groupRoot.parentId)) ? groupRoot.parentId : null;
    const markerEntryId = generateEntryId();
    markers.push({
      type: "archive_marker",
      id: markerEntryId,
      parentId: nearestPreservedParent,
      timestamp: firstEntry.timestamp,
      logicalId: markerEntryId,
      archiveBatchId,
      archivedEntryCount: entries.length,
      summary: `Archived: ${entries.length} entries. ${preview}`.slice(0, 600)
    });
  }
  const slimmedEntries = [
    ...lineage.entries.filter((e) => !toArchiveIds.has(e.id)),
    ...markers
  ];
  return {
    slimmedLineage: { ...lineage, entries: slimmedEntries },
    archivedEntries: toArchive,
    archivedCount: toArchive.length,
    archiveBatchId
  };
}
function collectReferencedByRetained(lineage, preserved, byId) {
  const referenced = /* @__PURE__ */ new Set();
  for (const entry of lineage.entries) {
    if (!preserved.has(entry.id) || entry.type !== "message") continue;
    const ref = entry.sourceEntryId;
    if (ref !== void 0 && ref !== entry.id && byId.has(ref) && !preserved.has(ref)) {
      referenced.add(ref);
    }
  }
  return referenced;
}
function isTextContentBlock(block) {
  return typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string";
}
function extractArchivePreview(entries) {
  const first = entries.find((e) => e.message?.role === "user");
  if (!first?.message) return "";
  const msg = first.message;
  if (typeof msg.content === "string") return msg.content.slice(0, 200);
  if (Array.isArray(msg.content)) {
    return msg.content.find(isTextContentBlock)?.text.slice(0, 200) ?? "";
  }
  return "";
}
export {
  appendSessionLineageLabel,
  applyLineageTruncation,
  applySessionCompaction,
  archiveOldIslands,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  evictOldIslandMessageContent,
  findPreviousUserEntryId,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessageEntryId,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  rewindSessionLineage,
  setSessionLineageActiveEntry
};
