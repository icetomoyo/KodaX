import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextCapacityError, estimateTokens } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import { recoverContextHistory } from './history-capacity-recovery.js';
import { TOOL_OUTPUT_DIR_ENV } from './tools/truncate.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-history-recovery-'));
  vi.stubEnv(TOOL_OUTPUT_DIR_ENV, directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
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
  const result = await recoverContextHistory({ messages, currentTokens: 125_541,
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

it('keeps protected tool state intact and relieves the next eligible result', async () => {
  const protectedPair = toolPair('skill');
  const persist = vi.fn();
  await expect(recoverContextHistory({ ...capacity, messages: protectedPair, persist }))
    .rejects.toBeInstanceOf(ContextCapacityError);
  expect(persist).not.toHaveBeenCalled();
  const result = await recoverContextHistory({ ...capacity, messages: [...protectedPair, ...toolPair()], persist });
  expect(result.messages.slice(0, 2)).toEqual(protectedPair);
  expect(result.messages[3]).not.toEqual(toolPair()[1]);
});

it('reuses full evidence when a saved preview needs further reduction', async () => {
  const messages = toolPair();
  const first = await recoverContextHistory({ ...capacity, messages });
  const artifacts = await fs.readdir(directory);
  const original = await fs.readFile(path.join(directory, artifacts[0]!), 'utf8');
  const second = await recoverContextHistory({ ...capacity, messages: first.messages });
  expect(estimateTokens(second.messages)).toBeLessThan(estimateTokens(first.messages));
  expect(await fs.readdir(directory)).toEqual(artifacts);
  expect(await fs.readFile(path.join(directory, artifacts[0]!), 'utf8')).toBe(original);
});

it('does not manufacture full evidence from an untrusted legacy marker', async () => {
  const messages = toolPair('bash', 'KODAX_RESULT_INCOMPLETE\n' + 'preview '.repeat(8_000));
  const persist = vi.fn();
  await expect(recoverContextHistory({ ...capacity, messages, persist })).rejects.toBeInstanceOf(ContextCapacityError);
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
  await expect(recoverContextHistory({ ...capacity, messages, persist })).rejects.toBeInstanceOf(ContextCapacityError);
  expect(messages).toEqual(original);
  expect(persist).not.toHaveBeenCalled();
});

it('propagates context commit failure without exposing a replacement', async () => {
  const messages = toolPair();
  const original = structuredClone(messages);
  const failure = new Error('session commit failed');
  await expect(recoverContextHistory({ ...capacity, messages, persist: async () => { throw failure; } })).rejects.toBe(failure);
  expect(messages).toEqual(original);
});

it('does not spill or commit when shrinking the response reserve is sufficient', async () => {
  const persist = vi.fn();
  const result = await recoverContextHistory({ ...capacity, messages: toolPair(), currentTokens: 95_773,
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
  const result = await recoverContextHistory({ ...capacity, messages, currentTokens, persist });
  expect(result.messages.at(-1)).toBe(user);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(result.currentTokens).toBeLessThan(currentTokens);
});
