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

it('reserves sibling full images together even with repeated provider call IDs, then settles the batch', async () => {
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
      { backups: new Map(), visualObservationOwner: owner, visualOutputReservations: reservations, resolveToolResultCapacityTokens: () => 3000 });
    const transcript: KodaXMessage[] = [{ role: 'user', content: 'Recall both.' }];
    const ctx = { agent: createAgent({ name: 'fixture', instructions: '' }), transcript, toolCallId: 'duplicate' };
    const input = { question: 'Check.', views: [{ label: 'original', observationId: receipts[0]!.observationId }] };
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
    provider = 'visual-image-route';
    const allowed = await tool.execute({ question: 'Check.', views: [{ label: 'image', observationId: receipts[0]!.observationId }] }, { agent: createAgent({ name: 'image', instructions: '' }) });
    expect(allowed.isError).not.toBe(true); expect(read).toHaveBeenCalledOnce();
  } finally { clearRuntimeModelProviders(); await rm(directory, { recursive: true, force: true }); }
});
