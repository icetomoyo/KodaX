import type OpenAI from 'openai';
import type { KodaXProviderConfig, KodaXMessage, KodaXProviderStreamOptions } from '../types.js';
import { requestHeaders, requestExtensionFetch } from './request-extensions.js';
import { observeProviderFetch } from '../provider-request-observation.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXOpenAIResponsesProvider } from './openai-responses.js';
import { cloudCredentialScope, isCloudConfigured, requireCloudCredential } from './cloud-auth.js';

/** Azure's v1 Responses route uses deployment IDs; legacy custom gateways remain untouched. */
export class KodaXAzureResponsesProvider extends KodaXOpenAIResponsesProvider {
  constructor(readonly name: string, protected readonly config: KodaXProviderConfig) { super(); }
  override isConfigured(): boolean { return isCloudConfigured(this.name); }
  override getGenerationSource(model?: string) { return { ...super.getGenerationSource(model), credentialScope: cloudCredentialScope(this.name) }; }
  protected override getApiKey(): string {
    const credential = requireCloudCredential(this.name);
    if (credential.type === 'aws') throw new Error('Azure requires an API key or Entra bearer credential.');
    return credential.type === 'api-key' ? credential.key : credential.token;
  }
  protected override buildClient(): Promise<OpenAI> { return buildAzureClient(this.name, this.config); }
  protected override responseSocketHeaders(_messages: readonly KodaXMessage[], _options?: KodaXProviderStreamOptions): Record<string, string> {
    const credential = requireCloudCredential(this.name);
    if (credential.type === 'aws') throw new Error('Azure requires a native API key or Entra bearer.');
    return Object.fromEntries(requestHeaders(credential.type === 'api-key' ? { 'api-key': credential.key } : { authorization: `Bearer ${credential.token}` }));
  }
}

export async function buildAzureClient(name: string, config: KodaXProviderConfig): Promise<OpenAI> {
    const credential = requireCloudCredential(name);
    if (credential.type === 'aws') throw new Error('Azure requires an API key or Entra bearer credential.');
    const { default: Client } = await import('openai');
    return new Client({ apiKey: credential.type === 'api-key' ? credential.key : credential.token, baseURL: config.baseUrl, organization: null, project: null, logLevel: 'off',
      defaultHeaders: credential.type === 'api-key' ? { Authorization: null, 'api-key': credential.key } : { Authorization: `Bearer ${credential.token}`, 'api-key': null },
      fetch: observeProviderFetch((url, init) => {
        // SDK environment headers are not Host authority; rebuild this native route's headers.
        const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'KodaX' });
        if (credential.type === 'api-key') headers.set('api-key', credential.key); else headers.set('authorization', `Bearer ${credential.token}`);
        return requestExtensionFetch(globalThis.fetch)(url, { ...init, headers });
      }) });
  }

export class KodaXAzureCompletionsProvider extends KodaXOpenAICompatProvider {
  constructor(readonly name: string, protected readonly config: KodaXProviderConfig) { super(); }
  override isConfigured(): boolean { return isCloudConfigured(this.name); }
  protected override getApiKey(): string {
    const credential = requireCloudCredential(this.name);
    if (credential.type === 'aws') throw new Error('Azure requires an API key or Entra bearer credential.');
    return credential.type === 'api-key' ? credential.key : credential.token;
  }
  protected override buildClient(): Promise<OpenAI> { return buildAzureClient(this.name, this.config); }
}
