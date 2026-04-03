/**
 * @kodax/agent Compaction Core
 *
 * Progressive compaction with lightweight tool-result pruning and rolling
 * summarization to an internal low-water mark.
 */

import { randomUUID } from 'node:crypto';
import type { KodaXBaseProvider, KodaXContentBlock, KodaXMessage } from '@kodax/ai';
import type { CompactionAnchor, CompactionConfig, CompactionResult } from './types.js';
import { countTokens, estimateTokens } from '../tokenizer.js';
import { extractArtifactLedger, extractFileOps } from './file-tracker.js';
import { extractCompactMemorySeed, generateSummary } from './summary-generator.js';

const DEFAULT_CONTEXT_WINDOW = 200000;
const STRUCTURED_PRUNE_MINIMUM_TOKENS = 20000;
const STRUCTURED_PRUNE_PROTECT_TOKENS = 40000;
const PRUNE_PROTECTED_TOOLS = new Set(['skill']);
const MAX_SUMMARIZATION_TOKENS_PER_CHUNK = 50000;
const SUMMARIZATION_RETRY_DELAY_MS = 2000;
const COMPACTION_SUMMARY_PREFIX = '[\u5bf9\u8bdd\u5386\u53f2\u6458\u8981]\n\n';

interface ToolContextInfo {
  name: string;
  preview: string;
}

interface ToolContextSeed {
  id: string;
  name: string;
  action: string;
  target?: string;
  query?: string;
}

interface PruneDecision {
  idsToPrune: Set<string>;
  prunableTokens: number;
}

interface PruneResult {
  messages: KodaXMessage[];
  hasPruned: boolean;
}

interface SummaryAttemptResult {
  summary: string;
  summarizedMessages: number;
  failed: boolean;
}

export function needsCompaction(
  messages: KodaXMessage[],
  config: CompactionConfig,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  tokenCountOverride?: number,
): boolean {
  if (!config.enabled) return false;

  const tokens = tokenCountOverride ?? estimateTokens(messages);
  const threshold = getTriggerTokens(config, contextWindow);
  return tokens > threshold;
}

export async function compact(
  messages: KodaXMessage[],
  config: CompactionConfig,
  provider: KodaXBaseProvider,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  customInstructions?: string,
  systemPrompt?: string,
  tokenCountOverride?: number,
): Promise<CompactionResult> {
  const tokensBefore = tokenCountOverride ?? estimateTokens(messages);

  if (!needsCompaction(messages, config, contextWindow, tokenCountOverride)) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
    };
  }

  let previousSummary: string | undefined;
  let remainingMessages = messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === 'system'
      && typeof msg.content === 'string'
      && msg.content.startsWith(COMPACTION_SUMMARY_PREFIX)
    ) {
      previousSummary = msg.content.slice(COMPACTION_SUMMARY_PREFIX.length);
      remainingMessages = [...messages.slice(0, i), ...messages.slice(i + 1)];
      break;
    }
  }

  const protectionPercent = config.protectionPercent ?? 20;
  const protectionTokens = Math.floor(contextWindow * (protectionPercent / 100));
  const protectCutIndex = findCutPoint(remainingMessages, protectionTokens);
  const toProcess = remainingMessages.slice(0, protectCutIndex);
  const toProtect = remainingMessages.slice(protectCutIndex);

  if (toProcess.length === 0) {
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

  const pruningThresholdTokens = config.pruningThresholdTokens ?? 500;
  const toolContextMap = buildToolContextMap(toProcess);
  const structuredPrune = collectStructuredPruneIds(toProcess, toolContextMap);
  const pruneResult = pruneToolResults(
    toProcess,
    toolContextMap,
    structuredPrune,
    pruningThresholdTokens,
  );

  const prunedMessages = pruneResult.messages;
  const prunedQueue = [...prunedMessages, ...toProtect];
  const triggerTokens = getTriggerTokens(config, contextWindow);

  if (pruneResult.hasPruned && estimateTokens(prunedQueue) <= triggerTokens) {
    const retainedSummary = previousSummary || buildFallbackCompactionSummary(totalFileOps, artifactLedger);
    const finalMessages = [createSummaryMessage(retainedSummary), ...prunedQueue];
    const tokensAfter = estimateTokens(finalMessages);
    const memorySeed = extractCompactMemorySeed(retainedSummary, totalFileOps);

    return {
      compacted: true,
      messages: finalMessages,
      summary: retainedSummary,
      tokensBefore,
      tokensAfter,
      entriesRemoved: 0,
      details: totalFileOps,
      artifactLedger,
      memorySeed,
      anchor: createCompactionAnchor(
        retainedSummary,
        tokensBefore,
        tokensAfter,
        0,
        totalFileOps,
        artifactLedger,
        memorySeed,
      ),
    };
  }

  const rollingSummaryPercent = config.rollingSummaryPercent ?? 10;
  const rollingSummaryTokens = Math.max(
    1,
    Math.floor(contextWindow * (rollingSummaryPercent / 100)),
  );
  const targetTokens = getTargetTokens(config, contextWindow);

  let summary = previousSummary || '';
  let workingProcess = prunedMessages;
  let entriesRemoved = 0;

  while (workingProcess.length > 0) {
    const currentMessages = buildCompactedMessages(summary, workingProcess, toProtect);
    if (estimateTokens(currentMessages) <= targetTokens) {
      break;
    }

    const summarizeCutIndex = Math.max(
      1,
      findForwardCutPoint(workingProcess, rollingSummaryTokens),
    );
    const toSummarize = workingProcess.slice(0, summarizeCutIndex);
    if (toSummarize.length === 0) {
      break;
    }

    const summaryAttempt = await summarizeMessages(
      toSummarize,
      provider,
      customInstructions,
      systemPrompt,
      summary,
    );

    if (summaryAttempt.summarizedMessages === 0) {
      break;
    }

    summary = summaryAttempt.summary;
    workingProcess = workingProcess.slice(summaryAttempt.summarizedMessages);
    entriesRemoved += summaryAttempt.summarizedMessages;

    if (summaryAttempt.failed) {
      break;
    }
  }

  const summaryChanged = summary !== (previousSummary || '');
  const didCompact = pruneResult.hasPruned || entriesRemoved > 0 || summaryChanged;
  if (!didCompact) {
    return {
      compacted: false,
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      entriesRemoved: 0,
      details: totalFileOps,
    };
  }

  const finalSummary = summary || buildFallbackCompactionSummary(totalFileOps, artifactLedger);
  const compactedMessages = buildCompactedMessages(finalSummary, workingProcess, toProtect);
  const tokensAfter = estimateTokens(compactedMessages);
  const memorySeed = extractCompactMemorySeed(finalSummary, totalFileOps);

  return {
    compacted: true,
    messages: compactedMessages,
    summary: finalSummary || undefined,
    tokensBefore,
    tokensAfter,
    entriesRemoved,
    details: totalFileOps,
    artifactLedger,
    memorySeed,
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

async function summarizeMessages(
  messages: KodaXMessage[],
  provider: KodaXBaseProvider,
  customInstructions: string | undefined,
  systemPrompt: string | undefined,
  previousSummary: string,
): Promise<SummaryAttemptResult> {
  let summary = previousSummary;
  let summarizedMessages = 0;
  const chunks = chunkMessages(messages, MAX_SUMMARIZATION_TOKENS_PER_CHUNK);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || chunk.length === 0) continue;

    try {
      summary = await generateSummary(
        chunk,
        provider,
        extractFileOps(chunk),
        customInstructions,
        systemPrompt,
        summary || undefined,
      );
      summarizedMessages += chunk.length;
    } catch (error) {
      if (process.env.KODAX_DEBUG_COMPACTION) {
        console.warn('[Compaction] Summary chunk failed, keeping partial summary progress.', error);
      }
      return { summary, summarizedMessages, failed: true };
    }

    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, SUMMARIZATION_RETRY_DELAY_MS));
    }
  }

  return { summary, summarizedMessages, failed: false };
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
    role: 'system',
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}`,
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

function buildFallbackCompactionSummary(
  details: NonNullable<CompactionResult['details']>,
  artifactLedger: NonNullable<CompactionResult['artifactLedger']>,
): string {
  const importantTargets = Array.from(new Set([
    ...details.readFiles,
    ...details.modifiedFiles,
    ...artifactLedger.map((entry) => entry.displayTarget ?? entry.target),
  ])).slice(0, 8);

  const keyContextLines = importantTargets.length > 0
    ? importantTargets.map((target) => `- ${target}`)
    : ['- No high-value targets recorded'];
  const readFiles = details.readFiles.length > 0 ? details.readFiles : [''];
  const modifiedFiles = details.modifiedFiles.length > 0 ? details.modifiedFiles : [''];

  return [
    '## Goal',
    'Continue the current task from the latest preserved context.',
    '',
    '## Constraints & Preferences',
    '- Preserve existing user intent and repo-local constraints.',
    '',
    '## Progress',
    '### Completed',
    '- [x] Older context was compacted into a durable anchor.',
    '',
    '### In Progress',
    '- [ ] Continue from the latest preserved tail.',
    '',
    '### Blockers',
    '- None',
    '',
    '## Key Decisions',
    '- **Compaction**: Keep only continuation-critical history.',
    '',
    '## Next Steps',
    '1. Re-open the most relevant targets before continuing if needed.',
    '',
    '## Key Context',
    ...keyContextLines,
    '',
    '---',
    '',
    '<read-files>',
    ...readFiles,
    '</read-files>',
    '',
    '<modified-files>',
    ...modifiedFiles,
    '</modified-files>',
  ].join('\n');
}

function getTriggerTokens(config: CompactionConfig, contextWindow: number): number {
  return contextWindow * (config.triggerPercent / 100);
}

function getTargetTokens(config: CompactionConfig, contextWindow: number): number {
  const protectionPercent = config.protectionPercent ?? 20;
  const triggerPercent = config.triggerPercent;

  if (triggerPercent <= protectionPercent) {
    return getTriggerTokens(config, contextWindow);
  }

  const targetPercent = protectionPercent + 0.4 * (triggerPercent - protectionPercent);
  return Math.floor(contextWindow * (targetPercent / 100));
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

function buildToolContextMap(messages: KodaXMessage[]): Map<string, ToolContextInfo> {
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
        const normalizedCommand = command.trim().replace(/\s+/g, ' ');
        const parts = normalizedCommand.split(/\s+/);
        seeds.push({
          id: block.id,
          name,
          action: parts[0] ?? name,
          target: parts.slice(1).find((token) => token && !token.startsWith('-')) ?? parts[0] ?? name,
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
    const displayTarget = seed.target
      ? (isPathLikeTarget(seed.target)
        ? shortestUniqueSuffix(seed.target, pathTargets)
        : seed.target)
      : undefined;

    const preview = seed.query && displayTarget
      ? `${seed.action} ${displayTarget} "${seed.query}"`
      : displayTarget
        ? `${seed.action} ${displayTarget}`
        : seed.query
          ? `${seed.action} "${seed.query}"`
          : seed.name;

    toolContextMap.set(seed.id, {
      name: seed.name,
      preview,
    });
  }

  return toolContextMap;
}

function collectStructuredPruneIds(
  messages: KodaXMessage[],
  toolContextMap: Map<string, ToolContextInfo>,
): PruneDecision {
  let protectedTurns = 0;
  let protectedToolTokens = 0;
  let prunableTokens = 0;
  const idsToPrune = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'user') {
      protectedTurns++;
    }

    if (protectedTurns < 2 || msg.role !== 'user' || !Array.isArray(msg.content)) {
      continue;
    }

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block?.type !== 'tool_result' || typeof block.content !== 'string') continue;

      const toolInfo = toolContextMap.get(block.tool_use_id);
      if (toolInfo && PRUNE_PROTECTED_TOOLS.has(toolInfo.name)) continue;

      const blockTokens = countToolResultTokens(block.content);
      protectedToolTokens += blockTokens;

      if (protectedToolTokens > STRUCTURED_PRUNE_PROTECT_TOKENS) {
        idsToPrune.add(block.tool_use_id);
        prunableTokens += blockTokens;
      }
    }
  }

  if (prunableTokens < STRUCTURED_PRUNE_MINIMUM_TOKENS) {
    return { idsToPrune: new Set<string>(), prunableTokens: 0 };
  }

  return { idsToPrune, prunableTokens };
}

function pruneToolResults(
  messages: KodaXMessage[],
  toolContextMap: Map<string, ToolContextInfo>,
  structuredPrune: PruneDecision,
  pruningThresholdTokens: number,
): PruneResult {
  let hasPruned = false;
  const prunedMessages = messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      return msg;
    }

    let changed = false;
    const newContent = msg.content.map((block) => {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') {
        return block;
      }

      const shouldStructuredPrune = structuredPrune.idsToPrune.has(block.tool_use_id);
      const shouldOversizePrune = countTokens(block.content) > pruningThresholdTokens;
      if (!shouldStructuredPrune && !shouldOversizePrune) {
        return block;
      }

      changed = true;
      hasPruned = true;
      const toolInfo = toolContextMap.get(block.tool_use_id);
      return {
        ...block,
        content: toolInfo ? `[Pruned: ${toolInfo.preview}]` : '[Pruned]',
      };
    });

    return changed ? { ...msg, content: newContent } : msg;
  });

  return { messages: prunedMessages, hasPruned };
}

function countToolResultTokens(content: string): number {
  return 4 + countTokens(content);
}

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
  const atomicBlocks = getAtomicBlocks(messages);

  for (let i = atomicBlocks.length - 1; i >= 0; i--) {
    const block = atomicBlocks[i];
    if (!block) continue;

    tokenCount += block.tokens;
    if (tokenCount > keepRecentTokens) {
      return block.start;
    }
  }

  return 0;
}

function findForwardCutPoint(messages: KodaXMessage[], targetTokens: number): number {
  let tokenCount = 0;
  const atomicBlocks = getAtomicBlocks(messages);

  if (atomicBlocks.length === 0) {
    return messages.length > 0 ? 1 : 0;
  }

  let cutEndIndex = 0;
  for (let i = 0; i < atomicBlocks.length; i++) {
    const block = atomicBlocks[i];
    if (!block) continue;

    tokenCount += block.tokens;
    cutEndIndex = block.end + 1;
    if (tokenCount >= targetTokens) {
      break;
    }
  }

  return Math.min(cutEndIndex, messages.length);
}

function chunkMessages(messages: KodaXMessage[], maxTokensPerChunk: number): KodaXMessage[][] {
  const chunks: KodaXMessage[][] = [];
  let currentChunk: KodaXMessage[] = [];
  let currentTokens = 0;

  const atomicBlocks = getAtomicBlocks(messages);

  for (const block of atomicBlocks) {
    const group = messages.slice(block.start, block.end + 1);
    const groupTokens = block.tokens;

    if (currentTokens + groupTokens > maxTokensPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [...group];
      currentTokens = groupTokens;
      continue;
    }

    currentChunk.push(...group);
    currentTokens += groupTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
