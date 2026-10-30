import type { KodaXCloudConnection, KodaXGenerationSource, KodaXProviderConfig } from '../types.js';
import { KodaXNativeProvider } from './native-provider.js';
import { cloudCredentialScope, isCloudConfigured, requireCloudCredential } from './cloud-auth.js';
export type { NativeRequest as NativeCloudRequest } from './native-provider.js';

/** Cloud authentication remains broker-only; ordinary native APIs retain explicit/env keys. */
export abstract class KodaXNativeCloudProvider extends KodaXNativeProvider {
  constructor(name: string, config: KodaXProviderConfig, protected readonly cloud: KodaXCloudConnection) {
    super(name, config, cloud.service === 'bedrock' ? 'bedrock-converse' : 'google-generate-content');
  }
  override isConfigured(): boolean { return isCloudConfigured(this.name); }
  override getGenerationSource(model?: string): KodaXGenerationSource {
    return { provider: this.name, api: this.cloud.service === 'bedrock' ? 'bedrock-converse' : 'google-generate-content',
      model: this.getWireModelId(model), baseUrl: this.config.baseUrl, credentialScope: cloudCredentialScope(this.name) };
  }
  protected override assertCredential(): void { requireCloudCredential(this.name); }
}
