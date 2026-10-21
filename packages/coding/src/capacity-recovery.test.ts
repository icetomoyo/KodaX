import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import { estimateTokens } from './tokenizer.js';

import {
  applyContextCapacityReserveOverride,
  cleanupUserInputDegradationCache,
  createUserInputDegradationCache,
  degradeIrreducibleUserInputs,
  hasIrreducibleUserInput,
  type ContextReserveOverrideProvider,
} from './capacity-recovery.js';
import { readTransientTextArtifact } from './transient-text-artifacts.js';
import { TOOL_OUTPUT_DIR_ENV } from './tools/truncate.js';

function fakeProvider(base: number): ContextReserveOverrideProvider {
  return { getEffectiveMaxOutputTokens: (_model?: string) => base };
}

describe('capacity recovery rungs (FEATURE_296 T5/T6)', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-capacity-recovery-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('identifies irreducible user text independently of its message encoding', () => {
    const text = 'binding requirements '.repeat(10_000);
    expect(hasIrreducibleUserInput([{ role: 'user', content: text }], 8192)).toBe(true);
    expect(hasIrreducibleUserInput([{ role: 'user', content: [
      { type: 'text', text }, { type: 'image', path: '/proof.png' },
    ] }], 8192)).toBe(true);
    expect(hasIrreducibleUserInput([{ role: 'assistant', content: text }], 8192)).toBe(false);
    expect(hasIrreducibleUserInput([{ role: 'user', content: [
      { type: 'text', text: 'Keep this image.' }, { type: 'image', path: '/proof.png' },
      { type: 'tool_result', tool_use_id: 'done', content: text },
    ] }], 8192)).toBe(false);
  });

  describe('degradeIrreducibleUserInputs', () => {
    it('pages only oversized text blocks in multimodal user input and preserves images and receipts', async () => {
      const text = 'Constraint: never deploy.\n' + 'evidence\n'.repeat(12000);
      const messages: KodaXMessage[] = [{ role: 'user', content: [
        { type: 'text', text }, { type: 'image', path: '/proof.png' },
        { type: 'tool_result', tool_use_id: 'finished', content: 'already executed' },
        { type: 'text', text: 'Keep the screenshot and do not repeat completed work.' },
      ] }];
      const original = structuredClone(messages);
      const cache = createUserInputDegradationCache();
      const request = { currentTokens: estimateTokens(messages), reservedResponseTokens: 3000, canReadPagedContent: true };
      try {
        const wire = await degradeIrreducibleUserInputs(messages, { backups: new Map() }, 8192, cache, request);
        expect(estimateTokens(wire)).toBeLessThan(5000);
        expect(wire[0]!.content).toEqual(expect.arrayContaining([
          { type: 'image', path: '/proof.png' },
          { type: 'tool_result', tool_use_id: 'finished', content: 'already executed' },
          { type: 'text', text: 'Keep the screenshot and do not repeat completed work.' },
        ]));
        expect([...cache.artifactPaths].map(readTransientTextArtifact)).toContain(text);
        expect(messages).toEqual(original);
        const restored = await degradeIrreducibleUserInputs(messages, { backups: new Map() }, 200000, cache, request);
        expect(restored).toEqual(original);
      } finally { await cleanupUserInputDegradationCache(cache); }
    });

    it('retains exact user input when the active tools cannot read paged content', async () => {
      const messages: KodaXMessage[] = [{ role: 'user', content: 'Binding requirements. '.repeat(8000) }];
      const cache = createUserInputDegradationCache();
      const result = await degradeIrreducibleUserInputs(messages, { backups: new Map() }, 8192, cache,
        { currentTokens: estimateTokens(messages), reservedResponseTokens: 3000, canReadPagedContent: false });
      expect(result).toEqual(messages);
      expect(cache.artifactPaths.size).toBe(0);
    });
    it('pages cumulative medium user inputs against the complete request budget without changing canonical constraints', async () => {
      const messages = Array.from({ length: 6 }, (_, index) => ({ role: 'user' as const,
        content: `Constraint ${index}: do not change API ${index}.\n` + 'evidence\n'.repeat(900) }));
      messages.push({ role: 'user', content: 'Continue the requested implementation.' });
      const original = structuredClone(messages);
      const cache = createUserInputDegradationCache();
      const wire = await degradeIrreducibleUserInputs(messages, { backups: new Map() }, 16_384, cache,
        { canReadPagedContent: true, currentTokens: estimateTokens(messages) + 8_000, reservedResponseTokens: 3_000 });
      expect(estimateTokens(wire)).toBeLessThan(5_000);
      expect(wire[messages.length - 1]).toBe(messages.at(-1));
      expect(messages).toEqual(original);
      const saved = [...cache.artifactPaths].map(readTransientTextArtifact);
      for (let index = 0; index < messages.length; index += 1) {
        if (wire[index] !== messages[index]) expect(saved).toContain(messages[index]!.content);
      }
      await cleanupUserInputDegradationCache(cache);
    });
    it('restores the complete request input after moving to a larger model window', async () => {
      const message = { role: 'user' as const, content: 'constraint and evidence '.repeat(4000) };
      const cache = createUserInputDegradationCache();
      const small = await degradeIrreducibleUserInputs([message], { backups: new Map() }, 8_192, cache, { currentTokens: estimateTokens([...[message]]), reservedResponseTokens: 3000, canReadPagedContent: true });
      expect(small[0]).not.toBe(message);
      const large = await degradeIrreducibleUserInputs([message], { backups: new Map() }, 200_000, cache, { currentTokens: estimateTokens([...[message]]), reservedResponseTokens: 3000, canReadPagedContent: true });
      expect(large[0]).toBe(message);
      await cleanupUserInputDegradationCache(cache);
    });
    it('does not treat an ordinary message as degradable merely because the configured window is below the reserve floor', async () => {
      const message: KodaXMessage = { role: 'user', content: 'hello' };
      const cache = createUserInputDegradationCache();

      const degraded = await degradeIrreducibleUserInputs(
        [message],
        { backups: new Map() },
        1_000,
        cache, { currentTokens: estimateTokens([...[message]]), reservedResponseTokens: 3000, canReadPagedContent: true },
      );

      expect(degraded).toEqual([message]);
      expect(cache.artifactPaths.size).toBe(0);
    });

    it('degrades an irreducibly oversized user input to preview + pointer', async () => {
      const oversized = `huge log\n${'evidence '.repeat(200_000)}`;
      const messages = [
        { role: 'system' as const, content: 'sys' },
        { role: 'user' as const, content: oversized },
        { role: 'assistant' as const, content: 'ack' },
      ];

      const cache = createUserInputDegradationCache();
      const degraded = await degradeIrreducibleUserInputs(
        messages,
        { backups: new Map() },
        100_000,
        cache, { currentTokens: estimateTokens([...messages]), reservedResponseTokens: 3000, canReadPagedContent: true },
      );

      // The request copy is degraded; the original transcript is untouched.
      expect(degraded[1]!.content).toContain('KODAX_RESULT_INCOMPLETE');
      expect(degraded[1]!.content).toContain('Full output saved to:');
      expect(degraded[1]!.content).toContain('read with offset/limit');
      expect(String(degraded[1]!.content).length).toBeLessThan(oversized.length / 10);
      expect(messages[1]!.content).toBe(oversized);
      expect(degraded.at(-1)).toMatchObject({ role: 'system', _source: 'capacity-input-context' });
      expect(messages.some(message => message.role === 'system' && message.content.includes('KodaX context recovery:'))).toBe(false);
      expect(degraded[0]!.content).toBe('sys');
      expect(degraded[2]!.content).toBe('ack');
      expect(cache.artifactPaths.size).toBe(1);
      const [artifactPath] = cache.artifactPaths;
      expect(artifactPath).toMatch(/^kodax-transient:\/\/text\/[0-9a-f]{64}$/);
      expect(readTransientTextArtifact(artifactPath!)).toBe(oversized);
      expect(await fs.readdir(tempDir)).toEqual([]);

      await cleanupUserInputDegradationCache(cache);
      expect(readTransientTextArtifact(artifactPath!)).toBeUndefined();
    });

    it('keeps ordinary large messages verbatim and reuses the cache', async () => {
      // Fits a legal request on its own (~under max input at floor reserve),
      // so no degradation even though it is large.
      const large = 'x '.repeat(10_000);
      const message = { role: 'user' as const, content: large };
      const cache = createUserInputDegradationCache();

      const first = await degradeIrreducibleUserInputs(
        [message],
        { backups: new Map() },
        100_000,
        cache, { currentTokens: estimateTokens([...[message]]), reservedResponseTokens: 3000, canReadPagedContent: true },
      );
      expect(first[0]!.content).toBe(large);
      expect(await fs.readdir(tempDir)).toEqual([]);

      // An irreducible message is degraded once and served from the cache on
      // the next request assembly.
      const oversized = { role: 'user' as const, content: 'y '.repeat(400_000) };
      const second = await degradeIrreducibleUserInputs(
        [oversized, message],
        { backups: new Map() },
        100_000,
        cache, { currentTokens: estimateTokens([...[oversized, message]]), reservedResponseTokens: 3000, canReadPagedContent: true },
      );
      expect(second[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
      const degradedContent = second[0]!.content;
      const third = await degradeIrreducibleUserInputs(
        [oversized],
        { backups: new Map() },
        100_000,
        cache, { currentTokens: estimateTokens([...[oversized]]), reservedResponseTokens: 3000, canReadPagedContent: true },
      );
      expect(third[0]!.content).toBe(degradedContent);
      expect(cache.artifactPaths.size).toBe(1);
      await cleanupUserInputDegradationCache(cache);
    });

    it('owns and removes every artifact for concurrent oversized messages', async () => {
      const first = { role: 'user' as const, content: `first\n${'a '.repeat(400_000)}` };
      const second = { role: 'user' as const, content: `second\n${'b '.repeat(400_000)}` };
      const cache = createUserInputDegradationCache();

      const degraded = await degradeIrreducibleUserInputs(
        [first, second],
        { backups: new Map() },
        100_000,
        cache, { currentTokens: estimateTokens([...[first, second]]), reservedResponseTokens: 3000, canReadPagedContent: true },
      );

      expect(degraded.filter(message => message.role === 'user')).toHaveLength(2);
      expect(cache.artifactPaths.size).toBe(2);
      const artifactPaths = [...cache.artifactPaths];
      expect(artifactPaths.map((value) => readTransientTextArtifact(value)))
        .toEqual(expect.arrayContaining([first.content, second.content]));
      expect(await fs.readdir(tempDir)).toEqual([]);

      await cleanupUserInputDegradationCache(cache);
      expect(artifactPaths.every((value) => readTransientTextArtifact(value) === undefined)).toBe(true);
    });

    it('skips tool_result-bearing user messages', async () => {
      const message = {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }],
      };
      const degraded = await degradeIrreducibleUserInputs(
        [message],
        { backups: new Map() },
        1_000,
        createUserInputDegradationCache(), { currentTokens: estimateTokens([...[message]]), reservedResponseTokens: 3000, canReadPagedContent: true },
      );
      expect(degraded[0]).toBe(message);
    });
  });

  describe('applyContextCapacityReserveOverride', () => {
    it('keeps the reserve when the request already fits', () => {
      const provider = fakeProvider(32_000);
      const effective = applyContextCapacityReserveOverride(provider, {
        contextWindow: 200_000,
        currentTokens: 100_000,
      });
      expect(effective).toBe(32_000);
    });

    it('shrinks the wire reserve while over capacity and never below the floor', () => {
      const provider = fakeProvider(64_000);
      const effective = applyContextCapacityReserveOverride(provider, {
        contextWindow: 100_000,
        currentTokens: 50_000,
      });
      expect(effective).toBeLessThan(64_000);

      const floored = applyContextCapacityReserveOverride(fakeProvider(64_000), {
        contextWindow: 100_000,
        currentTokens: 97_000,
      });
      expect(floored).toBe(3_000);
    });

    it('does not raise an already-shrunk reserve', () => {
      const provider = fakeProvider(64_000);
      const effective = applyContextCapacityReserveOverride(provider, {
        maxOutputTokens: 8_000,
        contextWindow: 100_000,
        currentTokens: 90_000,
      });
      // 90k + 8k + margin > 100k → shrink applies.
      expect(effective).toBeLessThanOrEqual(8_000);
    });
  });
});
