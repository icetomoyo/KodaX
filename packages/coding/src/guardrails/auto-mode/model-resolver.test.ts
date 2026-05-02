import { describe, expect, it } from 'vitest';
import {
  parseModelSpec,
  resolveClassifierModel,
  type ResolveClassifierModelOptions,
} from './model-resolver.js';

const baseOpts = (overrides: Partial<ResolveClassifierModelOptions> = {}): ResolveClassifierModelOptions => ({
  cliFlag: undefined,
  envVar: undefined,
  sessionOverride: undefined,
  userSettings: undefined,
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  ...overrides,
});

describe('parseModelSpec', () => {
  it('splits "provider:model" into separate fields', () => {
    expect(parseModelSpec('minimax:abab6.5t-chat')).toEqual({
      providerName: 'minimax',
      model: 'abab6.5t-chat',
    });
  });

  it('treats no-colon spec as model only (provider unspecified)', () => {
    expect(parseModelSpec('claude-sonnet-4-6')).toEqual({
      providerName: null,
      model: 'claude-sonnet-4-6',
    });
  });

  it('handles colons inside the model id by splitting on the FIRST colon only', () => {
    expect(parseModelSpec('openai:gpt-4o:variant-x')).toEqual({
      providerName: 'openai',
      model: 'gpt-4o:variant-x',
    });
  });

  it('rejects empty spec', () => {
    expect(() => parseModelSpec('')).toThrow(/empty/i);
  });

  it('rejects whitespace-only spec', () => {
    expect(() => parseModelSpec('   ')).toThrow(/empty/i);
  });

  it('trims surrounding whitespace', () => {
    expect(parseModelSpec('  anthropic:claude  ')).toEqual({
      providerName: 'anthropic',
      model: 'claude',
    });
  });

  it('rejects spec with empty provider before colon', () => {
    expect(() => parseModelSpec(':claude')).toThrow(/provider/i);
  });

  it('rejects spec with empty model after colon', () => {
    expect(() => parseModelSpec('anthropic:')).toThrow(/model/i);
  });
});

describe('resolveClassifierModel — priority chain', () => {
  it('falls back to default main when no override is set', () => {
    const result = resolveClassifierModel(baseOpts());
    expect(result.providerName).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.source).toBe('default-main');
  });

  it('userSettings is used when CLI / env / session are absent', () => {
    const result = resolveClassifierModel(baseOpts({
      userSettings: 'minimax:abab6.5t-chat',
    }));
    expect(result.providerName).toBe('minimax');
    expect(result.model).toBe('abab6.5t-chat');
    expect(result.source).toBe('user-settings');
  });

  it('sessionOverride beats userSettings', () => {
    const result = resolveClassifierModel(baseOpts({
      userSettings: 'minimax:abab6.5t-chat',
      sessionOverride: 'kimi:moonshot-v1',
    }));
    expect(result.providerName).toBe('kimi');
    expect(result.model).toBe('moonshot-v1');
    expect(result.source).toBe('session-override');
  });

  it('envVar beats sessionOverride and userSettings', () => {
    const result = resolveClassifierModel(baseOpts({
      userSettings: 'minimax:m',
      sessionOverride: 'kimi:k',
      envVar: 'zhipu:glm-4',
    }));
    expect(result.providerName).toBe('zhipu');
    expect(result.source).toBe('env');
  });

  it('cliFlag wins above all', () => {
    const result = resolveClassifierModel(baseOpts({
      userSettings: 'minimax:m',
      sessionOverride: 'kimi:k',
      envVar: 'zhipu:g',
      cliFlag: 'deepseek:deepseek-v3',
    }));
    expect(result.providerName).toBe('deepseek');
    expect(result.source).toBe('cli');
  });

  it('falls back to defaultProvider when spec has no provider prefix', () => {
    const result = resolveClassifierModel(baseOpts({
      cliFlag: 'haiku-4-5',
    }));
    expect(result.providerName).toBe('anthropic'); // inherited from defaultProvider
    expect(result.model).toBe('haiku-4-5');
    expect(result.source).toBe('cli');
  });

  it('returns the empty string spec as if no override (falls back to default)', () => {
    const result = resolveClassifierModel(baseOpts({
      sessionOverride: '',
    }));
    expect(result.source).toBe('default-main');
  });

  it('rejects a malformed spec at the highest-priority layer rather than silently falling through', () => {
    expect(() =>
      resolveClassifierModel(baseOpts({ cliFlag: ':no-provider' })),
    ).toThrow(/provider/i);
  });
});
