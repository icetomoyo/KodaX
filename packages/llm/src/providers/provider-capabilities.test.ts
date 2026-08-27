/**
 * FEATURE_198 v0.7.44 — Provider capability JSON loader tests.
 *
 * Coverage:
 *   - JSON file schema validation (happy path)
 *   - Validator rejects each major failure mode (missing required,
 *     wrong type, unknown profile, cliBridge contradiction)
 *   - Loader cache behavior (single read per process)
 *   - `_resetProviderSnapshotsCache` test hook
 *   - Profile-name → object resolution
 *   - CLI-bridge dynamic fill (gemini-cli / codex-cli)
 *   - **Drift guard**: every known KODAX provider exists in JSON with
 *     the right shape (catches accidental field deletions in JSON edits)
 *   - **Cross-check**: loader output identity for selected providers
 *     against hard-coded expected values (catches data mis-transcription
 *     during the F198 split)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';
import { KODAX_PROVIDER_SNAPSHOTS } from './registry.js';
import {
  _resetProviderSnapshotsCache,
  getProviderSnapshots,
} from './provider-capabilities.loader.js';
import { validateProviderCapabilitiesJson } from './provider-capabilities.types.js';

describe('FEATURE_198 — provider-capabilities loader', () => {
  beforeEach(() => {
    _resetProviderSnapshotsCache();
  });

  describe('basic loading', () => {
    it('reads JSON from disk and produces the expected provider keys', () => {
      const snapshots = getProviderSnapshots();
      const names = Object.keys(snapshots).sort();
      expect(names).toEqual(
        [
          'anthropic',
          'ark-coding',
          'codex-cli',
          'deepseek',
          'gemini-cli',
          'kimi',
          'kimi-code',
          'minimax-coding',
          'mimo',
          'mimo-coding',
          'openai',
          'qwen',
          'qwen-token-plan',
          'zai-coding',
          'zhipu',
          'zhipu-coding',
        ].sort(),
      );
    });

    it('caches the snapshot — second call returns the same object identity', () => {
      const a = getProviderSnapshots();
      const b = getProviderSnapshots();
      expect(a).toBe(b);
    });

    it('_resetProviderSnapshotsCache forces a fresh load', () => {
      const a = getProviderSnapshots();
      _resetProviderSnapshotsCache();
      const b = getProviderSnapshots();
      expect(a).not.toBe(b);
      // Same data, different identity
      expect(b).toEqual(a);
    });
  });

  describe('profile-name resolution', () => {
    it('resolves "image-input-native" to the imported profile object', () => {
      const anthropic = getProviderSnapshots().anthropic;
      expect(anthropic.capabilityProfile).toBe(
        IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
      );
    });

    it('resolves "image-input-cli-bridge" for gemini-cli', () => {
      const gemini = getProviderSnapshots()['gemini-cli'];
      expect(gemini.capabilityProfile).toBe(
        IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
      );
    });

    it('resolves "cli-bridge" for codex-cli', () => {
      const codex = getProviderSnapshots()['codex-cli'];
      expect(codex.capabilityProfile).toBe(CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE);
    });
  });

  describe('CLI-bridge dynamic fill', () => {
    it('gemini-cli has a non-empty model string filled from cli-bridge-models', () => {
      const gemini = getProviderSnapshots()['gemini-cli'];
      expect(typeof gemini.model).toBe('string');
      expect(gemini.model.length).toBeGreaterThan(0);
      expect(Array.isArray(gemini.models)).toBe(true);
      // models[] excludes the default
      for (const m of gemini.models ?? []) {
        expect(m.id).not.toBe(gemini.model);
      }
    });

    it('codex-cli has a non-empty model string filled from cli-bridge-models', () => {
      const codex = getProviderSnapshots()['codex-cli'];
      expect(typeof codex.model).toBe('string');
      expect(codex.model.length).toBeGreaterThan(0);
      expect(Array.isArray(codex.models)).toBe(true);
      for (const m of codex.models ?? []) {
        expect(m.id).not.toBe(codex.model);
      }
    });
  });

  describe('snapshot frozen', () => {
    it('top-level snapshot map is frozen', () => {
      const snap = getProviderSnapshots();
      expect(Object.isFrozen(snap)).toBe(true);
    });

    it('per-provider snapshot object is frozen', () => {
      const snap = getProviderSnapshots();
      expect(Object.isFrozen(snap.anthropic)).toBe(true);
    });

    it('models array is frozen', () => {
      const snap = getProviderSnapshots();
      const models = snap.anthropic.models;
      expect(Array.isArray(models)).toBe(true);
      expect(Object.isFrozen(models)).toBe(true);
      // each descriptor frozen too
      if (models) {
        for (const m of models) {
          expect(Object.isFrozen(m)).toBe(true);
        }
      }
    });
  });

  describe('registry KODAX_PROVIDER_SNAPSHOTS export', () => {
    it('exports the same snapshot the loader produced', () => {
      const fromLoader = getProviderSnapshots();
      // KODAX_PROVIDER_SNAPSHOTS was initialized at module load; loader
      // cache reset above means a fresh `getProviderSnapshots()` is a
      // DIFFERENT object identity. But the data must be deep-equal.
      expect(KODAX_PROVIDER_SNAPSHOTS).toEqual(fromLoader);
    });
  });

  describe('field-level cross-check (catches data mis-transcription)', () => {
    // The following block hard-codes the EXPECTED values for each
    // statically-known field. If a JSON edit drops or mis-types a value,
    // this fails immediately. CLI-bridge dynamic fields (model/models)
    // are NOT asserted here — they're verified separately above.

    it('anthropic: full field set matches expected', () => {
      const a = getProviderSnapshots().anthropic;
      expect(a.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      expect(a.model).toBe('claude-sonnet-4-6');
      expect(a.reasoningCapability).toBe('native-adaptive');
      expect(a.reasoningProfile).toMatchObject({
        reasoningPreset: 'claude-adaptive-max',
        effortStrategy: 'anthropic-output-effort',
        thinkingStrategy: 'anthropic-adaptive',
        defaultEffort: 'high',
      });
      expect(a.supportsThinking).toBe(true);
      expect(a.contextWindow).toBe(200000);
      expect(a.maxOutputTokens).toBe(64000);
      expect(a.thinkingBudgetCap).toBe(28000);
      expect(a.models).toEqual([
        expect.objectContaining({
          id: 'claude-opus-4-8',
          displayName: 'Opus 4.8',
          reasoningCapability: 'native-adaptive',
          reasoningProfile: expect.objectContaining({
            reasoningPreset: 'claude-adaptive-xhigh',
            effortStrategy: 'anthropic-output-effort',
            thinkingStrategy: 'anthropic-adaptive',
            defaultEffort: 'high',
          }),
          contextWindow: 1000000,
          maxOutputTokens: 128000,
        }),
        expect.objectContaining({
          id: 'claude-opus-4-7',
          displayName: 'Opus 4.7',
          reasoningCapability: 'native-adaptive',
          reasoningProfile: expect.objectContaining({
            reasoningPreset: 'claude-adaptive-xhigh',
            effortStrategy: 'anthropic-output-effort',
            thinkingStrategy: 'anthropic-adaptive',
            defaultEffort: 'high',
          }),
          contextWindow: 1000000,
          maxOutputTokens: 128000,
        }),
        expect.objectContaining({
          id: 'claude-opus-4-6',
          displayName: 'Opus 4.6',
          reasoningCapability: 'native-adaptive',
          reasoningProfile: expect.objectContaining({
            reasoningPreset: 'claude-adaptive-max',
          }),
          thinkingBudgetCap: 28000,
        }),
        expect.objectContaining({
          id: 'claude-haiku-4-5',
          displayName: 'Haiku 4.5',
          reasoningCapability: 'native-budget',
          reasoningProfile: expect.objectContaining({
            reasoningPreset: 'anthropic-budget',
            effortStrategy: 'provider-budget',
          }),
          thinkingBudgetCap: 10000,
        }),
      ]);
    });

    it('exposes effort-first reasoning metadata for OpenAI and Codex CLI', () => {
      const snap = getProviderSnapshots();
      expect(snap.openai.reasoningProfile).toMatchObject({
        effortStrategy: 'openai-chat-effort',
        defaultEffort: 'medium',
        supportsReasoningEffort: true,
      });
      expect(snap.openai.reasoningProfile?.supportedEfforts?.map((preset) => preset.value)).toEqual([
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
      expect(snap['codex-cli'].reasoningProfile).toMatchObject({
        effortStrategy: 'codex-cli-config',
        defaultEffort: 'medium',
        allowCustomEffort: true,
      });
    });

    it('deepseek: KODAX_ESCALATED_MAX_OUTPUT_TOKENS resolved to 64000', () => {
      const d = getProviderSnapshots().deepseek;
      expect(d.maxOutputTokens).toBe(64000);
      expect(d.contextWindow).toBe(1_000_000);
    });

    it('kimi-code: defaults to the direct K3 256K route and retains both K2.7 Code routes', () => {
      const k = getProviderSnapshots()['kimi-code'];
      expect(k.model).toBe('k3-256k');
      expect(k.maxOutputTokens).toBe(32000);
      expect(k.contextWindow).toBe(262_144);
      expect(k.models?.map((model) => model.id)).toEqual([
        'k3',
        'k3-256k',
        'kimi-for-coding',
        'kimi-for-coding-highspeed',
      ]);
      expect(k.models?.find((model) => model.id === 'k3')).toEqual(
        expect.objectContaining({
          displayName: 'Kimi K3 (1M, Allegretto+)',
          contextWindow: 1_048_576,
          reasoningCapability: 'native-effort',
          reasoningProfile: expect.objectContaining({
            reasoningPreset: 'kimi-k3',
            defaultEffort: 'high',
            disabledEfforts: ['none'],
          }),
        }),
      );
      expect(k.models?.find((model) => model.id === 'k3-256k')).toEqual(
        expect.objectContaining({
          displayName: 'Kimi K3 (256K, Moderato)',
          contextWindow: 262_144,
          reasoningCapability: 'native-effort',
          reasoningProfile: expect.objectContaining({
            reasoningPreset: 'kimi-k3',
            defaultEffort: 'high',
            disabledEfforts: ['none'],
          }),
        }),
      );
      expect(k.models?.find((model) => model.id === 'k3-256k')).not.toHaveProperty('wireModel');
    });

    it('kimi: retains the K2.7 default and exposes public K3 with the Kimi Code K3 parameters', () => {
      const k = getProviderSnapshots().kimi;
      expect(k.model).toBe('kimi-k2.7-code');
      expect(k.contextWindow).toBe(262_144);
      expect(k.reasoningProfile).toEqual(expect.objectContaining({
        reasoningPreset: 'kimi-k2.7-code',
        effortStrategy: 'prompt-only',
        localRejectEfforts: ['none', 'minimal'],
      }));
      expect(k.models?.map((model) => model.id)).toEqual([
        'kimi-k3',
        'kimi-k2.7-code-highspeed',
        'kimi-k2.6',
        'kimi-k2.5',
      ]);
      expect(k.models?.find((model) => model.id === 'kimi-k3')).toEqual(
        expect.objectContaining({
          displayName: 'Kimi K3',
          contextWindow: 1_048_576,
          maxOutputTokens: 32_000,
          reasoningCapability: 'native-effort',
          reasoningProfile: expect.objectContaining({
            reasoningPreset: 'kimi-k3',
            defaultEffort: 'high',
            disabledEfforts: ['none'],
          }),
        }),
      );
      expect(k.models?.find((model) => model.id === 'kimi-k2.7-code-highspeed')).toEqual(
        expect.objectContaining({ displayName: 'Kimi K2.7 Code HighSpeed' }),
      );
    });

    it('zhipu: GLM-5.3 model descriptor carries the documented 1M / 128K limits', () => {
      const z = getProviderSnapshots().zhipu;
      expect(z.models?.find((m) => m.id === 'glm-5.3')).toEqual(expect.objectContaining({
        id: 'glm-5.3',
        displayName: 'GLM-5.3',
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningCapability: 'native-effort',
        reasoningProfile: expect.objectContaining({
          reasoningPreset: 'zai-glm-5.3',
          effortStrategy: 'openai-chat-effort',
          defaultEffort: 'max',
          effortAliases: expect.objectContaining({
            minimal: 'low',
            light: 'low',
            medium: 'high',
            xhigh: 'max',
            ultra: 'max',
          }),
        }),
      }));
      // The ordinary BigModel API is still marked "coming soon" for GLM-5.3;
      // registering the model must not silently promote it to the live default.
      expect(z.model).toBe('glm-5');
    });

    it('zhipu-coding: bench-tuned 16K maxOutputTokens + thinkingBudgetCap', () => {
      const z = getProviderSnapshots()['zhipu-coding'];
      expect(z.maxOutputTokens).toBe(16000);
      expect(z.thinkingBudgetCap).toBe(16000);
      expect(z.contextWindow).toBe(200000);
      expect(z.models?.find((m) => m.id === 'glm-5.3')).toEqual(expect.objectContaining({
        id: 'glm-5.3',
        displayName: 'GLM-5.3',
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningCapability: 'native-effort',
        reasoningProfile: expect.objectContaining({
          reasoningPreset: 'zai-glm-5.3',
          effortStrategy: 'openai-chat-effort',
          defaultEffort: 'max',
        }),
      }));
      expect(z.models?.find((m) => m.id === 'glm-5.2')).toEqual(expect.objectContaining({
        id: 'glm-5.2',
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningProfile: expect.objectContaining({ reasoningPreset: 'zai-glm-5.2' }),
      }));
      // GLM-5.2 remains an explicit rollback choice during the 5.3 rollout;
      // glm-5.3-flash (2026-08-26, native multimodal) sits right after 5.3.
      expect(z.model).toBe('glm-5.3');
      expect(z.models?.map((m) => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5-turbo', 'glm-4.7']);
      expect(z.models?.find((m) => m.id === 'glm-4.7')).toEqual(expect.objectContaining({
        id: 'glm-4.7',
        displayName: 'GLM-4.7',
        contextWindow: 200_000,
        reasoningCapability: 'native-toggle',
        reasoningProfile: expect.objectContaining({
          reasoningPreset: 'zai-glm-toggle',
          effortStrategy: 'provider-toggle',
        }),
      }));
    });

    it('zai-coding defaults to GLM-5.3 while retaining GLM-5.2', () => {
      const z = getProviderSnapshots()['zai-coding'];
      expect(z.model).toBe('glm-5.3');
      expect(z.models?.map((m) => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5-turbo', 'glm-4.7']);
      expect(z.reasoningProfile).toMatchObject({
        reasoningPreset: 'zai-glm-5.3',
        supportsDisabledThinking: false,
      });
      expect(z.models?.find((m) => m.id === 'glm-5.3-flash')).toEqual(expect.objectContaining({
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningProfile: expect.objectContaining({ reasoningPreset: 'zai-glm-5.3' }),
      }));
      expect(z.models?.find((m) => m.id === 'glm-5.2')).toEqual(expect.objectContaining({
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningProfile: expect.objectContaining({ reasoningPreset: 'zai-glm-5.2' }),
      }));
    });

    it('minimax-coding defaults future sessions to MiniMax-M3', () => {
      const minimax = getProviderSnapshots()['minimax-coding'];
      expect(minimax.model).toBe('MiniMax-M3');
      expect(minimax.contextWindow).toBe(1_000_000);
      expect(minimax.reasoningCapability).toBe('native-adaptive');
    });

    it('ark-coding: per-model contextWindow overrides preserved', () => {
      const a = getProviderSnapshots()['ark-coding'];
      expect(a.contextWindow).toBe(200000);
      expect(a.maxOutputTokens).toBe(32000);
      // 2026-07-03 catalog refresh: retired glm-5.1 / glm-4.7 /
      // deepseek-v3.2 (wire returns UnsupportedModel 404); GLM-5.2
      // promoted to default with 1M/128K override (wire alias
      // glm-latest); Doubao Seed Code (next-gen, no "2.0") added.
      // 2026-08-15: GLM-5.3 added and promoted to default (same 1M/128K
      // pin); glm-5.2 retained as an explicit rollback route.
      const glm53 = a.models?.find((m) => m.id === 'glm-5.3');
      const glm52 = a.models?.find((m) => m.id === 'glm-5.2');
      const v4pro = a.models?.find((m) => m.id === 'deepseek-v4-pro');
      const m3 = a.models?.find((m) => m.id === 'MiniMax-M3');
      const m27 = a.models?.find((m) => m.id === 'MiniMax-M2.7');
      const seedCode = a.models?.find((m) => m.id === 'doubao-seed-code');
      expect(glm53?.contextWindow).toBe(1_000_000);
      expect(glm53?.maxOutputTokens).toBe(128_000);
      expect(glm52?.contextWindow).toBe(1_000_000);
      expect(glm52?.maxOutputTokens).toBe(128_000);
      expect(v4pro?.contextWindow).toBe(1_000_000);
      expect(m3?.contextWindow).toBe(1_000_000);
      expect(m27?.contextWindow).toBe(204_800);
      expect(seedCode?.contextWindow).toBe(256_000);
    });
  });

  // FEATURE_216 v0.7.45 — per-provider verifyStrategy drift guard.
  // Distribution (from 2026-05-28 12-provider real+fake key probe):
  //   count-tokens (6):    anthropic + qwen-token-plan + 4 anthropic-coding (zhipu/kimi/minimax/ark)
  //   models-list (4):     openai, deepseek, kimi, qwen
  //   minimal-message (3): zhipu, mimo, mimo-coding (each empirical reason)
  //   unsupported (2):     gemini-cli, codex-cli
  describe('FEATURE_216 verifyStrategy per-provider', () => {
    it('count-tokens providers (6): anthropic + 5 anthropic-compatible plans', () => {
      const snap = getProviderSnapshots();
      for (const name of ['anthropic', 'zhipu-coding', 'kimi-code', 'minimax-coding', 'ark-coding', 'qwen-token-plan']) {
        expect(snap[name].verifyStrategy).toBe('count-tokens');
      }
    });

    it('models-list providers (4): openai-compat with auth-gated /v1/models', () => {
      const snap = getProviderSnapshots();
      for (const name of ['openai', 'deepseek', 'kimi', 'qwen']) {
        expect(snap[name].verifyStrategy).toBe('models-list');
      }
    });

    it('minimal-message providers (3): zhipu (public /models false-positive) + mimo+mimo-coding (count_tokens 404)', () => {
      const snap = getProviderSnapshots();
      for (const name of ['zhipu', 'mimo', 'mimo-coding']) {
        expect(snap[name].verifyStrategy).toBe('minimal-message');
      }
    });

    it('cli-bridge providers (2) MUST be unsupported (credentials in CLI binary)', () => {
      const snap = getProviderSnapshots();
      for (const name of ['gemini-cli', 'codex-cli']) {
        expect(snap[name].verifyStrategy).toBe('unsupported');
      }
    });

    it('all 16 providers have an explicit verifyStrategy (no silent default)', () => {
      const snap = getProviderSnapshots();
      const expected = new Set(['count-tokens', 'models-list', 'minimal-message', 'unsupported']);
      let total = 0;
      for (const [, s] of Object.entries(snap)) {
        expect(expected.has(s.verifyStrategy)).toBe(true);
        total++;
      }
      expect(total).toBe(16);
    });
  });
});

describe('FEATURE_198 — validator failure modes', () => {
  function shouldThrow(raw: unknown, matcher: RegExp | string): void {
    expect(() => validateProviderCapabilitiesJson(raw)).toThrow(matcher);
  }

  it('rejects non-object root', () => {
    shouldThrow(null, /root must be an object/);
    shouldThrow('foo', /root must be an object/);
  });

  it('rejects wrong version', () => {
    shouldThrow({ version: 2, updatedAt: 'x', providers: {} }, /version must be 1/);
  });

  it('rejects missing updatedAt', () => {
    shouldThrow({ version: 1, providers: {} }, /updatedAt/);
  });

  it('rejects missing providers', () => {
    shouldThrow({ version: 1, updatedAt: 'x' }, /providers must be an object/);
  });

  it('rejects unknown reasoningCapability', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'magic',
            capabilityProfile: 'native',
          },
        },
      },
      /reasoningCapability must be one of/,
    );
  });

  it('rejects unknown capabilityProfile', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'super-deluxe',
          },
        },
      },
      /capabilityProfile must be one of/,
    );
  });

  it('rejects static entry missing model', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
          },
        },
      },
      /model is required/,
    );
  });

  it('rejects cliBridge entry that defines model', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          'foo-cli': {
            apiKeyEnv: 'F',
            model: 'should-not-be-here',
            reasoningCapability: 'none',
            capabilityProfile: 'cli-bridge',
            cliBridge: true,
            verifyStrategy: 'unsupported',
          },
        },
      },
      /cliBridge entry but defines model/,
    );
  });

  it('rejects negative contextWindow', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
            contextWindow: -1,
          },
        },
      },
      /contextWindow must be a non-negative/,
    );
  });

  it('rejects non-array models', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
            models: 'not-an-array',
          },
        },
      },
      /models must be an array/,
    );
  });

  it('rejects model descriptor missing id', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
            models: [{ displayName: 'missing-id' }],
          },
        },
      },
      /id must be a non-empty string/,
    );
  });

  it('rejects a wireModel alias whose target is not declared', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'stable',
            models: [{ id: 'tier-alias', wireModel: 'missing-target' }],
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
          },
        },
      },
      /wireModel.*must reference a declared model/,
    );
  });

  it('accepts minimal valid static entry', () => {
    const result = validateProviderCapabilitiesJson({
      version: 1,
      updatedAt: 'x',
      providers: {
        foo: {
          apiKeyEnv: 'F',
          model: 'm',
          reasoningCapability: 'none',
          capabilityProfile: 'native',
          verifyStrategy: 'models-list',
        },
      },
    });
    expect(result.providers.foo.model).toBe('m');
    expect(result.providers.foo.verifyStrategy).toBe('models-list');
  });

  it('validates provider- and model-level output-token field capabilities', () => {
    const result = validateProviderCapabilitiesJson({
      version: 1,
      updatedAt: 'x',
      providers: {
        foo: {
          apiKeyEnv: 'F',
          model: 'openai-model',
          models: [
            { id: 'deepseek-model', maxOutputTokensField: 'max_tokens' },
          ],
          maxOutputTokensField: 'max_completion_tokens',
          reasoningCapability: 'none',
          capabilityProfile: 'native',
          verifyStrategy: 'models-list',
        },
      },
    });

    expect(result.providers.foo.maxOutputTokensField).toBe('max_completion_tokens');
    expect(result.providers.foo.models?.[0]?.maxOutputTokensField).toBe('max_tokens');

    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            maxOutputTokensField: 'completion_limit',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
          },
        },
      },
      /maxOutputTokensField.*must be one of max_tokens, max_completion_tokens/,
    );
  });

  it('accepts deprecated reasoningCapabilityV2 as a compatibility alias', () => {
    const result = validateProviderCapabilitiesJson({
      version: 1,
      updatedAt: 'x',
      providers: {
        foo: {
          apiKeyEnv: 'F',
          model: 'm',
          reasoningCapability: 'native-effort',
          reasoningCapabilityV2: {
            reasoningPreset: 'openai-chat-reasoning',
            effortStrategy: 'openai-chat-effort',
            defaultEffort: 'medium',
          },
          capabilityProfile: 'native',
          verifyStrategy: 'models-list',
        },
      },
    });

    expect(result.providers.foo.reasoningProfile).toMatchObject({
      reasoningPreset: 'openai-chat-reasoning',
      effortStrategy: 'openai-chat-effort',
    });
  });

  it('rejects mixed reasoningProfile and deprecated reasoningCapabilityV2', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'native-effort',
            reasoningProfile: {
              reasoningPreset: 'openai-chat-reasoning',
              effortStrategy: 'openai-chat-effort',
            },
            reasoningCapabilityV2: {
              reasoningPreset: 'openai-chat-reasoning',
              effortStrategy: 'openai-chat-effort',
            },
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
          },
        },
      },
      /must not define both reasoningProfile and deprecated reasoningCapabilityV2/,
    );
  });

  it('accepts minimal valid cliBridge entry', () => {
    const result = validateProviderCapabilitiesJson({
      version: 1,
      updatedAt: 'x',
      providers: {
        'foo-cli': {
          apiKeyEnv: 'F',
          cliBridge: true,
          reasoningCapability: 'prompt-only',
          capabilityProfile: 'cli-bridge',
          verifyStrategy: 'unsupported',
        },
      },
    });
    expect(result.providers['foo-cli'].cliBridge).toBe(true);
    expect(result.providers['foo-cli'].model).toBeUndefined();
    expect(result.providers['foo-cli'].verifyStrategy).toBe('unsupported');
  });

  // FEATURE_216 v0.7.45 — verifyStrategy validator
  it('rejects missing verifyStrategy', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
          },
        },
      },
      /verifyStrategy must be one of/,
    );
  });

  it('rejects unknown verifyStrategy', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'send-postcard',
          },
        },
      },
      /verifyStrategy must be one of/,
    );
  });

  it('rejects cliBridge entry whose verifyStrategy is not "unsupported"', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          'foo-cli': {
            apiKeyEnv: 'F',
            cliBridge: true,
            reasoningCapability: 'prompt-only',
            capabilityProfile: 'cli-bridge',
            verifyStrategy: 'count-tokens',
          },
        },
      },
      /cliBridge entry but verifyStrategy=/,
    );
  });
});
