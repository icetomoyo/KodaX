import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import {
  convertProviderSearchResults,
  finalizeRetrievalResult,
  readResponseTextLimited,
  stripHtmlToText,
} from './retrieval.js';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const FETCH_TIMEOUT_MS = 12_000;
const SEARCH_MAX_BYTES = 256 * 1024;
const SEARCH_ENDPOINT_ENV = 'KODAX_WEB_SEARCH_ENDPOINT';
const DEFAULT_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

function clampLimit(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input)
    ? Math.floor(input)
    : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, value));
}

function createFetchTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function buildSearchUrl(query: string): URL {
  const endpoint = process.env[SEARCH_ENDPOINT_ENV] || DEFAULT_SEARCH_ENDPOINT;
  if (endpoint.includes('{query}')) {
    return new URL(endpoint.replace('{query}', encodeURIComponent(query)));
  }

  const url = new URL(endpoint);
  if (!url.searchParams.has('q')) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.set('q', query);
  }
  return url;
}

function resolveSearchHref(rawHref: string, searchUrl: URL): string | undefined {
  try {
    const url = new URL(rawHref, searchUrl);
    const redirected = url.searchParams.get('uddg');
    if (redirected) {
      return decodeURIComponent(redirected);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseSearchResults(html: string, searchUrl: URL, limit: number) {
  const results: Array<{
    title: string;
    locator: string;
    snippet?: string;
  }> = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const href = match[1]?.trim();
    const title = stripHtmlToText(match[2] ?? '').trim();
    if (!href || !title) {
      continue;
    }
    const locator = resolveSearchHref(href, searchUrl);
    if (!locator || seen.has(locator)) {
      continue;
    }
    seen.add(locator);
    results.push({
      title,
      locator,
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

export async function toolWebSearch(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const query = readOptionalString(input, 'query');
    if (!query) {
      throw new Error('query is required.');
    }
    const limit = clampLimit(input.limit);
    const providerId = readOptionalString(input, 'provider_id');

    if (providerId) {
      if (!ctx.extensionRuntime) {
        throw new Error('provider-backed web_search requires an active extension runtime.');
      }
      const providerResults = await ctx.extensionRuntime.searchCapabilities(providerId, query, { limit });
      return finalizeRetrievalResult({
        tool: 'web_search',
        query,
        scope: 'remote',
        trust: 'provider',
        freshness: 'unknown',
        provider: providerId,
        summary: providerResults.length > 0
          ? `Provider ${providerId} returned ${providerResults.length} search result(s).`
          : `Provider ${providerId} returned no search results for "${query}".`,
        items: convertProviderSearchResults(providerResults, limit),
        metadata: {
          endpoint: 'provider-search',
        },
      }, ctx);
    }

    const searchUrl = buildSearchUrl(query);
    const response = await fetch(searchUrl, {
      signal: createFetchTimeoutSignal(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'KodaX/0.7 retrieval',
        accept: 'text/html,text/plain;q=0.8,*/*;q=0.5',
      },
    });
    const { text: html, truncated, bytesRead } = await readResponseTextLimited(response, SEARCH_MAX_BYTES);
    const items = parseSearchResults(html, searchUrl, limit);

    return finalizeRetrievalResult({
      tool: 'web_search',
      query,
      scope: 'remote',
      trust: 'open-world',
      freshness: 'fresh',
      summary: items.length > 0
        ? `Found ${items.length} web search result(s) for "${query}".`
        : `No web search results for "${query}".`,
      items,
      artifacts: items.map((item) => ({
        kind: 'url',
        label: item.title,
        value: item.locator,
      })),
      metadata: {
        endpoint: searchUrl.origin,
        status: response.status,
        bytesRead,
        truncated,
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] web_search: ${message}`;
  }
}
