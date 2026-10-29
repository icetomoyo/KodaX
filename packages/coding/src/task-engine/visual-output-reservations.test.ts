import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it, vi } from 'vitest';
import { createAgent } from '@kodax-ai/agent';
import { createFileVisualObservationOwner, type VisualObservation } from '@kodax-ai/agent/media';
import type { KodaXMessage } from '@kodax-ai/llm';
import { clearRuntimeModelProviders, createCustomProvider, registerModelProvider } from '@kodax-ai/llm';
import { VISUAL_CODING_TOOLS } from '../tools/visual.js';
import { wrapCodingToolAsRunnable } from './_internal/managed-task/tool-wrappers.js';
import { createVisualOutputReservations } from './visual-output-reservations.js';

it.each([1, 2])('reserves sibling %i-view calls together even with repeated provider call IDs, then settles the batch', async count => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-budget-'));
  const receipts: VisualObservation[] = [];
  const owner = createFileVisualObservationOwner({ ownerId: 'session', directory, list: async () => receipts });
  try {
    receipts.push(await owner.pin(await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png'),
      { sourceKey: 'user', originEntryId: 'entry', mediaType: 'image/png' }));
    const read = vi.spyOn(owner, 'read');
    const reservations = createVisualOutputReservations();
    const definition = VISUAL_CODING_TOOLS.find(tool => tool.name === 'visual_inspect')!;
    const tool = wrapCodingToolAsRunnable(definition, definition.handler as (input: Record<string, unknown>, ctx: import('../types.js').KodaXToolExecutionContext) => Promise<import('../tools/types.js').ToolResult>,
      { backups: new Map(), visualObservationOwner: owner, visualOutputReservations: reservations, resolveToolResultCapacityTokens: () => count === 1 ? 3000 : 5500 });
    const transcript: KodaXMessage[] = [{ role: 'user', content: 'Recall both.' }];
    const ctx = { agent: createAgent({ name: 'fixture', instructions: '' }), transcript, toolCallId: 'duplicate' };
    const input = { question: 'Check.', views: Array.from({ length: count }, (_, index) => ({ label: `original ${index}`, observationId: receipts[0]!.observationId })) };
    const results = await Promise.all([tool.execute(input, ctx), tool.execute(input, ctx)]);
    expect(results.filter(result => result.isError)).toHaveLength(1);
    expect(JSON.stringify(results)).toContain('capacity unavailable');
    expect(read).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1);
    reservations.settle(transcript);
    expect((await tool.execute(input, ctx)).isError).not.toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('reports an unavailable image route before reading or reserving a visual result', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-text-route-'));
  const receipts: VisualObservation[] = [];
  const owner = createFileVisualObservationOwner({ ownerId: 'session', directory, list: async () => receipts });
  const read = vi.spyOn(owner, 'read'); const reserve = vi.fn(() => ({ cancel() {} }));
  registerModelProvider('visual-text-only', () => createCustomProvider({ name: 'visual-text-only', protocol: 'openai',
    model: 'text', baseUrl: 'https://unused.invalid', apiKeyEnv: 'UNUSED_VISUAL_KEY' }));
  registerModelProvider('visual-image-route', () => createCustomProvider({ name: 'visual-image-route', protocol: 'openai',
    model: 'image', baseUrl: 'https://unused.invalid', apiKeyEnv: 'UNUSED_VISUAL_KEY', imageInput: true }));
  let provider = 'visual-text-only';
  try {
    const definition = VISUAL_CODING_TOOLS.find(tool => tool.name === 'visual_inspect')!;
    const tool = wrapCodingToolAsRunnable(definition, definition.handler as import('../tools/types.js').ToolHandlerSync,
      { backups: new Map(), visualObservationOwner: owner, reserveVisualOutput: reserve, parentAgentConfig: { provider: 'visual-text-only' },
        visualModelSelection: () => ({ provider }) });
    const result = await tool.execute({ question: 'Check.', views: [{ label: 'image', observationId: 'unknown' }] }, { agent: createAgent({ name: 'text', instructions: '' }) });
    expect(result.content).toContain('image route unavailable');
    expect(read).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    receipts.push(await owner.pin(await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png'),
      { sourceKey: 'user', originEntryId: 'entry', mediaType: 'image/png' }));
    const pixelDefinition = VISUAL_CODING_TOOLS.find(tool => tool.name === 'visual_read_pixels')!;
    const pixels = wrapCodingToolAsRunnable(pixelDefinition, pixelDefinition.handler as import('../tools/types.js').ToolHandlerSync,
      { backups: new Map(), visualObservationOwner: owner, reserveVisualOutput: reserve, parentAgentConfig: { provider: 'visual-text-only' } });
    const numeric = await pixels.execute({ question: 'Read exact color.', views: [{ label: 'text only', observationId: receipts[0]!.observationId,
      region: { x: 0, y: 0, width: 1, height: 1 }, rows: 1, columns: 1 }] }, { agent: createAgent({ name: 'text', instructions: '' }) });
    expect(numeric.isError).not.toBe(true);
    expect(JSON.parse(numeric.content as string)).toMatchObject({ status: 'complete', palette: [[255, 0, 0, 255]] });
    expect(read).toHaveBeenCalledOnce();
    provider = 'visual-image-route';
    const allowed = await tool.execute({ question: 'Check.', views: [{ label: 'image', observationId: receipts[0]!.observationId }] }, { agent: createAgent({ name: 'image', instructions: '' }) });
    expect(allowed.isError).not.toBe(true); expect(read).toHaveBeenCalledTimes(2);
  } finally { clearRuntimeModelProviders(); await rm(directory, { recursive: true, force: true }); }
});

it('keeps the existing batch attention bound across visual siblings even in a large context', () => {
  const reservations = createVisualOutputReservations(); const transcript: KodaXMessage[] = [];
  const first = reservations.reserve(transcript, 1_000_000, 12_000);
  reservations.reserve(transcript, 1_000_000, 12_000); reservations.reserve(transcript, 1_000_000, 12_000);
  expect(() => reservations.reserve(transcript, 1_000_000, 12_000)).toThrow('capacity unavailable');
  first.cancel(); first.cancel();
  expect(() => reservations.reserve(transcript, 1_000_000, 12_000)).not.toThrow();
  expect(() => reservations.reserve(transcript, 1_000_000, 12_000)).toThrow('capacity unavailable');
  reservations.settle(transcript);
  expect(() => reservations.reserve(transcript, 1_000_000, 12_000)).not.toThrow();
});

it('rejects a pixel table before decoding if the final result policy would spill it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-pixel-output-bound-'));
  const receipts: VisualObservation[] = [];
  const owner = createFileVisualObservationOwner({ ownerId: 'session', directory, list: async () => receipts });
  try {
    const image = new Jimp({ width: 2048, height: 1 });
    for (let x = 0; x < 2048; x++) image.bitmap.data.set([x % 256, Math.floor(x / 256), 0, 255], x * 4);
    const observation = await owner.pin(await image.getBuffer('image/png'), { sourceKey: 'many-colors', originEntryId: 'entry', mediaType: 'image/png' });
    receipts.push(observation);
    const read = vi.spyOn(owner, 'read'); const reserve = vi.fn(() => ({ cancel() {} }));
    const definition = VISUAL_CODING_TOOLS.find(tool => tool.name === 'visual_read_pixels')!;
    const tool = wrapCodingToolAsRunnable(definition, definition.handler as import('../tools/types.js').ToolHandlerSync,
      { backups: new Map(), visualObservationOwner: owner, reserveVisualOutput: reserve });
    const result = await tool.execute({ question: 'Sample all colors.', views: [{ label: 'too large', observationId: observation.observationId,
      region: { x: 0, y: 0, width: 2048, height: 1 }, rows: 1, columns: 2048 }] }, { agent: createAgent({ name: 'fixture', instructions: '' }) });
    expect(result.isError).toBe(true); expect(result.content).toContain('result admission');
    expect(read).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
