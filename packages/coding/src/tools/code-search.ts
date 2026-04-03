import fs from 'node:fs/promises';
import { glob as globAsync } from 'glob';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPathOrCwd } from '../runtime-paths.js';
import { readOptionalString } from './internal.js';
import {
  convertProviderSearchResults,
  finalizeRetrievalResult,
} from './retrieval.js';
import type { KodaXRetrievalItem } from './types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_SCANNED_FILES = 300;
const SEARCHABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.yml', '.yaml',
  '.py', '.java', '.go', '.rs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
]);

function isSearchableFile(filePath: string): boolean {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return SEARCHABLE_EXTENSIONS.has(extension);
}

async function collectCandidateFiles(searchRoot: string): Promise<string[]> {
  const stat = await fs.stat(searchRoot);
  if (stat.isFile()) {
    return [searchRoot];
  }

  const files = await globAsync('**/*', {
    cwd: searchRoot,
    nodir: true,
    absolute: true,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.agent/**',
      '**/dist/**',
      '**/coverage/**',
    ],
  });

  return files
    .filter(isSearchableFile)
    .slice(0, MAX_SCANNED_FILES);
}

function clampLimit(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input)
    ? Math.floor(input)
    : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, value));
}

function buildSnippet(line: string, query: string, caseSensitive: boolean): string {
  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matchIndex = haystack.indexOf(needle);
  if (matchIndex < 0) {
    return line.trim();
  }
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(line.length, matchIndex + query.length + 72);
  const snippet = line.slice(start, end).trim();
  return start > 0 ? `...${snippet}` : snippet;
}

export async function toolCodeSearch(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const query = readOptionalString(input, 'query');
    if (!query) {
      throw new Error('query is required.');
    }
    const providerId = readOptionalString(input, 'provider_id');
    if (providerId) {
      if (!ctx.extensionRuntime) {
        throw new Error('provider-backed code_search requires an active extension runtime.');
      }
      const providerResults = await ctx.extensionRuntime.searchCapabilities(providerId, query, {
        limit: clampLimit(input.limit),
      });
      return finalizeRetrievalResult({
        tool: 'code_search',
        query,
        scope: 'workspace',
        trust: 'provider',
        freshness: 'unknown',
        provider: providerId,
        summary: providerResults.length > 0
          ? `Provider ${providerId} returned ${providerResults.length} code search result(s).`
          : `Provider ${providerId} returned no code search results for "${query}".`,
        items: convertProviderSearchResults(providerResults, clampLimit(input.limit)),
        metadata: {
          searchRoot: 'provider-search',
        },
      }, ctx);
    }

    const searchRoot = resolveExecutionPathOrCwd(readOptionalString(input, 'path'), ctx);
    const caseSensitive = input.case_sensitive === true;
    const limit = clampLimit(input.limit);
    const queryNeedle = caseSensitive ? query : query.toLowerCase();
    const files = await collectCandidateFiles(searchRoot);
    const items: KodaXRetrievalItem[] = [];

    for (const filePath of files) {
      if (items.length >= limit) {
        break;
      }

      const pathHaystack = caseSensitive ? filePath : filePath.toLowerCase();
      if (pathHaystack.includes(queryNeedle)) {
        items.push({
          title: filePath,
          locator: filePath,
          snippet: 'Filename/path match',
          score: 1,
          metadata: { matchType: 'path' },
        });
        if (items.length >= limit) {
          break;
        }
      }

      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let index = 0; index < lines.length && items.length < limit; index++) {
        const rawLine = lines[index] ?? '';
        const haystack = caseSensitive ? rawLine : rawLine.toLowerCase();
        if (!haystack.includes(queryNeedle)) {
          continue;
        }
        items.push({
          title: `${filePath}:${index + 1}`,
          locator: `${filePath}:${index + 1}`,
          snippet: buildSnippet(rawLine, query, caseSensitive),
          score: 0.8,
          metadata: { matchType: 'content', line: index + 1 },
        });
      }
    }

    return finalizeRetrievalResult({
      tool: 'code_search',
      query,
      scope: 'workspace',
      trust: 'workspace',
      freshness: 'snapshot',
      summary: items.length > 0
        ? `Found ${items.length} code search matches under ${searchRoot}.`
        : `No code search matches for "${query}" under ${searchRoot}.`,
      items,
      artifacts: items.map((item) => ({
        kind: 'path',
        label: item.title,
        value: item.locator ?? item.title,
      })),
      metadata: {
        searchRoot,
        scannedFiles: files.length,
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] code_search: ${message}`;
  }
}
