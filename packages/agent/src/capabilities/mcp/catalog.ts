import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';

import { getAgentConfigPath } from '../../runtime/agent-home.js';

export type McpCapabilityKind = 'tool' | 'resource' | 'prompt';
export type McpCapabilityRisk = 'read' | 'write' | 'network' | 'exec';

/** Per-tool task-augmentation support (2025-11-25 `execution.taskSupport`). */
export type McpToolTaskSupport = 'forbidden' | 'optional' | 'required';

/** Icon metadata (2025-11-25) attached to tools / resources / prompts. */
export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface McpCatalogItem {
  id: string;
  serverId: string;
  kind: McpCapabilityKind;
  name: string;
  title?: string;
  summary: string;
  tags?: string[];
  risk?: McpCapabilityRisk;
  annotations?: Record<string, unknown>;
  /** Argument names from the input schema, e.g. `(owner, repo, body?)`. */
  argsSignature?: string;
  cachedAt: string;
}
export interface McpCapabilityDescriptor extends McpCatalogItem {
  inputSchema?: unknown;
  outputSchema?: unknown;
  promptArgsSchema?: unknown;
  uri?: string;
  mimeType?: string;
  /** Sanitized icon metadata (unsafe-scheme icons dropped). */
  icons?: McpIcon[];
  /** Tool only — `execution.taskSupport`. Absent is treated as 'forbidden'. */
  taskSupport?: McpToolTaskSupport;
}

export interface McpServerCatalogSnapshot {
  serverId: string;
  items: McpCatalogItem[];
  descriptors: McpCapabilityDescriptor[];
  updatedAt: string;
  /** Hash of the server config that produced this catalog; a config edit invalidates the cache. */
  configFingerprint?: string;
  /** One line on what the server is for, from its initialize result. */
  serverPurpose?: string;
}

export interface McpCatalogSearchOptions {
  kind?: McpCapabilityKind;
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isCatalogItem(value: unknown, serverId: string): value is McpCatalogItem {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  const validKind = kind === 'tool' || kind === 'resource' || kind === 'prompt';
  if (
    !validKind
    || typeof value.id !== 'string'
    || value.serverId !== serverId
    || typeof value.name !== 'string'
    || value.name.trim().length === 0
    || typeof value.summary !== 'string'
    || typeof value.cachedAt !== 'string'
    || !isOptionalString(value.title)
  ) {
    return false;
  }
  if (value.id !== createMcpCapabilityId(serverId, kind, value.name)) return false;
  if (value.tags !== undefined && (
    !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')
  )) {
    return false;
  }
  if (value.risk !== undefined && !['read', 'write', 'network', 'exec'].includes(String(value.risk))) {
    return false;
  }
  return value.annotations === undefined || isRecord(value.annotations);
}

function hasMatchingCatalogIds(
  items: readonly McpCatalogItem[],
  descriptors: readonly McpCapabilityDescriptor[],
): boolean {
  const itemIds = items.map((item) => item.id);
  const descriptorIds = descriptors.map((item) => item.id);
  if (new Set(itemIds).size !== itemIds.length || new Set(descriptorIds).size !== descriptorIds.length) {
    return false;
  }
  return [...itemIds].sort(compareText).join('\n') === [...descriptorIds].sort(compareText).join('\n');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createMcpCatalogRevision(items: readonly McpCatalogItem[]): string {
  const content = [...items]
    .sort((left, right) => compareText(left.id, right.id))
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      tags: item.tags,
      risk: item.risk,
    }));
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

function safeIdComponent(value: string): string {
  return encodeURIComponent(value);
}

export function defaultMcpCacheDir(): string {
  return getAgentConfigPath('mcp');
}

export function createMcpCapabilityId(
  serverId: string,
  kind: McpCapabilityKind,
  name: string,
): string {
  return `mcp:${safeIdComponent(serverId)}:${kind}:${safeIdComponent(name)}`;
}

/**
 * Applied defensively at handler, provider, and parse boundaries.
 * Keep this idempotent so stacked normalization remains harmless.
 */
export function normalizeMcpCapabilityId(id: string): string {
  const trimmed = id.trim();
  const canonical = trimmed.match(/^mcp:([^:]+):(tool|resource|prompt):(.+)$/);
  if (canonical?.[1] && canonical[2] && canonical[3]) {
    return trimmed;
  }

  const withoutScheme = !trimmed.startsWith('mcp:')
    ? trimmed.match(/^([^:]+):(tool|resource|prompt):(.+)$/)
    : undefined;
  if (withoutScheme?.[1] && withoutScheme[2] && withoutScheme[3]) {
    return `mcp:${withoutScheme[1]}:${withoutScheme[2]}:${withoutScheme[3]}`;
  }

  const legacyUri = trimmed.match(/^mcp:\/\/([^/]+)\/(tool|resource|prompt)\/(.+)$/);
  if (legacyUri?.[1] && legacyUri[2] && legacyUri[3]) {
    return createMcpCapabilityId(
      decodeURIComponent(legacyUri[1]),
      legacyUri[2] as McpCapabilityKind,
      decodeURIComponent(legacyUri[3]),
    );
  }

  return trimmed;
}

export function parseMcpCapabilityId(id: string): {
  serverId: string;
  kind: McpCapabilityKind;
  name: string;
} {
  const normalized = normalizeMcpCapabilityId(id);
  const match = normalized.match(/^mcp:([^:]+):(tool|resource|prompt):(.+)$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid MCP capability id: ${id}`);
  }

  return {
    serverId: decodeURIComponent(match[1]),
    kind: match[2] as McpCapabilityKind,
    name: decodeURIComponent(match[3]),
  };
}

export function summarizeMcpCatalogEntry(
  value: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const description = typeof value?.description === 'string'
    ? value.description.trim()
    : '';
  const title = typeof value?.title === 'string'
    ? value.title.trim()
    : '';
  return description || title || fallback;
}

const SERVER_PURPOSE_MAX_CHARS = 100;

function firstSentence(text: string): string | undefined {
  // Skip markdown headings; a server name alone says less than its first sentence.
  const prose = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).join(' ');
  const sentence = prose.match(/^.*?(?:[.!?](?=\s|$)|。)/)?.[0] ?? prose;
  return sentence.trim() || undefined;
}

/**
 * One line on what a server is for, so the resident manifest tells the model
 * when an MCP search is worth it. Prefers the first sentence of the initialize
 * `instructions`, then `serverInfo.description`, then `serverInfo.title`.
 */
export function summarizeMcpServerPurpose(initializeResult: unknown): string | undefined {
  if (!initializeResult || typeof initializeResult !== 'object') return undefined;
  const result = initializeResult as Record<string, unknown>;
  const info = result.serverInfo && typeof result.serverInfo === 'object'
    ? result.serverInfo as Record<string, unknown>
    : {};
  const candidates = [result.instructions, info.description, info.title];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const line = firstSentence(candidate)?.replace(/\s+/g, ' ');
    if (!line) continue;
    return line.length > SERVER_PURPOSE_MAX_CHARS ? `${line.slice(0, SERVER_PURPOSE_MAX_CHARS - 1)}…` : line;
  }
  return undefined;
}

const SIGNATURE_MAX_ARGS = 8;

function listArgs(schema: unknown): Array<{ name: string; required: boolean }> | undefined {
  if (Array.isArray(schema)) {
    // Prompt arguments arrive as [{ name, required }].
    return schema.flatMap((entry: unknown) => {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : undefined;
      return typeof record?.name === 'string' && record.name
        ? [{ name: record.name, required: record.required === true }]
        : [];
    });
  }
  if (!schema || typeof schema !== 'object') return undefined;
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (!properties || typeof properties !== 'object') return [];
  const requiredNames = new Set(Array.isArray(required) ? required : []);
  return Object.keys(properties).map((name) => ({ name, required: requiredNames.has(name) }));
}

/**
 * One-line argument list for search results, so a simple tool can be called
 * without a describe round. Types and nesting stay in mcp_describe.
 */
export function summarizeMcpArgsSignature(schema: unknown): string | undefined {
  const args = listArgs(schema);
  if (!args) return undefined;
  const names = args
    .slice(0, SIGNATURE_MAX_ARGS)
    .map((arg) => (arg.required ? arg.name : `${arg.name}?`));
  if (args.length > SIGNATURE_MAX_ARGS) names.push('…');
  return `(${names.join(', ')})`;
}

// Per 2025-11-25 icon security rules clients MUST reject unsafe schemes
// (javascript:, file:, ftp:, ws:, local app schemes). Allow only http(s) and
// data: URIs; relative URLs are unresolvable without a server origin and dropped.
const SAFE_ICON_SCHEMES = ['https:', 'http:', 'data:'];

function isSafeIconSrc(src: string): boolean {
  const lower = src.toLowerCase();
  return SAFE_ICON_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

/**
 * Validate and normalize a raw `icons` array from a tool/resource/prompt entry,
 * dropping malformed entries and unsafe-scheme sources. Returns undefined when
 * nothing safe remains so callers can omit the field entirely.
 */
export function sanitizeMcpIcons(raw: unknown): McpIcon[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const icons: McpIcon[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const src = typeof record.src === 'string' ? record.src.trim() : '';
    if (!src || !isSafeIconSrc(src)) {
      continue;
    }
    const icon: McpIcon = { src };
    if (typeof record.mimeType === 'string' && record.mimeType.trim()) {
      icon.mimeType = record.mimeType.trim();
    }
    if (Array.isArray(record.sizes)) {
      const sizes = record.sizes.filter(
        (size): size is string => typeof size === 'string' && size.trim().length > 0,
      );
      if (sizes.length > 0) {
        icon.sizes = sizes;
      }
    }
    if (record.theme === 'light' || record.theme === 'dark') {
      icon.theme = record.theme;
    }
    icons.push(icon);
  }
  return icons.length > 0 ? icons : undefined;
}

export function deriveMcpCapabilityRisk(
  kind: McpCapabilityKind,
  name: string,
  annotations?: Record<string, unknown>,
): McpCapabilityRisk | undefined {
  if (kind === 'resource' || kind === 'prompt') {
    return 'read';
  }

  const lowerName = name.toLowerCase();
  if (annotations?.destructive === true || annotations?.destructiveHint === true) {
    return 'write';
  }
  if (annotations?.openWorld === true || annotations?.openWorldHint === true) {
    return 'network';
  }
  if (annotations?.exec === true || annotations?.execHint === true || lowerName.includes('exec')) {
    return 'exec';
  }
  if (
    lowerName.includes('delete')
    || lowerName.includes('remove')
    || lowerName.includes('write')
    || lowerName.includes('update')
    || lowerName.includes('create')
  ) {
    return 'write';
  }

  return 'read';
}

export function buildCatalogSearchText(item: McpCatalogItem): string {
  return [
    item.id,
    item.serverId,
    item.kind,
    item.name,
    item.title,
    item.summary,
    ...(item.tags ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .toLowerCase();
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_WORD_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  return normalized.split(/\s+/).flatMap((token) => {
    if (!CJK_SCRIPT.test(token)) return [token];
    return [...CJK_WORD_SEGMENTER.segment(token)]
      .filter((segment) => segment.isWordLike)
      .map((segment) => segment.segment);
  });
}

interface McpCatalogScore {
  score: number;
  complete: boolean;
}

function scoreCatalogItem(
  item: McpCatalogItem,
  query: string,
  tokens: readonly string[],
): McpCatalogScore {
  const rawId = item.id.toLowerCase();
  const rawName = item.name.toLowerCase();
  if (rawId === query) return { score: 100_000, complete: true };
  if (rawName === query || normalizeSearchText(item.name) === normalizeSearchText(query)) {
    return { score: 90_000, complete: true };
  }

  const fields = [
    { text: normalizeSearchText(item.name), weight: 80 },
    { text: normalizeSearchText(item.id), weight: 60 },
    { text: normalizeSearchText(item.title ?? ''), weight: 40 },
    { text: normalizeSearchText((item.tags ?? []).join(' ')), weight: 30 },
    { text: normalizeSearchText(item.summary), weight: 15 },
    { text: normalizeSearchText(item.serverId), weight: 10 },
    { text: item.kind, weight: 5 },
  ];
  let matched = 0;
  let score = 0;
  for (const token of tokens) {
    const best = fields.reduce((weight, field) => (
      field.text.includes(token) ? Math.max(weight, field.weight) : weight
    ), 0);
    if (best > 0) {
      matched += 1;
      score += best;
    }
  }
  return { score, complete: matched === tokens.length };
}

export function searchMcpCatalog(
  items: readonly McpCatalogItem[],
  query: string,
  options: McpCatalogSearchOptions = {},
): McpCatalogItem[] {
  const rawQuery = query.trim().toLowerCase();
  const tokens = tokenizeSearchText(query);
  const limit = options.limit === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(options.limit));
  const candidates = items.filter((item) => !options.kind || item.kind === options.kind);

  if (tokens.length === 0) {
    return [...candidates]
      .sort((left, right) => compareText(left.id, right.id))
      .slice(0, limit);
  }

  return candidates
    .map((item) => ({ item, ...scoreCatalogItem(item, rawQuery, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => Number(right.complete) - Number(left.complete)
      || right.score - left.score
      || compareText(left.item.id, right.item.id))
    .slice(0, limit)
    .map(({ item }) => item);
}

export function getMcpCachePaths(cacheDir: string, serverId: string): {
  catalogDir: string;
  indexPath: string;
  itemsPath: string;
} {
  const catalogDir = path.join(cacheDir, 'catalog');
  const fileStem = toCacheFileStem(serverId);
  return {
    catalogDir,
    indexPath: path.join(catalogDir, `${fileStem}.index.json`),
    itemsPath: path.join(catalogDir, `${fileStem}.items.json`),
  };
}

/**
 * Server ids come from user config, so they may contain path separators or
 * characters Windows rejects. Ordinary ids keep their readable name; anything
 * else is percent-encoded. Safe ids never contain `%`, so the mapping is
 * injective and two servers cannot share a cache file.
 */
function toCacheFileStem(serverId: string): string {
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(serverId)) return serverId;
  return encodeURIComponent(serverId)
    .replace(/[!'()*~.]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export async function writeMcpServerCatalog(
  cacheDir: string,
  snapshot: McpServerCatalogSnapshot,
): Promise<void> {
  const { catalogDir, indexPath, itemsPath } = getMcpCachePaths(cacheDir, snapshot.serverId);
  await fs.mkdir(catalogDir, { recursive: true });
  await fs.writeFile(
    indexPath,
    JSON.stringify({
      serverId: snapshot.serverId,
      updatedAt: snapshot.updatedAt,
      configFingerprint: snapshot.configFingerprint,
      serverPurpose: snapshot.serverPurpose,
      items: snapshot.items,
    }, null, 2),
    'utf8',
  );
  await fs.writeFile(
    itemsPath,
    JSON.stringify({
      serverId: snapshot.serverId,
      updatedAt: snapshot.updatedAt,
      descriptors: snapshot.descriptors,
    }, null, 2),
    'utf8',
  );
}

export async function readMcpServerCatalog(
  cacheDir: string,
  serverId: string,
  configFingerprint?: string,
): Promise<McpServerCatalogSnapshot | undefined> {
  const { indexPath, itemsPath } = getMcpCachePaths(cacheDir, serverId);
  try {
    const [indexRaw, itemsRaw] = await Promise.all([
      fs.readFile(indexPath, 'utf8'),
      fs.readFile(itemsPath, 'utf8'),
    ]);
    const indexJson = JSON.parse(indexRaw) as unknown;
    const itemsJson = JSON.parse(itemsRaw) as unknown;
    if (!isRecord(indexJson) || !isRecord(itemsJson)) return undefined;
    // A cache written before fingerprints existed stays usable until the next refresh stamps it.
    const storedFingerprint = typeof indexJson.configFingerprint === 'string' ? indexJson.configFingerprint : undefined;
    if (configFingerprint !== undefined && storedFingerprint !== undefined && storedFingerprint !== configFingerprint) {
      return undefined;
    }
    if (
      (indexJson.serverId !== undefined && indexJson.serverId !== serverId)
      || (itemsJson.serverId !== undefined && itemsJson.serverId !== serverId)
      || !Array.isArray(indexJson.items)
      || !Array.isArray(itemsJson.descriptors)
      || !indexJson.items.every((item) => isCatalogItem(item, serverId))
      || !itemsJson.descriptors.every((item) => isCatalogItem(item, serverId))
    ) {
      return undefined;
    }
    const indexUpdatedAt = typeof indexJson.updatedAt === 'string' ? indexJson.updatedAt : undefined;
    const itemsUpdatedAt = typeof itemsJson.updatedAt === 'string' ? itemsJson.updatedAt : undefined;
    if (indexUpdatedAt && itemsUpdatedAt && indexUpdatedAt !== itemsUpdatedAt) return undefined;
    const catalogItems = indexJson.items as McpCatalogItem[];
    const descriptors = itemsJson.descriptors as McpCapabilityDescriptor[];
    if (!hasMatchingCatalogIds(catalogItems, descriptors)) return undefined;

    return {
      serverId,
      updatedAt: itemsUpdatedAt ?? indexUpdatedAt ?? new Date(0).toISOString(),
      items: catalogItems,
      descriptors,
      ...(storedFingerprint !== undefined ? { configFingerprint: storedFingerprint } : {}),
      ...(typeof indexJson.serverPurpose === 'string' ? { serverPurpose: indexJson.serverPurpose } : {}),
    };
  } catch {
    return undefined;
  }
}
