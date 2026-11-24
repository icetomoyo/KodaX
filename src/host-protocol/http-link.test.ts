import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostLinkClose } from './close.js';
import { dialHostHttp } from './http-link.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

/** A stand-in Host: `stream` writes the event stream as it likes; posted bodies are recorded. */
async function fakeHost(stream: (response: ServerResponse) => void) {
  const posts: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/v2/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      stream(response);
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      posts.push(body);
      // Slow to answer, so frames sent meanwhile queue up behind this one.
      setTimeout(() => response.writeHead(204).end(), 50);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { posts, options: { eventsUrl: `${base}/v2/events`, messagesUrl: `${base}/v2/messages`, openTimeoutMs: 1_000 } };
}

function recorder() {
  const frames: string[] = [];
  const ends: Array<HostLinkClose | undefined> = [];
  return { frames, ends, events: { frame: (text: string) => frames.push(text), end: (close?: HostLinkClose) => ends.push(close) } };
}

describe('the HTTP link to a Host', () => {
  it('reads events split anywhere across chunks, skips heartbeats, and joins multi-line data', async () => {
    const host = await fakeHost((response) => {
      const chunks = ['event: open\r', '\ndata: {"stream":"s1"}\r\n\r\n', 'data: a', 'bc\r\n\r\n', ':\n\n', 'data: one\ndata: two\n\n'];
      for (const chunk of chunks) response.write(chunk);
    });
    const seen = recorder();
    await dialHostHttp(host.options)(seen.events);
    await vi.waitFor(() => expect(seen.frames).toEqual(['abc', 'one\ntwo']));
  });

  it('sends frames in order, those queued behind a POST together, each under the stream name', async () => {
    const host = await fakeHost(response => response.write('event: open\ndata: {"stream":"s1"}\n\n'));
    const link = await dialHostHttp(host.options)(recorder().events);
    for (const frame of ['{"a":1}', '{"b":2}', '{"c":3}']) link.send(frame);
    await vi.waitFor(() => expect(host.posts).toEqual(['s1\n{"a":1}', 's1\n{"b":2}\n{"c":3}']));
  });

  it('ends with the close event the Host sent, and as lost when the stream just stops', async () => {
    const closing = await fakeHost((response) => {
      response.write('event: open\ndata: {"stream":"s1"}\n\n');
      setTimeout(() => response.end('event: close\ndata: {"code":4429,"reason":"overloaded"}\n\n'), 20);
    });
    const told = recorder();
    await dialHostHttp(closing.options)(told.events);
    await vi.waitFor(() => expect(told.ends).toEqual([{ code: 4429, reason: 'overloaded' }]));

    const dropping = await fakeHost((response) => {
      response.write('event: open\ndata: {"stream":"s1"}\n\n');
      setTimeout(() => response.destroy(), 20);
    });
    const lost = recorder();
    await dialHostHttp(dropping.options)(lost.events);
    await vi.waitFor(() => expect(lost.ends).toEqual([{ code: 1006, reason: '' }]));
  });

  it('fails to dial when the stream does not open in time, as behind a proxy that holds it back', async () => {
    const host = await fakeHost(response => response.write(':\n\n'));
    await expect(dialHostHttp(host.options)(recorder().events)).rejects.toThrow(/did not open the HTTP stream/);
  });
});
