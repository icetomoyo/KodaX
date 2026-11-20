import { describe, expect, it } from 'vitest';

import type { KodaXToolExecutionContext } from '../types.js';
import { toolKodaxManual } from './manual.js';
import { getBuiltinToolDefinition, isToolMutation } from './registry.js';

const ctx = {} as KodaXToolExecutionContext;

describe('FEATURE_218 kodax_manual tool', () => {
  it('is registered and read-only (not a mutation)', () => {
    const def = getBuiltinToolDefinition('kodax_manual');
    expect(def).toBeDefined();
    expect(def?.name).toBe('kodax_manual');
    expect(isToolMutation('kodax_manual')).toBe(false);
  });

  it('description disambiguates KodaX from Claude Code / Codex', () => {
    const def = getBuiltinToolDefinition('kodax_manual');
    expect(def?.description).toContain('~/.kodax/config.json');
    expect(def?.description).toContain('.claude/settings.json');
    expect(def?.description).toContain('config.toml');
    expect(def?.description).toContain('not other-product pretraining');
  });

  it('returns a topic answer with title + content + related topics', async () => {
    const out = await toolKodaxManual({ topic: 'providers' }, ctx);
    expect(out).toContain('# Providers & models');
    expect(out.toLowerCase()).toContain('provider');
    expect(out).toContain('Related topics');
  });

  it('returns the index for empty input (never fabricates)', async () => {
    const out = await toolKodaxManual({}, ctx);
    expect(out).toContain('KodaX Manual — Index');
    expect(out).toContain('Topics:');
    expect(out).toContain('"id":"extensions"');
    expect(out).toContain('"id":"troubleshooting"');
  });

  it('returns extension authoring and usage guidance', async () => {
    const out = await toolKodaxManual({ topic: 'extensions' }, ctx);
    expect(out).toContain('# Extensions');
    expect(out).toContain('~/.kodax/extensions');
    expect(out).toContain('--extension <path>');
    expect(out).toContain('/reload');
  });

  it('ignores non-string topic/query without throwing', async () => {
    const out = await toolKodaxManual({ topic: 42, query: null }, ctx);
    expect(out).toContain('KodaX Manual — Index');
  });

  it('FEATURE_221: serves an SDK-consumer injected topic via ctx.selfManual', async () => {
    const spaceCtx = {
      selfManual: {
        productName: 'KodaX-Space',
        topics: [
          { id: 'space-settings', title: 'KodaX-Space Settings', summary: 'config', body: 'Open Settings → Providers' },
        ],
      },
    } as KodaXToolExecutionContext;

    const injected = await toolKodaxManual({ topic: 'space-settings' }, spaceCtx);
    expect(injected).toContain('# KodaX-Space Settings');
    expect(injected).toContain('Settings → Providers');

    // base KodaX topics still reachable (extend) and re-branded.
    const base = await toolKodaxManual({ topic: 'providers' }, spaceCtx);
    expect(base).toContain('about KodaX-Space itself');
  });

  it('FEATURE_221: ctx.selfManual.baseTopics [] fully replaces the base (white-label)', async () => {
    const replaceCtx = {
      selfManual: {
        productName: 'KodaX-Space',
        baseTopics: [],
        topics: [
          { id: 'space-settings', title: 'KodaX-Space Settings', summary: 'config', body: 'Open Settings' },
        ],
      },
    } as KodaXToolExecutionContext;

    // Injected topic works…
    expect(await toolKodaxManual({ topic: 'space-settings' }, replaceCtx)).toContain('# KodaX-Space Settings');
    // …but a KodaX base topic is no longer seeded, so it is not served.
    const providers = await toolKodaxManual({ topic: 'providers' }, replaceCtx);
    expect(providers).not.toContain('# Providers & models');
  });
});
