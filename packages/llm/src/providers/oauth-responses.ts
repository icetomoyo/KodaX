import { createHash, randomUUID } from 'node:crypto';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';
import type { KodaXMessage, KodaXProviderConfig, KodaXVerifyCredentialResult, KodaXProviderStreamOptions } from '../types.js';
import type { OAuthService } from '../oauth/session.js';
import { getScopedProviderCredential, hasScopedProviderCredentialAuthority, withProviderRequestCredential } from '../provider-credential-context.js';
import { KodaXOpenAIResponsesProvider } from './openai-responses.js';
import { runVerifyCredential } from './verify-credential.js';

/** Subscription authentication is explicit; the existing API-key and CLI aliases are unchanged. */
export class KodaXOAuthResponsesProvider extends KodaXOpenAIResponsesProvider {
  constructor(readonly name: string, protected readonly config: KodaXProviderConfig, private readonly service: OAuthService) { super(); }
  override isConfigured(): boolean { return hasScopedProviderCredentialAuthority(this.name) === true; }
  override getGenerationSource(model?: string) {
    const source = super.getGenerationSource(model);
    return { ...source, credentialScope: source.credentialScope && source.credentialScope !== 'unavailable' ? createHash('sha256')
      .update(JSON.stringify([this.service, source.credentialScope])).digest('hex') : 'unavailable' };
  }
  protected override getApiKey(): string {
    const token = getScopedProviderCredential(this.name);
    if (!token) throw new Error('OAuth provider requires a scoped credential broker.');
    return token;
  }
  protected override requiresResponseStream(): boolean { return this.service !== 'github-copilot'; }
  override supportsNonStreamingFallback(): boolean { return !this.requiresResponseStream(); }
  protected override prepareResponseRequest(params: ResponseCreateParamsBase): ResponseCreateParamsBase {
    if (this.service === 'openai-codex') {
      const { max_output_tokens: _budget, ...body } = params;
      return { ...body, instructions: params.instructions || 'You are a helpful assistant.' };
    }
    if (this.service !== 'openai-chatgpt') return params;
    return { ...params,
      tools: params.tools?.length ? [{ type: 'namespace', name: 'kodax', description: 'Tools available for this request',
        tools: params.tools.filter(tool => tool.type === 'function' || tool.type === 'custom') }] : undefined,
      input: Array.isArray(params.input) ? params.input.map(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? { ...item, namespace: 'kodax' } : item) : params.input };
  }
  protected override acceptsResponseToolNamespace(namespace?: string): boolean {
    return this.service === 'openai-chatgpt' ? namespace === 'kodax' : namespace === undefined;
  }
  protected override responseSocketHeaders(messages: readonly KodaXMessage[], options?: KodaXProviderStreamOptions): Record<string, string> {
    const headers = new Headers(super.responseSocketHeaders(messages, options));
    if (this.service === 'openai-codex') {
      const id = randomUUID();
      headers.set('openai-beta', 'responses_websockets=2026-02-06');
      headers.set('x-client-request-id', id); headers.set('session-id', options?.sessionId ?? options?.promptCacheKey ?? id);
    }
    return Object.fromEntries(headers);
  }
  protected override responseRequestHeaders(messages: readonly KodaXMessage[]): Record<string, string> | undefined {
    if (this.service === 'openai-codex') {
      // A routing claim only. Login identity validation remains the trusted host's responsibility.
      let account: unknown;
      try {
        const payload: unknown = JSON.parse(Buffer.from(this.getApiKey().split('.')[1] ?? '', 'base64url').toString());
        if (payload && typeof payload === 'object') {
          const auth = (payload as Record<string, unknown>)['https://api.openai.com/auth'];
          if (auth && typeof auth === 'object') account = (auth as Record<string, unknown>).chatgpt_account_id;
        }
      } catch { throw new Error('Codex OAuth token has no valid account routing claim.'); }
      if (typeof account !== 'string' || !account || /[\r\n]/.test(account)) throw new Error('Codex OAuth token has no valid account routing claim.');
      return { 'chatgpt-account-id': account };
    }
    if (this.service !== 'github-copilot') return undefined;
    const last = messages.at(-1);
    const initiator = last?.role === 'user' && (typeof last.content === 'string'
      || last.content.some(block => block.type !== 'tool_result')) ? 'user' : 'agent';
    const images = messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'
      || (block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(part => part.type === 'image'))));
    return { 'X-Initiator': initiator, 'Openai-Intent': 'conversation-edits', ...(images ? { 'Copilot-Vision-Request': 'true' } : {}) };
  }
  override verifyCredential(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<KodaXVerifyCredentialResult> {
    if (this.config.verifyStrategy === 'unsupported') return super.verifyCredential(opts);
    return runVerifyCredential({ strategy: 'minimal-message', providerName: this.name, ...opts, runners: [{
      strategy: 'minimal-message', approxTokensSpent: 22,
      run: signal => withProviderRequestCredential(this, 'utility', signal, async requestSignal => {
        await this.complete([{ role: 'user', content: 'hi' }], [], '', false, { singleAttempt: true, maxOutputTokensOverride: 16 }, requestSignal);
      }),
    }] });
  }
}
