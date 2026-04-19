/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 4)
 *
 * Managed-output fence detection and sanitization helpers. Zero-behavior-change
 * move from task-engine.ts.
 *
 * These helpers strip internal managed-task control-plane markers and fenced
 * protocol blocks (complete or max-tokens-truncated) from worker output before
 * it becomes user-facing text.
 *
 * The three sanitize functions (`sanitizeManagedUserFacingText`,
 * `sanitizeManagedStreamingText`, `sanitizeEvaluatorPublicAnswer`) are grouped
 * with the fence helpers (`MANAGED_FENCE_NAMES`, `isManagedFencePrefix`,
 * `findIncompleteManagedFenceIndex`) because they share the same fence-prefix
 * matching logic — moving them apart would require duplicating constants.
 */

import {
  MANAGED_TASK_CONTRACT_BLOCK,
  MANAGED_TASK_HANDOFF_BLOCK,
  MANAGED_TASK_SCOUT_BLOCK,
  MANAGED_TASK_VERDICT_BLOCK,
} from '../../../managed-protocol.js';
import {
  MANAGED_TASK_BUDGET_REQUEST_BLOCK,
  TACTICAL_CHILD_RESULT_BLOCK,
  TACTICAL_INVESTIGATION_SHARDS_BLOCK,
  TACTICAL_LOOKUP_SHARDS_BLOCK,
  TACTICAL_REVIEW_FINDINGS_BLOCK,
} from '../constants.js';

// Internal control-plane markers that should be cut from user-facing output.
export const MANAGED_CONTROL_PLANE_MARKERS = [
  '[Managed Task Protocol Retry]',
  'Assigned native agent identity:',
  'Tool policy:',
  'Blocked tools:',
  'Allowed shell patterns:',
  'Dependency handoff artifacts:',
  'Dependency summary preview:',
  'Preferred agent:',
  'Read structured bundle first:',
  'Read human summary next:',
];

/**
 * All known managed fence block names.  Used to detect truncated fences
 * whose info string is a prefix of one of these names (e.g. "k", "kod",
 * "kodax-task-sc" are all prefixes of "kodax-task-scout").
 */
export const MANAGED_FENCE_NAMES: readonly string[] = [
  MANAGED_TASK_SCOUT_BLOCK,               // kodax-task-scout
  MANAGED_TASK_CONTRACT_BLOCK,            // kodax-task-contract
  MANAGED_TASK_HANDOFF_BLOCK,             // kodax-task-handoff
  MANAGED_TASK_VERDICT_BLOCK,             // kodax-task-verdict
  TACTICAL_REVIEW_FINDINGS_BLOCK,         // kodax-review-findings
  TACTICAL_INVESTIGATION_SHARDS_BLOCK,    // kodax-investigation-shards
  TACTICAL_LOOKUP_SHARDS_BLOCK,           // kodax-lookup-shards
  TACTICAL_CHILD_RESULT_BLOCK,            // kodax-child-result
  MANAGED_TASK_BUDGET_REQUEST_BLOCK,      // kodax-budget-request
];

/**
 * Check whether `candidate` is a prefix of any known managed fence name.
 * Case-insensitive. Used to identify truncated fences (e.g. "```k", "```kodax-task-sc").
 */
export function isManagedFencePrefix(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return MANAGED_FENCE_NAMES.some((name) => name.startsWith(lower));
}

/**
 * Find the start index of a trailing unclosed fence whose info string is a
 * prefix of a known managed fence name.  Returns -1 if not found.
 *
 * Scans backwards from the end of the text so that earlier closed code blocks
 * (e.g. ```python...```) do not shadow a truncated managed fence at the tail.
 *
 * Matches patterns like:
 *   \n```k           (truncated at 1st char)
 *   \n```kodax-task   (truncated mid-name)
 *   \n```kodax-task-scout\nsummary: ...  (truncated mid-body)
 */
export function findIncompleteManagedFenceIndex(text: string): number {
  let searchFrom = text.length;

  while (searchFrom > 0) {
    const backtickIdx = text.lastIndexOf('```', searchFrom - 1);
    if (backtickIdx < 0) return -1;

    // Must start at beginning of a line (preceded by \n) or at position 0.
    if (backtickIdx > 0 && text[backtickIdx - 1] !== '\n') {
      searchFrom = backtickIdx;
      continue;
    }

    // Extract info string (word chars + hyphens immediately after ```)
    const rest = text.slice(backtickIdx + 3);
    const infoMatch = rest.match(/^([\w-]+)/);

    if (!infoMatch) {
      // Bare ``` with no info string → this is a closing fence marker.
      // Everything above it is closed.  Stop searching.
      return -1;
    }

    const infoString = infoMatch[1];
    const body = rest.slice(infoString.length);

    // Check whether this fence is closed (a bare ``` on its own line after it).
    if (/\n\s*```\s*(\n|$)/.test(body)) {
      // Closed fence — not what we are looking for.  Stop searching;
      // any earlier fence is also necessarily closed.
      return -1;
    }

    // ── Unclosed fence found ──
    // Include the preceding newline in the cut position.
    const fenceStart = backtickIdx > 0
      ? (backtickIdx > 1 && text[backtickIdx - 2] === '\r'
        ? backtickIdx - 2
        : backtickIdx - 1)
      : backtickIdx;

    // Full "kodax" prefix → definitively ours, strip regardless of body content.
    if (infoString.toLowerCase().startsWith('kodax')) {
      return fenceStart;
    }

    // Partial prefix (e.g. "k", "ko", "kod", "koda") → only strip if:
    //   1. The info string IS a prefix of a known managed fence name, AND
    //   2. The body is empty or whitespace-only (the fence name itself was
    //      truncated, not a legitimate code block with actual content).
    if (isManagedFencePrefix(infoString) && /^\s*$/.test(body)) {
      return fenceStart;
    }

    // Last unclosed fence is not managed — stop.
    return -1;
  }

  return -1;
}

export function sanitizeManagedUserFacingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  let cutIndex = -1;
  for (const marker of MANAGED_CONTROL_PLANE_MARKERS) {
    const index = trimmed.indexOf(marker);
    if (index >= 0 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index;
    }
  }
  if (cutIndex === 0) {
    return '';
  }
  let visibleText = (cutIndex > 0 ? trimmed.slice(0, cutIndex) : trimmed).trim();
  // Strip complete managed fences (with closing ```).
  // Full "kodax" prefix required — the name is never truncated in a closed fence.
  for (;;) {
    const stripped = visibleText.replace(/\r?\n?\`\`\`kodax[\w-]*\s*[\s\S]*?\`\`\`\s*$/i, '').trim();
    if (stripped === visibleText) {
      break;
    }
    visibleText = stripped;
  }
  // Strip trailing incomplete managed fence (no closing ``` — max_tokens truncation).
  // Uses prefix-matching against known managed fence names to avoid misidentifying
  // legitimate code blocks (e.g. ```kotlin, ```ksh).
  const incompleteFenceIdx = findIncompleteManagedFenceIndex(visibleText);
  if (incompleteFenceIdx >= 0) {
    visibleText = visibleText.slice(0, incompleteFenceIdx).trim();
  }
  return visibleText;
}

export function sanitizeManagedStreamingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  let cutIndex = -1;
  for (const marker of MANAGED_CONTROL_PLANE_MARKERS) {
    const index = trimmed.indexOf(marker);
    if (index >= 0 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index;
    }
  }

  // Detect incomplete managed fence using prefix-matching against known names.
  const incompleteManagedFenceIndex = findIncompleteManagedFenceIndex(trimmed);
  if (incompleteManagedFenceIndex >= 0 && (cutIndex === -1 || incompleteManagedFenceIndex < cutIndex)) {
    cutIndex = incompleteManagedFenceIndex;
  }

  if (cutIndex === 0) {
    return '';
  }

  return (cutIndex > 0 ? trimmed.slice(0, cutIndex) : trimmed).trim();
}

export function sanitizeEvaluatorPublicAnswer(text: string): string {
  const sanitized = sanitizeManagedUserFacingText(text).trim();
  if (!sanitized) {
    return '';
  }

  const paragraphs = sanitized.split(/\n\s*\n/);
  const remaining = [...paragraphs];
  let removedInternalFraming = false;

  const internalRolePattern = /\b(generator|planner|evaluator|verdict|contract|handoff|managed task)\b/i;
  const internalMetaPattern = /\b(spot-check|spot check|verification|double-check|double check|sufficient evidence)\b/i;
  const explicitProcessLeadPattern = /^(confirmed:|i now have sufficient evidence\b|let me (?:verify|check|double-check|review)\b|now let me\b|good\.\s*now let me\b|from the code i(?:'ve| have)? already (?:read|checked|reviewed)\b|here is my final evaluation\b)/i;

  while (remaining.length > 0) {
    const paragraph = remaining[0]?.trim() ?? '';
    if (!paragraph) {
      remaining.shift();
      removedInternalFraming = true;
      continue;
    }

    const isDivider = /^-{3,}$/.test(paragraph);
    if (isDivider && removedInternalFraming) {
      remaining.shift();
      continue;
    }

    const isExplicitProcessLead = explicitProcessLeadPattern.test(paragraph);
    const isInternalProcessLead = /^i\b/i.test(paragraph)
      && internalRolePattern.test(paragraph)
      && internalMetaPattern.test(paragraph);

    if (
      isExplicitProcessLead
      || isInternalProcessLead
    ) {
      remaining.shift();
      removedInternalFraming = true;
      continue;
    }

    break;
  }

  const cleaned = remaining.join('\n\n').trim();
  return cleaned || sanitized;
}
