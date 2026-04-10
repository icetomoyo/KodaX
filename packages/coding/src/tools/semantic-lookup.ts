import {
  type ModuleCapsule,
  type ProcessCapsule,
  type RepoIntelligenceIndex,
  type RepoSymbolRecord,
} from '../repo-intelligence/query.js';
import { getRepoIntelligenceIndex } from '../repo-intelligence/runtime.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import { finalizeRetrievalResult } from './retrieval.js';
import type { KodaXRetrievalArtifact, KodaXRetrievalItem } from './types.js';

type SemanticLookupKind = 'auto' | 'symbol' | 'module' | 'process';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function clampLimit(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input)
    ? Math.floor(input)
    : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, value));
}

function scoreCandidate(query: string, ...candidates: Array<string | undefined>): number {
  const normalizedQuery = query.trim().toLowerCase();
  let best = 0;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalized = candidate.toLowerCase();
    if (normalized === normalizedQuery) {
      best = Math.max(best, 1);
      continue;
    }
    if (normalized.startsWith(normalizedQuery)) {
      best = Math.max(best, 0.92);
      continue;
    }
    if (normalized.includes(normalizedQuery)) {
      best = Math.max(best, 0.78);
      continue;
    }
    const queryParts = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryParts.length > 0 && queryParts.every((part) => normalized.includes(part))) {
      best = Math.max(best, 0.66);
    }
  }
  return best;
}

function buildSymbolItem(
  symbol: RepoSymbolRecord,
  score: number,
): { item: KodaXRetrievalItem; artifact: KodaXRetrievalArtifact } {
  return {
    item: {
      title: `${symbol.name} (${symbol.kind})`,
      locator: `${symbol.filePath}:${symbol.line}`,
      snippet: symbol.signature,
      score,
      metadata: {
        kind: 'symbol',
        moduleId: symbol.moduleId,
        exported: symbol.exported,
        confidence: symbol.confidence,
      },
    },
    artifact: {
      kind: 'symbol',
      label: symbol.qualifiedName,
      value: `${symbol.filePath}:${symbol.line}`,
    },
  };
}

function buildModuleItem(
  module: ModuleCapsule,
  score: number,
): { item: KodaXRetrievalItem; artifact: KodaXRetrievalArtifact } {
  return {
    item: {
      title: module.label,
      locator: module.root,
      snippet: `Module ${module.moduleId} with ${module.symbolCount} symbols and ${module.sourceFileCount} source files.`,
      score,
      metadata: {
        kind: 'module',
        moduleId: module.moduleId,
        confidence: module.confidence,
      },
    },
    artifact: {
      kind: 'module',
      label: module.label,
      value: module.root,
    },
  };
}

function buildProcessItem(
  process: ProcessCapsule,
  score: number,
): { item: KodaXRetrievalItem; artifact: KodaXRetrievalArtifact } {
  return {
    item: {
      title: process.label,
      locator: process.entryFile,
      snippet: process.summary,
      score,
      metadata: {
        kind: 'process',
        moduleId: process.moduleId,
        confidence: process.confidence,
      },
    },
    artifact: {
      kind: 'process',
      label: process.label,
      value: process.entryFile,
    },
  };
}

function collectSemanticItems(
  index: RepoIntelligenceIndex,
  query: string,
  kind: SemanticLookupKind,
  limit: number,
): { items: KodaXRetrievalItem[]; artifacts: KodaXRetrievalArtifact[] } {
  const matches: Array<{
    score: number;
    item: KodaXRetrievalItem;
    artifact: KodaXRetrievalArtifact;
  }> = [];

  if (kind === 'auto' || kind === 'symbol') {
    for (const symbol of index.symbols) {
      const score = scoreCandidate(query, symbol.name, symbol.qualifiedName, symbol.filePath, symbol.signature);
      if (score <= 0) {
        continue;
      }
      matches.push({ score, ...buildSymbolItem(symbol, score) });
    }
  }

  if (kind === 'auto' || kind === 'module') {
    for (const module of index.modules) {
      const score = scoreCandidate(query, module.label, module.moduleId, module.root, ...module.topSymbols);
      if (score <= 0) {
        continue;
      }
      matches.push({ score, ...buildModuleItem(module, score) });
    }
  }

  if (kind === 'auto' || kind === 'process') {
    for (const process of index.processes) {
      const score = scoreCandidate(query, process.label, process.entryFile, process.entrySymbol, process.summary);
      if (score <= 0) {
        continue;
      }
      matches.push({ score, ...buildProcessItem(process, score) });
    }
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.item.title.localeCompare(right.item.title);
  });

  return {
    items: matches.slice(0, limit).map((entry) => entry.item),
    artifacts: matches.slice(0, limit).map((entry) => entry.artifact),
  };
}

export async function toolSemanticLookup(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const query = readOptionalString(input, 'query');
    if (!query) {
      throw new Error('query is required.');
    }
    const rawKind = readOptionalString(input, 'kind') ?? 'auto';
    const kind = ['auto', 'symbol', 'module', 'process'].includes(rawKind)
      ? rawKind as SemanticLookupKind
      : 'auto';
    const limit = clampLimit(input.limit);
    const index = await getRepoIntelligenceIndex(ctx, {
      targetPath: readOptionalString(input, 'target_path'),
      refresh: input.refresh === true,
    });
    const { items, artifacts } = collectSemanticItems(index, query, kind, limit);

    return finalizeRetrievalResult({
      tool: 'semantic_lookup',
      query,
      scope: 'workspace',
      trust: 'workspace',
      freshness: 'snapshot',
      summary: items.length > 0
        ? `Found ${items.length} semantic match(es) for "${query}" in repository intelligence.`
        : `No semantic matches for "${query}" in repository intelligence.`,
      items,
      artifacts,
      metadata: {
        kind,
        generatedAt: index.generatedAt,
        sourceFileCount: index.sourceFileCount,
        capability: index.capability?.engine ?? 'oss',
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] semantic_lookup: ${message}`;
  }
}
