import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as requestHttp, type IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import { constants as zlib, createBrotliDecompress, createUnzip } from 'node:zlib';

import { isCloudMetadataAddress, isPrivateNetworkAddress } from '@kodax-ai/agent';

// Same limit as fetch().
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Sockets connected straight to the server. Behind an environment proxy the peer is the proxy. */
const directSockets = new WeakSet<Socket>();

export interface GuardedHttpResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  /** Decoded body stream. Status and headers live on this result, not on the Response. */
  readonly body: Response;
}

function metadataRefusal(address: string, url: URL): string {
  return `refused ${url.host} because it resolves to the cloud metadata address ${address}. `
    + 'Metadata endpoints can hand out cloud credentials.';
}

/** Refusal text for an address web_fetch must not reach, or undefined when allowed. */
function refusalFor(address: string, url: URL, previousHopPublic: boolean): string | undefined {
  if (isCloudMetadataAddress(address)) return metadataRefusal(address, url);
  if (previousHopPublic && isPrivateNetworkAddress(address)) {
    return `refused a redirect from a public or proxied site to ${url.host} on the private network (${address}). `
      + 'Public pages may not steer web_fetch into the local network.';
  }
  return undefined;
}

/** Validates every resolved address at connect time, so DNS rebinding cannot swap targets. */
function guardedLookup(url: URL, previousHopPublic: boolean, onLookup: () => void): LookupFunction {
  return ((hostname: string, options: object, callback: (...args: unknown[]) => void) => {
    onLookup();
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error);
      const refusal = addresses.map((entry) => refusalFor(entry.address, url, previousHopPublic)).find(Boolean);
      if (refusal) return callback(new Error(refusal));
      if ('all' in options && options.all) return callback(null, addresses);
      const [first] = addresses;
      return first ? callback(null, first.address, first.family) : callback(new Error(`${hostname} did not resolve.`));
    });
  }) as LookupFunction;
}

function literalAddress(url: URL): string | undefined {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return isIP(host) ? host : undefined;
}

function assertLiteralHostAllowed(url: URL, previousHopPublic: boolean): void {
  // Node skips lookup() for address literals.
  const literal = literalAddress(url);
  const refusal = literal === undefined ? undefined : refusalFor(literal, url, previousHopPublic);
  if (refusal) throw new Error(refusal);
}

/**
 * The server address a hop reached, or undefined when an environment proxy
 * resolved the hostname. Node calls lookup() only for direct connections.
 */
function reachedAddress(url: URL, socket: Socket, lookedUp: boolean): string | undefined {
  if (lookedUp) directSockets.add(socket);
  return literalAddress(url) ?? (directSockets.has(socket) ? socket.remoteAddress : undefined);
}

interface Hop {
  readonly incoming: IncomingMessage;
  readonly lookedUp: boolean;
}

function requestHop(url: URL, previousHopPublic: boolean, signal: AbortSignal, headers: Record<string, string>): Promise<Hop> {
  return new Promise((resolve, reject) => {
    let lookedUp = false;
    const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, {
      method: 'GET',
      headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' },
      lookup: guardedLookup(url, previousHopPublic, () => { lookedUp = true; }),
      signal,
    }, (incoming) => resolve({ incoming, lookedUp }));
    // A pooled keep-alive socket skips lookup(), so check its server before the request is sent.
    request.once('socket', (socket: Socket) => {
      const refusal = request.reusedSocket && directSockets.has(socket)
        ? refusalFor(socket.remoteAddress ?? '', url, previousHopPublic)
        : undefined;
      if (refusal) request.destroy(new Error(refusal));
    });
    request.once('error', reject);
    request.end();
  });
}

function decodedBody(incoming: IncomingMessage): Readable {
  const encoding = incoming.headers['content-encoding']?.trim().toLowerCase();
  // Lenient flushing accepts truncated streams, as fetch() does.
  const decoder = encoding === 'br'
    ? createBrotliDecompress({ flush: zlib.BROTLI_OPERATION_FLUSH, finishFlush: zlib.BROTLI_OPERATION_FLUSH })
    : encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'deflate'
      ? createUnzip({ flush: zlib.Z_SYNC_FLUSH, finishFlush: zlib.Z_SYNC_FLUSH })
      : undefined;
  // pipeline() destroys the returned decoder on failure, so the reader still sees the error.
  return decoder ? pipeline(incoming, decoder, () => undefined) : incoming;
}

/**
 * GET with redirects that never reaches cloud metadata and never lets a public
 * hop redirect into the private network. Direct private targets stay allowed.
 * Behind an environment proxy (NODE_USE_ENV_PROXY) the proxy resolves
 * hostnames, so only address literals and the proxy's own address are checked,
 * and a hop the proxy resolved counts as public.
 */
export async function guardedHttpGet(
  target: string,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<GuardedHttpResponse> {
  let url = new URL(target);
  let previousHopPublic = false;
  for (let redirects = 0; ; redirects += 1) {
    assertLiteralHostAllowed(url, previousHopPublic);
    const { incoming, lookedUp } = await requestHop(url, previousHopPublic, signal, headers);
    const peer = incoming.socket.remoteAddress ?? '';
    // Behind a proxy, or on a socket another module pooled, the peer was never looked up.
    if (isCloudMetadataAddress(peer)) {
      incoming.destroy();
      throw new Error(metadataRefusal(peer, url));
    }
    const address = reachedAddress(url, incoming.socket, lookedUp);
    const status = incoming.statusCode ?? 0;
    const location = incoming.headers.location;
    if (!REDIRECT_STATUSES.has(status) || !location) {
      const body = new Response(Readable.toWeb(decodedBody(incoming)) as ReadableStream<Uint8Array>);
      return { url: url.href, status, contentType: incoming.headers['content-type'], body };
    }
    incoming.resume();
    if (redirects >= MAX_REDIRECTS) throw new Error(`stopped after ${MAX_REDIRECTS} redirects.`);
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new Error(`redirect to unsupported protocol ${next.protocol}`);
    }
    // The proxy hid this hop's address, so it may not steer web_fetch into the private network either.
    previousHopPublic = address === undefined || !isPrivateNetworkAddress(address);
    url = next;
  }
}
