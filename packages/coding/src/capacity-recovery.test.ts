import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyContextCapacityReserveOverride,
  createUserInputDegradationCache,
  degradeIrreducibleUserInputs,
  type ContextReserveOverrideProvider,
} from './capacity-recovery.js';
import { TOOL_OUTPUT_DIR_ENV } from './tools/truncate.js';

function fakeProvider(base: number): ContextReserveOverrideProvider & {
  override: number | undefined;
} {
  const provider = {
    override: undefined as number | undefined,
    getEffectiveMaxOutputTokens: (_model?: string) => provider.override ?? base,
    setMaxOutputTokensOverride: (value: number | undefined) => {
      provider.override = value;
    },
  };
  return provider;
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
    it('degrades an irreducibly oversized user input to preview + pointer', async () => {
      const oversized = `huge log\n${'evidence '.repeat(200_000)}`;
      const messages = [
        { role: 'system' as const, content: 'sys' },
        { role: 'user' as const, content: oversized },
        { role: 'assistant' as const, content: 'ack' },
      ];

      const degraded = await degradeIrreducibleUserInputs(
        messages,
        { backups: new Map() },
        100_000,
        createUserInputDegradationCache(),
      );

      // The request copy is degraded; the original transcript is untouched.
      expect(degraded[1]!.content).toContain('KODAX_RESULT_INCOMPLETE');
      expect(degraded[1]!.content).toContain('Full output saved to:');
      expect(degraded[1]!.content).toContain('read with offset/limit');
      expect(String(degraded[1]!.content).length).toBeLessThan(oversized.length / 10);
      expect(messages[1]!.content).toBe(oversized);
      expect(degraded[0]!.content).toBe('sys');
      expect(degraded[2]!.content).toBe('ack');
      const [artifact] = await fs.readdir(tempDir);
      expect(await fs.readFile(path.join(tempDir, artifact!), 'utf8')).toBe(oversized);
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
      expect(await fs.readdir(tempDir)).toHaveLength(1);
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
      expect(provider.override).toBeUndefined();
    });

    it('shrinks the wire reserve while over capacity and never below the floor', () => {
      const provider = fakeProvider(64_000);
      const effective = applyContextCapacityReserveOverride(provider, {
        contextWindow: 100_000,
        currentTokens: 50_000,
      });
      expect(effective).toBeLessThan(64_000);
      expect(provider.override).toBe(effective);

      const floored = applyContextCapacityReserveOverride(fakeProvider(64_000), {
        contextWindow: 100_000,
        currentTokens: 97_000,
      });
      expect(floored).toBe(3_000);
    });

    it('does not raise an already-shrunk reserve', () => {
      const provider = fakeProvider(8_000);
      const effective = applyContextCapacityReserveOverride(provider, {
        contextWindow: 100_000,
        currentTokens: 90_000,
      });
      // 90k + 8k + margin > 100k → shrink applies.
      expect(effective).toBeLessThanOrEqual(8_000);
      expect(provider.override).toBe(effective);
    });
  });
});
