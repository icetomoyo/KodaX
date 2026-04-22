/**
 * Small pure managed-protocol parse/build helpers — restored from v0.7.22
 * task-engine (FEATURE_079 Slice 4). Zero-behavior-change port.
 *
 * Re-added v0.7.26 during parity audit: the Runner-driven path relies on
 * structured emit tools for the happy path, but the fenced-block
 * fallback is documented in the role prompts (Planner contract /
 * Evaluator verdict specs) so an LLM that fails to call the tool can
 * still surface a well-formed payload. These helpers drive that
 * fallback parsing, plus the user-safe failure-reason split that
 * prevents internal block names from leaking into user-visible errors.
 */

import {
  MANAGED_PROTOCOL_TOOL_NAME,
  MANAGED_TASK_CONTRACT_BLOCK,
  MANAGED_TASK_HANDOFF_BLOCK,
  MANAGED_TASK_SCOUT_BLOCK,
  MANAGED_TASK_VERDICT_BLOCK,
  mergeManagedProtocolPayload,
  normalizeManagedNextHarness,
  normalizeManagedVerdictStatus,
} from '../../../managed-protocol.js';
import type {
  KodaXManagedProtocolPayload,
  KodaXManagedVerdictPayload,
  KodaXResult,
} from '../../../types.js';

/**
 * Scan `text` for the last occurrence of a triple-backtick fenced block with
 * the given `blockName` info string. Returns the trimmed body and start index,
 * or `undefined` if no such fence exists. Case-insensitive on the info string.
 */
export function findLastFencedBlock(
  text: string,
  blockName: string,
): { body: string; index: number } | undefined {
  const pattern = new RegExp(String.raw`\`\`\`${blockName}\s*([\s\S]*?)\`\`\``, 'ig');
  let lastMatch: RegExpExecArray | undefined;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) {
      break;
    }
    lastMatch = match;
  }
  if (!lastMatch) {
    return undefined;
  }
  return {
    body: lastMatch[1]?.trim() ?? '',
    index: lastMatch.index,
  };
}

/**
 * Parse a JSON-encoded evaluator verdict body into a KodaXManagedVerdictPayload.
 * Returns `undefined` when the JSON is invalid or the required `status` field
 * cannot be normalized. Accepts both `snake_case` and `camelCase` field forms
 * for `next_harness`/`nextHarness`, `user_answer`/`userAnswer`, and
 * `followup`/`followups`.
 */
export function parseManagedTaskVerdictDirectiveFromJson(
  body: string,
  visibleText: string,
): KodaXManagedVerdictPayload | undefined {
  let parsed: {
    status?: string;
    reason?: string;
    user_answer?: string;
    userAnswer?: string;
    next_harness?: string;
    nextHarness?: string;
    followup?: string[] | string;
    followups?: string[] | string;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const status = parsed?.status ? normalizeManagedVerdictStatus(String(parsed.status)) : undefined;
  if (!status) {
    return undefined;
  }
  const nextHarnessCandidate = parsed.next_harness ?? parsed.nextHarness;
  const followupValue = parsed.followup ?? parsed.followups;
  const followups = Array.isArray(followupValue)
    ? followupValue.map((item) => String(item).trim()).filter(Boolean)
    : typeof followupValue === 'string'
      ? followupValue.split(/\r?\n/).map((item) => item.replace(/^-+\s*/, '').trim()).filter(Boolean)
      : [];
  return {
    source: 'evaluator',
    status,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() || undefined : undefined,
    nextHarness: nextHarnessCandidate ? normalizeManagedNextHarness(String(nextHarnessCandidate)) : undefined,
    followups,
    userFacingText: visibleText,
    userAnswer: typeof parsed.user_answer === 'string'
      ? parsed.user_answer.trim() || undefined
      : typeof parsed.userAnswer === 'string'
        ? parsed.userAnswer.trim() || undefined
        : undefined,
  };
}

/**
 * Classify a protocol failure reason into a user-safe `publicReason` (no
 * internal block names leaked) and a full `debugReason`. When the raw reason
 * mentions internal protocol tokens (block names, the protocol tool name),
 * return a generic public message and keep the original as debug detail.
 */
export function resolveManagedProtocolFailureReasons(
  reason: string,
): { publicReason: string; debugReason: string } {
  const normalized = reason.trim();
  if (!normalized) {
    return {
      publicReason: 'required structured completion data was missing',
      debugReason: 'No protocol failure reason was provided.',
    };
  }

  if (
    normalized.includes(MANAGED_PROTOCOL_TOOL_NAME)
    || normalized.includes(MANAGED_TASK_VERDICT_BLOCK)
    || normalized.includes(MANAGED_TASK_CONTRACT_BLOCK)
    || normalized.includes(MANAGED_TASK_SCOUT_BLOCK)
    || normalized.includes(MANAGED_TASK_HANDOFF_BLOCK)
  ) {
    if (/verdict|evaluator/i.test(normalized)) {
      return {
        publicReason: 'required structured verification data was missing',
        debugReason: normalized,
      };
    }
    return {
      publicReason: 'required structured completion data was missing',
      debugReason: normalized,
    };
  }

  return {
    publicReason: normalized,
    debugReason: normalized,
  };
}

/**
 * Return just the `publicReason` portion of `resolveManagedProtocolFailureReasons`.
 * Convenience wrapper used when only the user-visible summary is needed.
 */
export function summarizeManagedProtocolFailureReason(reason: string): string {
  return resolveManagedProtocolFailureReasons(reason).publicReason;
}

/**
 * Append a "Verification degraded: {reason}" note to `baseText`. If the note is
 * already present, return `baseText` unchanged. If `baseText` is empty, return
 * just the note.
 */
export function buildVerificationDegradedVisibleText(
  baseText: string,
  reason: string,
): string {
  const normalizedBase = baseText.trim();
  const note = `Verification degraded: ${reason}`;
  if (!normalizedBase) {
    return note;
  }
  return normalizedBase.includes(note) ? normalizedBase : `${normalizedBase}\n\n${note}`;
}

/**
 * Merge `payload` into `result.managedProtocolPayload` and return a new result
 * object with the merged payload. Delegates the actual merge to
 * `mergeManagedProtocolPayload` in managed-protocol.ts so the shape rules live
 * in one place.
 */
export function withManagedProtocolPayload(
  result: KodaXResult,
  payload: Partial<KodaXManagedProtocolPayload>,
): KodaXResult {
  const mergedPayload = mergeManagedProtocolPayload(result.managedProtocolPayload, payload);
  return {
    ...result,
    managedProtocolPayload: mergedPayload,
  };
}
