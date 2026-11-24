/**
 * A2A answers fetch `Request`s. Its own loopback listener and the Host's
 * network port both receive Node HTTP requests, and convert them here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

type RequestInitWithDuplex = RequestInit & { readonly duplex: 'half' };

/** The fetch request for one Node received, its body streamed rather than read up front. */
export function toFetchRequest(request: IncomingMessage): Request {
  const host = request.headers.host ?? '127.0.0.1';
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else for (const item of value ?? []) headers.append(key, item);
  }
  const init: RequestInitWithDuplex = {
    method: request.method,
    headers,
    ...(request.method === 'GET' || request.method === 'HEAD'
      ? {} : { body: Readable.toWeb(request) as ReadableStream<Uint8Array> }),
    duplex: 'half',
  };
  return new Request(`http://${host}${request.url ?? '/'}`, init);
}

/** Writes a fetch response to Node's, and stops a streamed body when the client goes away. */
export function sendFetchResponse(response: ServerResponse, result: Response): void {
  response.statusCode = result.status;
  result.headers.forEach((value, key) => response.setHeader(key, value));
  if (!result.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(result.body);
  const closeBody = (): void => {
    body.destroy();
  };
  response.once('close', closeBody);
  body.once('close', () => response.off('close', closeBody));
  body.once('error', () => {
    if (!response.destroyed) response.destroy();
  });
  body.pipe(response);
}
