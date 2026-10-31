import { createHash } from 'node:crypto';
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import type {
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
} from '../types.js';
import { COMPACTION_SUMMARY_PREFIX } from './compaction/compaction.js';
import { getSessionLineagePath } from './kodax-session-lineage.js';

export type KodaXSessionHistoryScope = 'compacted' | 'all';
export type KodaXSessionHistorySource = 'user' | 'assistant' | 'system' | 'tool' | 'child_task';

export interface KodaXSessionHistorySearchOptions {
  query: string;
  limit?: number;
  role?: KodaXMessage['role'];
  scope?: KodaXSessionHistoryScope;
}

export interface KodaXSessionHistoryHit {
  entryId: string;
  /** Version of this entry's visible evidence, independent of normal tail appends. */
  entryRevision?: string;
  logicalId?: string;
  sourceEntryId?: string;
  timestamp: string;
  role: KodaXMessage['role'];
  source: KodaXSessionHistorySource;
  active: boolean;
  score: number;
  snippet: string;
  citation: string;
}

export interface KodaXSessionHistorySearchResult {
  revision: string;
  hits: KodaXSessionHistoryHit[];
}

/** @internal Cooperative control used by Runtime history reads. */
export interface KodaXSessionHistorySearchControl {
  readonly revision: string;
  checkpoint(): void;
  yieldControl(): Promise<void>;
}

export interface KodaXSessionHistoryReadOptions {
  entryId: string;
  /** A hit's entryRevision, or the legacy strict whole-history revision. */
  revision?: string;
  offset?: number;
  maxChars?: number;
}

export type KodaXSessionHistoryReadResult =
  | { status: 'not_found'; revision: string; entryId: string }
  | { status: 'stale'; revision: string; entryId: string; entryRevision?: string }
  | {
    status: 'ok';
    revision: string;
    entryRevision?: string;
    entryId: string;
    content: string;
    offset: number;
    nextOffset: number | null;
    totalChars: number;
    redactedBlockCount: number;
    citation: string;
  };

interface VisibleMessage {
  text: string;
  redactedBlockCount: number;
  source: KodaXSessionHistorySource;
}

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_READ_CHARS = 6_000;
const MAX_READ_CHARS = 12_000;
const SNIPPET_CHARS = 320;
const LEGACY_COMPACTION_SUMMARY_MARKER = COMPACTION_SUMMARY_PREFIX.trimEnd();
const MIN_METADATA_QUERY_LENGTH = 8;
const MAX_COOPERATIVE_SEARCH_QUERY_CHARS = 16 * 1024;
const MAX_COOPERATIVE_SEARCH_QUERY_TERMS = 128;
const COOPERATIVE_SEARCH_BATCH_SIZE = 16;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function visibleToolResult(block: Extract<KodaXContentBlock, { type: 'tool_result' }>): string {
  if (typeof block.content === 'string') return block.content;
  return block.content
    .map((item) => item.type === 'text' ? item.text : `[image: ${item.path}]`)
    .join('\n');
}

function visibleMessage(message: KodaXMessage): VisibleMessage {
  if (typeof message.content === 'string') {
    return {
      text: message.content,
      redactedBlockCount: 0,
      source: message._taskResult || message._taskResults ? 'child_task' : message.role,
    };
  }

  const parts: string[] = [];
  let redactedBlockCount = 0;
  let hasToolEvidence = false;
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'tool_use':
        hasToolEvidence = true;
        parts.push(`[tool_use ${block.name}] ${JSON.stringify(block.input)}`);
        break;
      case 'tool_result':
        hasToolEvidence = true;
        parts.push(`[tool_result ${block.tool_use_id}] ${visibleToolResult(block)}`);
        break;
      case 'image':
        parts.push(`[image: ${block.path}]`);
        break;
      case 'thinking':
      case 'redacted_thinking':
        redactedBlockCount += 1;
        break;
      case 'cache-boundary':
        break;
      default: {
        const exhaustive: never = block;
        return exhaustive;
      }
    }
  }
  return {
    text: parts.join('\n'),
    redactedBlockCount,
    source: message._taskResult || message._taskResults
      ? 'child_task'
      : hasToolEvidence ? 'tool' : message.role,
  };
}

function historyRevision(lineage: KodaXSessionLineage): string {
  const hash = createHash('sha256');
  hash.update(lineage.activeEntryId ?? '');
  for (const entry of lineage.entries) {
    hash.update('\0');
    hash.update(JSON.stringify(entry));
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Bind exactly the readable evidence and its identity/provenance, never hidden reasoning. */
function entryEvidenceRevision(entry: KodaXSessionMessageEntry, visible: VisibleMessage): string {
  const identity = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
    logicalId: entry.logicalId, sourceEntryId: entry.sourceEntryId,
    role: entry.message.role, source: entry.message._source, synthetic: entry.message._synthetic ?? false };
  return `entry:sha256:${createHash('sha256').update(JSON.stringify([identity, visible])).digest('hex')}`;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function lexicalTerms(value: string): string[] {
  const terms = normalized(value).match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(terms.filter((term) => term.length > 1))];
}

function scoreText(
  text: string,
  metadata: string,
  query: string,
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
): number {
  const haystack = normalized(text);
  const normalizedMetadata = normalized(metadata);
  const needle = normalized(query).trim();
  if (!needle) return 0;
  let score = haystack.includes(needle) ? 1_000 + Math.min(needle.length, 200) : 0;
  if (needle.length >= MIN_METADATA_QUERY_LENGTH && normalizedMetadata.includes(needle)) {
    score += 1_500 + Math.min(needle.length, 200);
  }
  let matchedTerms = 0;
  for (const term of queryTerms) {
    const inText = haystack.includes(term);
    if (!inText) continue;
    matchedTerms += 1;
    const frequency = documentFrequency.get(term) ?? documentCount;
    const inverseFrequency = Math.log((documentCount + 1) / (frequency + 1)) + 1;
    score += Math.round((20 + Math.min(term.length, 20)) * inverseFrequency);
  }
  if (queryTerms.length > 0) score += Math.round((matchedTerms / queryTerms.length) * 100);
  return score;
}

async function scoreTextCooperatively(
  haystack: string,
  normalizedMetadata: string,
  needle: string,
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  control: KodaXSessionHistorySearchControl,
): Promise<number> {
  if (!needle) return 0;
  let score = haystack.includes(needle) ? 1_000 + Math.min(needle.length, 200) : 0;
  if (needle.length >= MIN_METADATA_QUERY_LENGTH && normalizedMetadata.includes(needle)) {
    score += 1_500 + Math.min(needle.length, 200);
  }
  let matchedTerms = 0;
  for (let index = 0; index < queryTerms.length; index += 1) {
    control.checkpoint();
    if (index > 0 && index % COOPERATIVE_SEARCH_BATCH_SIZE === 0) {
      await control.yieldControl();
    }
    const term = queryTerms[index]!;
    if (!haystack.includes(term)) continue;
    matchedTerms += 1;
    const frequency = documentFrequency.get(term) ?? documentCount;
    const inverseFrequency = Math.log((documentCount + 1) / (frequency + 1)) + 1;
    score += Math.round((20 + Math.min(term.length, 20)) * inverseFrequency);
  }
  if (queryTerms.length > 0) score += Math.round((matchedTerms / queryTerms.length) * 100);
  return score;
}

function snippet(text: string, query: string): string {
  if (text.length <= SNIPPET_CHARS) return text;
  const index = normalized(text).indexOf(normalized(query).trim());
  const start = index < 0 ? 0 : Math.max(0, index - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function activeEntryIds(lineage: KodaXSessionLineage): Set<string> {
  return new Set(getSessionLineagePath(lineage).map((entry) => entry.id));
}

function isHistoryNavigableEntry(entry: KodaXSessionEntry): boolean {
  return entry.type !== 'label'
    && entry.type !== 'goal'
    && entry.type !== 'client_notice'
    && entry.type !== 'memory_outcome_digest'
    && entry.type !== 'memory_review_receipt'
    && entry.type !== 'rewind_marker';
}

async function activeEntryIdsCooperatively(
  lineage: KodaXSessionLineage,
  control: KodaXSessionHistorySearchControl,
): Promise<Set<string>> {
  const byId = new Map<string, KodaXSessionEntry>();
  for (let index = 0; index < lineage.entries.length; index += 1) {
    control.checkpoint();
    if (index > 0 && index % COOPERATIVE_SEARCH_BATCH_SIZE === 0) {
      await control.yieldControl();
    }
    const entry = lineage.entries[index]!;
    if (isHistoryNavigableEntry(entry)) byId.set(entry.id, entry);
  }
  const activeIds = new Set<string>();
  const visited = new Set<string>();
  let current = lineage.activeEntryId
    ? byId.get(lineage.activeEntryId)
    : undefined;
  while (current !== undefined && !visited.has(current.id)) {
    control.checkpoint();
    if (
      activeIds.size > 0
      && activeIds.size % COOPERATIVE_SEARCH_BATCH_SIZE === 0
    ) {
      await control.yieldControl();
    }
    visited.add(current.id);
    activeIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return activeIds;
}

function isSyntheticCheckpoint(message: KodaXMessage): boolean {
  if (message._source === 'compaction-checkpoint') return true;
  return typeof message.content === 'string'
    && message.content.trimStart().startsWith(LEGACY_COMPACTION_SUMMARY_MARKER);
}

function isCompactedPlaceholder(message: KodaXMessage): boolean {
  if (typeof message.content === 'string') return message.content.trim() === '[compacted]';
  return message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0].text.trim() === '[compacted]';
}

function historyEvidence(message: KodaXMessage): VisibleMessage | null {
  if (message.role === 'system' || isSyntheticCheckpoint(message) || isCompactedPlaceholder(message)) {
    return null;
  }
  const visible = visibleMessage(message);
  return visible.text.trim().length > 0 ? visible : null;
}

export function searchSessionHistory(
  lineage: KodaXSessionLineage,
  options: KodaXSessionHistorySearchOptions,
): KodaXSessionHistorySearchResult {
  const revision = historyRevision(lineage);
  const query = options.query.trim();
  if (!query) return { revision, hits: [] };

  const activeIds = activeEntryIds(lineage);
  const entryOrder = new Map(lineage.entries.map((entry, index) => [entry.id, index]));
  const scope = options.scope ?? 'compacted';
  const queryTerms = lexicalTerms(query);
  const candidates = lineage.entries.flatMap((entry) => {
    if (entry.type !== 'message') return [];
    // Historical recovery is an evidence plane for user, assistant, tool, and
    // child-task content. Host instructions and synthetic checkpoints are
    // intentionally excluded so they cannot crowd out or disclose evidence.
    const visible = historyEvidence(entry.message);
    if (!visible) return [];
    const active = activeIds.has(entry.id);
    if (scope === 'compacted' && active) return [];
    if (options.role && entry.message.role !== options.role) return [];
    return [{
      entry,
      entryRevision: entryEvidenceRevision(entry, visible),
      active,
      visible,
      metadata: [entry.id, entry.logicalId, entry.sourceEntryId].filter(Boolean).join(' '),
    }];
  });
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    const count = candidates.reduce(
      (total, candidate) => total + (normalized(candidate.visible.text).includes(term) ? 1 : 0),
      0,
    );
    documentFrequency.set(term, count);
  }
  const hits: KodaXSessionHistoryHit[] = [];
  for (const { entry, entryRevision, active, visible, metadata } of candidates) {
    const score = scoreText(
      visible.text,
      metadata,
      query,
      queryTerms,
      documentFrequency,
      candidates.length,
    );
    if (score <= 0) continue;
    hits.push({
      entryId: entry.id,
      entryRevision,
      logicalId: entry.logicalId,
      sourceEntryId: entry.sourceEntryId,
      timestamp: entry.timestamp,
      role: entry.message.role,
      source: visible.source,
      active,
      score,
      snippet: snippet(visible.text, query),
      citation: `session-history:${entry.id}`,
    });
  }

  hits.sort((left, right) => right.score - left.score
    || right.timestamp.localeCompare(left.timestamp)
    || (entryOrder.get(right.entryId) ?? 0) - (entryOrder.get(left.entryId) ?? 0)
    || left.entryId.localeCompare(right.entryId));
  return {
    revision,
    hits: hits.slice(0, boundedInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)),
  };
}

function createCooperativeSearchLimitError(
  message: string,
  data: Readonly<Record<string, string | number>>,
): Error & {
  readonly code: 'invalid_params';
  readonly data: Readonly<Record<string, string | number>>;
} {
  return Object.assign(new Error(message), {
    code: 'invalid_params' as const,
    data,
  });
}

/** @internal Runtime preflight; kept out of the public package barrels. */
export function validateSessionHistorySearchQuery(query: string): void {
  if (query.length > MAX_COOPERATIVE_SEARCH_QUERY_CHARS) {
    throw createCooperativeSearchLimitError(
      'Transcript search query exceeds the character limit',
      {
        limitChars: MAX_COOPERATIVE_SEARCH_QUERY_CHARS,
        resource: 'query',
      },
    );
  }
  if (lexicalTerms(query).length > MAX_COOPERATIVE_SEARCH_QUERY_TERMS) {
    throw createCooperativeSearchLimitError(
      'Transcript search query contains too many unique terms',
      {
        limitTerms: MAX_COOPERATIVE_SEARCH_QUERY_TERMS,
        resource: 'query_terms',
      },
    );
  }
}

function compareHistoryHits(
  left: KodaXSessionHistoryHit,
  right: KodaXSessionHistoryHit,
  entryOrder: ReadonlyMap<string, number>,
): number {
  return right.score - left.score
    || right.timestamp.localeCompare(left.timestamp)
    || (entryOrder.get(right.entryId) ?? 0) - (entryOrder.get(left.entryId) ?? 0)
    || left.entryId.localeCompare(right.entryId);
}

/**
 * Runtime-facing history search that yields between bounded batches so
 * timeout/cancel signals can be observed while indexing large transcripts.
 */
export async function searchSessionHistoryCooperatively(
  lineage: KodaXSessionLineage,
  options: KodaXSessionHistorySearchOptions,
  control: KodaXSessionHistorySearchControl,
): Promise<KodaXSessionHistorySearchResult> {
  const revision = control.revision;
  const rawQuery = options.query;
  validateSessionHistorySearchQuery(rawQuery);
  const query = rawQuery.trim();
  if (!query) return { revision, hits: [] };
  control.checkpoint();
  await control.yieldControl();
  const normalizedQuery = normalized(query).trim();
  const queryTerms = lexicalTerms(query);

  const activeIds = await activeEntryIdsCooperatively(lineage, control);
  const entryOrder = new Map<string, number>();
  const candidates: Array<{
    readonly entry: KodaXSessionMessageEntry;
    readonly entryRevision: string;
    readonly active: boolean;
    readonly visible: VisibleMessage;
    readonly normalizedText: string;
    readonly normalizedMetadata: string;
  }> = [];
  const scope = options.scope ?? 'compacted';
  for (let index = 0; index < lineage.entries.length; index += 1) {
    control.checkpoint();
    if (index > 0 && index % COOPERATIVE_SEARCH_BATCH_SIZE === 0) {
      await control.yieldControl();
    }
    const entry = lineage.entries[index]!;
    entryOrder.set(entry.id, index);
    if (entry.type !== 'message') continue;
    const visible = historyEvidence(entry.message);
    if (!visible) continue;
    const active = activeIds.has(entry.id);
    if (scope === 'compacted' && active) continue;
    if (options.role && entry.message.role !== options.role) continue;
    const metadata = [entry.id, entry.logicalId, entry.sourceEntryId]
      .filter(Boolean)
      .join(' ');
    candidates.push({
      entry,
      entryRevision: entryEvidenceRevision(entry, visible),
      active,
      visible,
      normalizedText: normalized(visible.text),
      normalizedMetadata: normalized(metadata),
    });
  }

  const documentFrequency = new Map<string, number>();
  let comparisons = 0;
  for (const term of queryTerms) {
    let count = 0;
    for (const candidate of candidates) {
      control.checkpoint();
      comparisons += 1;
      if (comparisons % COOPERATIVE_SEARCH_BATCH_SIZE === 0) {
        await control.yieldControl();
      }
      if (candidate.normalizedText.includes(term)) count += 1;
    }
    documentFrequency.set(term, count);
  }

  const limit = boundedInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const hits: KodaXSessionHistoryHit[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    control.checkpoint();
    if (index > 0 && index % COOPERATIVE_SEARCH_BATCH_SIZE === 0) {
      await control.yieldControl();
    }
    const {
      entry,
      active,
      visible,
      normalizedText,
      normalizedMetadata,
    } = candidates[index]!;
    const score = await scoreTextCooperatively(
      normalizedText,
      normalizedMetadata,
      normalizedQuery,
      queryTerms,
      documentFrequency,
      candidates.length,
      control,
    );
    if (score <= 0) continue;
    hits.push({
      entryId: entry.id,
      entryRevision: candidates[index]!.entryRevision,
      logicalId: entry.logicalId,
      sourceEntryId: entry.sourceEntryId,
      timestamp: entry.timestamp,
      role: entry.message.role,
      source: visible.source,
      active,
      score,
      snippet: visible.text.length <= SNIPPET_CHARS
        ? visible.text
        : (() => {
          const matchIndex = normalizedText.indexOf(normalizedQuery);
          const start = matchIndex < 0
            ? 0
            : Math.max(0, matchIndex - Math.floor(SNIPPET_CHARS / 3));
          const end = Math.min(visible.text.length, start + SNIPPET_CHARS);
          return `${start > 0 ? '…' : ''}${visible.text.slice(start, end)}${
            end < visible.text.length ? '…' : ''
          }`;
        })(),
      citation: `session-history:${entry.id}`,
    });
    hits.sort((left, right) => compareHistoryHits(left, right, entryOrder));
    if (hits.length > limit) hits.pop();
  }
  control.checkpoint();
  return { revision, hits };
}

export function readSessionHistoryEntry(
  lineage: KodaXSessionLineage,
  options: KodaXSessionHistoryReadOptions,
): KodaXSessionHistoryReadResult {
  const revision = historyRevision(lineage);
  const entry = lineage.entries.find(
    (candidate): candidate is KodaXSessionMessageEntry =>
      candidate.type === 'message' && candidate.id === options.entryId,
  );
  const visible = entry ? historyEvidence(entry.message) : null;
  const entryRevision = entry && visible ? entryEvidenceRevision(entry, visible) : undefined;
  const entryScoped = options.revision?.startsWith('entry:sha256:') === true;
  if (entryScoped && !entryRevision) return { status: 'not_found', revision, entryId: options.entryId };
  if (options.revision && options.revision !== (entryScoped ? entryRevision : revision)) {
    return { status: 'stale', revision, entryId: options.entryId, ...(entryRevision ? { entryRevision } : {}) };
  }
  if (!entry) return { status: 'not_found', revision, entryId: options.entryId };
  if (!visible) return { status: 'not_found', revision, entryId: options.entryId };
  const offset = boundedInteger(options.offset, 0, 0, visible.text.length);
  const maxChars = boundedInteger(options.maxChars, DEFAULT_READ_CHARS, 1, MAX_READ_CHARS);
  const end = Math.min(visible.text.length, offset + maxChars);
  return {
    status: 'ok',
    revision,
    entryRevision,
    entryId: entry.id,
    content: visible.text.slice(offset, end),
    offset,
    nextOffset: end < visible.text.length ? end : null,
    totalChars: visible.text.length,
    redactedBlockCount: visible.redactedBlockCount,
    citation: `session-history:${entry.id}`,
  };
}
