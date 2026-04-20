import { describe, expect, it, vi } from 'vitest';
import type { KodaXMessage, KodaXTokenUsage } from './types.js';
import {
  createApiContextTokenSnapshot,
  createCompletedTurnTokenSnapshot,
  createContextTokenSnapshot,
  createEstimatedContextTokenSnapshot,
  hasValidTokenUsage,
  rebaseContextTokenSnapshot,
  recomputeContextTokenSnapshot,
  resolveContextTokenCount,
} from './token-accounting.js';
import * as tokenizer from './tokenizer.js';

describe('token accounting', () => {
  const messages: KodaXMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ];

  it('accepts only finite non-negative token usage', () => {
    const valid: KodaXTokenUsage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };

    expect(hasValidTokenUsage(valid)).toBe(true);
    expect(hasValidTokenUsage(undefined)).toBe(false);
    expect(hasValidTokenUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 4,
    })).toBe(false);
    expect(hasValidTokenUsage({
      inputTokens: -1,
      outputTokens: 5,
      totalTokens: 5,
    })).toBe(false);
  });

  it('prefers API usage when it is valid', () => {
    const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(42);

    const snapshot = createContextTokenSnapshot(messages, {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });

    expect(snapshot).toEqual({
      currentTokens: 120,
      baselineEstimatedTokens: 42,
      source: 'api',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      },
    });

    estimateSpy.mockRestore();
  });

  it('falls back to local estimation when API usage is missing or invalid', () => {
    const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(64);

    expect(createEstimatedContextTokenSnapshot(messages)).toEqual({
      currentTokens: 64,
      baselineEstimatedTokens: 64,
      source: 'estimate',
    });

    expect(createContextTokenSnapshot(messages, {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 5,
    })).toEqual({
      currentTokens: 64,
      baselineEstimatedTokens: 64,
      source: 'estimate',
    });

    estimateSpy.mockRestore();
  });

  it('rebases API snapshots against local message growth', () => {
    const estimateSpy = vi
      .spyOn(tokenizer, 'estimateTokens')
      .mockReturnValueOnce(40)
      .mockReturnValueOnce(55)
      .mockReturnValueOnce(55)
      .mockReturnValueOnce(55);

    const snapshot = createApiContextTokenSnapshot(messages, {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    });

    expect(resolveContextTokenCount(messages, snapshot)).toBe(115);
    expect(rebaseContextTokenSnapshot(messages, snapshot)).toEqual({
      currentTokens: 115,
      baselineEstimatedTokens: 55,
      source: 'api',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
      },
    });

    estimateSpy.mockRestore();
  });

  it('uses totalTokens once an assistant turn has completed', () => {
    const estimateSpy = vi
      .spyOn(tokenizer, 'estimateTokens')
      .mockReturnValueOnce(55)
      .mockReturnValueOnce(70);

    const snapshot = createCompletedTurnTokenSnapshot(messages, {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    });

    expect(snapshot).toEqual({
      currentTokens: 110,
      baselineEstimatedTokens: 55,
      source: 'api',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
      },
    });

    expect(resolveContextTokenCount(messages, snapshot)).toBe(125);

    estimateSpy.mockRestore();
  });

  it('falls back to estimation when completed-turn usage is missing or invalid', () => {
    const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(88);

    expect(createCompletedTurnTokenSnapshot(messages, undefined)).toEqual({
      currentTokens: 88,
      baselineEstimatedTokens: 88,
      source: 'estimate',
    });

    expect(createCompletedTurnTokenSnapshot(messages, {
      inputTokens: 20,
      outputTokens: 30,
      totalTokens: 10,
    })).toEqual({
      currentTokens: 88,
      baselineEstimatedTokens: 88,
      source: 'estimate',
    });

    estimateSpy.mockRestore();
  });

  it('falls back to the fresh estimate when the snapshot is malformed', () => {
    const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(77);

    expect(resolveContextTokenCount(messages, {
      currentTokens: Number.NaN,
      baselineEstimatedTokens: 20,
      source: 'api',
    })).toBe(77);

    estimateSpy.mockRestore();
  });

  describe('recomputeContextTokenSnapshot (FEATURE_076 Q2)', () => {
    it('fully recomputes both current and baseline from messages (ignores old snapshot token counts)', () => {
      const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(55);

      const oldSnapshot = {
        currentTokens: 9999,           // worker-session leftover; should NOT leak
        baselineEstimatedTokens: 8888, // also stale; should NOT leak
        source: 'api' as const,
      };

      const fresh = recomputeContextTokenSnapshot(messages, oldSnapshot);

      expect(fresh.currentTokens).toBe(55);
      expect(fresh.baselineEstimatedTokens).toBe(55);

      estimateSpy.mockRestore();
    });

    it('preserves source from old snapshot when available', () => {
      const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(42);

      const fresh = recomputeContextTokenSnapshot(messages, {
        currentTokens: 100,
        baselineEstimatedTokens: 100,
        source: 'api',
      });

      expect(fresh.source).toBe('api');
      estimateSpy.mockRestore();
    });

    it('drops stale usage (old snapshot measured worker session, not user dialog)', () => {
      const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(42);

      const fresh = recomputeContextTokenSnapshot(messages, {
        currentTokens: 100,
        baselineEstimatedTokens: 100,
        source: 'api',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

      expect(fresh.usage).toBeUndefined();
      estimateSpy.mockRestore();
    });

    it('works without any old snapshot (source defaults to estimate)', () => {
      const estimateSpy = vi.spyOn(tokenizer, 'estimateTokens').mockReturnValue(30);

      const fresh = recomputeContextTokenSnapshot(messages, undefined);

      expect(fresh).toEqual({
        currentTokens: 30,
        baselineEstimatedTokens: 30,
        source: 'estimate',
      });
      estimateSpy.mockRestore();
    });
  });
});
