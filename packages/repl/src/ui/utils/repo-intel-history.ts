import type { KodaXRepoIntelligenceTraceEvent } from "@kodax/coding";
import type { CreatableHistoryItem } from "../types.js";

/** Narrow info-only history item so callers can pass to emitInfoItemToCorrectLayer. */
export type RepoIntelTraceHistoryItem = {
  readonly type: "info";
  readonly text: string;
  readonly icon?: string;
};

/**
 * v0.7.27 FEATURE_086 — render a repo-intelligence trace event as an
 * info history item. Matches the retry / recovery pattern so the
 * transcript stays stylistically consistent.
 *
 * Stages carry different payloads; we render a compact single-line
 * summary with a `[RepoIntel] <stage> · ...` prefix that pairs well
 * with the event.summary field the emitter already populates.
 */
export function createRepoIntelTraceHistoryItem(
  event: KodaXRepoIntelligenceTraceEvent,
): RepoIntelTraceHistoryItem {
  const stageLabel = stageDisplayName(event.stage);
  const details = buildRepoIntelDetailLine(event);
  const text = details
    ? `[RepoIntel] ${stageLabel} · ${details}`
    : `[RepoIntel] ${stageLabel}`;

  return {
    type: "info",
    icon: "\u{1F4E1}",
    text,
  };
}

function stageDisplayName(stage: KodaXRepoIntelligenceTraceEvent["stage"]): string {
  switch (stage) {
    case "routing":
      return "routing";
    case "preturn":
      return "preturn";
    case "module":
      return "module";
    case "impact":
      return "impact";
    case "task-snapshot":
      return "task-snapshot";
    default: {
      const exhaustiveCheck: never = stage;
      return String(exhaustiveCheck);
    }
  }
}

function buildRepoIntelDetailLine(event: KodaXRepoIntelligenceTraceEvent): string {
  const parts: string[] = [];

  const capability = event.capability;
  if (capability) {
    parts.push(`mode=${capability.mode}`);
    if (capability.status !== "ok") {
      parts.push(`status=${capability.status}`);
    }
  }

  const trace = event.trace;
  if (trace) {
    if (trace.daemonLatencyMs !== undefined) {
      parts.push(`daemon ${trace.daemonLatencyMs}ms`);
    }
    if (trace.cliLatencyMs !== undefined) {
      parts.push(`cli ${trace.cliLatencyMs}ms`);
    }
    if (trace.cacheHit !== undefined) {
      parts.push(trace.cacheHit ? "cache hit" : "cache miss");
    }
    if (trace.capsuleEstimatedTokens !== undefined) {
      parts.push(`${formatTokens(trace.capsuleEstimatedTokens)} tokens`);
    }
  }

  // Fall back to the emitter's own `summary` string when we have no
  // structured fields to show. summary already contains stage= prefix,
  // so strip the duplicate stage marker the emitter adds.
  if (parts.length === 0 && event.summary) {
    return stripSummaryStagePrefix(event.summary);
  }

  return parts.join(" · ");
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

function stripSummaryStagePrefix(summary: string): string {
  // Emitter summary looks like `stage=routing | mode=... | daemon_ms=...`.
  // Drop the leading `stage=<value> | ` so the stage label doesn't
  // duplicate the prefix we already render.
  return summary.replace(/^stage=[^|]+\|\s*/, "").trim();
}

export function emitRepoIntelTraceHistoryItem(
  addHistoryItem: (item: CreatableHistoryItem) => void,
  event: KodaXRepoIntelligenceTraceEvent,
): void {
  addHistoryItem(createRepoIntelTraceHistoryItem(event) as CreatableHistoryItem);
}
