/**
 * The REPL's saved defaults and provider catalog over v2, against a real Host.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { disposeReplHosts, MODEL, replHost } from '../../tests/repl-v2-host.js';
import { createReplCatalog, createReplConfig } from './settings.js';

afterEach(disposeReplHosts, 60_000);

describe('the REPL settings over v2', () => {
  it('saves, reads and reloads defaults in the shapes the REPL reads, leaving out the retired agent mode', async () => {
    const { client } = await replHost('answer');
    const config = createReplConfig(client);

    expect(await config.patch({ stallLog: true, fallbackProviders: ['openai'], agentMode: 'ama' }))
      .toEqual(expect.objectContaining({ stallLog: true, fallbackProviders: ['openai'] }));
    expect((await config.read()).agentMode).toBeUndefined();
    const effective = await config.readEffective();
    expect(effective.stallLog).toEqual({ value: true, source: 'persisted', applied: true });
    expect(effective.fallbackProviders).toMatchObject({ value: ['openai'], source: 'persisted' });

    // Only the retired field: nothing to save, so the Host's revision stays as it was.
    const { revision } = await client.call('config.get', {});
    expect(await config.patch({ agentMode: 'ama' })).toMatchObject({ stallLog: true });
    expect((await client.call('config.get', {})).revision).toBe(revision);

    expect(await config.patch({ stallLog: null })).not.toHaveProperty('stallLog');
    expect(await config.reload()).toEqual({ ok: true, config: expect.objectContaining({ fallbackProviders: ['openai'] }) });
  });

  it('lists providers and their efforts, and probes on the key the CLI lends', async () => {
    const { client } = await replHost('answer');
    const asked: unknown[] = [];
    const catalog = createReplCatalog(client, async (request) => { asked.push(request); return undefined; });

    const providers = await catalog.providers();
    const scripted = providers.find(provider => provider.name === MODEL);
    expect(scripted).toMatchObject({ model: MODEL, models: expect.arrayContaining([MODEL]) });
    expect(await catalog.models({ provider: MODEL })).toEqual([{ provider: MODEL, models: scripted!.models }]);
    expect(await catalog.reasoningEfforts({ provider: MODEL })).toEqual(expect.arrayContaining([expect.any(String)]));

    const probed = await catalog.probeReasoningEfforts({ provider: MODEL, model: MODEL, efforts: ['low'] });
    expect(probed).toEqual([expect.objectContaining({ effort: 'low', status: expect.any(String) })]);
    expect(asked).toEqual([{ kind: 'provider_probe', input: { provider: MODEL, model: MODEL, efforts: ['low'] } }]);
    await expect(catalog.forgetCapabilities({ provider: MODEL })).resolves.toBeUndefined();
  });
});
