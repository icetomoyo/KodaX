/**
 * FEATURE_218 — deterministic resolver for the self-knowledge manual.
 * FEATURE_221 — extended to merge SDK-consumer-injected topics over the KodaX
 * base (override by id) and to re-brand the scope anchor with a product name.
 *
 * Matching order: exact topic id → alias exact match → query token overlap →
 * unknown falls back to a lightweight structured index (never fabricates).
 * Exact-topic answers are complete and carry an anti-confusion scope anchor.
 */

import { MANUAL_REGISTRY, MANUAL_TOPIC_IDS } from './registry.js';
import type {
  KodaXManualIndexTopic,
  KodaXManualSource,
  KodaXManualTopicId,
  KodaXManualTopicInput,
  ResolveKodaXManualInput,
  ResolveKodaXManualOptions,
  ResolveKodaXManualResult,
} from './types.js';

/** @deprecated Capacity is enforced once by the final tool-result admission layer. */
export const MANUAL_TOPIC_MAX_BYTES = 4096;
/** @deprecated Indexes use structured lightweight metadata and are not byte-cropped. */
export const MANUAL_INDEX_MAX_BYTES = 2048;

const DEFAULT_PRODUCT_NAME = 'KodaX';

/** Common internal shape the matcher operates on (base + injected topics). */
interface ManualEntry {
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly body: string;
  readonly sources: readonly KodaXManualSource[];
  readonly nextTopics: readonly string[];
}

function normalizeInjected(t: KodaXManualTopicInput): ManualEntry {
  // Coerce the string fields defensively: an SDK consumer is plain JS and may
  // pass a null/undefined body/summary, which would otherwise blow up in
  // downstream string assembly with an opaque Node TypeError.
  return {
    id: String(t.id ?? ''),
    title: String(t.title ?? ''),
    aliases: t.aliases ?? [],
    summary: String(t.summary ?? ''),
    body: String(t.body ?? ''),
    sources: t.sources ?? [],
    nextTopics: t.nextTopics ?? [],
  };
}

/** Ordered base + injected entries; injected override base by id, then append. */
function buildEntries(
  extraTopics?: readonly KodaXManualTopicInput[],
  baseTopics?: readonly KodaXManualTopicId[],
): {
  ids: string[];
  byId: Map<string, ManualEntry>;
} {
  const byId = new Map<string, ManualEntry>();
  const ids: string[] = [];
  // FEATURE_221: `baseTopics` parameterizes which base topics are seeded.
  // `undefined` ⇒ all base topics (legacy selection behavior); `[]` ⇒ none (full
  // white-label replace); a subset ⇒ exactly those (keep inherited mechanisms).
  const seedIds = baseTopics ?? MANUAL_TOPIC_IDS;
  for (const id of seedIds) {
    // Dedup a caller-supplied baseTopics with a repeated id (else the index +
    // ranked results would list it twice). MANUAL_TOPIC_IDS is already unique,
    // so the default path is unaffected. Mirrors the extraTopics loop's guard.
    if (byId.has(id)) continue;
    // A caller-supplied baseTopics could name an unknown id defensively; skip it.
    const base = MANUAL_REGISTRY[id];
    if (!base) continue;
    byId.set(id, base);
    ids.push(id);
  }
  for (const t of extraTopics ?? []) {
    if (!byId.has(t.id)) ids.push(t.id);
    byId.set(t.id, normalizeInjected(t));
  }
  return { ids, byId };
}

/** Anti-confusion anchor — this product, not Claude Code / Codex CLI. */
function scopeAnchor(topicId: string, productName: string): string {
  const base = `(${productName} ${topicId} manual — about ${productName} itself, not Claude Code or Codex CLI.`;
  // The ~/.kodax config-path hint only belongs on KodaX's own manual; a
  // re-branded consumer manual must not assert KodaX paths on the consumer's
  // (possibly fully white-labeled) topics. Default stays byte-identical.
  const tail =
    productName === 'KodaX' ? ' KodaX config lives in ~/.kodax/config.json + KODAX_* env vars.)' : ')';
  return base + tail;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/u)
    .filter((t) => t.length > 0);
}

function findByExactId(ids: readonly string[], byId: Map<string, ManualEntry>, value: string): ManualEntry | undefined {
  return ids.includes(value) ? byId.get(value) : undefined;
}

function findByAlias(ids: readonly string[], byId: Map<string, ManualEntry>, value: string): ManualEntry | undefined {
  const needle = value.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  for (const id of ids) {
    const topic = byId.get(id)!;
    if (topic.aliases.some((a) => a.toLowerCase() === needle)) return topic;
  }
  return undefined;
}

function scoreTopic(
  topic: ManualEntry,
  queryTokens: readonly string[],
  normalizedQuery: string,
): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize([topic.id, topic.title, topic.summary, ...topic.aliases].join(' ')));
  let hits = 0;
  for (const t of queryTokens) if (haystack.has(t)) hits += 1;
  for (const alias of topic.aliases) {
    const normalizedAlias = alias.trim().toLowerCase();
    if (/[一-鿿]/u.test(normalizedAlias) && normalizedQuery.includes(normalizedAlias)) {
      hits += 2;
    }
  }
  return hits;
}

function rankByQuery(ids: readonly string[], byId: Map<string, ManualEntry>, query: string): ManualEntry[] {
  const queryTokens = tokenize(query);
  const normalizedQuery = query.toLowerCase();
  return ids
    .map((id) => byId.get(id)!)
    .map((topic) => ({ topic, score: scoreTopic(topic, queryTokens, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.topic);
}

function buildTopicResult(topic: ManualEntry, productName: string): ResolveKodaXManualResult {
  return {
    matchedTopic: topic.id,
    title: topic.title,
    content: `${scopeAnchor(topic.id, productName)}\n\n${topic.body}`,
    topics: [],
    sources: topic.sources,
    nextTopics: topic.nextTopics,
  };
}

function toIndexTopic(topic: ManualEntry): KodaXManualIndexTopic {
  return {
    id: topic.id,
    title: topic.title,
    summary: topic.summary,
  };
}

function buildIndexResult(
  ids: readonly string[],
  byId: Map<string, ManualEntry>,
  productName: string,
  suggested?: readonly ManualEntry[],
): ResolveKodaXManualResult {
  const content =
    suggested && suggested.length > 0
      ? `No exact ${productName} manual topic matched. Choose a closest topic id and call kodax_manual again.`
      : `${productName} manual topic index. Choose an exact topic id and call kodax_manual again.`;
  const topics = (suggested && suggested.length > 0 ? suggested : ids.map((id) => byId.get(id)!))
    .map(toIndexTopic);
  const nextTopics = (suggested ?? []).slice(0, 3).map((t) => t.id);
  return {
    matchedTopic: 'index',
    title: `${productName} Manual — Index`,
    content,
    topics,
    sources: [],
    nextTopics,
  };
}

export function resolveKodaXManual(
  input: ResolveKodaXManualInput,
  options?: ResolveKodaXManualOptions,
): ResolveKodaXManualResult {
  const productName = options?.productName?.trim() || DEFAULT_PRODUCT_NAME;
  const { ids, byId } = buildEntries(options?.extraTopics, options?.baseTopics);

  const topicHint = input.topic?.trim();
  if (topicHint) {
    const exact = findByExactId(ids, byId, topicHint) ?? findByAlias(ids, byId, topicHint);
    if (exact) return buildTopicResult(exact, productName);
    return buildIndexResult(ids, byId, productName, rankByQuery(ids, byId, topicHint).slice(0, 3));
  }

  const query = input.query?.trim();
  if (query) {
    const exact = findByExactId(ids, byId, query)
      ?? findByExactId(ids, byId, query.toLowerCase())
      ?? findByAlias(ids, byId, query);
    if (exact) return buildTopicResult(exact, productName);
    const ranked = rankByQuery(ids, byId, query);
    if (ranked.length > 0 && ranked[0]) return buildTopicResult(ranked[0], productName);
    return buildIndexResult(ids, byId, productName);
  }

  return buildIndexResult(ids, byId, productName);
}
