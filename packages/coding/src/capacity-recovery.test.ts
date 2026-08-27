import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyContextCapacityReserveOverride,
  cleanupUserInputDegradationCache,
  createUserInputDegradationCache,
  degradeIrreducibleUserInputs,
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

  describe('degradeIrreducibleUserInputs', () => {
    it('does not treat an ordinary message as degradable merely because the configured window is below the reserve floor', async () => {
      const message: KodaXMessage = { role: 'user', content: 'hello' };
      const cache = createUserInputDegradationCache();

      const degraded = await degradeIrreducibleUserInputs(
        [message],
        { backups: new Map() },
        1_000,
        cache,
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
        cache,
      );

      // The request copy is degraded; the original transcript is untouched.
      expect(degraded[1]!.content).toContain('KODAX_RESULT_INCOMPLETE');
      expect(degraded[1]!.content).toContain('Full output saved to:');
      expect(degraded[1]!.content).toContain('read with offset/limit');
      expect(String(degraded[1]!.content).length).toBeLessThan(oversized.length / 10);
      expect(messages[1]!.content).toBe(oversized);
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
        cache,
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
        cache,
      );
      expect(second[0]!.content).toContain('KODAX_RESULT_INCOMPLETE');
      const degradedContent = second[0]!.content;
      const third = await degradeIrreducibleUserInputs(
        [oversized],
        { backups: new Map() },
        100_000,
        cache,
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
        cache,
      );

      expect(degraded).toHaveLength(2);
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
        createUserInputDegradationCache(),
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
