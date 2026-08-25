import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCustomProvider, registerCustomProviders } from '@kodax-ai/llm';

import { evaluateProviderPolicy } from '../provider-policy.js';
import type { KodaXInputArtifact } from './index.js';
import { getModelInputCapabilities, validateInputArtifactsForModel } from './index.js';

// SDK composition chain for embedders: a custom provider declared with
// imageInput:true must pass every gate the runtime applies to image
// artifacts — the media capability/validator surface (re-exported here,
// the same surface run-substrate / runner-driven call) and the SA
// provider-policy gate (multimodal hints must not block).
const VLLM_CUSTOM = {
  name: 'my-vllm',
  protocol: 'openai',
  baseUrl: 'http://localhost:8000/v1',
  apiKeyEnv: 'MY_VLLM_API_KEY',
  model: 'Qwen/Qwen3.8-27B-Instruct',
  imageInput: true,
} as const;

const IMAGE_ARTIFACT: KodaXInputArtifact = {
  kind: 'image',
  path: '/tmp/shot.png',
  mediaType: 'image/png',
  source: 'clipboard',
};

describe('custom provider imageInput (SDK chain)', () => {
  afterEach(() => {
    registerCustomProviders([]);
    vi.unstubAllEnvs();
  });

  it('reports image support through the SDK media surface', () => {
    registerCustomProviders([{ ...VLLM_CUSTOM }]);

    const caps = getModelInputCapabilities({
      provider: 'my-vllm',
      model: 'Qwen/Qwen3.8-27B-Instruct',
    });
    expect(caps.image.status).toBe('supported');
    expect(caps.image.sdkSupported).toBe(true);
  });

  it('accepts image artifacts through validateInputArtifactsForModel', () => {
    registerCustomProviders([{ ...VLLM_CUSTOM }]);

    expect(() => validateInputArtifactsForModel([IMAGE_ARTIFACT], {
      provider: 'my-vllm',
      model: 'Qwen/Qwen3.8-27B-Instruct',
    })).not.toThrow();
  });

  it('rejects image artifacts when the custom provider has no imageInput', () => {
    const { imageInput: _ignored, ...textOnly } = VLLM_CUSTOM;
    registerCustomProviders([{ ...textOnly }]);

    expect(() => validateInputArtifactsForModel([IMAGE_ARTIFACT], {
      provider: 'my-vllm',
      model: 'Qwen/Qwen3.8-27B-Instruct',
    })).toThrowError(/cannot consume image artifacts/);
  });

  it('does not block multimodal-hinted flows in the provider-policy gate', () => {
    vi.stubEnv('MY_VLLM_API_KEY', 'test-key');
    const provider = createCustomProvider({ ...VLLM_CUSTOM });

    const decision = evaluateProviderPolicy({
      providerName: 'my-vllm',
      model: 'Qwen/Qwen3.8-27B-Instruct',
      provider,
      hints: { multimodal: true },
    });

    expect(decision.status).not.toBe('block');
    expect(decision.issues.map((issue) => issue.code)).not.toContain('multimodal-unsupported');
  });

  it('still blocks multimodal hints for a custom provider without imageInput', () => {
    vi.stubEnv('MY_VLLM_API_KEY', 'test-key');
    const { imageInput: _ignored, ...textOnly } = VLLM_CUSTOM;
    const provider = createCustomProvider({ ...textOnly });

    const decision = evaluateProviderPolicy({
      providerName: 'my-vllm',
      model: 'Qwen/Qwen3.8-27B-Instruct',
      provider,
      hints: { multimodal: true },
    });

    expect(decision.status).toBe('block');
    expect(decision.issues.map((issue) => issue.code)).toContain('multimodal-unsupported');
  });
});
