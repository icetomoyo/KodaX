/**
 * What the Host serves over plain HTTP on its network port, besides
 * `/healthz`: `POST /pair`, where a browser trades a pairing code for its
 * device cookie, and the static web pages in `server.webRoot`, such as KodaX
 * Space's web UI. Pages and the WebSocket share one origin, so no CORS.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import type { HostDeviceRegistry } from './devices.js';

/** The path a pairing page posts its code to. */
export const HOST_PAIR_PATH = '/pair';
/** The cookie that carries a paired browser's device token. */
export const HOST_DEVICE_COOKIE = 'kodax_device';

/** Chrome caps a cookie at 400 days, so the Host sends it again on every connection. */
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
/** `{"code":"…"}` with a 22-character code, with room to spare. */
const MAX_PAIR_BODY_BYTES = 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export interface HostWebOptions {
  /** The directory of static pages. Without it the Host serves none. */
  readonly webRoot?: string;
  /** The devices, while pairing is on. */
  readonly devices: () => Pick<HostDeviceRegistry, 'redeem'> | undefined;
}

export function createHostWebHandler(options: HostWebOptions): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://host').pathname;
    const answer = request.method === 'POST' && pathname === HOST_PAIR_PATH
      ? pair(request, response, options.devices())
      : (request.method === 'GET' || request.method === 'HEAD') && options.webRoot !== undefined
        ? servePage(request, response, options.webRoot)
        : Promise.resolve(end(response, 404));
    answer.catch((error: unknown) => {
      emitKodaXDiagnostic({
        source: 'host.network', level: 'warn', message: 'The Host could not answer a web request.',
        detail: { path: pathname, error: error instanceof Error ? error.message : String(error) },
      });
      if (!response.headersSent) end(response, 500);
      else response.destroy();
    });
  };
}

/** The `Set-Cookie` value for a device token, `Secure` when the device paired over https. */
export function deviceCookie(token: string, origin: string): string {
  const secure = new URL(origin).protocol === 'https:' ? '; Secure' : '';
  return `${HOST_DEVICE_COOKIE}=${token}; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

/** The device token in a `Cookie` header, if it carries one. */
export function readDeviceCookie(header: string): string | undefined {
  for (const part of header.split(';')) {
    const [name, value] = part.trim().split('=', 2);
    if (name === HOST_DEVICE_COOKIE && value !== undefined && value !== '') return value;
  }
  return undefined;
}

async function pair(request: IncomingMessage, response: ServerResponse, devices: ReturnType<HostWebOptions['devices']>): Promise<void> {
  if (devices === undefined) return end(response, 404);
  const { origin } = request.headers;
  // The device is bound to this origin, so it must be a real one, and the page must be the Host's own.
  const fetchSite = request.headers['sec-fetch-site'];
  if (origin === undefined || !isWebOrigin(origin) || (fetchSite !== undefined && fetchSite !== 'same-origin')) {
    return end(response, 403);
  }
  if (Number(request.headers['content-length'] ?? 0) > MAX_PAIR_BODY_BYTES) return end(response, 413, { connection: 'close' });
  const body = await readSmallBody(request);
  if (body === undefined) return;
  const code = parseCode(body);
  if (code === undefined) return end(response, 400);
  const paired = devices.redeem(code, origin);
  if (paired === undefined) return end(response, 403);
  response.writeHead(200, {
    'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': deviceCookie(paired.token, origin),
  }).end(JSON.stringify({ device: { id: paired.device.id, name: paired.device.name } }));
}

/** The body, or undefined when it outgrew the limit, which drops the connection. */
async function readSmallBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PAIR_BODY_BYTES) {
      request.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { readonly code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

async function servePage(request: IncomingMessage, response: ServerResponse, webRoot: string): Promise<void> {
  const file = await resolvePage(webRoot, new URL(request.url ?? '/', 'http://host').pathname);
  if (file === undefined) return end(response, 404);
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': file.size,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  if (request.method === 'HEAD') return void response.end();
  await pipeline(createReadStream(file.path), response);
}

/**
 * The file a URL path names inside the web root, after links are followed, or
 * undefined. `/` is `index.html`; other directories are not pages.
 */
async function resolvePage(webRoot: string, pathname: string): Promise<{ readonly path: string; readonly size: number } | undefined> {
  let relative: string;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  } catch {
    return undefined;
  }
  try {
    const root = await realpath(webRoot);
    const file = await realpath(path.join(root, relative));
    const inside = path.relative(root, file);
    if (inside === '' || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return undefined;
    const info = await stat(file);
    return info.isFile() ? { path: file, size: info.size } : undefined;
  } catch (error: unknown) {
    // A name that does not exist, or one the file system cannot hold, such as with a NUL in it.
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ERR_INVALID_ARG_VALUE' || code === 'EINVAL';
}

function isWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

function end(response: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, headers).end();
}
