import type { KodaXCustomProviderConfig } from './types.js';
import { createCloudProviderConfig } from './cloud/provider-config.js';
import { createOAuthProviderConfig } from './oauth/provider-config.js';
import { validateCustomProviderConfig } from './providers/custom-provider.js';

export type ProviderChatApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'azure-openai-responses'
  | 'openai-codex-responses' | 'google-generative-ai' | 'google-vertex' | 'bedrock-converse-stream' | 'mistral-conversations' | 'pi-messages';
export interface ProviderPreset { readonly id: string; readonly apiKeyEnv: string; readonly chatApis: readonly ProviderChatApi[];
  readonly baseUrl?: string; readonly imageApi?: 'openrouter-images'; readonly classifierApi?: 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'openai-decisions' }
const C = 'openai-completions', A = 'anthropic-messages', R = 'openai-responses', G = 'google-generative-ai';
const PRESETS: readonly ProviderPreset[] = [
  { id: 'amazon-bedrock', apiKeyEnv: 'AWS_BEARER_TOKEN_BEDROCK', chatApis: ['bedrock-converse-stream'] },
  { id: 'ant-ling', apiKeyEnv: 'ANT_LING_API_KEY', chatApis: [C], baseUrl: 'https://api.ant-ling.com/v1' },
  { id: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', chatApis: [A], baseUrl: 'https://api.anthropic.com' },
  { id: 'azure', apiKeyEnv: 'AZURE_OPENAI_API_KEY', chatApis: ['azure-openai-responses', C] },
  { id: 'baseten', apiKeyEnv: 'BASETEN_API_KEY', chatApis: [C], baseUrl: 'https://inference.baseten.co/v1' },
  { id: 'cerebras', apiKeyEnv: 'CEREBRAS_API_KEY', chatApis: [C], baseUrl: 'https://api.cerebras.ai/v1' },
  { id: 'cloudflare-ai-gateway', apiKeyEnv: 'CLOUDFLARE_API_KEY', chatApis: [A, C, R] },
  { id: 'cloudflare-workers-ai', apiKeyEnv: 'CLOUDFLARE_API_KEY', chatApis: [C], classifierApi: 'cloudflare-workers-ai-system-one' },
  { id: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY', chatApis: [C], baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'fireworks', apiKeyEnv: 'FIREWORKS_API_KEY', chatApis: [A, C], baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { id: 'github-copilot', apiKeyEnv: 'COPILOT_GITHUB_TOKEN', chatApis: [A, C, R] },
  { id: 'google', apiKeyEnv: 'GEMINI_API_KEY', chatApis: [G] },
  { id: 'google-vertex', apiKeyEnv: 'GOOGLE_CLOUD_API_KEY', chatApis: ['google-vertex'] },
  { id: 'groq', apiKeyEnv: 'GROQ_API_KEY', chatApis: [C], baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'huggingface', apiKeyEnv: 'HF_TOKEN', chatApis: [C], baseUrl: 'https://router.huggingface.co/v1' },
  { id: 'kimi-coding', apiKeyEnv: 'KIMI_API_KEY', chatApis: [C], baseUrl: 'https://api.kimi.com/coding/v1' },
  { id: 'meta', apiKeyEnv: 'META_API_KEY', chatApis: [R], baseUrl: 'https://api.meta.ai/v1' },
  { id: 'minimax', apiKeyEnv: 'MINIMAX_API_KEY', chatApis: [A], baseUrl: 'https://api.minimax.io/anthropic' },
  { id: 'minimax-cn', apiKeyEnv: 'MINIMAX_CN_API_KEY', chatApis: [A], baseUrl: 'https://api.minimaxi.com/anthropic' },
  { id: 'mistral', apiKeyEnv: 'MISTRAL_API_KEY', chatApis: ['mistral-conversations'], baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'moonshotai', apiKeyEnv: 'MOONSHOT_API_KEY', chatApis: [C], baseUrl: 'https://api.moonshot.ai/v1' },
  { id: 'moonshotai-cn', apiKeyEnv: 'MOONSHOT_API_KEY', chatApis: [C], baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'nvidia', apiKeyEnv: 'NVIDIA_API_KEY', chatApis: [C], baseUrl: 'https://integrate.api.nvidia.com/v1' },
  { id: 'openai', apiKeyEnv: 'OPENAI_API_KEY', chatApis: [R], classifierApi: 'openai-decisions', baseUrl: 'https://api.openai.com/v1' },
  { id: 'openai-codex', apiKeyEnv: 'KODAX_OAUTH_BROKER_ONLY', chatApis: ['openai-codex-responses'] },
  { id: 'opencode', apiKeyEnv: 'OPENCODE_API_KEY', chatApis: [A, C, R, G], classifierApi: 'typesafe-system-one' },
  { id: 'opencode-go', apiKeyEnv: 'OPENCODE_API_KEY', chatApis: [A, C, R, G] },
  { id: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY', chatApis: [A, C], imageApi: 'openrouter-images', classifierApi: 'typesafe-system-one', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'qwen-token-plan', apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY', chatApis: [C], baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
  { id: 'qwen-token-plan-cn', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY', chatApis: [C], baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
  { id: 'qwen-token-plan-individual', apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY', chatApis: [C], baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
  { id: 'radius', apiKeyEnv: 'RADIUS_API_KEY', chatApis: ['pi-messages'], baseUrl: 'https://radius.pi.dev' },
  { id: 'together', apiKeyEnv: 'TOGETHER_API_KEY', chatApis: [C], baseUrl: 'https://api.together.ai/v1' },
  { id: 'typesafe', apiKeyEnv: 'TYPESAFE_API_KEY', chatApis: [], classifierApi: 'typesafe-system-one' },
  { id: 'vercel-ai-gateway', apiKeyEnv: 'AI_GATEWAY_API_KEY', chatApis: [A], baseUrl: 'https://ai-gateway.vercel.sh' },
  { id: 'xai', apiKeyEnv: 'XAI_API_KEY', chatApis: [R], baseUrl: 'https://api.x.ai/v1' },
  { id: 'xiaomi', apiKeyEnv: 'XIAOMI_API_KEY', chatApis: [C], baseUrl: 'https://api.xiaomimimo.com/v1' },
  { id: 'xiaomi-token-plan-ams', apiKeyEnv: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY', chatApis: [C], baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1' },
  { id: 'xiaomi-token-plan-cn', apiKeyEnv: 'XIAOMI_TOKEN_PLAN_CN_API_KEY', chatApis: [C], baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
  { id: 'xiaomi-token-plan-sgp', apiKeyEnv: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', chatApis: [C], baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' },
  { id: 'zai', apiKeyEnv: 'ZAI_API_KEY', chatApis: [C], baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
  { id: 'zai-coding-cn', apiKeyEnv: 'ZAI_CODING_CN_API_KEY', chatApis: [C], baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
];

/** Public connection facts, not a claim of account/model entitlement or a replacement for legacy aliases. */
export function listProviderPresets(): readonly ProviderPreset[] { return structuredClone(PRESETS); }
export function createProviderConnection(id: string, input: Pick<KodaXCustomProviderConfig, 'name' | 'model'> &
  Partial<Omit<KodaXCustomProviderConfig, 'name' | 'model'>> & { apiId?: ProviderChatApi }): KodaXCustomProviderConfig {
  const preset = PRESETS.find(p => p.id === id);
  if (!preset) throw new Error(`Unknown provider preset: ${id}`);
  if (!preset.chatApis.length) throw new Error('This provider exposes a classifier operation, not a chat route.');
  const apiId = input.apiId ?? (preset.chatApis.length === 1 ? preset.chatApis[0] : undefined);
  if (!apiId || !preset.chatApis.includes(apiId)) throw new Error('Select one explicit supported API for this provider.');
  if ((id === 'opencode' || id === 'opencode-go') && !input.baseUrl) throw new Error('This gateway requires an explicit model endpoint.');
  let connection: KodaXCustomProviderConfig;
  const { apiId: _api, ...overrides } = input;
  if (id === 'github-copilot' || id === 'openai-codex') {
    connection = createOAuthProviderConfig({ service: id, name: input.name, model: input.model,
      api: apiId === A ? A : apiId === C ? 'chat-completions' : 'responses' });
  } else if (apiId === G || apiId === 'google-vertex' || apiId === 'bedrock-converse-stream' || id === 'azure') {
    connection = cloudConnection(id, input, apiId);
    connection.apiKeyEnv = input.apiKeyEnv ?? preset.apiKeyEnv;
    if (apiId === G && id !== 'google') connection.authentication = 'bearer';
  } else {
    let baseUrl = input.baseUrl ?? preset.baseUrl;
    if (!baseUrl) throw new Error('This route requires an explicit account/model endpoint.');
    if (apiId === A && ['fireworks', 'openrouter'].includes(id)) baseUrl = baseUrl.replace(/\/v1\/?$/, '');
    const protocol = apiId === A ? 'anthropic' : apiId === 'mistral-conversations' ? 'mistral' : apiId === 'pi-messages' ? 'pi-messages' : 'openai';
    connection = { ...overrides, protocol, baseUrl, apiKeyEnv: input.apiKeyEnv ?? preset.apiKeyEnv,
      ...(protocol === 'openai' ? { api: apiId === R ? 'responses' : 'chat-completions' } : {}),
      ...(id === 'cloudflare-ai-gateway' ? { authentication: 'cloudflare-gateway' } : {}), verifyStrategy: input.verifyStrategy ?? 'minimal-message' };
    if (['openrouter', 'opencode', 'opencode-go'].includes(id) && apiId === A) connection.authentication = 'bearer';
  }
  if (id === 'fireworks') {
    connection.promptCacheAffinity = input.promptCacheAffinity ?? true;
    connection.cacheCapabilities = input.cacheCapabilities ?? (apiId === A
      ? { dialect: 'anthropic', locations: ['system', 'messages'], affinityHeader: 'x-session-affinity' }
      : { dialect: 'affinity', affinityHeader: 'x-session-affinity' });
    if (apiId === C) connection.toolCapabilities = input.toolCapabilities ?? { strict: true };
  }
  connection = { ...overrides, ...connection };
  validateCustomProviderConfig(connection);
  return connection;
}
function cloudConnection(id: string, input: Pick<KodaXCustomProviderConfig, 'name' | 'model'> & Partial<KodaXCustomProviderConfig>, api: ProviderChatApi): KodaXCustomProviderConfig {
  const common = { name: input.name, model: input.model };
  let connection: KodaXCustomProviderConfig;
  if (id === 'azure') {
    if (!input.baseUrl) throw new Error('Azure requires an explicit resource endpoint.');
    connection = createCloudProviderConfig({ ...common, service: 'azure', endpoint: input.baseUrl });
    if (api === C) connection.api = 'chat-completions';
  } else if (api === 'bedrock-converse-stream') {
    if (input.cloud?.service !== 'bedrock') throw new Error('Bedrock requires an explicit cloud region.');
    connection = createCloudProviderConfig({ ...common, ...input.cloud });
  } else if (api === 'google-vertex') connection = createCloudProviderConfig({ ...common, ...(input.cloud?.service === 'vertex' ? input.cloud : { service: 'vertex' as const }) });
  else connection = createCloudProviderConfig({ ...common, service: 'gemini' });
  return { ...connection, ...input, ...(id === 'azure' ? { baseUrl: connection.baseUrl } : {}), protocol: connection.protocol, cloud: connection.cloud, api: connection.api };
}
