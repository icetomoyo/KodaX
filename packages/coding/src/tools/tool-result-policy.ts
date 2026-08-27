import type { KodaXToolExecutionContext } from '../types.js';
import { hasTransientTextArtifact } from '../transient-text-artifacts.js';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { countTokens } from '../tokenizer.js';
import {
  formatSize,
  persistToolOutput,
  truncateHead,
  truncateTail,
} from './truncate.js';
import type { ToolResultCapacity } from './tool-result-budget.js';

export interface ToolResultPolicy {
  maxLines: number;
  maxBytes: number;
  direction: 'head' | 'tail';
  spillToFile: boolean;
}

export interface GuardedToolResult {
  content: string;
  truncated: boolean;
  outputPath?: string;
  policy: ToolResultPolicy;
  /**
   * FEATURE_121 v0.7.40 — set when `persistToolOutput` threw and
   * `content` was returned inline as the data-loss-guard fallback.
   * Callers that need an LLM-summary follow-up (`dispatch-child-tasks`
   * for `child_task_summary`) branch on this flag. Undefined/false
   * means the normal success path ran.
   */
  spillFailed?: boolean;
}

// These are preview-shape ceilings used only after the request-level batch
// owner has proven that complete delivery cannot fit. They are not spill
// triggers and never shorten an otherwise admissible result.
const DEFAULT_POLICY: ToolResultPolicy = {
  maxLines: 1200,
  maxBytes: 40 * 1024,
  direction: 'head',
  spillToFile: true,
};

const TOOL_RESULT_POLICIES: Record<string, ToolResultPolicy> = {
  read: {
    maxLines: 2000,
    maxBytes: 50 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  bash: {
    maxLines: 600,
    maxBytes: 32 * 1024,
    direction: 'tail',
    spillToFile: true,
  },
  grep: {
    maxLines: 400,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  web_search: {
    maxLines: 240,
    maxBytes: 20 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  web_fetch: {
    maxLines: 320,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  code_search: {
    maxLines: 320,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  semantic_lookup: {
    maxLines: 260,
    maxBytes: 20 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  changed_diff: {
    maxLines: 1400,
    maxBytes: 48 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  changed_diff_bundle: {
    maxLines: 1600,
    maxBytes: 56 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  write: {
    maxLines: 350,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  edit: {
    maxLines: 350,
    maxBytes: 24 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  // FEATURE_121 (v0.7.40): child task <task-completed> banner summary.
  // 50KB / head — aligns with `read`. Child role prompts encourage placing
  // executive summary in the report head, so head-direction preserves the
  // most decision-relevant content for Worker.
  child_task_summary: {
    maxLines: 1500,
    maxBytes: 50 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  tool_call: {
    maxLines: 2200,
    maxBytes: 64 * 1024,
    direction: 'head',
    spillToFile: true,
  },
  // FEATURE_296 T5: irreducibly oversized fresh user input (request-copy
  // degradation). Only the hint is load-bearing — the preview size comes from
  // `maxInlineTokens` at the call site.
  user_input: {
    maxLines: 1200,
    maxBytes: 40 * 1024,
    direction: 'head',
    spillToFile: true,
  },
};

// Capacity answers "will the next request fit?"; attention bounds answer
// "can the model use this result without one payload dominating the turn?".
// Both are enforced here so Issue 158 keeps one request-level admission owner.
const TOOL_RESULT_PER_ENTRY_ATTENTION_TOKENS = 16_000;
const TOOL_RESULT_BATCH_ATTENTION_TOKENS = 48_000;
const TOOL_RESULT_ENTRY_STRUCTURAL_TOKENS = 4;
const TOOL_RESULT_BATCH_STRUCTURAL_TOKENS = 4;

export function getToolResultPolicy(toolName: string): ToolResultPolicy {
  return TOOL_RESULT_POLICIES[toolName] ?? DEFAULT_POLICY;
}

function exceedsLineLimit(content: string, maxLines: number): boolean {
  if (maxLines < 1) return content.length > 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > maxLines) return true;
  }
  return false;
}

function exceedsToolResultPolicy(content: string, policy: ToolResultPolicy): boolean {
  if (Buffer.byteLength(content, 'utf8') > policy.maxBytes) return true;
  return exceedsLineLimit(content, policy.maxLines);
}

function buildToolResultHint(toolName: string): string {
  switch (toolName) {
    case 'read':
      return 'Use read with offset/limit or grep to continue with a smaller slice.';
    case 'bash':
      return 'Narrow the command, or redirect output to a file before reading it.';
    case 'grep':
      return 'Narrow the pattern or path, or switch to files_with_matches/count first.';
    case 'web_search':
      return 'Refine the query or fetch a specific result URL for higher-confidence source capture.';
    case 'web_fetch':
      return 'Fetch a narrower page or follow up with read/grep on the saved output file.';
    case 'code_search':
      return 'Narrow the search root or query, or follow up with read on the matched file.';
    case 'semantic_lookup':
      return 'Narrow the query or use symbol_context/module_context for a deeper semantic follow-up.';
    case 'changed_diff':
      return 'Continue with changed_diff offset/limit, or switch to read for current-file context after identifying the relevant patch slice.';
    case 'changed_diff_bundle':
      return 'Use changed_diff_bundle to sweep high-priority files first, then switch to changed_diff or read for a specific suspicious file.';
    case 'write':
    case 'edit':
      return 'Inspect the file with read instead of relying on a huge diff preview.';
    case 'child_task_summary':
      return 'Use the Read tool on the saved output path to view the full child task report.';
    case 'user_input':
      return 'Use read with offset/limit on the saved output file to page through the full input.';
    default:
      return 'Use a narrower follow-up tool call to inspect the missing details.';
  }
}

export interface ApplyToolResultGuardrailOptions {
  /**
   * FEATURE_121 (v0.7.40): force the guardrail down the spill+preview path
   * regardless of `policy.maxBytes`. Used by envelope aggregate budget
   * enforcement to reclaim space when N child summaries individually fit
   * but together exceed the envelope cap.
   */
  forceSpill?: boolean;
  /** Optional physical capacity for a single-result compatibility caller. */
  toolResultBudget?: ToolResultCapacity;
  /** Exact final content budget, including the artifact marker. */
  maxInlineTokens?: number;
  /** Existing local artifact pointer when re-admitting an already guarded result. */
  existingOutputPath?: string;
  /** Explicit run-scoped spill directory for request-only artifacts. */
  outputDirectory?: string;
  /** Trusted request-only persistence seam for non-filesystem artifacts. */
  persistOutput?: (toolName: string, content: string) => Promise<string>;
}

export interface ToolResultBatchEntry {
  readonly id: string;
  readonly toolName: string;
  readonly content: string;
  readonly outputPath?: string;
}

export const TOOL_RESULT_INCOMPLETE_MARKER = 'KODAX_RESULT_INCOMPLETE';

/**
 * Capacity debt (FEATURE_296 / ADR-067): the admitted batch exceeds the local
 * next-request estimate by `requiredTokens - availableTokens`. Debt is a
 * recovery signal for the request-assembly ladder (forced compaction, reserve
 * shrink); it never terminates a run by itself.
 */
export interface ToolResultBatchDebt {
  readonly requiredTokens: number;
  readonly availableTokens: number;
}

/** Result of the batch admission choke point; debt is present only when over. */
export interface GuardedToolResultBatch {
  readonly entries: readonly ToolResultBatchEntry[];
  readonly capacityDebt?: ToolResultBatchDebt;
}

/** Single diagnostic identity for debt events across all admission callers. */
export const TOOL_RESULT_DEBT_DIAGNOSTIC_SOURCE = 'coding:tool-result-policy';

export function emitCapacityDebtDiagnostic(
  requiredTokens: number,
  availableTokens: number,
): void {
  emitKodaXDiagnostic({
    source: TOOL_RESULT_DEBT_DIAGNOSTIC_SOURCE,
    level: 'error',
    message:
      `Tool result admission requires ${requiredTokens} tokens against a `
      + `${availableTokens}-token budget; over-budget entries are admitted as `
      + `capacity debt (or kept as a typed failure by child-briefing callers).`,
  });
}

/**
 * Typed capacity terminal (FEATURE_296): raised only where debt admission does
 * not apply (child briefing sizing, ladder-exhaustion terminals). Carries a
 * stable code plus token numbers so SDK layers can classify by identity
 * instead of message text.
 */
export class ToolResultBatchCapacityError extends Error {
  readonly code = 'KODAX_TOOL_RESULT_CAPACITY_EXCEEDED';
  readonly requiredTokens: number;
  readonly availableTokens: number;

  constructor(requiredTokens: number, availableTokens: number) {
    super(
      `Tool result batch cannot preserve recoverable tool/result pairs within capacity: `
      + `${requiredTokens} tokens required, ${availableTokens} available.`,
    );
    this.name = 'ToolResultBatchCapacityError';
    this.requiredTokens = requiredTokens;
    this.availableTokens = availableTokens;
  }
}

export async function applyToolResultGuardrail(
  toolName: string,
  content: string,
  ctx: KodaXToolExecutionContext,
  options?: ApplyToolResultGuardrailOptions,
): Promise<GuardedToolResult> {
  const policy = getToolResultPolicy(toolName);
  const maxInlineTokens = options?.maxInlineTokens
    ?? options?.toolResultBudget?.aggregateInlineTokens;
  const existingOutputPath = options?.existingOutputPath;
  const existingGuard = existingOutputPath
    ? splitGuardedContent(content)
    : undefined;
  if (existingGuard) {
    const outputPath = existingOutputPath;
    return {
      content: maxInlineTokens !== undefined && countTokens(content) > maxInlineTokens
        ? fitExistingGuardedContentToTokenBudget(existingGuard, policy, maxInlineTokens)
        : content,
      truncated: true,
      ...(outputPath ? { outputPath } : {}),
      policy,
    };
  }
  const exceedsPhysicalPolicy = exceedsToolResultPolicy(content, policy);
  if (!options?.forceSpill && !exceedsPhysicalPolicy && maxInlineTokens === undefined) {
    return {
      content,
      truncated: false,
      policy,
    };
  }
  if (
    !options?.forceSpill
    && !exceedsPhysicalPolicy
    && maxInlineTokens !== undefined
    && countTokens(content) <= maxInlineTokens
  ) {
    return {
      content,
      truncated: false,
      policy,
    };
  }
  // Under forceSpill, we still want the same head/tail preview behaviour, but
  // we treat any content as "must spill" so we go through the spill path.
  const effectivePolicy: ToolResultPolicy = exceedsPhysicalPolicy
    ? policy
    : maxInlineTokens !== undefined
    ? {
        ...policy,
        maxBytes: Buffer.byteLength(content, 'utf-8'),
        maxLines: Number.MAX_SAFE_INTEGER,
      }
    : options?.forceSpill
    ? { ...policy, maxBytes: Math.min(policy.maxBytes, 2 * 1024), maxLines: Math.min(policy.maxLines, 20) }
    : policy;
  const truncation =
    effectivePolicy.direction === 'tail'
      ? truncateTail(content, effectivePolicy)
      : truncateHead(content, effectivePolicy);

  let outputPath: string | undefined;
  let spillFailed = false;
  let spillError: unknown;
  if (policy.spillToFile) {
    try {
      outputPath = options?.persistOutput
        ? await options.persistOutput(toolName, content)
        : await persistToolOutput(toolName, content, ctx, options?.outputDirectory);
    } catch (err) {
      outputPath = undefined;
      spillFailed = true;
      spillError = err;
    }
  }

  // FEATURE_121 v0.7.40 — spill-failure data-loss guard.
  //
  // When `persistToolOutput` throws (disk full / EACCES / EROFS / EIO /
  // ENOSPC / SELinux denial), the previous behaviour silently dropped
  // the truncation tail: caller got a `~50KB` preview with no spill
  // path and no marker, the remaining bytes were unrecoverable, and
  // the Worker had no signal that anything was lost.
  //
  // Treatment: return full `content` inlined with `truncated: false`.
  // The agent-layer envelope-budget enforcer will get a second chance
  // to spill at banner-composition time; if that also fails, the full
  // payload still rides in the LLM context (over-budget but visible)
  // rather than silently shrinking. User contract for FEATURE_121:
  // silent data loss > observable over-budget.
  //
  // `truncated: false` is the right field value here even though the
  // mechanism is "fallback inline" — all current callers
  // (dispatch-child-tasks.ts × 3, envelope-budget.ts × 1) read only
  // `.content`. If a future caller branches on `.truncated`, it should
  // treat this case the same as "small content fit in budget" (which
  // is exactly the externally-visible behaviour).
  //
  // Disk failure is still reported, but through the diagnostic channel so
  // interactive hosts can render or suppress it without corrupting the TUI.
  if (spillFailed) {
    emitKodaXDiagnostic({
      source: 'coding:tool-result-policy',
      level: 'error',
      message:
        `persistToolOutput failed for ${toolName}; ` +
        `inlining ${Buffer.byteLength(content, 'utf-8')} bytes to preserve data.`,
      detail: spillError,
    });
    return {
      content,
      truncated: false,
      policy,
      spillFailed: true,
    };
  }

  const guardedContent = maxInlineTokens !== undefined
    ? fitGuardedContentToTokenBudget(
        toolName,
        content,
        policy,
        outputPath,
        maxInlineTokens,
      )
    : formatGuardedContent(toolName, policy, truncation, outputPath, true);

  if (process.env.KODAX_DEBUG_TOOL_GUARDRAILS) {
    emitKodaXDiagnostic({
      source: 'coding:tool-result-policy',
      level: 'debug',
      message: 'Tool result truncated by guardrail.',
      detail: {
        toolName,
        outputPath,
        totalBytes: truncation.totalBytes,
        shownBytes: truncation.outputBytes,
        truncatedBy: truncation.truncatedBy,
      },
    });
  }

  return {
    content: guardedContent,
    truncated: true,
    outputPath,
    policy,
  };
}

/**
 * The sole capacity owner for a dispatched tool-result batch.
 *
 * Results remain complete while each result and the batch fit both the physical
 * next-request capacity and the independent attention bounds. The largest raw
 * results are spilled one at a time, with the full output preserved as an
 * artifact. The actual replacement (including its marker and envelope overhead)
 * is recounted before deciding whether another result must spill. When even
 * marker-only entries exceed the physical estimate, the shortfall is returned
 * as capacity debt (FEATURE_296 / ADR-067) — the pair always commits and the
 * recovery ladder owns the next request — while artifact persistence failure
 * still degrades visibly rather than discarding otherwise admissible data.
 */
export async function applyToolResultBatchGuardrail(
  entries: readonly ToolResultBatchEntry[],
  ctx: KodaXToolExecutionContext,
  budget: ToolResultCapacity | undefined,
  additionalMessageTokens = 0,
): Promise<GuardedToolResultBatch> {
  if (entries.length === 0) return { entries: [] };

  const result = await Promise.all(entries.map(async (entry): Promise<ToolResultBatchEntry> => {
    const preserveTransientCapability = entry.outputPath !== undefined
      && hasTransientTextArtifact(entry.outputPath);
    const guarded = await applyToolResultGuardrail(entry.toolName, entry.content, ctx, {
      existingOutputPath: entry.outputPath,
      ...(preserveTransientCapability
        ? { persistOutput: async () => entry.outputPath! }
        : {}),
    });
    return {
      ...entry,
      content: guarded.content,
      ...(guarded.outputPath ? { outputPath: guarded.outputPath } : {}),
    };
  }));
  if (!budget) return { entries: result };

  const entryTokens = result.map((entry) => countToolResultTokens(entry.content));
  const fixedMessageTokens = Math.max(0, Math.floor(additionalMessageTokens));
  const physicalCapacityTokens = Math.max(0, Math.floor(budget.aggregateInlineTokens));
  let inlineResultTokens = TOOL_RESULT_BATCH_STRUCTURAL_TOKENS
    + entryTokens.reduce((total, tokens) => total + tokens, 0);
  let physicalTotalTokens = fixedMessageTokens + inlineResultTokens;
  if (physicalTotalTokens <= physicalCapacityTokens
    && inlineResultTokens <= TOOL_RESULT_BATCH_ATTENTION_TOKENS
    && entryTokens.every((tokens) => tokens <= TOOL_RESULT_PER_ENTRY_ATTENTION_TOKENS)) {
    return { entries: result };
  }

  const candidates = result
    .map((_entry, index) => ({ index, tokens: entryTokens[index]! }))
    .sort((left, right) => right.tokens - left.tokens);

  for (const candidate of candidates) {
    const exceedsEntryAttention = entryTokens[candidate.index]!
      > TOOL_RESULT_PER_ENTRY_ATTENTION_TOKENS;
    const exceedsBatchAttention = inlineResultTokens > TOOL_RESULT_BATCH_ATTENTION_TOKENS;
    const exceedsPhysicalCapacity = physicalTotalTokens > physicalCapacityTokens;
    if (!exceedsEntryAttention && !exceedsBatchAttention && !exceedsPhysicalCapacity) break;
    const entry = result[candidate.index]!;
    const preserveTransientCapability = entry.outputPath !== undefined
      && hasTransientTextArtifact(entry.outputPath);
    const otherInlineTokens = inlineResultTokens - entryTokens[candidate.index]!;
    const maxInlineTokens = Math.min(
      TOOL_RESULT_PER_ENTRY_ATTENTION_TOKENS - TOOL_RESULT_ENTRY_STRUCTURAL_TOKENS,
      Math.max(
        0,
        TOOL_RESULT_BATCH_ATTENTION_TOKENS
          - otherInlineTokens
          - TOOL_RESULT_ENTRY_STRUCTURAL_TOKENS,
      ),
      Math.max(
        0,
        physicalCapacityTokens
          - fixedMessageTokens
          - otherInlineTokens
          - TOOL_RESULT_ENTRY_STRUCTURAL_TOKENS,
      ),
    );
    const guarded = await applyToolResultGuardrail(entry.toolName, entry.content, ctx, {
      forceSpill: true,
      maxInlineTokens,
      existingOutputPath: entry.outputPath,
      ...(preserveTransientCapability
        ? { persistOutput: async () => entry.outputPath! }
        : {}),
    });
    result[candidate.index] = {
      ...entry,
      content: guarded.content,
      ...(guarded.outputPath ? { outputPath: guarded.outputPath } : {}),
    };
    entryTokens[candidate.index] = countToolResultTokens(guarded.content);
    inlineResultTokens = otherInlineTokens + entryTokens[candidate.index]!;
    physicalTotalTokens = fixedMessageTokens + inlineResultTokens;
  }

  if (physicalTotalTokens > physicalCapacityTokens) {
    emitCapacityDebtDiagnostic(physicalTotalTokens, physicalCapacityTokens);
    return {
      entries: result,
      capacityDebt: {
        requiredTokens: physicalTotalTokens,
        availableTokens: physicalCapacityTokens,
      },
    };
  }

  const attentionAdmissionIncomplete = inlineResultTokens > TOOL_RESULT_BATCH_ATTENTION_TOKENS
    || entryTokens.some((tokens) => tokens > TOOL_RESULT_PER_ENTRY_ATTENTION_TOKENS);
  if (attentionAdmissionIncomplete) {
    emitKodaXDiagnostic({
      source: 'coding:tool-result-policy',
      level: 'warn',
      message:
        `Tool result attention admission could not be satisfied without losing recoverability; `
        + `${inlineResultTokens} physically admissible tokens remain inline.`,
    });
  }

  return { entries: result };
}

function countToolResultTokens(content: string): number {
  // Mirrors the current tokenizer's structural overhead for a tool_result block.
  return countTokens(content) + TOOL_RESULT_ENTRY_STRUCTURAL_TOKENS;
}

interface ExistingGuardedContent {
  readonly preview: string;
  readonly marker: string;
}

function splitGuardedContent(content: string): ExistingGuardedContent | undefined {
  const markerStart = content.lastIndexOf(`[${TOOL_RESULT_INCOMPLETE_MARKER}.`);
  if (markerStart < 0) return undefined;

  const marker = content.slice(markerStart).trimEnd();
  if (!marker.endsWith(']')) return undefined;
  const separatorLength = content.slice(Math.max(0, markerStart - 2), markerStart) === '\n\n'
    ? 2
    : 0;
  const preview = content.slice(0, markerStart - separatorLength);
  return {
    preview,
    marker,
  };
}

function fitExistingGuardedContentToTokenBudget(
  guarded: ExistingGuardedContent,
  policy: ToolResultPolicy,
  maxInlineTokens: number,
): string {
  if (countTokens(guarded.marker) > maxInlineTokens || !guarded.preview) {
    return guarded.marker;
  }

  const truncate = policy.direction === 'tail' ? truncateTail : truncateHead;
  let best = guarded.marker;
  let low = 1;
  let high = Buffer.byteLength(guarded.preview, 'utf-8');
  while (low <= high) {
    const candidateBytes = Math.floor((low + high) / 2);
    const preview = truncate(guarded.preview, {
      maxBytes: candidateBytes,
      maxLines: Number.MAX_SAFE_INTEGER,
    }).content;
    const candidate = preview ? `${preview}\n\n${guarded.marker}` : guarded.marker;
    if (countTokens(candidate) <= maxInlineTokens) {
      best = candidate;
      low = candidateBytes + 1;
    } else {
      high = candidateBytes - 1;
    }
  }
  return best;
}

function fitGuardedContentToTokenBudget(
  toolName: string,
  content: string,
  policy: ToolResultPolicy,
  outputPath: string | undefined,
  maxInlineTokens: number,
): string {
  const truncate = policy.direction === 'tail' ? truncateTail : truncateHead;
  const markerOnly = formatGuardedContent(
    toolName,
    policy,
    truncate(content, { maxBytes: 0, maxLines: 0 }),
    outputPath,
    false,
  );
  if (countTokens(markerOnly) > maxInlineTokens) {
    return markerOnly;
  }

  let best = markerOnly;
  let low = 1;
  let high = Math.max(0, Buffer.byteLength(content, 'utf-8') - 1);
  while (low <= high) {
    const candidateBytes = Math.floor((low + high) / 2);
    const truncation = truncate(content, {
      maxBytes: candidateBytes,
      maxLines: Number.MAX_SAFE_INTEGER,
    });
    const candidate = formatGuardedContent(
      toolName,
      policy,
      truncation,
      outputPath,
      false,
    );
    if (countTokens(candidate) <= maxInlineTokens) {
      best = candidate;
      low = candidateBytes + 1;
    } else {
      high = candidateBytes - 1;
    }
  }
  return best;
}

function formatGuardedContent(
  toolName: string,
  policy: ToolResultPolicy,
  truncation: ReturnType<typeof truncateHead>,
  outputPath: string | undefined,
  explainMissingFirstLine: boolean,
): string {
  const preview = explainMissingFirstLine && truncation.firstLineExceedsLimit && !truncation.content
    ? '[Output preview omitted because the first line alone exceeded the tool-output byte limit.]'
    : truncation.content;
  const prefix = policy.direction === 'tail'
    ? 'Tool output truncated to the most recent portion.'
    : 'Tool output truncated.';
  const summary =
    `${prefix} Showing ${truncation.outputLines} of ${truncation.totalLines} lines `
    + `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  const saved = outputPath ? ` Full output saved to: ${outputPath}.` : '';
  const hint = ` ${buildToolResultHint(toolName)}`;
  const marker = `[${TOOL_RESULT_INCOMPLETE_MARKER}. ${summary}${saved}${hint}]`;
  return preview ? `${preview}\n\n${marker}` : marker;
}
