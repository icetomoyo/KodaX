import type { KodaXCustomProviderConfig } from '../types.js';
import type { OAuthService } from './session.js';

export const OAUTH_PROVIDER_BASE_URLS: Readonly<Record<OAuthService, string>> = {
  'openai-chatgpt': 'https://api.openai.com/v1',
  'openai-codex': 'https://chatgpt.com/backend-api/codex',
  'github-copilot': 'https://api.individual.githubcopilot.com',
};

/** Safe connection metadata only. Register it through the existing custom-provider/config entrance. */
export function createOAuthProviderConfig(input: { service: OAuthService; name: string; model: string }): KodaXCustomProviderConfig {
  return { name: input.name, model: input.model, protocol: 'openai', api: 'responses', oauth: input.service,
    baseUrl: OAUTH_PROVIDER_BASE_URLS[input.service], apiKeyEnv: 'KODAX_OAUTH_BROKER_ONLY', verifyStrategy: 'minimal-message' };
}
