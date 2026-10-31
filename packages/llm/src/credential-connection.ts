import { createHash } from 'node:crypto';
import type { KodaXCloudConnection } from './types.js';

export interface ProviderCredentialConnection {
  readonly provider: string; readonly api: string; readonly baseUrl?: string;
  readonly authentication?: string; readonly oauth?: string; readonly cloud?: KodaXCloudConnection;
}
/** Non-secret destination proof. Model, budget, keys and environment-variable names do not define a credential destination. */
export function credentialConnectionFingerprint(connection: ProviderCredentialConnection): string {
  const cloud = connection.cloud;
  const route = cloud?.service === 'vertex' ? [cloud.service, cloud.project, cloud.location]
    : cloud?.service === 'bedrock' ? [cloud.service, cloud.region] : cloud ? [cloud.service] : undefined;
  const endpoint = connection.baseUrl ? new URL(connection.baseUrl).href.replace(/\/$/, '') : undefined;
  const mode = connection.authentication ?? (connection.api === 'anthropic-messages' ? 'api-key'
    : connection.api === 'google-generate-content' ? 'google-native'
    : connection.cloud?.service === 'azure' ? 'azure-native' : connection.api === 'bedrock-converse' ? 'bedrock-native' : 'bearer');
  return createHash('sha256').update(JSON.stringify([connection.provider, connection.api, endpoint, mode, connection.oauth, route])).digest('hex');
}
