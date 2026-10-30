import type { KodaXCustomProviderConfig } from '../types.js';
import type { OAuthService } from './session.js';

export const OAUTH_PROVIDER_BASE_URLS: Readonly<Record<OAuthService, string>> = {
  'openai-chatgpt': 'https://api.openai.com/v1',
  'openai-codex': 'https://chatgpt.com/backend-api/codex',
  'github-copilot': 'https://api.individual.githubcopilot.com',
  anthropic: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai/api/v1',
  'kimi-coding': 'https://api.kimi.com/coding/v1', meta: 'https://api.meta.ai/v1', xai: 'https://api.x.ai/v1', radius: 'https://radius.pi.dev',
};

/** Safe connection metadata only. Register it through the existing custom-provider/config entrance. */
export function createOAuthProviderConfig(input: { service: OAuthService; name: string; model: string;
  api?: 'responses' | 'chat-completions' | 'anthropic-messages'; baseUrl?: string }): KodaXCustomProviderConfig {
  const protocol = input.service === 'anthropic' || input.api === 'anthropic-messages' ? 'anthropic' : input.service === 'radius' ? 'pi-messages' : 'openai';
  const api = protocol === 'openai' ? input.api ?? (input.service === 'openrouter' || input.service === 'kimi-coding' ? 'chat-completions' : 'responses') : undefined;
  return { name: input.name, model: input.model, protocol, ...(api ? { api: api as 'responses' | 'chat-completions' } : {}), oauth: input.service,
    ...(protocol === 'anthropic' ? { authentication: 'bearer' as const } : {}),
    baseUrl: input.baseUrl ?? OAUTH_PROVIDER_BASE_URLS[input.service], apiKeyEnv: 'KODAX_OAUTH_BROKER_ONLY', verifyStrategy: 'minimal-message' };
}

export function validateOAuthProviderConfig(config: KodaXCustomProviderConfig): void {
  if (!config.oauth) return;
  if (!Object.hasOwn(OAUTH_PROVIDER_BASE_URLS, config.oauth)) throw new Error('Unknown OAuth service.');
  const expected = createOAuthProviderConfig({ service: config.oauth, name: config.name, model: config.model,
    ...(config.oauth === 'github-copilot' ? { api: config.protocol === 'anthropic' ? 'anthropic-messages' : config.api } : {}) });
  const url = new URL(config.baseUrl);
  const flexible = config.oauth === 'radius';
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || config.protocol !== expected.protocol || config.api !== expected.api
    || (!flexible && config.baseUrl.replace(/\/$/, '') !== expected.baseUrl)) throw new Error('OAuth connection requires its matching native protocol and endpoint.');
  if (config.protocol === 'anthropic' && config.authentication !== 'bearer') throw new Error('Subscription Messages requires bearer authentication.');
}
