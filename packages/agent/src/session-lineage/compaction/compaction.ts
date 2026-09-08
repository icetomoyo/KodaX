/**
 * ../../index.js Compaction Core
 *
 * Full-coverage large compaction with deterministic recent-context and
 * user-query preservation.
 */

import { randomUUID } from 'node:crypto';
import type { KodaXBaseProvider, KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import type { CompactionAnchor, CompactionConfig, CompactionResult, CompactionRequestMetrics } from './types.js';
import { countTokens, estimateTokens } from '../../tokenizer.js';
import { extractArtifactLedger, extractFileOps } from './file-tracker.js';
import {
  buildCompactionCacheInstruction,
  buildCompactionPromptSnapshot,
  extractCompactMemorySeed,
  generateSummary,
} from './summary-generator.js';
import type {
  CompactionCacheContext,
  CompactionProviderObserver,
  CompactionProviderRouting,
} from './summary-generator.js';
import { extractBashIntent } from './bash-intent.js';
import { preserveToolResultRecovery } from './result-extractors.js';
import {
  calculateMaxContextInputTokens,
  ContextCapacityError,
  reclaimReservedResponseTokens,
  exceedsContextCapacity,
} from '../../context-capacity.js';
import { resolveCompactionPolicy } from './policy.js';
import {
  mergeUserQueryLedger,
  parseUserQueryLedger,
  renderUserQueryLedger,
} from './query-ledger.js';

const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * FEATURE_183 (v0.7.42) — tool names whose tool_result content is NEVER
 * pruned / microcompact-cleared.
 *
 * **Rationale**: KodaX historically used a near-empty blacklist (`{'skill'}`),
 * meaning *every* other tool_result was eligible for prune / clear. Forensic
 * analysis (788-session scan) + claudecode parity review showed this
 * over-aggressively destroyed high-value context — child-task verdicts, user
 * Q&A, MCP outputs, repo-intelligence capsules, control-plane payloads — all
 * silently replaced with `[Cleared: ...]` placeholders the model could not
 * reconstruct.
 *
 * **Design**: flip from blacklist to whitelist semantics implicitly by listing
 * everything *worth keeping*. The tools still missing here are the
 * "exploration / execution" set (read, edit, write, multi_edit,
 * insert_after_anchor, bash, glob, grep, code_search,
 * web_search, web_fetch) — high-frequency, large-result, low-density-of-decision
 * tools where pruning to a preview is the right call.
 *
 * **Cross-package coupling**: these names mirror @kodax-ai/coding's
 * registry-declared tool names. session-lineage cannot import from coding
 * (would create a circular tsc -b dependency), so the names are duplicated
 * here. The `protected-tools-registry-parity.test.ts` asserts both sides
 * stay in sync — any name drift breaks the test.
 *
 * **Categories**:
 *   - skill content (1)        — already protected pre-F183
 *   - user-interaction (2)     — ask_user_question, exit_plan_mode
 *   - actor control (7)        — spawn/send/followup/wait/interrupt/list/output
 *   - progressive disclosure (1) — tool_search — its result carries the full
 *                                description a model fetched for a deferred
 *                                tool; on the managed path that description is
 *                                hint-only in tools[] and never resident, so
 *                                the result is the only place the full teaching
 *                                lives (FEATURE_250)
 *   - goal state (3)          — get_goal, create_goal, update_goal — status
 *                                snapshots and lifecycle transition receipts
 *                                for the persistent /goal state
 *   - todo state (4)           — todo_create, todo_update, todo_list,
 *                                todo_get — the model's self-maintained
 *                                plan; results serialise the entire
 *                                `items[]` list (or full single item for
 *                                todo_get) and clearing them erases task
 *                                memory mid-run
 *   - worktree / undo (3)      — worktree_create, worktree_remove, undo
 *   - MCP (5)                  — mcp_search/describe/call/read_resource/get_prompt
 *   - repo intelligence (11)   — repo_overview, changed_scope, changed_diff,
 *                                changed_diff_bundle, module_context,
 *                                symbol_context, process_context, impact_estimate,
 *                                relationship_scan, cyclic_dependencies,
 *                                semantic_lookup
 */
const PRUNE_PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  // Pre-F183
  'skill',
  // User-interaction + plan
  'ask_user_question',
  'exit_plan_mode',
  // Actor control flow
  'spawn_agent',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'agent_output',
  // FEATURE_250 — progressive disclosure. A `tool_search` result is the
  // `<function>…</function>` block carrying the full schema/description a model
  // fetched for a deferred tool. On the managed path deferred tools are
  // hint-only in tools[] and the full description never becomes resident (the
  // tool list is static), so the tool_search RESULT is the only surface the
  // full teaching lives on. Protect it from microcompaction's unconditional
  // 20-turn prune sweep so a model that paid a turn to fetch a deferred tool's
  // schema doesn't silently lose it. Cheap: tool_search results are small and
  // low-frequency.
  'tool_search',
  // Goal state — the canonical state persists as session-lineage goal entries,
  // but these tool results are the model-visible status snapshots and lifecycle
  // transition receipts. They are short, low-frequency, and control-plane-like.
  'get_goal',
  'create_goal',
  'update_goal',
  // Todo state — the model's self-maintained plan list. todo_create /
  // todo_update / todo_list / todo_get results contain the full serialised
  // item set (or per-item full detail for todo_get):
  // (`{ok, items: [{id, subject, description?, status, activeForm?, note?, ...}, ...]}`).
  // Clearing erases task memory mid-run — exactly the failure mode F183
  // is here to prevent (claudecode parity: `TodoWriteTool` / `TaskGetTool`
  // both protected).
  'todo_create',
  'todo_update',
  'todo_list',
  // v0.7.42 — `todo_get` is read-only single-item lookup. Protected so
  // microcompaction doesn't strip a recent staleness-refresh result the
  // model is about to mutate via todo_update on the next turn.
  'todo_get',
  // Worktree / undo (low-frequency but high-value control events)
  'worktree_create',
  'worktree_remove',
  'undo',
  // MCP — user-configured external tools, results high-reuse
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'mcp_read_resource',
  'mcp_get_prompt',
  // Repo intelligence — already-condensed high-density capsules
  'repo_overview',
  'changed_scope',
  'changed_diff',
  'changed_diff_bundle',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
  'relationship_scan',
  'cyclic_dependencies',
  'semantic_lookup',
]);

/**
 * Exported as the canonical PROTECTED set so peer modules
 * (microcompaction.ts default config, registry-parity test, future
 * Stage 3 ledger work) can pull a single source-of-truth.
 */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = PRUNE_PROTECTED_TOOLS;

/**
 * Marker prefix on the synthesized summary system message. Other packages
 * use this literal as the discriminator to tell CompactionSummary system
 * messages apart from role-prompt system messages \u2014 exported so callers
 * (notably `@kodax-ai/coding`'s `preserveTranscriptForRoundExit`) cannot
 * drift from the producer side.
 */
export const COMPACTION_SUMMARY_PREFIX = '[\u5bf9\u8bdd\u5386\u53f2\u6458\u8981]\n\n';
export const COMPACTED_HISTORY_RECOVERY_GUIDANCE = `

## Exact history recovery
This checkpoint is a semantic summary, not an exact transcript. If a later
request depends on an omitted historical detail, do not guess. When available,
use session_history_search to find cited entries, then session_history_read to
read only the required exact evidence.`;

/** User messages below this token threshold are never truncated */
const USER_MESSAGE_PROTECTION_TOKENS = 800;
/** Tokens to keep from the head of a long user message */
const USER_MESSAGE_HEAD_TOKENS = 400;
/** Tokens to keep from the tail of a long user message */
const USER_MESSAGE_TAIL_TOKENS = 200;

export interface ToolContextInfo {
  name: string;
  preview: string;
}

interface ToolContextSeed {
  id: string;
  name: string;
  action: string;
  target?: string;
  query?: string;
  previewOverride?: string;
}

/**
 * FEATURE_181 (v0.7.42): detect LLM "I have no content to summarize" output.
 *
 * Empty-like markers observed across 788 sessions (7.8% of compactions):
 *   - "No active goal" / "no active goal"
 *   - "conversation is empty" / "The conversation is empty"
 *   - "no prior context"
 *   - "nothing to summarize" / "no content to summarize"
 *
 * Also catches very short outputs (< 80 chars) — a meaningful goal summary
 * is empirically ≥150 chars even for simple tasks. Conservative threshold:
 * false positives only cause us to KEEP the previous summary, never lose
 * information.
 *
 * Exported for unit testing.
 */
export function isEmptyLikeSummary(summary: string): boolean {
  if (!summary) return true;
  const trimmed = summary.trim();
  if (trimmed.length < 80) return true;
  const lower = trimmed.toLowerCase();
  const emptyMarkers = [
    'no active goal',
    'conversation is empty',
    'no prior context',
    'nothing to summarize',
    'no content to summarize',
    'no content provided',
  ];
  return emptyMarkers.some((m) => lower.includes(m));
}

export function needsCompaction(
  messages: KodaXMessage[],
  config: CompactionConfig,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  tokenCountOverride?: number,
  reservedResponseTokens = 0,
): boolean {
  const tokens = tokenCountOverride ?? estimateTokens(messages);
  const maxPhysicalInputTokens = calculateMaxContextInputTokens(
    contextWindow,
    reservedResponseTokens,
  );
  const policy = resolveCompactionPolicy(
    config,
    contextWindow,
    maxPhysicalInputTokens,
  );
  return tokens >= policy.triggerTokens;
}

export async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  customInstructions?: string,
  systemPrompt?: string,
  tokenCountOverride?: number,
  summaryPrompt?: string,
  updateSummaryPrompt?: string,
  modelOverride?: string,
  force: boolean = false,
  reservedResponseTokens = 0,
  cacheContext?: CompactionCacheContext,
  observer?: CompactionProviderObserver,
  routing?: CompactionProviderRouting,
): Promise<CompactionResult> {
  const tokensBefore = tokenCountOverride ?? estimateTokens(messages);
  const estimatedTranscriptTokensBefore = estimateTokens(messages);
  const fixedOverheadTokens = Math.max(
    0,
    tokensBefore - estimatedTranscriptTokensBefore,
  );
  const maxPhysicalInputTokens = calculateMaxContextInputTokens(
    contextWindow,
    reservedResponseTokens,
  );
  const policy = resolveCompactionPolicy(
    config,
    contextWindow,
    maxPhysicalInputTokens,
  );
  const physicalTokensFor = (candidate: KodaXMessage[]): number => (
    fixedOverheadTokens + estimateTokens(candidate)
  );

  if (!force && !needsCompaction(
    messages,
    config,
    contextWindow,
    tokenCountOverride,
    reservedResponseTokens,
  )) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  let previousSummary: string | undefined;
  let previousQueryLedger = parseUserQueryLedger('');
  let remainingMessages = messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      (msg?.role === 'system' || msg?.role === 'user')
      && typeof msg.content === 'string'
      && msg.content.startsWith(COMPACTION_SUMMARY_PREFIX)
      && (msg.role === 'system' || msg._source === 'compaction-checkpoint')
    ) {
      const checkpointBody = msg.content.slice(COMPACTION_SUMMARY_PREFIX.length);
      previousSummary = checkpointBody.endsWith(COMPACTED_HISTORY_RECOVERY_GUIDANCE)
        ? checkpointBody.slice(0, -COMPACTED_HISTORY_RECOVERY_GUIDANCE.length)
        : checkpointBody;
      previousQueryLedger = parseUserQueryLedger(previousSummary);
      remainingMessages = [...messages.slice(0, i), ...messages.slice(i + 1)];
      break;
    }
  }

  const protectionTokens = policy.protectionTokens;
  const protectCutIndex = findCutPoint(remainingMessages, protectionTokens);
  const toProcess = remainingMessages.slice(0, protectCutIndex);
  const toProtect = remainingMessages.slice(protectCutIndex);

  if (toProcess.length === 0) {
    if (exceedsContextCapacity({
      contextWindow,
      currentTokens: tokensBefore,
      reservedResponseTokens: reclaimReservedResponseTokens({
        contextWindow, currentTokens: tokensBefore, reservedResponseTokens,
      }),
    })) {
      throw new ContextCapacityError({
        contextWindow,
        currentTokens: tokensBefore,
        reservedResponseTokens,
      }, 'History compaction');
    }
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  const totalFileOps = extractFileOps(toProcess);
  const artifactLedger = extractArtifactLedger(toProcess);

  // FEATURE_272: a major compact covers the complete eligible prefix in one
  // transaction. Temporary map/reduce results never become canonical history.
  // A query has exactly one canonical representation after compaction:
  // compacted-prefix queries live in the exact ledger, while protected-tail
  // queries remain as raw messages. Recording the tail here as well duplicates
  // it and directly consumes the savings the compaction just created.
  const queryLedger = mergeUserQueryLedger(previousQueryLedger, toProcess);
  const cacheInstructionTokens = countTokens(buildCompactionCacheInstruction(
    buildCompactionPromptSnapshot({
      messages: [],
      details: totalFileOps,
      customInstructions,
      systemPrompt,
      previousSummary,
      summaryPrompt,
      updateSummaryPrompt,
    }),
    toProtect.length,
  ));
  const effectiveCacheContext = cacheContext
    && tokensBefore + cacheInstructionTokens <= maxPhysicalInputTokens
    ? { ...cacheContext, protectedTailMessageCount: toProtect.length }
    : undefined;
  const summaryRequests: CompactionRequestMetrics[] = [];
  const externalObserver = cacheContext?.observer ?? observer;
  const requestObserver: CompactionProviderObserver = {
    ...externalObserver,
    onMetrics: (metrics) => {
      summaryRequests.push(metrics);
      externalObserver?.onMetrics?.(metrics);
    },
  };
  const generated = await summarizeCompletePrefix({
    messages: toProcess,
    cacheMessages: effectiveCacheContext ? messages : undefined,
    cacheContext: effectiveCacheContext ? { ...effectiveCacheContext, observer: requestObserver } : undefined,
    observer: requestObserver,
    routing: { ...routing, reasoning: config.reasoning },
    provider,
    customInstructions,
    systemPrompt,
    previousSummary,
    summaryPrompt,
    updateSummaryPrompt,
    modelOverride,
    contextWindow,
    reservedResponseTokens,
  });
  const finalSummary = [
    stripRenderedUserQueryLedger(generated.summary),
    renderUserQueryLedger(queryLedger),
  ].filter(Boolean).join('\n\n');
  const entriesRemoved = toProcess.length;
  const compactedMessages = buildCompactedMessages(finalSummary, [], toProtect);
  const tokensAfter = physicalTokensFor(compactedMessages);
  // Return the usable candidate even under remaining pressure. The host owns
  // response-reserve recovery, artifact relief and the durable commit.
  const memorySeed = extractCompactMemorySeed(finalSummary, totalFileOps);

  return {
    compacted: true,
    messages: compactedMessages,
    summary: finalSummary,
    tokensBefore,
    tokensAfter,
    entriesRemoved,
    details: totalFileOps,
    artifactLedger,
    memorySeed,
    report: {
      summaryRequests,
      strategy: generated.strategy,
      triggerSource: policy.triggerSource,
      effectiveTriggerTokens: policy.triggerTokens,
      protectedBudgetTokens: protectionTokens,
      fixedInputTokens: fixedOverheadTokens,
      eligibleTokens: estimateTokens(toProcess),
      rawTailTokens: estimateTokens(toProtect),
      summaryTokens: countTokens(stripRenderedUserQueryLedger(finalSummary)),
      queryLedgerTokens: countTokens(renderUserQueryLedger(queryLedger)),
    },
    anchor: createCompactionAnchor(
      finalSummary,
      tokensBefore,
      tokensAfter,
      entriesRemoved,
      totalFileOps,
      artifactLedger,
      memorySeed,
    ),
  };
}

interface CompletePrefixSummaryInput {
  readonly messages: KodaXMessage[];
  readonly cacheMessages?: KodaXMessage[];
  readonly cacheContext?: CompactionCacheContext;
  readonly observer?: CompactionCacheContext['observer'];
  readonly routing?: CompactionProviderRouting;
  readonly provider: KodaXBaseProvider;
  readonly customInstructions?: string;
  readonly systemPrompt?: string;
  readonly previousSummary?: string;
  readonly summaryPrompt?: string;
  readonly updateSummaryPrompt?: string;
  readonly modelOverride?: string;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
}

interface CompletePrefixSummaryResult {
  readonly summary: string;
  readonly strategy: 'full_prefix' | 'map_reduce';
}

function stripRenderedUserQueryLedger(summary: string): string {
  const marker = '## User Queries & Corrections';
  const index = summary.indexOf(marker);
  return (index >= 0 ? summary.slice(0, index) : summary).trim();
}

function assertUsableSummary(summary: string, previousSummary?: string): void {
  const semanticSummary = stripRenderedUserQueryLedger(summary);
  if (isEmptyLikeSummary(semanticSummary)) {
    throw new Error('Compaction summary did not contain usable semantic content');
  }
  if (
    previousSummary
    && semanticSummary === stripRenderedUserQueryLedger(previousSummary)
  ) {
    throw new Error('Compaction summary did not incorporate the eligible prefix');
  }
}

async function summarizeCompletePrefix(
  input: CompletePrefixSummaryInput,
): Promise<CompletePrefixSummaryResult> {
  if (input.cacheContext && input.cacheMessages) {
    const summary = await generateSummary(
      input.cacheMessages,
      input.provider,
      extractFileOps(input.messages),
      input.customInstructions,
      input.systemPrompt,
      input.previousSummary,
      input.summaryPrompt,
      input.updateSummaryPrompt,
      input.modelOverride,
      input.cacheContext,
      input.observer,
      input.routing,
    );
    assertUsableSummary(summary, input.previousSummary);
    return { summary, strategy: 'full_prefix' };
  }

  const promptTokens = countSummaryRequestTokens(input.messages, {
    customInstructions: input.customInstructions,
    systemPrompt: input.systemPrompt,
    previousSummary: input.previousSummary,
    summaryPrompt: input.summaryPrompt,
    updateSummaryPrompt: input.updateSummaryPrompt,
  });
  if (!exceedsContextCapacity({
    contextWindow: input.contextWindow,
    currentTokens: promptTokens,
    reservedResponseTokens: input.reservedResponseTokens,
  })) {
    const summary = await generateSummary(
      input.messages,
      input.provider,
      extractFileOps(input.messages),
      input.customInstructions,
      input.systemPrompt,
      input.previousSummary,
      input.summaryPrompt,
      input.updateSummaryPrompt,
      input.modelOverride,
      undefined,
      input.observer,
      input.routing,
    );
    assertUsableSummary(summary, input.previousSummary);
    return { summary, strategy: 'full_prefix' };
  }

  const mappedSummaries: string[] = [];
  let remaining = input.messages;
  while (remaining.length > 0) {
    let chunkEnd: number;
    let chunk: KodaXMessage[];
    try {
      chunkEnd = findSummaryChunkEnd(
        remaining,
        input.customInstructions,
        input.systemPrompt,
        '',
        input.summaryPrompt,
        input.updateSummaryPrompt,
        input.contextWindow,
        input.reservedResponseTokens,
      );
      chunk = remaining.slice(0, chunkEnd);
    } catch (error) {
      if (!(error instanceof ContextCapacityError)) throw error;
      const firstBlock = getAtomicBlocks(remaining)[0];
      if (!firstBlock) throw error;
      chunkEnd = firstBlock.end + 1;
      chunk = createCapacitySafeSummaryBlock(remaining.slice(0, chunkEnd));
      const compactedPromptTokens = countSummaryRequestTokens(chunk, {
        customInstructions: input.customInstructions,
        systemPrompt: input.systemPrompt,
        summaryPrompt: input.summaryPrompt,
        updateSummaryPrompt: input.updateSummaryPrompt,
      });
      if (exceedsContextCapacity({
        contextWindow: input.contextWindow,
        currentTokens: compactedPromptTokens,
        reservedResponseTokens: input.reservedResponseTokens,
      })) {
        throw error;
      }
    }
    const summary = await generateSummary(
      chunk,
      input.provider,
      extractFileOps(chunk),
      input.customInstructions,
      input.systemPrompt,
      undefined,
      input.summaryPrompt,
      input.updateSummaryPrompt,
      input.modelOverride,
      undefined,
      input.observer,
      input.routing,
    );
    assertUsableSummary(summary);
    mappedSummaries.push(summary);
    remaining = remaining.slice(chunkEnd);
  }

  const reductionMessages: KodaXMessage[] = mappedSummaries.map((summary, index) => ({
    role: 'user',
    content: `<compaction-part index="${index + 1}">\n${summary}\n</compaction-part>`,
    _synthetic: true,
    _source: 'compaction-map-result',
  }));
  const reduced = await generateSummary(
    reductionMessages,
    input.provider,
    extractFileOps(input.messages),
    input.customInstructions,
    input.systemPrompt,
    input.previousSummary,
    input.summaryPrompt,
    input.updateSummaryPrompt,
    input.modelOverride,
    undefined,
    input.observer,
    input.routing,
  );
  assertUsableSummary(reduced, input.previousSummary);
  return { summary: reduced, strategy: 'map_reduce' };
}

function createCapacitySafeSummaryBlock(messages: KodaXMessage[]): KodaXMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'tool_result') return block;
        const placeholder = `[Compacted oversized tool result for summary: ${countTokens(
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        )} tokens]`;
        return {
          ...block,
          content: preserveToolResultRecovery(block.content, placeholder, block.metadata),
        };
      }),
    };
  });
}

function findSummaryChunkEnd(
  messages: KodaXMessage[],
  customInstructions: string | undefined,
  systemPrompt: string | undefined,
  previousSummary: string,
  summaryPrompt: string | undefined,
  updateSummaryPrompt: string | undefined,
  contextWindow: number,
  reservedResponseTokens: number,
): number {
  let bestEnd = 0;
  const atomicBlocks = getAtomicBlocks(messages);

  for (const block of atomicBlocks) {
    const end = block.end + 1;
    const candidate = messages.slice(0, end);
    const promptTokens = countSummaryRequestTokens(candidate, {
      customInstructions, systemPrompt, previousSummary,
      summaryPrompt, updateSummaryPrompt,
    });
    if (exceedsContextCapacity({
      contextWindow,
      currentTokens: promptTokens,
      reservedResponseTokens,
    })) {
      break;
    }
    bestEnd = end;
  }

  if (bestEnd === 0) {
    const firstBlock = atomicBlocks[0];
    const firstEnd = firstBlock ? firstBlock.end + 1 : 0;
    const firstMessages = messages.slice(0, firstEnd);
    const promptTokens = countSummaryRequestTokens(firstMessages, {
      customInstructions, systemPrompt, previousSummary,
      summaryPrompt, updateSummaryPrompt,
    });
    throw new ContextCapacityError({
      contextWindow,
      currentTokens: promptTokens,
      reservedResponseTokens,
    }, 'Compaction summary request');
  }

  return bestEnd;
}

interface SummaryPromptOptions {
  readonly customInstructions?: string;
  readonly systemPrompt?: string;
  readonly previousSummary?: string;
  readonly summaryPrompt?: string;
  readonly updateSummaryPrompt?: string;
}

function countSummaryRequestTokens(
  messages: KodaXMessage[],
  options: SummaryPromptOptions,
): number {
  const snapshot = buildCompactionPromptSnapshot({
    messages,
    details: extractFileOps(messages),
    customInstructions: options.customInstructions,
    systemPrompt: options.systemPrompt,
    previousSummary: options.previousSummary || undefined,
    summaryPrompt: options.summaryPrompt,
    updateSummaryPrompt: options.updateSummaryPrompt,
  });
  return countTokens(snapshot.systemPrompt) + countTokens(snapshot.userPrompt);
}

function buildCompactedMessages(
  summary: string,
  messages: KodaXMessage[],
  protectedMessages: KodaXMessage[],
): KodaXMessage[] {
  return summary
    ? [createSummaryMessage(summary), ...messages, ...protectedMessages]
    : [...messages, ...protectedMessages];
}

function createSummaryMessage(summary: string): KodaXMessage {
  return {
    role: 'user',
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
    _synthetic: true,
    _source: 'compaction-checkpoint',
  };
}

function createCompactionAnchor(
  summary: string,
  tokensBefore: number,
  tokensAfter: number,
  entriesRemoved: number,
  details: CompactionResult['details'],
  artifactLedger: NonNullable<CompactionResult['artifactLedger']>,
  memorySeed: NonNullable<CompactionResult['memorySeed']>,
): CompactionAnchor {
  return {
    summary,
    tokensBefore,
    tokensAfter,
    entriesRemoved,
    reason: 'automatic_compaction',
    artifactLedgerId: artifactLedger.length > 0
      ? `ledger_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      : undefined,
    details,
    memorySeed,
  };
}

function splitPathSegments(target: string): string[] {
  return target.split(/[\\/]+/).filter(Boolean);
}

function isPathLikeTarget(target: string | undefined): boolean {
  if (!target) {
    return false;
  }
  return /[\\/]/.test(target) || /\.[a-z0-9]+$/i.test(target);
}

function shortestUniqueSuffix(target: string, allTargets: string[]): string {
  const parts = splitPathSegments(target);
  if (parts.length === 0) {
    return target;
  }

  for (let length = 1; length <= parts.length; length++) {
    const suffix = parts.slice(-length).join('/');
    const matches = allTargets.filter((candidate) => candidate.endsWith(suffix));
    if (matches.length === 1) {
      return suffix;
    }
  }

  return parts.join('/');
}

export function buildToolContextMap(messages: KodaXMessage[]): Map<string, ToolContextInfo> {
  const toolContextMap = new Map<string, ToolContextInfo>();
  const seeds: ToolContextSeed[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;

      const name = String(block.name || 'tool');
      const input = (block.input as Record<string, unknown>) || {};
      const command = input.command ?? input.CommandLine ?? input.command_line;

      if (typeof command === 'string' && command.trim()) {
        const intent = extractBashIntent(command);
        const parts = intent.split(/\s+/);
        seeds.push({
          id: block.id,
          name,
          action: parts[0] ?? name,
          target: parts.slice(1).find((token) => token && !token.startsWith('-')) ?? parts[0] ?? name,
          previewOverride: intent,
        });
        continue;
      }

      const target = (() => {
        const pathLikeKeys = [
          'path',
          'file',
          'outputPath',
          'cwd',
          'target_path',
          'scenePath',
          'scriptPath',
          'resourcePath',
          'module',
          'entry',
          'url',
        ] as const;
        for (const key of pathLikeKeys) {
          const value = input[key];
          if (typeof value === 'string' && value.trim()) {
            return value.trim();
          }
        }
        return undefined;
      })();
      const query = typeof input.pattern === 'string'
        ? input.pattern
        : typeof input.query === 'string'
          ? input.query
          : undefined;
      const action = name === 'write' ? 'write'
        : name === 'edit' ? 'edit'
          : name === 'read' ? 'read'
            : name === 'grep' ? 'grep'
              : name;

      seeds.push({
        id: block.id,
        name,
        action,
        target,
        query,
      });
    }
  }

  const pathTargets = seeds
    .map((seed) => seed.target)
    .filter((target): target is string => isPathLikeTarget(target));

  for (const seed of seeds) {
    let preview: string;

    if (seed.previewOverride) {
      preview = seed.previewOverride;
    } else {
      const displayTarget = seed.target
        ? (isPathLikeTarget(seed.target)
          ? shortestUniqueSuffix(seed.target, pathTargets)
          : seed.target)
        : undefined;

      preview = seed.query && displayTarget
        ? `${seed.action} ${displayTarget} "${seed.query}"`
        : displayTarget
          ? `${seed.action} ${displayTarget}`
          : seed.query
            ? `${seed.action} "${seed.query}"`
            : seed.name;
    }

    toolContextMap.set(seed.id, {
      name: seed.name,
      preview,
    });
  }

  return toolContextMap;
}

/**
 * Truncate a long user text string, preserving head and tail.
 * Short texts (≤ USER_MESSAGE_PROTECTION_TOKENS) are returned as-is.
 */
export function truncateUserText(text: string): string {
  const tokens = countTokens(text);
  if (tokens <= USER_MESSAGE_PROTECTION_TOKENS) return text;

  const headChars = Math.floor(text.length * (USER_MESSAGE_HEAD_TOKENS / tokens));
  const tailChars = Math.floor(text.length * (USER_MESSAGE_TAIL_TOKENS / tokens));
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);

  return `${head}\n[…user message truncated, original ~${tokens} tokens…]\n${tail}`;
}

/**
 * Group an assistant `tool_use` turn with its immediately-following user
 * `tool_result` turn so the LLM-summarization cut never splits a tool pair.
 *
 * Adjacency assumption: KodaX's agent loop always pushes ALL tool_results for
 * one assistant turn into a SINGLE user message placed immediately after it
 * (see `pushToolResultsAndSettle`), so the `messages[i+1]` check covers every
 * pair the loop produces. Non-adjacent / multi-message tool_results are not a
 * shape KodaX emits; if one ever arose (hand-built history, external caller),
 * the cut could split it — but `commitCompactedHistory` runs
 * `validateAndFixToolHistory` on the compaction output every turn before the
 * provider call, which strips any orphan that resulted. This function is an
 * optimization (avoid splitting), not the correctness guarantee; the backstop
 * is the validator (covered by CAP-002 contract tests).
 */
function getAtomicBlocks(messages: KodaXMessage[]): Array<{ start: number; end: number; tokens: number }> {
  const atomicBlocks: Array<{ start: number; end: number; tokens: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const hasToolUse = msg.role === 'assistant'
      && Array.isArray(msg.content)
      && msg.content.some((b: KodaXContentBlock) => b.type === 'tool_use');

    if (hasToolUse) {
      const nextMsg = messages[i + 1];
      const hasNextToolResult = nextMsg?.role === 'user'
        && Array.isArray(nextMsg.content)
        && nextMsg.content.some((b: KodaXContentBlock) => b.type === 'tool_result');

      if (hasNextToolResult) {
        atomicBlocks.push({
          start: i,
          end: i + 1,
          tokens: estimateTokens([msg, nextMsg]),
        });
        i++;
        continue;
      }
    }

    atomicBlocks.push({
      start: i,
      end: i,
      tokens: estimateTokens([msg]),
    });
  }

  return atomicBlocks;
}

function findCutPoint(messages: KodaXMessage[], keepRecentTokens: number): number {
  let tokenCount = 0;
  let protectedBlocks = 0;
  const atomicBlocks = getAtomicBlocks(messages);

  for (let i = atomicBlocks.length - 1; i >= 0; i--) {
    const block = atomicBlocks[i];
    if (!block) continue;

    if (tokenCount + block.tokens > keepRecentTokens) {
      // Always retain at least the newest atomic block, even when that one
      // block exceeds the budget. Once a newer block is already protected,
      // do not pull the older block across the boundary merely because it is
      // the first one that would overflow the tail budget.
      return protectedBlocks === 0 ? block.start : block.end + 1;
    }
    tokenCount += block.tokens;
    protectedBlocks++;
  }

  return 0;
}
