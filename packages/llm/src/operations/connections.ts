import { listProviderPresets } from '../provider-presets.js';
import type { KodaXClassifierConnection, KodaXDeferredConnection, KodaXImageConnection } from './types.js';
import { operationUrl } from './request.js';

type Input<T extends { baseUrl: string }> = Omit<T, 'baseUrl'> & { baseUrl?: string };
export function createProviderOperationConnection(id: string, input: Input<KodaXImageConnection>): KodaXImageConnection;
export function createProviderOperationConnection(id: string, input: Input<KodaXClassifierConnection>): KodaXClassifierConnection;
export function createProviderOperationConnection(id: string, input: Input<KodaXDeferredConnection>): KodaXDeferredConnection;
export function createProviderOperationConnection(id: string, input: Input<KodaXImageConnection> | Input<KodaXClassifierConnection> | Input<KodaXDeferredConnection>): KodaXImageConnection | KodaXClassifierConnection | KodaXDeferredConnection {
  const preset = listProviderPresets().find(p => p.id === id);
  if (!preset || !(input.api === 'openrouter-images' ? preset.imageApi === input.api
    : input.api === 'openai-background-responses' ? id === 'openai' : preset.classifierApi === input.api)) throw new Error('Provider does not declare this operation.');
  const baseUrl = input.baseUrl ?? (id === 'typesafe' ? 'https://api.typesafe.ai/v1' : preset.baseUrl);
  if (!baseUrl) throw new Error('Operation requires an explicit account/model endpoint.');
  const connection = { ...input, baseUrl, apiKeyEnv: input.apiKeyEnv ?? preset.apiKeyEnv };
  if (!/^[A-Za-z_]\w*$/.test(connection.apiKeyEnv)) throw new Error('Invalid operation credential environment name.');
  if (connection.api === 'typesafe-system-one' && id === 'openrouter') connection.dialect ??= 'openrouter-system-one';
  if (connection.api === 'openai-background-responses' && !connection.accountScope?.trim()) throw new Error('Deferred operation requires an explicit account scope.');
  operationUrl(connection, '');
  return connection;
}
