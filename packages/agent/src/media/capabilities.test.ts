import { describe, expect, it } from 'vitest';

import { getModelInputCapabilities } from './capabilities.js';

const ARK_CODING_IMAGE_MODELS = [
  'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'MiniMax-M3',
] as const;

const QWEN_TOKEN_PLAN_IMAGE_MODELS = [
  'qwen3.8-max',
  'qwen3.8-max-preview',
  'qwen3.7-plus',
  'qwen3.6-flash',
] as const;

const QWEN_TOKEN_PLAN_TEXT_MODELS = [
  'qwen3.7-max',
  'glm-5.2',
  'deepseek-v4-pro',
] as const;

describe('getModelInputCapabilities', () => {
  it('supports official OpenAI image input from provider-specific capability metadata', () => {
    const caps = getModelInputCapabilities({ provider: 'openai' });
    expect(caps.image.status).toBe('supported');
    expect(caps.image.sdkSupported).toBe(true);
    expect(caps.video.status).toBe('unsupported');
    expect(caps.file.status).toBe('unsupported');
  });

  it('supports documented Kimi model aliases', () => {
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'kimi-k3' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'kimi-k3' }).video.status).toBe('provider-native-unwired');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'k2.6' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'k2.7-code' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'k2.7-code-highspeed' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'kimi-k2.5' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'k3' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'k3-256k' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'k3' }).video.status).toBe('provider-native-unwired');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'k3-256k' }).video.status).toBe('unsupported');
    expect(getModelInputCapabilities({ provider: 'kimi-code' }).video.status).toBe('unsupported');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'kimi-for-coding-highspeed' }).image.status).toBe('supported');
  });

  it.each(ARK_CODING_IMAGE_MODELS)(
    'supports image but not video input for verified Ark Coding route %s',
    (model) => {
      const caps = getModelInputCapabilities({ provider: 'ark-coding', model });
      expect(caps.image.status).toBe('supported');
      expect(caps.video.status).toBe('unsupported');
    },
  );

  it.each(['doubao-seed-2.0-lite', 'MiniMax-M2.7', 'deepseek-v4-pro'])(
    'keeps unverified nearby Ark Coding route %s image-unsupported',
    (model) => {
      expect(getModelInputCapabilities({ provider: 'ark-coding', model }).image.status).toBe('unsupported');
    },
  );

  it.each(QWEN_TOKEN_PLAN_IMAGE_MODELS)(
    'supports image input for verified Qwen Token Plan route %s',
    (model) => {
      expect(getModelInputCapabilities({ provider: 'qwen-token-plan', model }).image.status)
        .toBe('supported');
    },
  );

  it.each(QWEN_TOKEN_PLAN_TEXT_MODELS)(
    'keeps Qwen Token Plan text-only route %s image-unsupported',
    (model) => {
      expect(getModelInputCapabilities({ provider: 'qwen-token-plan', model }).image.status)
        .toBe('unsupported');
    },
  );

  it('supports image but not video input for the DeepSeek vision route', () => {
    const caps = getModelInputCapabilities({
      provider: 'deepseek',
      model: 'deepseek-v4-flash-vision-exp',
    });
    expect(caps.image.status).toBe('supported');
    expect(caps.video.status).toBe('unsupported');
  });

  it.each(['deepseek-v4-flash', 'deepseek-v4-pro'])(
    'keeps DeepSeek text-only route %s image-unsupported',
    (model) => {
      expect(getModelInputCapabilities({ provider: 'deepseek', model }).image.status)
        .toBe('unsupported');
    },
  );

  it('keeps the DeepSeek provider default model image-unsupported', () => {
    expect(getModelInputCapabilities({ provider: 'deepseek' }).image.status).toBe('unsupported');
  });

  it('supports documented non-official image models and their current defaults', () => {
    const supported = getModelInputCapabilities({
      provider: 'minimax-coding',
      model: 'minimax-m3',
    });
    expect(supported.image.status).toBe('supported');
    expect(supported.video.status).toBe('provider-native-unwired');
    expect(supported.video.nativeSupported).toBe(true);
    expect(supported.video.sdkSupported).toBe(false);
    expect(supported.video.mediaTypes).toEqual([]);
    expect(supported.video.nativeMediaTypes).toContain('video/mp4');
    expect(supported.video.reason).toContain('not wired');
    expect(supported.file.maxCount).toBe(0);

    expect(getModelInputCapabilities({ provider: 'minimax-coding' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'mimo-coding' }).image.status).toBe('unsupported');
    expect(getModelInputCapabilities({ provider: 'mimo-coding', model: 'mimo-v2.5' }).image.status).toBe('supported');
  });
});
