import { describe, expect, it } from 'vitest';
import {
  getRunScopedConfig,
  runWithScopedConfig,
  resolvePromptCacheDisabled,
  resolveWorkflowMaxConcurrency,
  WORKFLOW_MAX_CONCURRENCY_DEFAULT,
} from '@kodax-ai/llm';

import { resolveModelHintTier } from './model-hint-routing.js';
import { deriveRunScopedConfig } from './run-scoped-config.js';
import type { KodaXOptions } from './types.js';

/**
 * Run-scoped config (AsyncLocalStorage) — the concurrency-safe replacement for
 * the global-env bridge on the SDK path. runManagedTask wraps each run in
 * runWithScopedConfig(options-derived config); readers (here resolveModelHintTier)
 * read the store first, env fallback second. The concurrency test is the point:
 * two overlapping runs with different tiers must NOT clobber each other.
 */
describe('run-scoped model tiers (ALS, concurrency-safe)', () => {
  it('resolveModelHintTier reads the run-scoped deep tier (any child)', () => {
    const tier = runWithScopedConfig(
      { modelTiers: { deep: { provider: 'zhipu-coding', model: 'glm-5.2' } } },
      () => resolveModelHintTier('deep', false),
    );
    expect(tier).toEqual({ provider: 'zhipu-coding', model: 'glm-5.2' });
  });

  it("'fast' tier stays read-only-gated (write child gets no tier)", () => {
    const cfg = { modelTiers: { fast: { provider: 'deepseek', model: 'deepseek-v4-flash' } } };
    expect(runWithScopedConfig(cfg, () => resolveModelHintTier('fast', true)))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(runWithScopedConfig(cfg, () => resolveModelHintTier('fast', false))).toBeUndefined();
  });

  it('concurrent runs with different tiers do NOT clobber each other', async () => {
    const runA = runWithScopedConfig({ modelTiers: { deep: { model: 'A' } } }, async () => {
      await new Promise((r) => setTimeout(r, 5)); // let run B interleave
      return resolveModelHintTier('deep', false)?.model;
    });
    const runB = runWithScopedConfig({ modelTiers: { deep: { model: 'B' } } }, async () =>
      resolveModelHintTier('deep', false)?.model,
    );
    const [a, b] = await Promise.all([runA, runB]);
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('falls back to env outside any run-scoped context', () => {
    const saved = { p: process.env.KODAX_DEEP_PROVIDER, m: process.env.KODAX_DEEP_MODEL };
    try {
      delete process.env.KODAX_DEEP_PROVIDER;
      process.env.KODAX_DEEP_MODEL = 'env-model';
      expect(getRunScopedConfig()).toBeUndefined();
      expect(resolveModelHintTier('deep', false)).toEqual({ provider: undefined, model: 'env-model' });
    } finally {
      if (saved.p === undefined) delete process.env.KODAX_DEEP_PROVIDER; else process.env.KODAX_DEEP_PROVIDER = saved.p;
      if (saved.m === undefined) delete process.env.KODAX_DEEP_MODEL; else process.env.KODAX_DEEP_MODEL = saved.m;
    }
  });
});

describe('deriveRunScopedConfig (KodaXOptions → run-scoped config)', () => {
  it('maps every run-scoped field the SDK exposes', () => {
    const options = {
      modelTiers: { deep: { provider: 'p', model: 'm' } },
      maxOutputTokens: 4096,
      disablePromptCache: true,
      lsp: false,
      workflow: { maxConcurrency: 12 },
    } as KodaXOptions;
    expect(deriveRunScopedConfig(options)).toEqual({
      modelTiers: { deep: { provider: 'p', model: 'm' } },
      maxOutputTokens: 4096,
      disablePromptCache: true,
      lsp: false,
      workflow: { maxConcurrency: 12 },
    });
  });

  it('omits unset fields so the CLI/env path stays on its fallbacks (empty object)', () => {
    // Only fields the caller set may enter the ALS store; an empty object leaves
    // every reader on process.env — the single-session CLI / config.json path.
    expect(deriveRunScopedConfig({} as KodaXOptions)).toEqual({});
  });

  it('scopes the root conversation id, preferring the logical id children inherit', () => {
    expect(deriveRunScopedConfig({ session: { id: 'root-1' } } as KodaXOptions)).toEqual({ sessionId: 'root-1' });
    expect(deriveRunScopedConfig({
      session: { id: 'worker-child' },
      context: { contextIdentitySessionId: 'root-1' },
    } as KodaXOptions)).toEqual({ sessionId: 'root-1' });
  });

  it('keeps the enclosing conversation id when a nested run names none', () => {
    runWithScopedConfig({ sessionId: 'outer-1' }, () => {
      expect(deriveRunScopedConfig({} as KodaXOptions)).toEqual({ sessionId: 'outer-1' });
      expect(deriveRunScopedConfig({ session: { id: 'inner-1' } } as KodaXOptions)).toEqual({ sessionId: 'inner-1' });
    });
  });
});

describe('resolvePromptCacheDisabled (SDK > run scope > env)', () => {
  function withPromptCacheEnv(value: string | undefined, fn: () => void): void {
    const saved = process.env.KODAX_DISABLE_PROMPT_CACHE;
    try {
      if (value === undefined) delete process.env.KODAX_DISABLE_PROMPT_CACHE;
      else process.env.KODAX_DISABLE_PROMPT_CACHE = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env.KODAX_DISABLE_PROMPT_CACHE;
      else process.env.KODAX_DISABLE_PROMPT_CACHE = saved;
    }
  }

  it('uses the env bridge only when no explicit or scoped value exists', () => {
    withPromptCacheEnv('1', () => expect(resolvePromptCacheDisabled()).toBe(true));
    withPromptCacheEnv(undefined, () => expect(resolvePromptCacheDisabled()).toBe(false));
  });

  it('lets explicit and run-scoped false re-enable caching over the env bridge', () => {
    withPromptCacheEnv('1', () => {
      expect(resolvePromptCacheDisabled(false)).toBe(false);
      expect(runWithScopedConfig(
        { disablePromptCache: false },
        () => resolvePromptCacheDisabled(),
      )).toBe(false);
    });
  });
});

describe('resolveWorkflowMaxConcurrency (default 8, configurable, clamped)', () => {
  function withEnv(value: string | undefined, fn: () => void): void {
    const saved = process.env.KODAX_WORKFLOW_MAX_CONCURRENCY;
    try {
      if (value === undefined) delete process.env.KODAX_WORKFLOW_MAX_CONCURRENCY;
      else process.env.KODAX_WORKFLOW_MAX_CONCURRENCY = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env.KODAX_WORKFLOW_MAX_CONCURRENCY;
      else process.env.KODAX_WORKFLOW_MAX_CONCURRENCY = saved;
    }
  }

  it('defaults to 8 with no override', () => {
    withEnv(undefined, () => {
      expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT);
      expect(WORKFLOW_MAX_CONCURRENCY_DEFAULT).toBe(8);
    });
  });

  it('reads the KODAX_WORKFLOW_MAX_CONCURRENCY env bridge', () => {
    withEnv('4', () => expect(resolveWorkflowMaxConcurrency()).toBe(4));
  });

  it('run-scoped SDK config wins over the env bridge', () => {
    withEnv('4', () => {
      const resolved = runWithScopedConfig(
        { workflow: { maxConcurrency: 12 } },
        () => resolveWorkflowMaxConcurrency(),
      );
      expect(resolved).toBe(12);
    });
  });

  it('clamps to [1, 32] and ignores non-positive/garbage values', () => {
    withEnv('999', () => expect(resolveWorkflowMaxConcurrency()).toBe(32));
    withEnv('0', () => expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT));
    withEnv('-5', () => expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT));
    withEnv('abc', () => expect(resolveWorkflowMaxConcurrency()).toBe(WORKFLOW_MAX_CONCURRENCY_DEFAULT));
    expect(
      runWithScopedConfig({ workflow: { maxConcurrency: 100 } }, () => resolveWorkflowMaxConcurrency()),
    ).toBe(32);
  });
});

describe('cacheWarming in nested Runs', () => {
  it('keeps the enclosing Run setting unless the nested Run sets its own', () => {
    const outer = deriveRunScopedConfig({ cacheWarming: 'off' } as KodaXOptions);
    expect(runWithScopedConfig(outer, () => deriveRunScopedConfig({} as KodaXOptions).cacheWarming)).toBe('off');
    expect(runWithScopedConfig(outer, () => deriveRunScopedConfig({ cacheWarming: 'run' } as KodaXOptions).cacheWarming)).toBe('run');
    expect(deriveRunScopedConfig({} as KodaXOptions).cacheWarming).toBeUndefined();
  });
});
