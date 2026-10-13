import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { KodaXProductClient, ClientRunOutcome, ClientToolInvocationInput, ClientViewItem } from '@kodax-ai/kodax/client';
import { createKodaXArtifactPort } from './client.js';
import { createArtifactSdk } from './index.js';

it('reads binary chunks only from the exact Host invocation and ignores lastText', async () => {
 const bytes = await fs.readFile('tests/fixtures/images/valid-png.png'), sha256 = createHash('sha256').update(bytes).digest('hex');
 const raster = { path: '/host/image.png', sha256, mediaType: 'image/png' as const, width: 160, height: 46, locator: { kind: 'static' as const } };
 let invocation: ClientToolInvocationInput | undefined;
 const item: ClientViewItem = { id: 'owned-tool', type: 'tool', text: '', sourceRunId: 'run', tool: { callId: 'call', name: 'artifact_read_evidence', status: 'success' }, attachments: [{ kind: 'image', path: raster.path }] };
 const close = vi.fn(), readItem = vi.fn(async (_session: string, _item: string, options?: { attachmentOffset?: number }) => {
  const offset = options?.attachmentOffset ?? 0, end = Math.min(offset + 95, bytes.length);
  return { id: item.id, text: '', offset: 0, totalLength: 0, image: { mediaType: 'image/png' as const, sha256, width: 160, height: 46,
   dataBase64: bytes.subarray(offset, end).toString('base64'), offset, totalLength: bytes.length, ...(end < bytes.length ? { nextOffset: end } : {}) } };
 });
 const client = { runs: { startTool: vi.fn(async (input: ClientToolInvocationInput) => { invocation = input; return { runId: 'run', sessionId: 's' }; }),
  await: async (): Promise<ClientRunOutcome> => ({ runId: 'run', sessionId: 's', phase: 'completed', result: { success: true, lastText: 'not a transport', messages: [
   { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: invocation!.name, input: invocation!.input }] },
   { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: JSON.stringify({ protocol: 'kodax-artifact/1', operation: 'readEvidence', status: 'ready', diagnostics: [], imageRef: raster }) }, { type: 'image', path: raster.path }] }] },
  ] } }), stop: vi.fn() }, sessions: { observe: async (_id: string, listener: (view: { items: readonly ClientViewItem[] }) => void) => { listener({ items: [item] }); return { close }; }, readItem } } as unknown as Pick<KodaXProductClient, 'runs' | 'sessions'>;
 const sdk = createArtifactSdk(createKodaXArtifactPort(client, 's'));
 const result = await sdk.readEvidence({ source: { kind: 'surface', target: 'tab', observedAt: '2026-10-13T00:00:00Z' }, raster });
 expect(Buffer.from(result.image!.dataBase64, 'base64')).toEqual(bytes);
 expect(readItem).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce(); expect(client.runs.startTool).toHaveBeenCalledOnce();
});
it('does not replay busy/disconnected/unknown Runs and stops only its own admitted Run', async () => {
 const controller = new AbortController(), stop = vi.fn(async () => ({ runId: 'owned', sessionId: 's', accepted: true, state: 'requested', outcome: 'unknown', phase: 'stopping' }));
 const startTool = vi.fn(async () => ({ runId: 'owned', sessionId: 's' }));
 const client = { runs: { startTool, stop, await: async () => { controller.abort(); return { runId: 'owned', sessionId: 's', phase: 'unknown' }; } } } as unknown as Pick<KodaXProductClient, 'runs' | 'sessions'>;
 await expect(createArtifactSdk(createKodaXArtifactPort(client, 's')).prepare(controller.signal)).rejects.toThrow(/unknown/);
 expect(startTool).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledExactlyOnceWith('owned');
 startTool.mockRejectedValue(new Error('busy/disconnected'));
 await expect(createArtifactSdk(createKodaXArtifactPort(client, 's')).prepare()).rejects.toThrow(/busy/);
 expect(startTool).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledOnce();
});
it('joins failed Stop even when the Run wait itself loses the connection', async () => {
 const controller = new AbortController(), stopped = vi.fn();
 const client = { runs: { startTool: async () => ({ runId: 'owned', sessionId: 's' }),
  await: async () => { controller.abort(); throw new Error('transport lost'); },
  stop: async () => { await new Promise(resolve => setTimeout(resolve, 10)); stopped(); throw new Error('Stop failed'); } } } as unknown as Pick<KodaXProductClient, 'runs' | 'sessions'>;
 await expect(createArtifactSdk(createKodaXArtifactPort(client, 's')).prepare(controller.signal)).rejects.toThrow(/Stop/);
 expect(stopped).toHaveBeenCalledOnce();
});
