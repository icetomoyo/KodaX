/**
 * Judge predicates middleware — CAP-017 + CAP-018 + CAP-088
 *
 * Capability inventory:
 * - docs/features/v0.7.29-capability-inventory.md#cap-017-pre-answer-judge
 * - docs/features/v0.7.29-capability-inventory.md#cap-018-post-tool-judge
 * - docs/features/v0.7.29-capability-inventory.md#cap-088-tool-evidence-summarizer-for-auto-reroute-input
 *
 * Class 3 (declarable opt-in middleware). Two judges fire from the SA
 * loop in `auto` reasoning mode:
 *
 *   - **Pre-answer judge** (CAP-017): right before the model emits a
 *     final answer, when the response has the *shape* of a real review
 *     output (not a "now let me check ..." mid-reasoning utterance),
 *     re-evaluate via auto-reroute (CAP-019) to potentially escalate
 *     reasoning depth.
 *
 *   - **Post-tool judge** (CAP-018): after a tool result lands, when
 *     the tool evidence contains failure signals, invoke auto-reroute
 *     to potentially switch task family (e.g., review → bugfix).
 *
 * The gating IF that wraps each `maybeAdvanceAutoReroute` call lives at
 * the call site in `agent.ts` (and will move to the substrate executor's
 * judge hook chain in P3). What lives here are the **predicates** that
 * decide whether the call site should fire:
 *
 *   - `isReviewFinalAnswerCandidate(prompt, plan, lastText)` — gates the
 *     pre-answer judge.
 *   - `hasStrongToolFailureEvidence(toolEvidence)` — gates the post-tool
 *     judge.
 *   - `summarizeToolEvidence(toolBlocks, toolResults)` (CAP-088) —
 *     constructs the `toolEvidence` string that feeds into the
 *     `hasStrongToolFailureEvidence` gate. Three invariants are
 *     load-bearing:
 *       (a) only includes results whose content passes
 *           `looksLikeToolRuntimeEvidence` (delegates to
 *           `looksLikeActionableRuntimeEvidence` in `runtime-evidence.ts`);
 *       (b) truncates each line at 220 chars (217 + `...`);
 *       (c) deduplicates identical lines via `Set`;
 *       (d) caps at 5 lines.
 *
 * Both predicates and the summarizer are pure functions of their inputs
 * and contain regex / string-shape heuristics that have been tuned over
 * multiple releases.
 *
 * **Default for**: `defaultCodingAgent` (preserves SA current behavior);
 * post-tool judge ALSO enabled on `generatorAgent` per FEATURE_100 design
 * — give Generator mid-iteration adaptive recovery.
 *
 * Migration history: extracted from `agent.ts:1106-1154`
 * (`looksLikeReviewProgressUpdate` 1106-1124 +
 * `isReviewFinalAnswerCandidate` 1126-1149 +
 * `hasStrongToolFailureEvidence` 1151-1154) and `agent.ts:3125-3152`
 * (`summarizeToolEvidence` + `looksLikeToolRuntimeEvidence`) —
 * pre-FEATURE_100 baseline — during FEATURE_100 P2.
 */

import type { KodaXToolResultBlock } from '../../types.js';
import type { ReasoningPlan } from '../../reasoning.js';
import { looksLikeActionableRuntimeEvidence } from '../../runtime-evidence.js';

const REVIEW_PROGRESS_UPDATE_PREFIXES = [
  'now let me',
  'let me look',
  'let me check',
  'let me inspect',
  'now i will',
  '现在让我',
  '让我看看',
  '让我检查',
  '我现在来',
  '接下来我',
  '下面我来',
] as const;

export function looksLikeReviewProgressUpdate(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return REVIEW_PROGRESS_UPDATE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isReviewFinalAnswerCandidate(
  prompt: string,
  reasoningPlan: ReasoningPlan,
  lastText: string,
): boolean {
  if (reasoningPlan.decision.primaryTask !== 'review') {
    return true;
  }

  const normalizedPrompt = prompt.toLowerCase();
  const normalizedText = lastText.trim();
  if (!normalizedText || looksLikeReviewProgressUpdate(normalizedText)) {
    return false;
  }

  if (normalizedText.length >= 600) {
    return true;
  }

  return /\b(must fix|finding|optional improvements|final assessment|verdict)\b/i.test(normalizedText)
    || /(必须修复|问题|建议|结论|评审报告|最终评审)/.test(normalizedText)
    || /^\s*(?:[-*]|\d+\.)\s+/m.test(normalizedText)
    || /\b(must[- ]fix|strict review|pr review|code review)\b/i.test(normalizedPrompt);
}

export function hasStrongToolFailureEvidence(toolEvidence: string): boolean {
  return /\b(fail(?:ed|ure)?|error|blocked|exception|traceback|assert|regression|not found|timeout|console error|permission denied)\b/i
    .test(toolEvidence);
}

/**
 * Thin wrapper around `looksLikeActionableRuntimeEvidence` from
 * `runtime-evidence.ts`. The wrapper exists so `summarizeToolEvidence`
 * can swap in a different signal source later without touching the
 * summarizer. Migration history: `agent.ts:3150-3152`.
 */
export function looksLikeToolRuntimeEvidence(content: string): boolean {
  return looksLikeActionableRuntimeEvidence(content);
}

export function summarizeToolEvidence(
  toolBlocks: Array<{ id: string; name: string }>,
  toolResults: KodaXToolResultBlock[],
): string {
  const evidenceLines: string[] = [];

  for (const result of toolResults) {
    if (typeof result.content !== 'string') {
      continue;
    }

    const toolName = toolBlocks.find((tool) => tool.id === result.tool_use_id)?.name ?? 'tool';
    const content = result.content.replace(/\s+/g, ' ').trim();
    if (!content || !looksLikeToolRuntimeEvidence(content)) {
      continue;
    }

    const truncated =
      content.length > 220 ? `${content.slice(0, 217)}...` : content;
    evidenceLines.push(`- ${toolName}: ${truncated}`);
  }

  return Array.from(new Set(evidenceLines)).slice(0, 5).join('\n');
}
