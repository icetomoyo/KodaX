/**
 * v0.7.43 SDK model-capability exposure — contract tests.
 *
 * These verify the data SDK consumers (KodaX Space etc.) see when they
 * read context-window / max-output / thinking-budget metadata WITHOUT
 * a provider instance — i.e. without setting any API key env var.
 *
 * If any assertion below fails, an embedder's popout UI will display
 * stale or missing model info — touch the snapshot in `registry.ts`
 * or `custom-registry.ts` accordingly.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getModelCapabilities,
  getProviderModelDescriptors,
  listAllModelCapabilities,
  listBuiltinModelCapabilities,
  resolveModelCapabilities,
  resolveProviderModelDescriptors,
  registerCustomProviders,
  getCustomProviderModelDescriptors,
  getCustomModelCapabilities,
  listCustomProviderModelCapabilities,
  KODAX_PROVIDER_SNAPSHOTS,
} from './index.js';

describe('built-in provider model capabilities (no API key required)', () => {
  it('exposes Anthropic Sonnet 4.6 default at 200K context / 64K max output', () => {
    const caps = getModelCapabilities('anthropic', 'claude-sonnet-4-6');
    expect(caps).toBeDefined();
    expect(caps?.contextWindow).toBe(200_000);
    expect(caps?.maxOutputTokens).toBe(64000);
    expect(caps?.thinkingBudgetCap).toBe(28000);
    expect(caps?.supportsThinking).toBe(true);
    expect(caps?.isDefault).toBe(true);
  });

  it('honors per-model thinkingBudgetCap override for Haiku 4.5 (10K) without inheriting Opus 28K', () => {
    const haiku = getModelCapabilities('anthropic', 'claude-haiku-4-5');
    expect(haiku?.thinkingBudgetCap).toBe(10000);
    // Provider-level contextWindow + maxOutputTokens still cascade through.
    expect(haiku?.contextWindow).toBe(200_000);
    expect(haiku?.maxOutputTokens).toBe(64000);
  });

  it('exposes the current public Kimi lineup at the exact 256 Ki-token limit', () => {
    const k3 = getModelCapabilities('kimi', 'kimi-k3');
    expect(k3?.displayName).toBe('Kimi K3');
    expect(k3?.contextWindow).toBe(1_048_576);
    expect(k3?.maxOutputTokens).toBe(32_000);
    expect(k3?.isDefault).toBe(false);
    expect(k3?.reasoningProfile).toMatchObject({
      reasoningPreset: 'kimi-k3',
      defaultEffort: 'high',
      disabledEfforts: ['none'],
    });

    const k27 = getModelCapabilities('kimi', 'kimi-k2.7-code');
    expect(k27?.contextWindow).toBe(262_144);
    expect(k27?.maxOutputTokens).toBe(32_768);
    expect(k27?.isDefault).toBe(true);

    const highspeed = getModelCapabilities('kimi', 'kimi-k2.7-code-highspeed');
    expect(highspeed?.contextWindow).toBe(262_144);
    expect(highspeed?.maxOutputTokens).toBe(32_768);

    const k26 = getModelCapabilities('kimi', 'kimi-k2.6');
    expect(k26?.contextWindow).toBe(262_144);
    const k25 = getModelCapabilities('kimi', 'kimi-k2.5');
    expect(k25?.contextWindow).toBe(262_144);
  });

  it('defaults Kimi Code to K3 256K while retaining K3 1M and both K2.7 routes', () => {
    const k3 = getModelCapabilities('kimi-code', 'k3');
    expect(k3?.contextWindow).toBe(1_048_576);
    expect(k3?.maxOutputTokens).toBe(32_000);
    expect(k3?.isDefault).toBe(false);
    expect(k3?.reasoningProfile).toMatchObject({
      reasoningPreset: 'kimi-k3',
      defaultEffort: 'high',
      disabledEfforts: ['none'],
    });

    const k3Moderato = getModelCapabilities('kimi-code', 'k3-256k');
    expect(k3Moderato?.displayName).toBe('Kimi K3 (256K, Moderato)');
    expect(k3Moderato?.contextWindow).toBe(262_144);
    expect(k3Moderato?.isDefault).toBe(true);
    expect(k3Moderato?.reasoningProfile).toMatchObject({
      reasoningPreset: 'kimi-k3',
      defaultEffort: 'high',
    });

    const stable = getModelCapabilities('kimi-code', 'kimi-for-coding');
    expect(stable?.contextWindow).toBe(262_144);
    expect(stable?.isDefault).toBe(false);
    expect(stable?.reasoningProfile).toMatchObject({
      reasoningPreset: 'kimi-k2.7-code',
    });
  });

  it('keeps public K3 runtime parameters aligned with kimi-code/k3', () => {
    const publicK3 = getModelCapabilities('kimi', 'kimi-k3');
    const subscriptionK3 = getModelCapabilities('kimi-code', 'k3');

    expect(publicK3?.contextWindow).toBe(subscriptionK3?.contextWindow);
    expect(publicK3?.maxOutputTokens).toBe(subscriptionK3?.maxOutputTokens);
    expect(publicK3?.reasoningCapability).toBe(subscriptionK3?.reasoningCapability);
    expect(publicK3?.reasoningProfile).toEqual(subscriptionK3?.reasoningProfile);
  });

  it('exposes Zhipu GLM-5.3 at 1M context / 128K max output', () => {
    const glm53 = getModelCapabilities('zhipu', 'glm-5.3');
    expect(glm53?.contextWindow).toBe(1_000_000);
    expect(glm53?.maxOutputTokens).toBe(131_072);
    expect(glm53?.reasoningProfile).toMatchObject({
      reasoningPreset: 'zai-glm-5.3',
      defaultEffort: 'max',
    });
  });

  it('honors a models[] override even when the model IS the provider default (R3 regression)', () => {
    // Invariant: ANY provider whose default model ALSO has a models[] entry must
    // return that entry's override, not the bare provider defaults. zhipu-coding
    // defaults to glm-5.3 (1M), as do zai-coding and ark-coding (each with
    // its own 1M-window override; ark caps output at 128K).
    // The pre-fix resolver used a bare default descriptor and returned the 200K/16K
    // provider defaults (the "context window shows 200K" bug); getEffective* already
    // returned the right values, so these metadata resolvers must now agree.
    for (const { provider, model, maxOut } of [
      { provider: 'zhipu-coding', model: 'glm-5.3', maxOut: 131_072 },
      { provider: 'zai-coding', model: 'glm-5.3', maxOut: 131_072 },
      { provider: 'ark-coding', model: 'glm-5.3', maxOut: 128_000 },
    ] as const) {
      const caps = getModelCapabilities(provider, model);
      expect(caps?.contextWindow, `${provider} ctx`).toBe(1_000_000);
      expect(caps?.maxOutputTokens, `${provider} maxOut`).toBe(maxOut);
      expect(caps?.reasoningCapability, `${provider} reasoning`).toBe('native-effort');
      // The override does not disturb the provider's default flag.
      expect(caps?.isDefault, `${provider} isDefault`).toBe(true);
      // resolveModelCapabilities (the unified dispatcher hosts call) agrees.
      expect(resolveModelCapabilities(provider, model)?.contextWindow).toBe(1_000_000);
      // C3: getProviderModelDescriptors must NOT double-list the self-colliding
      // default model appears exactly once, carrying its override.
      const defaultDescriptors = getProviderModelDescriptors(provider).filter((d) => d.id === model);
      expect(defaultDescriptors, `${provider} ${model} descriptor count`).toHaveLength(1);
      expect(defaultDescriptors[0]?.contextWindow).toBe(1_000_000);
    }
  });

  it('exposes deepseek-v4 series at 1M context', () => {
    expect(getModelCapabilities('deepseek', 'deepseek-v4-flash')?.contextWindow).toBe(1_000_000);
    expect(getModelCapabilities('deepseek', 'deepseek-v4-pro')?.contextWindow).toBe(1_000_000);
  });

  it('registers glm-5.3-flash (native multimodal, 1M) on all three Zhipu routes', () => {
    for (const provider of ['zhipu', 'zhipu-coding', 'zai-coding'] as const) {
      const caps = getModelCapabilities(provider, 'glm-5.3-flash');
      expect(caps?.contextWindow, `${provider} ctx`).toBe(1_000_000);
      expect(caps?.maxOutputTokens, `${provider} maxOut`).toBe(131_072);
      // Text params identical to GLM-5.3 per bigmodel docs — the flash cannot
      // disable thinking either, so it reuses the zai-glm-5.3 effort mapping.
      expect(caps?.reasoningCapability, `${provider} reasoning`).toBe('native-effort');
      expect(caps?.reasoningProfile).toMatchObject({
        reasoningPreset: 'zai-glm-5.3',
        defaultEffort: 'max',
        supportsDisabledThinking: false,
      });
    }
  });

  it('exposes effort-first reasoning metadata on built-in model capabilities', () => {
    expect(getModelCapabilities('openai', 'gpt-5.3-codex')?.reasoningProfile).toMatchObject({
      effortStrategy: 'openai-chat-effort',
      defaultEffort: 'medium',
    });
    expect(getModelCapabilities('codex-cli', KODAX_PROVIDER_SNAPSHOTS['codex-cli'].model)?.reasoningProfile)
      .toMatchObject({
        effortStrategy: 'codex-cli-config',
        allowCustomEffort: true,
      });
    expect(getModelCapabilities('anthropic', 'claude-opus-4-8')?.reasoningProfile).toMatchObject({
      effortStrategy: 'anthropic-output-effort',
      thinkingStrategy: 'anthropic-adaptive',
    });
  });

  it('exposes Ark Coding per-model context windows (glm-5.2=1M, k2.7-code=256K, M3=1M, M2.7=204K, v4=1M, doubao=256K)', () => {
    // 2026-07-03 catalog refresh: Ark retired glm-5.1 / glm-4.7 /
    // deepseek-v3.2 (wire returns UnsupportedModel 404). GLM-5.2
    // promoted to default (wire alias glm-latest). Doubao Seed Code
    // (next-gen, no "2.0" suffix) added.
    expect(getModelCapabilities('ark-coding', 'glm-5.2')?.contextWindow).toBe(1_000_000);
    expect(getModelCapabilities('ark-coding', 'kimi-k2.7-code')?.contextWindow).toBe(256_000);
    expect(getModelCapabilities('ark-coding', 'kimi-k2.6')?.contextWindow).toBe(256_000);
    expect(getModelCapabilities('ark-coding', 'MiniMax-M3')?.contextWindow).toBe(1_000_000);
    expect(getModelCapabilities('ark-coding', 'MiniMax-M2.7')?.contextWindow).toBe(204_800);
    expect(getModelCapabilities('ark-coding', 'deepseek-v4-pro')?.contextWindow).toBe(1_000_000);
    expect(getModelCapabilities('ark-coding', 'deepseek-v4-flash')?.contextWindow).toBe(1_000_000);
    expect(getModelCapabilities('ark-coding', 'doubao-seed-2.0-code')?.contextWindow).toBe(256_000);
    expect(getModelCapabilities('ark-coding', 'doubao-seed-2.0-pro')?.contextWindow).toBe(256_000);
    expect(getModelCapabilities('ark-coding', 'doubao-seed-2.0-lite')?.contextWindow).toBe(256_000);
    expect(getModelCapabilities('ark-coding', 'doubao-seed-code')?.contextWindow).toBe(256_000);
  });

  it('returns undefined only for an unknown provider', () => {
    expect(getModelCapabilities('nonexistent', 'whatever')).toBeUndefined();
  });

  it('inherits provider-level capability for an unknown model under a known provider', () => {
    const caps = getModelCapabilities('anthropic', 'claude-2-not-shipped');
    const defaultCaps = getModelCapabilities(
      'anthropic',
      KODAX_PROVIDER_SNAPSHOTS['anthropic'].model,
    );
    expect(caps).toBeDefined();
    expect(caps?.model).toBe('claude-2-not-shipped');
    expect(caps?.isDefault).toBe(false);
    // Optimistic-wide default: a new/uncatalogued model id gets the family's
    // reasoning ladder + context window instead of collapsing to undefined.
    expect(caps?.reasoningProfile).toEqual(defaultCaps?.reasoningProfile);
    expect(caps?.contextWindow).toBe(defaultCaps?.contextWindow);
  });

  it('descriptors list default first, then alternatives, per provider', () => {
    const descriptors = getProviderModelDescriptors('anthropic');
    expect(descriptors[0]?.id).toBe('claude-sonnet-4-6'); // default
    expect(descriptors.map((d) => d.id)).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('CLI-bridge providers (gemini-cli, codex-cli) leave context fields undefined', () => {
    const gemini = getModelCapabilities('gemini-cli', KODAX_PROVIDER_SNAPSHOTS['gemini-cli'].model);
    expect(gemini?.contextWindow).toBeUndefined();
    expect(gemini?.maxOutputTokens).toBeUndefined();
    expect(gemini?.supportsThinking).toBe(false);

    const codex = getModelCapabilities('codex-cli', KODAX_PROVIDER_SNAPSHOTS['codex-cli'].model);
    expect(codex?.contextWindow).toBeUndefined();
    expect(codex?.maxOutputTokens).toBeUndefined();
    expect(codex?.supportsThinking).toBe(false);
  });

  it('listBuiltinModelCapabilities returns every (provider, model) pair', () => {
    const list = listBuiltinModelCapabilities();
    const routeKeys = list.map((c) => `${c.provider}/${c.model}`);

    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    // At least one entry per built-in provider; default models always present.
    const anthropicDefault = list.find(
      (c) => c.provider === 'anthropic' && c.model === 'claude-sonnet-4-6',
    );
    expect(anthropicDefault?.isDefault).toBe(true);
    const haiku = list.find((c) => c.provider === 'anthropic' && c.model === 'claude-haiku-4-5');
    expect(haiku?.isDefault).toBe(false);
    // Spot-check coverage: minimax-coding listing carries both the M2.7
    // GA default and the M3 Frontier Coding model (2026-06 gateway
    // retired the M2.5 / M2.1 / M2 family).
    const minimaxModels = list.filter((c) => c.provider === 'minimax-coding').map((c) => c.model);
    expect(minimaxModels).toContain('MiniMax-M2.7');
    expect(minimaxModels).toContain('MiniMax-M3');
  });

  it('NO API key needed — env vars stay unset throughout (refuted Space hypothesis)', () => {
    const originalKeys = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'KIMI_API_KEY',
      'ZHIPU_API_KEY',
      'ARK_CODING_API_KEY',
    ].map((k) => [k, process.env[k]] as const);

    // Clear keys for the duration of this assertion.
    for (const [k] of originalKeys) delete process.env[k];

    try {
      // None of these calls should throw despite zero API keys configured.
      expect(() => getModelCapabilities('anthropic', 'claude-sonnet-4-6')).not.toThrow();
      expect(() => getProviderModelDescriptors('deepseek')).not.toThrow();
      expect(() => listBuiltinModelCapabilities()).not.toThrow();
      expect(getModelCapabilities('anthropic', 'claude-sonnet-4-6')?.contextWindow).toBe(200_000);
    } finally {
      for (const [k, v] of originalKeys) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('custom provider model capabilities', () => {
  afterEach(() => {
    // Reset custom registry between tests.
    registerCustomProviders([]);
  });

  it('exposes custom provider with per-model overrides + provider-level fallback', () => {
    registerCustomProviders([
      {
        name: 'my-corp-llm',
        baseUrl: 'https://internal.example.com/v1',
        apiKeyEnv: 'MY_CORP_LLM_API_KEY',
        protocol: 'openai',
        model: 'corp-default',
        models: [
          // Per-model override:
          { id: 'corp-long', displayName: 'Corp Long-Context', contextWindow: 2_000_000 },
          // String-only (inherits provider-level):
          'corp-mini',
        ],
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        supportsThinking: true,
        thinkingBudgetCap: 8_000,
        reasoningCapability: 'native-effort',
      },
    ]);

    const longCaps = getCustomModelCapabilities('my-corp-llm', 'corp-long');
    expect(longCaps?.contextWindow).toBe(2_000_000); // descriptor override
    expect(longCaps?.maxOutputTokens).toBe(16_000); // provider fallback

    const miniCaps = getCustomModelCapabilities('my-corp-llm', 'corp-mini');
    expect(miniCaps?.contextWindow).toBe(128_000); // provider fallback
    expect(miniCaps?.maxOutputTokens).toBe(16_000);

    const defaultCaps = getCustomModelCapabilities('my-corp-llm', 'corp-default');
    expect(defaultCaps?.isDefault).toBe(true);
    expect(defaultCaps?.contextWindow).toBe(128_000);
    expect(defaultCaps?.supportsThinking).toBe(true);
    expect(defaultCaps?.thinkingBudgetCap).toBe(8_000);
    expect(defaultCaps?.reasoningCapability).toBe('native-effort');
  });

  it('honors a models[] override when the custom default model has its own entry (R3 regression)', () => {
    registerCustomProviders([
      {
        name: 'corp-gateway',
        baseUrl: 'https://gw.example.com/v1',
        apiKeyEnv: 'CORP_GATEWAY_API_KEY',
        protocol: 'openai',
        model: 'corp-default',
        models: [
          // The DEFAULT model declares its own override — pre-fix this was dropped
          // in favor of the bare {id} default descriptor + provider-level values.
          { id: 'corp-default', displayName: 'Corp Default', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
        ],
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      },
    ]);
    const caps = getCustomModelCapabilities('corp-gateway', 'corp-default');
    expect(caps?.contextWindow).toBe(1_000_000);
    expect(caps?.maxOutputTokens).toBe(131_072);
    expect(caps?.isDefault).toBe(true);
  });

  it('returns undefined for unknown custom-provider / model', () => {
    expect(getCustomModelCapabilities('does-not-exist', 'm')).toBeUndefined();
  });

  it('listCustomProviderModelCapabilities returns default-first per provider', () => {
    registerCustomProviders([
      {
        name: 'cp-a',
        baseUrl: 'https://a.example/v1',
        apiKeyEnv: 'CP_A_API_KEY',
        protocol: 'openai',
        model: 'a-1',
        models: ['a-2', { id: 'a-3', contextWindow: 64_000 }],
        contextWindow: 32_000,
      },
    ]);
    const list = listCustomProviderModelCapabilities();
    expect(list.map((c) => c.model)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(list[0]?.isDefault).toBe(true);
    expect(list.find((c) => c.model === 'a-3')?.contextWindow).toBe(64_000);
  });

  it('descriptor listing handles legacy `models: string[]` entries', () => {
    registerCustomProviders([
      {
        name: 'legacy-cp',
        baseUrl: 'https://l.example/v1',
        apiKeyEnv: 'LEGACY_CP_API_KEY',
        protocol: 'openai',
        model: 'legacy-default',
        models: ['legacy-alt-1', 'legacy-alt-2'],
      },
    ]);
    const descriptors = getCustomProviderModelDescriptors('legacy-cp');
    expect(descriptors?.map((d) => d.id)).toEqual([
      'legacy-default',
      'legacy-alt-1',
      'legacy-alt-2',
    ]);
  });

  it('uses the models[] override as the default descriptor when the custom default model has its own entry (R3 regression)', () => {
    // Parity with getCustomModelCapabilities' descriptor-first precedence: when the
    // default model also declares a models[] entry with overrides, the DEFAULT
    // descriptor must carry those overrides (contextWindow / maxOutputTokens /
    // displayName), not a bare {id}. Pre-fix the descriptor list returned a bare
    // default while getCustomModelCapabilities returned the override — the two SDK
    // surfaces disagreed for the same provider/model, so a picker UI built on the
    // descriptor list showed missing metadata for the default model.
    registerCustomProviders([
      {
        name: 'corp-gateway',
        baseUrl: 'https://gw.example.com/v1',
        apiKeyEnv: 'CORP_GATEWAY_API_KEY',
        protocol: 'openai',
        model: 'corp-default',
        models: [
          { id: 'corp-default', displayName: 'Corp Default', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
          { id: 'corp-alt', contextWindow: 64_000 },
        ],
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      },
    ]);
    const descriptors = getCustomProviderModelDescriptors('corp-gateway');
    // Default still first, listed exactly once (not duplicated), carrying its override.
    expect(descriptors?.map((d) => d.id)).toEqual(['corp-default', 'corp-alt']);
    expect(descriptors?.[0]?.contextWindow).toBe(1_000_000);
    expect(descriptors?.[0]?.maxOutputTokens).toBe(131_072);
    expect(descriptors?.[0]?.displayName).toBe('Corp Default');
    // The two SDK surfaces now agree for the default model.
    const caps = getCustomModelCapabilities('corp-gateway', 'corp-default');
    expect(caps?.contextWindow).toBe(descriptors?.[0]?.contextWindow);
    expect(caps?.maxOutputTokens).toBe(descriptors?.[0]?.maxOutputTokens);
  });

  it('maps custom provider reasoningPreset into effective reasoning metadata', () => {
    registerCustomProviders([
      {
        name: 'glm-custom',
        baseUrl: 'https://glm.example/v1',
        apiKeyEnv: 'GLM_CUSTOM_API_KEY',
        protocol: 'openai',
        model: 'glm-5.2',
        reasoningPreset: 'zai-glm-5.2',
        reasoning: { defaultEffort: 'high' },
      },
    ]);

    const caps = getCustomModelCapabilities('glm-custom', 'glm-5.2');
    expect(caps?.reasoningCapability).toBe('native-effort');
    expect(caps?.supportsThinking).toBe(true);
    expect(caps?.reasoningProfile).toMatchObject({
      reasoningPreset: 'zai-glm-5.2',
      effortStrategy: 'openai-chat-effort',
      defaultEffort: 'high',
    });
  });

  it('maps per-model custom reasoningPreset and keeps prompt-only supportsThinking false', () => {
    registerCustomProviders([
      {
        name: 'mixed-custom',
        baseUrl: 'https://mixed.example/v1',
        apiKeyEnv: 'MIXED_CUSTOM_API_KEY',
        protocol: 'anthropic',
        model: 'default-toggle',
        reasoningPreset: 'mimo-v2.5-toggle',
        models: [
          { id: 'kimi-code', reasoningPreset: 'kimi-k2.7-code' },
        ],
      },
    ]);

    const defaultCaps = getCustomModelCapabilities('mixed-custom', 'default-toggle');
    expect(defaultCaps?.reasoningCapability).toBe('native-toggle');
    expect(defaultCaps?.supportsThinking).toBe(true);

    const kimiCaps = getCustomModelCapabilities('mixed-custom', 'kimi-code');
    expect(kimiCaps?.reasoningCapability).toBe('prompt-only');
    expect(kimiCaps?.supportsThinking).toBe(false);
    expect(kimiCaps?.reasoningProfile).toMatchObject({
      reasoningPreset: 'kimi-k2.7-code',
      effortStrategy: 'prompt-only',
      localRejectEfforts: ['none', 'minimal'],
    });
  });
});

describe('unified dispatcher (resolveModelCapabilities, resolveProviderModelDescriptors)', () => {
  afterEach(() => {
    registerCustomProviders([]);
  });

  it('routes built-in names to built-in path', () => {
    const caps = resolveModelCapabilities('kimi', 'kimi-k2.6');
    expect(caps?.contextWindow).toBe(262_144);
  });

  it('routes custom names to custom path', () => {
    registerCustomProviders([
      {
        name: 'dispatched-cp',
        baseUrl: 'https://x.example/v1',
        apiKeyEnv: 'DISPATCHED_CP_API_KEY',
        protocol: 'openai',
        model: 'dispatched-model',
        contextWindow: 999_999,
      },
    ]);
    const caps = resolveModelCapabilities('dispatched-cp', 'dispatched-model');
    expect(caps?.contextWindow).toBe(999_999);
  });

  it('listAllModelCapabilities merges built-in + custom', () => {
    registerCustomProviders([
      {
        name: 'merge-cp',
        baseUrl: 'https://m.example/v1',
        apiKeyEnv: 'MERGE_CP_API_KEY',
        protocol: 'openai',
        model: 'merge-default',
      },
    ]);
    const list = listAllModelCapabilities();
    expect(list.some((c) => c.provider === 'anthropic')).toBe(true);
    expect(list.some((c) => c.provider === 'merge-cp')).toBe(true);
    // Built-in providers come before custom in the merged list.
    const firstBuiltin = list.findIndex((c) => c.provider === 'anthropic');
    const firstCustom = list.findIndex((c) => c.provider === 'merge-cp');
    expect(firstBuiltin).toBeLessThan(firstCustom);
  });

  it('resolveProviderModelDescriptors returns empty array (not undefined) for unknown name', () => {
    expect(resolveProviderModelDescriptors('totally-unknown')).toEqual([]);
  });
});

describe('snapshot drift guard: every Provider class config matches snapshot data', () => {
  // This is the safety net for the v0.7.43 DRY refactor: if anyone re-adds
  // capability fields to a Provider class's `buildProviderConfig({...})`
  // extras instead of editing the snapshot, the value would drift. Since
  // Provider construction throws on missing API key for built-ins, we
  // verify the snapshot directly — `buildProviderConfig` is exercised
  // implicitly by every Provider import.

  it('every snapshot with supportsThinking=true also declares contextWindow + maxOutputTokens', () => {
    for (const [name, snapshot] of Object.entries(KODAX_PROVIDER_SNAPSHOTS)) {
      if (snapshot.supportsThinking) {
        expect(
          snapshot.contextWindow,
          `provider ${name} has supportsThinking=true but no contextWindow`,
        ).toBeDefined();
        expect(
          snapshot.maxOutputTokens,
          `provider ${name} has supportsThinking=true but no maxOutputTokens`,
        ).toBeDefined();
      }
    }
  });

  it('every `models[]` entry is a KodaXModelDescriptor object (not string)', () => {
    for (const [name, snapshot] of Object.entries(KODAX_PROVIDER_SNAPSHOTS)) {
      for (const entry of snapshot.models ?? []) {
        expect(
          typeof entry,
          `provider ${name} has string model entry — should be KodaXModelDescriptor`,
        ).toBe('object');
        expect(entry).toHaveProperty('id');
      }
    }
  });
});
