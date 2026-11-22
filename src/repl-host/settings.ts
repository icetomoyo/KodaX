/**
 * The REPL's settings over a v2 Host: the saved defaults every Session starts
 * from, and the providers and what their models' reasoning accepts.
 */
import type { ClientCapabilityProbeResult, ClientProviderInfo } from '@kodax-ai/coding/client-contract';
import type { CommandCallbacks } from '@kodax-ai/repl';

import { toClientConfig, toClientEffectiveConfig } from '../client-settings.js';
import { createRequestId, type HostCallParams, type KodaXHostClient } from '../host-protocol/host-client.js';
import type { ReplLeases } from './leases.js';

type ReplConfig = NonNullable<CommandCallbacks['config']>;
type ReplCatalog = NonNullable<CommandCallbacks['catalog']> & NonNullable<CommandCallbacks['providerCapabilities']>;
type HostConfigPatch = HostCallParams<'config.update'>['patch'];

export function createReplConfig(client: KodaXHostClient<'local'>): ReplConfig {
  const read: ReplConfig['read'] = async () => toClientConfig((await client.call('config.get', {})).config);
  return {
    read,
    readEffective: async () => toClientEffectiveConfig((await client.call('config.get', {})).effective),
    async patch({ agentMode: _retired, ...patch }) {
      // AMA is the only agent mode, so v2 keeps no `agentMode` and saving it changes nothing.
      if (Object.keys(patch).length === 0) return read();
      const saved = await client.call('config.update', { requestId: createRequestId(), patch: patch as HostConfigPatch });
      return toClientConfig(saved.config);
    },
    reload: async () => ({
      ok: true,
      config: toClientConfig((await client.call('config.reload', { requestId: createRequestId() })).config),
    }),
  };
}

export function createReplCatalog(client: KodaXHostClient<'local'>, leases: ReplLeases): ReplCatalog {
  const providers = async (): Promise<readonly ClientProviderInfo[]> =>
    (await client.call('provider.list', {})).items as readonly ClientProviderInfo[];
  return {
    providers,
    models: async filter => (await providers())
      .filter(provider => filter?.provider === undefined || provider.name === filter.provider)
      .map(provider => ({ provider: provider.name, models: provider.models })),
    reasoningEfforts: async ({ provider, model }) => (await client.call('provider.reasoning.efforts', {
      provider, ...(model !== undefined ? { model } : {}),
    })).items,
    async probeReasoningEfforts({ provider, model, efforts }) {
      // Probing sends the provider real requests, so it runs on the key the CLI lends.
      const leased = await leases({ kind: 'provider_probe', input: { provider, ...(model !== undefined ? { model } : {}), efforts } });
      const { items } = await client.call('provider.reasoning.probe', {
        requestId: createRequestId(), provider, efforts: [...efforts],
        ...(model !== undefined ? { model } : {}), ...(leased !== undefined ? { leases: leased } : {}),
      });
      return items as readonly ClientCapabilityProbeResult[];
    },
    async forgetCapabilities(input) {
      await client.call('provider.reasoning.forget', {
        requestId: createRequestId(),
        ...(input?.provider !== undefined ? { provider: input.provider } : {}),
        ...(input?.model !== undefined ? { model: input.model } : {}),
      });
    },
  };
}
