import type { CapabilityResult } from '../extensions/types.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import {
  convertCapabilityReadResult,
  extractHtmlTitle,
  finalizeRetrievalResult,
  readResponseTextLimited,
  stripHtmlToText,
} from './retrieval.js';

const FETCH_TIMEOUT_MS = 12_000;
const FETCH_MAX_BYTES = 512 * 1024;

function createFetchTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readCapabilityContent(result: CapabilityResult): string | undefined {
  if (typeof result.content === 'string' && result.content.trim().length > 0) {
    return result.content.trim();
  }
  return undefined;
}

export async function toolWebFetch(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const providerId = readOptionalString(input, 'provider_id');
    const capabilityId = readOptionalString(input, 'capability_id');

    if (providerId && capabilityId) {
      if (!ctx.extensionRuntime) {
        throw new Error('provider-backed web_fetch requires an active extension runtime.');
      }
      const {
        provider_id: _providerId,
        capability_id: _capabilityId,
        ...providerInput
      } = input;
      const providerResult = await ctx.extensionRuntime.readCapability(
        providerId,
        capabilityId,
        providerInput,
      );
      return finalizeRetrievalResult(
        convertCapabilityReadResult(
          'web_fetch',
          providerId,
          capabilityId,
          providerResult,
          `Fetched provider capability ${capabilityId} from ${providerId}.`,
        ),
        ctx,
      );
    }

    const url = readOptionalString(input, 'url');
    if (!url) {
      throw new Error('url is required unless provider_id + capability_id are supplied.');
    }
    if (!isSupportedUrl(url)) {
      throw new Error('url must use http or https.');
    }

    const response = await fetch(url, {
      method: 'GET',
      signal: createFetchTimeoutSignal(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'KodaX/0.7 retrieval',
        accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const { text: body, truncated, bytesRead } = await readResponseTextLimited(response, FETCH_MAX_BYTES);
    const isHtml = contentType.includes('text/html');
    const title = isHtml ? extractHtmlTitle(body) : undefined;
    const content = isHtml ? stripHtmlToText(body) : body.trim();
    const finalUrl = response.url || url;

    return finalizeRetrievalResult({
      tool: 'web_fetch',
      scope: 'remote',
      trust: 'open-world',
      freshness: 'fresh',
      summary: response.ok
        ? `Fetched ${finalUrl} (${response.status}).`
        : `Fetched ${finalUrl} with non-success status ${response.status}.`,
      content: readCapabilityContent({ kind: 'resource', content }) ?? content,
      items: title
        ? [{
          title,
          locator: finalUrl,
          snippet: content.slice(0, 240).trim(),
          metadata: { status: response.status, contentType },
        }]
        : [],
      artifacts: [{
        kind: 'url',
        label: title ?? finalUrl,
        value: finalUrl,
      }],
      metadata: {
        status: response.status,
        contentType,
        title,
        bytesRead,
        truncated,
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] web_fetch: ${message}`;
  }
}
