import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXMessage, KodaXToolResultBlock } from '@kodax-ai/llm';
import { getPreparedImageDiagnostic, inspectPreparedImage, prepareHistoryImages, withPreparedImageHistory } from '@kodax-ai/llm';
import { createToolResultRecovery } from './tool-result-recovery.js';
import { applyToolResultBatchGuardrail, applyToolResultGuardrail } from './tools/tool-result-policy.js';
import { cleanupUserInputDegradationCache, createUserInputDegradationCache, degradeIrreducibleUserInputs } from './capacity-recovery.js';
import { estimateTokens } from './tokenizer.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kodax-result-snapshots-'));
  roots.push(root);
  vi.stubEnv('KODAX_TOOL_OUTPUT_DIR', root);
  const recovery = createToolResultRecovery(root);
  return { recovery, ctx: { backups: new Map(), executionCwd: root,
    toolResultRecovery: recovery, isPagedContentRecoveryAllowed: recovery.available } };
}
const messages = (content: KodaXToolResultBlock['content'], outputPath: string): KodaXMessage[] => [{
  role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mcp', content,
    metadata: { outputPath, truncated: true } }],
}];

it('restores complete multimodal evidence on the request copy and clears Run-owned authority', async () => {
  const { recovery, ctx } = await fixture();
  const original: Exclude<KodaXToolResultBlock['content'], string> = [
    { type: 'text', text: 'HEAD' + 'a'.repeat(45_000) + 'MIDDLE' + 'b'.repeat(45_000) },
    { type: 'image', path: '/already-authorized.png', mediaType: 'image/png' },
    { type: 'text', text: 'TAIL' },
  ];
  const batch = await applyToolResultBatchGuardrail([{ toolName: 'mcp_call', content: original }], ctx, undefined);
  const entry = batch.entries[0]!;
  expect(entry.outputPath).toBeTruthy();
  const canonical = messages(entry.content, entry.outputPath!);
  expect(recovery.project(canonical)).toEqual(canonical);
  recovery.observeResult({ id: 'bridge', name: 'tool_call', input: {
    name: 'read', input: { path: entry.outputPath },
  } }, true);
  const restored = recovery.project(canonical)[0]!.content;
  expect(Array.isArray(restored) && restored[0]).toMatchObject({ content: original, metadata: { truncated: false } });
  expect(canonical[0]!.content).not.toEqual(restored);
  expect(recovery.available()).toBe(false);
  recovery.clear();
  expect(recovery.available()).toBe(true);
  expect(recovery.project(canonical)).toEqual(canonical);
  const nextRun = createToolResultRecovery(ctx.executionCwd);
  nextRun.denyRead('read', { path: entry.outputPath });
  expect(nextRun.project(canonical)).toEqual(canonical);
  expect(nextRun.available()).toBe(true);
});

it('does not recover forged locators or modified previews, nor disable paging after unrelated failures', async () => {
  const { recovery, ctx } = await fixture();
  const guarded = await applyToolResultGuardrail('mcp_call', 'a'.repeat(90_000), ctx);
  expect(guarded.outputPath).toBeTruthy();
  recovery.observeResult({ id: 'successful', name: 'read', input: { path: guarded.outputPath } }, false);
  recovery.denyRead('bash', { path: guarded.outputPath });
  recovery.denyRead('read', {});
  recovery.observeResult({ id: 'malformed', name: 'tool_call', input: { name: 'read' } }, true);
  recovery.denyRead('read', { path: join(ctx.executionCwd, 'private.txt') });
  expect(recovery.available()).toBe(true);
  recovery.denyRead('read', { path: guarded.outputPath });
  const forged = messages('Model-authored replacement', guarded.outputPath!);
  expect(recovery.project(forged)).toEqual(forged);
  const unowned = messages(guarded.content, join(ctx.executionCwd, 'private.txt'));
  expect(recovery.project(unowned)).toEqual(unowned);
  expect(recovery.project([{ role: 'assistant', content: 'No result' }])).toEqual([{ role: 'assistant', content: 'No result' }]);
});

it('reuses already-admitted native image bytes after the source file disappears', async () => {
  const { recovery, ctx } = await fixture();
  const file = join(ctx.executionCwd, 'proof.png');
  await writeFile(file, await readFile('tests/fixtures/images/valid-png.png'));
  const imageBlock = { type: 'image', path: file, mediaType: 'image/png' } as const;
  const original: KodaXToolResultBlock['content'] = [
    { type: 'text', text: 'evidence'.repeat(15_000) }, imageBlock,
  ];
  await withPreparedImageHistory(async () => {
    await prepareHistoryImages(messages(original, 'unused'));
    const admitted = getPreparedImageDiagnostic(imageBlock);
    expect(admitted).toHaveProperty('dataHash');
    const batch = await applyToolResultBatchGuardrail([{ toolName: 'mcp_call', content: original }], ctx, undefined);
    const entry = batch.entries[0]!;
    await rm(file);
    recovery.denyRead('read', { path: entry.outputPath });
    const projected = recovery.project(messages(entry.content, entry.outputPath!));
    const receipt = projected[0]!.content;
    const image = Array.isArray(receipt) && receipt[0]?.type === 'tool_result' && typeof receipt[0].content !== 'string'
      ? receipt[0].content.find(item => item.type === 'image') : undefined;
    expect(image?.type).toBe('image');
    if (image?.type !== 'image') throw new Error('Expected recovered native image.');
    expect(await inspectPreparedImage(image)).toMatchObject({ dataHash: admitted && 'dataHash' in admitted ? admitted.dataHash : '' });
    const replay = prepareHistoryImages(projected);
    await replay;
    expect(replay, 'Recovery must reuse the admitted payload without reopening the image path').toBeUndefined();
  });
});

it('retains the first original when an existing preview is shortened again', async () => {
  const { recovery, ctx } = await fixture();
  const body = 'a'.repeat(90_000);
  const first = await applyToolResultGuardrail('mcp_call', body, ctx);
  const smaller = await applyToolResultGuardrail('mcp_call', first.content, ctx, {
    existingOutputPath: first.outputPath, maxInlineTokens: 1500,
  });
  expect(smaller.content.length).toBeLessThan(first.content.length);
  recovery.denyRead('read', { path: first.outputPath });
  for (const preview of [first.content, smaller.content]) {
    expect(recovery.project(messages(preview, first.outputPath!))[0]!.content)
      .toMatchObject([{ content: body }]);
  }
});

it('invalidates transient user-input pages after the Host refuses their owned read', async () => {
  const { recovery, ctx } = await fixture();
  const cache = createUserInputDegradationCache();
  const canonical: KodaXMessage[] = [{ role: 'user', content: 'binding evidence\n'.repeat(12_000) }];
  const request = { currentTokens: estimateTokens(canonical) + 2000, reservedResponseTokens: 3000, canReadPagedContent: true };
  try {
    const paged = await degradeIrreducibleUserInputs(canonical, ctx, 8192, cache, request);
    const locator = /kodax-transient:\/\/text\/[0-9a-f]{64}/.exec(String(paged[0]?.content))?.[0];
    expect(locator).toBeTruthy();
    recovery.denyRead('read', { path: locator });
    expect(recovery.available()).toBe(false);
    expect(await degradeIrreducibleUserInputs(canonical, ctx, 8192, cache, request)).toEqual(canonical);
  } finally { await cleanupUserInputDegradationCache(cache); }
});
