import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextCapacityError, estimateTokens } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import type { KodaXToolResultBlock } from '@kodax-ai/llm';
import { recoverContextHistory } from './history-capacity-recovery.js';
import { TOOL_OUTPUT_DIR_ENV } from './tools/truncate.js';
import { createUserInputDegradationCache, degradeIrreducibleUserInputs, cleanupUserInputDegradationCache } from './capacity-recovery.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-history-recovery-'));
  vi.stubEnv(TOOL_OUTPUT_DIR_ENV, directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

it('recovers transient artifact writes without publishing a replacement early', async () => {
  const originalWrite = fs.writeFile;
  const failure = Object.assign(new Error('I/O unavailable'), { code: 'EIO' });
  const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure).mockImplementation(originalWrite);
  const messages = toolPair();
  const before = structuredClone(messages);
  const persist = vi.fn();
  const result = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages, persist });
  expect(write).toHaveBeenCalledTimes(2);
  expect(result.changed).toBe(true);
  expect(messages).toEqual(before);
  expect(persist).toHaveBeenCalledOnce();
});

it('retries artifact metadata I/O but Stop interrupts a blocked artifact write', async () => {
  const first = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: toolPair() });
  vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
  const second = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: first.messages });
  expect(second.changed).toBe(true);
  const controller = new AbortController();
  const persist = vi.fn();
  vi.spyOn(fs, 'writeFile').mockImplementation(async () => {
    controller.abort();
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  await expect(recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: toolPair(), persist,
    executionContext: { backups: new Map(), abortSignal: controller.signal } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(persist).not.toHaveBeenCalled();
});

it('durably relieves the latest completed tool result without mutating the original history', async () => {
  const body = "print('x')\n".repeat(17_000);
  const messages: KodaXMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'bash', input: { command: 'cat file' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: body }] },
  ];
  const before = estimateTokens(messages);
  const persist = vi.fn(async () => {
    const files = await fs.readdir(directory);
    expect(files).toHaveLength(1);
    expect(await fs.readFile(path.join(directory, files[0]!), 'utf8')).toBe(body);
  });
  const result = await recoverContextHistory({ canReadPagedContent: true, messages, currentTokens: 125_541,
    contextWindow: 131_072, reservedResponseTokens: 3_000, persist });
  expect(result.messages[0]).toBe(messages[0]);
  expect(result.messages[1]).not.toBe(messages[1]);
  expect(estimateTokens(messages)).toBe(before);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(result.currentTokens).toBeLessThanOrEqual(124_341);
});

function toolPair(name = 'bash', content = 'large evidence '.repeat(12_000)): KodaXMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: name, name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: name, content }] },
  ];
}

const capacity = { currentTokens: 125_541, contextWindow: 131_072, reservedResponseTokens: 3_000 };

it('waits without replacing history when the active tools cannot retrieve saved originals', async () => {
  const messages: KodaXMessage[] = [
    { role: 'user', content: 'Binding constraints. '.repeat(5000) },
    { role: 'assistant', content: 'Earlier analysis. '.repeat(5000) },
    ...toolPair(),
  ];
  const original = structuredClone(messages);
  const persist = vi.fn();
  await expect(recoverContextHistory({ messages, currentTokens: estimateTokens(messages), contextWindow: 8192,
    reservedResponseTokens: 3000, canReadPagedContent: false, persist })).rejects.toBeInstanceOf(ContextCapacityError);
  expect(messages).toEqual(original);
  expect(persist).not.toHaveBeenCalled();
  expect(await fs.readdir(directory)).toEqual([]);
});

it('retains history when the read policy denies saved artifact paths', async () => {
  const messages: KodaXMessage[] = [
    { role: 'assistant', content: 'Earlier analysis. '.repeat(5000) }, ...toolPair(),
  ];
  const persist = vi.fn();
  await expect(recoverContextHistory({ messages, currentTokens: estimateTokens(messages), contextWindow: 8192,
    reservedResponseTokens: 3000, canReadPagedContent: true, persist,
    executionContext: { backups: new Map(), assertReadablePath: () => { throw new Error('Read policy denied'); } },
  })).rejects.toBeInstanceOf(ContextCapacityError);
  expect(persist).not.toHaveBeenCalled();
});

it('recovers cumulative ordinary assistant history while keeping every user constraint and execution receipt', async () => {
  const messages: KodaXMessage[] = [{ role: 'system', content: 'Never disclose secrets.' }];
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: 'user', content: `Constraint ${index}: preserve public API ${index}.` },
      { role: 'assistant', content: `Evidence ${index}\n` + 'investigation detail\n'.repeat(1200) });
  }
  const executed = toolPair('edit', 'Successfully applied edit exactly once.');
  messages.push(...executed, { role: 'user', content: 'Continue implementing; do not repeat the edit.' });
  const original = structuredClone(messages);
  const persist = vi.fn(async () => {
    expect((await fs.readdir(directory)).length).toBeGreaterThan(0);
  });
  const result = await recoverContextHistory({ canReadPagedContent: true, messages, currentTokens: estimateTokens(messages),
    contextWindow: 32_768, reservedResponseTokens: 3_000, persist });
  expect(result.changed).toBe(true);
  expect(result.currentTokens).toBeLessThan(29_000);
  expect(result.messages.filter(message => message.role !== 'assistant')).toEqual(
    original.filter(message => message.role !== 'assistant'));
  expect(result.messages.slice(-3)).toEqual(original.slice(-3));
  expect(messages).toEqual(original);
  const saved = await Promise.all((await fs.readdir(directory)).map(file => fs.readFile(path.join(directory, file), 'utf8')));
  for (let index = 0; index < messages.length; index += 1) {
    if (result.messages[index] !== messages[index]) expect(saved).toContain(messages[index]!.content);
  }
  expect(persist).toHaveBeenCalledTimes(1);
});

it('keeps medium user requirements inline by paging old analysis before user inputs', async () => {
  const messages: KodaXMessage[] = [
    { role: 'user', content: 'Requirement: preserve each API and its exact error behavior.\n'.repeat(300) },
    { role: 'assistant', content: 'Old exploratory analysis that remains retrievable.\n'.repeat(4000) },
    { role: 'user', content: 'Further constraints and task evidence.\n'.repeat(300) },
    { role: 'assistant', content: 'Continue from current evidence.' },
    { role: 'user', content: 'Finish the requested work.' },
  ];
  const recovered = await recoverContextHistory({ canReadPagedContent: true, messages, currentTokens: estimateTokens(messages),
    contextWindow: 16_384, reservedResponseTokens: 3_000 });
  const cache = createUserInputDegradationCache();
  try {
    const wire = await degradeIrreducibleUserInputs(recovered.messages, { backups: new Map() }, 16_384, cache,
      { canReadPagedContent: true, currentTokens: recovered.currentTokens, reservedResponseTokens: 3_000 });
    expect(wire.filter(message => message.role === 'user')).toEqual(messages.filter(message => message.role === 'user'));
    expect(cache.artifactPaths.size).toBe(0);
  } finally { await cleanupUserInputDegradationCache(cache); }
});

it('keeps protected tool state intact and relieves the next eligible result', async () => {
  const protectedPair = toolPair('skill');
  const persist = vi.fn();
  await expect(recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: protectedPair, persist }))
    .rejects.toBeInstanceOf(ContextCapacityError);
  expect(persist).not.toHaveBeenCalled();
  const result = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: [...protectedPair, ...toolPair()], persist });
  expect(result.messages.slice(0, 2)).toEqual(protectedPair);
  expect(result.messages[3]).not.toEqual(toolPair()[1]);
});

it('reuses full evidence when a saved preview needs further reduction', async () => {
  const messages = toolPair();
  const first = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages });
  const artifacts = await fs.readdir(directory);
  const original = await fs.readFile(path.join(directory, artifacts[0]!), 'utf8');
  const second = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: first.messages });
  expect(estimateTokens(second.messages)).toBeLessThan(estimateTokens(first.messages));
  expect(await fs.readdir(directory)).toEqual(artifacts);
  expect(await fs.readFile(path.join(directory, artifacts[0]!), 'utf8')).toBe(original);
});

it('does not manufacture full evidence from an untrusted legacy marker', async () => {
  const messages = toolPair('bash', 'KODAX_RESULT_INCOMPLETE\n' + 'preview '.repeat(8_000));
  const persist = vi.fn();
  await expect(recoverContextHistory({ canReadPagedContent: true, ...capacity, messages, persist })).rejects.toBeInstanceOf(ContextCapacityError);
  expect(await fs.readdir(directory)).toEqual([]);
  expect(persist).not.toHaveBeenCalled();
});

it('leaves original history intact when artifact persistence fails', async () => {
  const blocked = path.join(directory, 'file-instead-of-directory');
  await fs.writeFile(blocked, 'blocked');
  vi.stubEnv(TOOL_OUTPUT_DIR_ENV, blocked);
  const messages = toolPair();
  const original = structuredClone(messages);
  const persist = vi.fn();
  await expect(recoverContextHistory({ canReadPagedContent: true, ...capacity, messages, persist })).rejects.toBeInstanceOf(ContextCapacityError);
  expect(messages).toEqual(original);
  expect(persist).not.toHaveBeenCalled();
});

it('propagates context commit failure without exposing a replacement', async () => {
  const messages = toolPair();
  const original = structuredClone(messages);
  const failure = new Error('session commit failed');
  await expect(recoverContextHistory({ canReadPagedContent: true, ...capacity, messages, persist: async () => { throw failure; } })).rejects.toBe(failure);
  expect(messages).toEqual(original);
});

it('does not spill or commit when shrinking the response reserve is sufficient', async () => {
  const persist = vi.fn();
  const result = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: toolPair(), currentTokens: 95_773,
    reservedResponseTokens: 32_768, persist });
  expect(result.changed).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
  expect(persist).not.toHaveBeenCalled();
});

it('composes request-only oversized user relief with durable tool history relief', async () => {
  const user: KodaXMessage = { role: 'user', content: 'x'.repeat(600_000) };
  const messages = [...toolPair(), user];
  const currentTokens = estimateTokens([user]) + 130_000;
  const persist = vi.fn();
  const result = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages, currentTokens, persist });
  expect(result.messages.at(-1)).toBe(user);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(result.currentTokens).toBeLessThan(currentTokens);
});

it('recovers multimodal text durably and keeps images and their original evidence on further relief', async () => {
  const image = { type: 'image', path: '/retained-image.png' } as const;
  const body = 'large evidence '.repeat(12_000);
  const messages = toolPair();
  const block = (messages[1]!.content as KodaXToolResultBlock[])[0]!;
  block.content = [{ type: 'text', text: body }, image];
  const original = structuredClone(messages);
  const first = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages });
  const reduced = (first.messages[1]!.content as KodaXToolResultBlock[])[0]!;
  expect(reduced.content).toEqual(expect.arrayContaining([image]));
  const artifact = reduced.metadata?.outputPath as string;
  expect(await fs.readFile(artifact, 'utf8')).toBe(body);
  const second = await recoverContextHistory({ canReadPagedContent: true, ...capacity, messages: first.messages });
  const next = (second.messages[1]!.content as KodaXToolResultBlock[])[0]!;
  expect(next.content).toEqual(expect.arrayContaining([image]));
  expect(next.metadata?.outputPath).toBe(artifact);
  expect(await fs.readFile(artifact, 'utf8')).toBe(body);
  expect(estimateTokens(second.messages)).toBeLessThan(estimateTokens(first.messages));
  expect(messages).toEqual(original);
});

it('reports irreducible image capacity without losing the image or committing partial history', async () => {
  const messages = toolPair();
  const block = (messages[1]!.content as KodaXToolResultBlock[])[0]!;
  block.content = [{ type: 'image', path: '/retained-image.png' }];
  const original = structuredClone(messages);
  const persist = vi.fn();
  await expect(recoverContextHistory({ canReadPagedContent: true, ...capacity, messages, persist }))
    .rejects.toBeInstanceOf(ContextCapacityError);
  expect(messages).toEqual(original);
  expect(persist).not.toHaveBeenCalled();
  expect(await fs.readdir(directory)).toEqual([]);
});
