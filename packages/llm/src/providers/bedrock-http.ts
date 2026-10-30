import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { observeProviderFetch } from '../provider-request-observation.js';

interface BedrockRequest {
  protocol: string; hostname: string; port?: number; path: string; method: string;
  headers: Record<string, string>; body?: unknown; query?: Record<string, string | string[] | null | undefined>;
}
/** Let the official SDK sign/serialize/decode, while retaining the existing physical fetch boundary. */
export function bedrockHttpHandler(signal?: AbortSignal) {
  let body: Readable | undefined;
  return {
    metadata: { handlerProtocol: 'h1' },
    destroy() { body?.destroy(); body = undefined; },
    async handle(request: BedrockRequest) {
      signal?.throwIfAborted();
      const url = new URL(`${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}`);
      for (const [key, value] of Object.entries(request.query ?? {})) {
        for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined && entry !== null) url.searchParams.append(key, entry);
      }
      if (request.body !== undefined && typeof request.body !== 'string' && !(request.body instanceof Uint8Array)) throw new Error('Unexpected Bedrock request body.');
      const response = await observeProviderFetch(globalThis.fetch)(url.href, { method: request.method, headers: request.headers,
        body: request.body as string | Uint8Array | undefined, signal, redirect: 'error' });
      body = response.body ? Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>) : Readable.from([]);
      return { response: { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()),
        body } };
    },
  };
}
