import type { KodaXCloudConnection, KodaXProviderConfig, KodaXStreamResult } from '../types.js';
import { KodaXNativeProvider, type NativeRequest } from './native-provider.js';
import { KodaXNativeCloudProvider } from './native-cloud.js';

/** Keep synchronous provider creation and load wire implementations at the first request. */
export class KodaXLazyNativeProvider extends KodaXNativeProvider {
  constructor(name: string, config: KodaXProviderConfig, private readonly protocol: 'mistral' | 'pi-messages') {
    super(name, config, protocol === 'mistral' ? 'mistral-chat' : 'pi-messages');
  }
  override supportsNonStreamingFallback(): boolean { return this.protocol === 'mistral'; }
  override usesPromptCacheAffinity(): boolean { return this.protocol === 'mistral' && this.config.promptCacheAffinity === true; }
  protected async invoke(request: NativeRequest): Promise<KodaXStreamResult> {
    const provider = this.protocol === 'mistral'
      ? new (await import('./mistral-native.js')).KodaXMistralProvider(this.name, this.config)
      : new (await import('./pi-messages.js')).KodaXPiMessagesProvider(this.name, this.config);
    return provider.invokeNative(request);
  }
}
export class KodaXLazyCloudProvider extends KodaXNativeCloudProvider {
  constructor(name: string, config: KodaXProviderConfig, cloud: KodaXCloudConnection) { super(name, config, cloud); }
  protected async invoke(request: NativeRequest): Promise<KodaXStreamResult> {
    const provider = this.cloud.service === 'bedrock'
      ? new (await import('./bedrock-native.js')).KodaXBedrockProvider(this.name, this.config, this.cloud)
      : new (await import('./google-native.js')).KodaXGoogleProvider(this.name, this.config, this.cloud);
    return provider.invokeNative(request);
  }
}
