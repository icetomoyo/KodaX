import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createKodaXArtifactHostPort, type ArtifactHostClient, type ArtifactHostItem } from './host-port.js';
import { createArtifactSdk } from './index.js';

type Variant = 'inline' | 'saved-output' | 'foreign-run' | 'two-items' | 'missing' | 'ambiguous' | 'other-hash' | 'corrupt' | 'failed';

async function fakeHost(variant: Variant) {
 const bytes = await fs.readFile('tests/fixtures/images/valid-png.png'), sha256 = createHash('sha256').update(bytes).digest('hex');
 const raster = { path: '/host/image.png', sha256, mediaType: 'image/png' as const, width: 160, height: 46, locator: { kind: 'static' as const } };
 // What the item shows: the metadata line, then the text `read` gave with the image.
 const payload = JSON.stringify({ protocol: 'kodax-artifact/1', operation: 'readEvidence', status: 'ready', diagnostics: [], imageRef: raster })
  + '\n[Read image: /host/image.png (1 KB, image/png)]';
 const delivered = Buffer.from(bytes); if (variant === 'corrupt') delivered[delivered.length - 1] ^= 1;
 const attachment = { kind: 'image', blobId: 'b-1', mediaType: 'image/png' };
 const tool = (runId: string, id = 'tool-item'): ArtifactHostItem => ({ id, type: 'tool', runId,
  text: variant === 'saved-output' ? payload.slice(-20) : payload, ...(variant === 'saved-output' ? { textTotal: 20 } : {}),
  tool: { name: 'artifact_read_evidence', status: 'success', ...(variant === 'saved-output' ? { outputSaved: true } : {}) },
  attachments: variant === 'missing' ? [] : variant === 'ambiguous' ? [attachment, { ...attachment, blobId: 'b-2' }] : [attachment] });
 const items = [{ id: 'user', type: 'user', text: 'typed', runId: 'run' }, tool(variant === 'foreign-run' ? 'other-run' : 'run'),
  ...(variant === 'two-items' ? [tool('run', 'tool-item-2')] : [])];
 const started: Record<string, unknown>[] = [];
 const close = vi.fn();
 const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
  if (method === 'run.startTool') { started.push(params); return { run: { id: 'run', sessionId: 's' } }; }
  if (method === 'run.wait') return { run: { id: 'run', sessionId: 's', outcome: variant === 'failed'
   ? { status: 'failed', code: 'tool_failed', message: 'no renderer' } : { status: 'completed', code: 'completed' } } };
  if (method === 'item.read') { expect(params).toMatchObject({ sessionId: 's', itemId: 'tool-item', part: 'output' });
   return params.cursor === undefined ? { text: payload.slice(0, 50), total: payload.length, nextCursor: 'c1' } : { text: payload.slice(50), total: payload.length }; }
  if (method === 'blob.read') { expect(params).toMatchObject({ sessionId: 's', blobId: 'b-1' });
   const offset = params.cursor === undefined ? 0 : Number(params.cursor), end = Math.min(offset + 95, bytes.length);
   return { data: delivered.subarray(offset, end).toString('base64'), mediaType: 'image/png', byteLength: bytes.length,
    sha256: variant === 'other-hash' ? '0'.repeat(64) : sha256, ...(end < bytes.length ? { nextCursor: String(end) } : {}) }; }
  throw new Error('unexpected ' + method);
 });
 const client = { call, observeSession: async (_id: string, observer: { onView(view: { items: readonly ArtifactHostItem[] }): void }) => {
  observer.onView({ items }); return { close }; } } as unknown as ArtifactHostClient;
 const request = () => createArtifactSdk(createKodaXArtifactHostPort(client, 's'))
  .readEvidence({ source: { kind: 'surface', target: 'tab', observedAt: '2026-10-13T00:00:00Z' }, raster });
 const calls = (method: string) => call.mock.calls.filter(([name]) => name === method).length;
 return { bytes, request, calls, started, close };
}

it.each(['inline', 'saved-output'] as const)('reads the image by the blob its tool item names: %s', async variant => {
 const host = await fakeHost(variant);
 const result = await host.request();
 expect(Buffer.from(result.image!.dataBase64, 'base64')).toEqual(host.bytes);
 expect(host.started).toEqual([expect.objectContaining({ sessionId: 's', tool: 'artifact_read_evidence', text: expect.stringMatching(/\S/) })]);
 expect(host.started[0]!.requestId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
 expect(host.calls('blob.read')).toBe(2); expect(host.close).toHaveBeenCalledOnce();
});

it.each(['foreign-run', 'two-items', 'missing', 'ambiguous', 'other-hash', 'corrupt', 'failed'] as const)
('refuses an image it cannot tie to its own Run: %s', async variant => {
 const host = await fakeHost(variant);
 await expect(host.request()).rejects.toThrow();
 expect(host.calls('run.startTool')).toBe(1);
 expect(host.calls('blob.read')).toBe(variant === 'corrupt' ? 2 : variant === 'other-hash' ? 1 : 0);
});

it('stops only its own Run when the caller gives up, and joins a Stop that failed', async () => {
 const controller = new AbortController();
 const call = vi.fn(async (method: string): Promise<unknown> => {
  if (method === 'run.startTool') return { run: { id: 'owned', sessionId: 's' } };
  if (method === 'run.wait') { if (!controller.signal.aborted) { controller.abort(); return { run: { id: 'owned', sessionId: 's' } }; }
   return { run: { id: 'owned', sessionId: 's', outcome: { status: 'cancelled', code: 'cancelled' } } }; }
  if (method === 'run.stop') throw new Error('Stop failed');
  throw new Error('unexpected ' + method);
 });
 const client = { call, observeSession: vi.fn() } as unknown as ArtifactHostClient;
 await expect(createArtifactSdk(createKodaXArtifactHostPort(client, 's')).prepare(controller.signal)).rejects.toMatchObject({
  errors: [expect.objectContaining({ message: expect.stringMatching(/cancelled/) }), expect.objectContaining({ message: 'Stop failed' })] });
 expect(call.mock.calls.filter(([name]) => name === 'run.stop')).toEqual([['run.stop', { requestId: expect.any(String), runId: 'owned' }]]);
 expect(call.mock.calls.filter(([name]) => name === 'run.wait')).toHaveLength(2);
});

it('starts nothing again when the Host refuses the start', async () => {
 const call = vi.fn(async () => { throw new Error('conflict: the Session is running'); });
 const client = { call, observeSession: vi.fn() } as unknown as ArtifactHostClient;
 await expect(createArtifactSdk(createKodaXArtifactHostPort(client, 's')).prepare()).rejects.toThrow(/conflict/);
 expect(call).toHaveBeenCalledOnce();
});
