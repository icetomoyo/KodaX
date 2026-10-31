import { describe, expect, it } from 'vitest';

import {
  MANUAL_INDEX_MAX_BYTES,
  MANUAL_TOPIC_MAX_BYTES,
  resolveKodaXManual,
} from './resolver.js';
import { MANUAL_REGISTRY, MANUAL_TOPIC_IDS } from './registry.js';

describe('FEATURE_218 resolveKodaXManual', () => {
  it('resolves an exact topic id', () => {
    const r = resolveKodaXManual({ topic: 'providers' });
    expect(r.matchedTopic).toBe('providers');
    expect(r.content.toLowerCase()).toContain('provider');
    expect(r.content.endsWith(MANUAL_REGISTRY.providers.body)).toBe(true);
    expect(r.nextTopics.length).toBeGreaterThan(0);
    expect(r.topics).toEqual([]);
  });

  it('resolves an English alias', () => {
    expect(resolveKodaXManual({ topic: 'settings' }).matchedTopic).toBe('config');
    expect(resolveKodaXManual({ topic: 'automatic compaction' }).matchedTopic).toBe('compaction');
  });

  it('resolves a Chinese alias', () => {
    expect(resolveKodaXManual({ topic: '供应商' }).matchedTopic).toBe('providers');
    expect(resolveKodaXManual({ topic: '权限' }).matchedTopic).toBe('permissions');
  });

  it('resolves a free-text query by token overlap', () => {
    const r = resolveKodaXManual({ query: 'how do I configure an openai provider' });
    expect(['providers', 'custom-providers', 'config']).toContain(r.matchedTopic);
  });

  it('prefers an exact query topic or alias over incidental keyword matches', () => {
    expect(resolveKodaXManual({ query: ' SDK ' }).matchedTopic).toBe('sdk');
    expect(resolveKodaXManual({ query: 'sdk' }).matchedTopic).toBe('sdk');
    const result = resolveKodaXManual({ query: 'space config' }, {
      baseTopics: ['config'],
      productName: 'Space',
      extraTopics: [{ id: 'SpaceHelp', title: 'Help', summary: 'Product help',
        aliases: ['space config'], body: 'Open Space settings.' }],
    });
    expect(result.matchedTopic).toBe('SpaceHelp');
    expect(result.content).toContain('Open Space settings.');
    expect(resolveKodaXManual({ query: 'SpaceHelp' }, {
      baseTopics: [], extraTopics: [{ id: 'SpaceHelp', title: 'Help', summary: '', body: 'Consumer help' }],
    }).matchedTopic).toBe('SpaceHelp');
    expect(resolveKodaXManual({ query: 'SDK' }, { baseTopics: [] }).matchedTopic).toBe('index');
  });

  it('resolves extension authoring questions', () => {
    const r = resolveKodaXManual({ query: 'how do I write a KodaX extension' });
    expect(r.matchedTopic).toBe('extensions');
    expect(r.content).toContain('~/.kodax/extensions');
    expect(r.content).toContain('/extensions');
  });

  it.each(['work-mode', 'workMode', 'script', '工作模式', 'Script 模式', '怎么切换工作模式？'])(
    'finds work-mode instructions for %s', (query) => {
      const result = resolveKodaXManual({ query });
      expect(result.matchedTopic).toBe('commands');
      expect(result.content).toContain('--work-mode');
      expect(result.content).toContain('experimental');
      expect(result.content).toContain('Coding is the default');
    },
  );

  it('resolves a Chinese free-text query', () => {
    const r = resolveKodaXManual({ query: '怎么 resume 上一次 session' });
    expect(r.matchedTopic).toBe('sessions');
  });

  it('routes memory capability questions to the governed memory topic', () => {
    const r = resolveKodaXManual({ query: '你好，你现在有记忆能力吗？' });

    expect(r.matchedTopic).toBe('memory');
    expect(r.content).toContain('memory_recall');
    expect(r.content).toContain('/memory');
  });

  it('returns the index (never fabricates) for an unknown topic', () => {
    const r = resolveKodaXManual({ topic: 'definitely-not-a-topic-xyz' });
    expect(r.matchedTopic).toBe('index');
    expect(r.content).toContain('topic');
  });

  it('returns the full index for empty input', () => {
    const r = resolveKodaXManual({});
    expect(r.matchedTopic).toBe('index');
    expect(r.topics).toEqual(MANUAL_TOPIC_IDS.map((id) => ({
      id,
      title: MANUAL_REGISTRY[id].title,
      summary: MANUAL_REGISTRY[id].summary,
    })));
    expect(r.content).toContain('call kodax_manual');
  });

  it('prepends an anti-confusion scope anchor on topic answers', () => {
    const r = resolveKodaXManual({ topic: 'config' });
    expect(r.content).toContain('not Claude Code or Codex CLI');
    expect(r.content).toContain('~/.kodax/config.json');
  });

  it('keeps legacy byte-limit constants as compatibility hints, not active crops', () => {
    const r = resolveKodaXManual({ topic: 'providers' });
    expect(MANUAL_TOPIC_MAX_BYTES).toBe(4096);
    expect(MANUAL_INDEX_MAX_BYTES).toBe(2048);
    expect(r.content.endsWith(MANUAL_REGISTRY.providers.body)).toBe(true);
  });
});
