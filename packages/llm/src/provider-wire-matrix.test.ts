import { afterEach, expect, it, vi } from 'vitest';
import { createProviderConnection, listProviderPresets, type ProviderChatApi } from './provider-presets.js';
import { createCustomProvider } from './providers/custom-provider.js';
import { runWithProviderCredential } from './provider-credential-context.js';
import { serializeCloudCredential } from './cloud/credentials.js';
import type { KodaXCloudConnection } from './types.js';

const C = 'openai-completions', A = 'anthropic-messages', R = 'openai-responses', G = 'google-generative-ai';
interface Case { id: string; apiId: ProviderChatApi; expected: string; baseUrl?: string; cloud?: KodaXCloudConnection; header?: string }
// Independent endpoint expectations from the pinned source inventory and official wire references.
const cases: readonly Case[] = [
  { id: 'amazon-bedrock', apiId: 'bedrock-converse-stream', cloud: { service: 'bedrock', region: 'us-east-1' }, expected: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/wire-model/converse' },
  { id: 'ant-ling', apiId: C, expected: 'https://api.ant-ling.com/v1/chat/completions' },
  { id: 'anthropic', apiId: A, header: 'x-api-key', expected: 'https://api.anthropic.com/v1/messages' },
  { id: 'azure', apiId: 'azure-openai-responses', baseUrl: 'https://resource.openai.azure.com', header: 'api-key', expected: 'https://resource.openai.azure.com/openai/v1/responses' },
  { id: 'azure', apiId: C, baseUrl: 'https://resource.openai.azure.com', header: 'api-key', expected: 'https://resource.openai.azure.com/openai/v1/chat/completions' },
  { id: 'baseten', apiId: C, expected: 'https://inference.baseten.co/v1/chat/completions' },
  { id: 'cerebras', apiId: C, expected: 'https://api.cerebras.ai/v1/chat/completions' },
  { id: 'cloudflare-ai-gateway', apiId: A, baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic', header: 'cf-aig-authorization', expected: 'https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages' },
  { id: 'cloudflare-ai-gateway', apiId: C, baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai', header: 'cf-aig-authorization', expected: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions' },
  { id: 'cloudflare-ai-gateway', apiId: R, baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai', header: 'cf-aig-authorization', expected: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai/responses' },
  { id: 'cloudflare-workers-ai', apiId: C, baseUrl: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1', expected: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions' },
  { id: 'deepseek', apiId: C, expected: 'https://api.deepseek.com/v1/chat/completions' },
  { id: 'fireworks', apiId: A, header: 'x-api-key', expected: 'https://api.fireworks.ai/inference/v1/messages' },
  { id: 'fireworks', apiId: C, expected: 'https://api.fireworks.ai/inference/v1/chat/completions' },
  { id: 'github-copilot', apiId: A, expected: 'https://api.individual.githubcopilot.com/v1/messages' },
  { id: 'github-copilot', apiId: C, expected: 'https://api.individual.githubcopilot.com/chat/completions' },
  { id: 'github-copilot', apiId: R, expected: 'https://api.individual.githubcopilot.com/responses' },
  { id: 'google', apiId: G, header: 'x-goog-api-key', expected: 'https://generativelanguage.googleapis.com/v1beta/models/wire-model:generateContent' },
  { id: 'google-vertex', apiId: 'google-vertex', cloud: { service: 'vertex', project: 'fixture', location: 'global' }, expected: 'https://aiplatform.googleapis.com/v1/projects/fixture/locations/global/publishers/google/models/wire-model:generateContent' },
  { id: 'groq', apiId: C, expected: 'https://api.groq.com/openai/v1/chat/completions' },
  { id: 'huggingface', apiId: C, expected: 'https://router.huggingface.co/v1/chat/completions' },
  { id: 'kimi-coding', apiId: C, expected: 'https://api.kimi.com/coding/v1/chat/completions' },
  { id: 'meta', apiId: R, expected: 'https://api.meta.ai/v1/responses' },
  { id: 'minimax', apiId: A, header: 'x-api-key', expected: 'https://api.minimax.io/anthropic/v1/messages' },
  { id: 'minimax-cn', apiId: A, header: 'x-api-key', expected: 'https://api.minimaxi.com/anthropic/v1/messages' },
  { id: 'mistral', apiId: 'mistral-conversations', expected: 'https://api.mistral.ai/v1/chat/completions' },
  { id: 'moonshotai', apiId: C, expected: 'https://api.moonshot.ai/v1/chat/completions' },
  { id: 'moonshotai-cn', apiId: C, expected: 'https://api.moonshot.cn/v1/chat/completions' },
  { id: 'nvidia', apiId: C, expected: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  { id: 'openai', apiId: R, expected: 'https://api.openai.com/v1/responses' },
  { id: 'openai-codex', apiId: 'openai-codex-responses', expected: 'https://chatgpt.com/backend-api/codex/responses' },
  { id: 'opencode', apiId: A, baseUrl: 'https://opencode.ai/inference/anthropic', expected: 'https://opencode.ai/inference/anthropic/v1/messages' },
  { id: 'opencode', apiId: C, baseUrl: 'https://opencode.ai/inference/v1', expected: 'https://opencode.ai/inference/v1/chat/completions' },
  { id: 'opencode', apiId: R, baseUrl: 'https://opencode.ai/inference/v1', expected: 'https://opencode.ai/inference/v1/responses' },
  { id: 'opencode', apiId: G, baseUrl: 'https://opencode.ai/inference/google/v1beta', expected: 'https://opencode.ai/inference/google/v1beta/models/wire-model:generateContent' },
  { id: 'opencode-go', apiId: A, baseUrl: 'https://opencode.ai/inference/go/anthropic', expected: 'https://opencode.ai/inference/go/anthropic/v1/messages' },
  { id: 'opencode-go', apiId: C, baseUrl: 'https://opencode.ai/inference/go/v1', expected: 'https://opencode.ai/inference/go/v1/chat/completions' },
  { id: 'opencode-go', apiId: R, baseUrl: 'https://opencode.ai/inference/go/v1', expected: 'https://opencode.ai/inference/go/v1/responses' },
  { id: 'opencode-go', apiId: G, baseUrl: 'https://opencode.ai/inference/go/google/v1beta', expected: 'https://opencode.ai/inference/go/google/v1beta/models/wire-model:generateContent' },
  { id: 'openrouter', apiId: A, expected: 'https://openrouter.ai/api/v1/messages' },
  { id: 'openrouter', apiId: C, expected: 'https://openrouter.ai/api/v1/chat/completions' },
  { id: 'qwen-token-plan', apiId: C, expected: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions' },
  { id: 'qwen-token-plan-cn', apiId: C, expected: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions' },
  { id: 'qwen-token-plan-individual', apiId: C, expected: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions' },
  { id: 'radius', apiId: 'pi-messages', expected: 'https://radius.pi.dev/messages' },
  { id: 'together', apiId: C, expected: 'https://api.together.ai/v1/chat/completions' },
  { id: 'vercel-ai-gateway', apiId: A, header: 'x-api-key', expected: 'https://ai-gateway.vercel.sh/v1/messages' },
  { id: 'xai', apiId: R, expected: 'https://api.x.ai/v1/responses' },
  { id: 'xiaomi', apiId: C, expected: 'https://api.xiaomimimo.com/v1/chat/completions' },
  { id: 'xiaomi-token-plan-ams', apiId: C, expected: 'https://token-plan-ams.xiaomimimo.com/v1/chat/completions' },
  { id: 'xiaomi-token-plan-cn', apiId: C, expected: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions' },
  { id: 'xiaomi-token-plan-sgp', apiId: C, expected: 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions' },
  { id: 'zai', apiId: C, expected: 'https://api.z.ai/api/coding/paas/v4/chat/completions' },
  { id: 'zai-coding-cn', apiId: C, expected: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions' },
];
afterEach(() => { vi.unstubAllGlobals(); });
it('accounts for every provider identity and every declared chat API', () => {
  for (const preset of listProviderPresets()) {
    if (preset.id === 'typesafe') { expect(preset.classifierApi).toBe('typesafe-system-one'); continue; }
    expect(cases.filter(c => c.id === preset.id).map(c => c.apiId).sort()).toEqual([...preset.chatApis].sort());
  }
});
it.each(cases)('captures $id / $apiId request target and explicit authentication', async row => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ message: 'fixture authentication rejection', error: { message: 'fixture authentication rejection' } }, { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  const config = createProviderConnection(row.id, { name: `wire-${row.id}`, model: 'wire-model', apiId: row.apiId,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}), ...(row.cloud ? { cloud: row.cloud } : {}), maxOutputTokens: 16, reasoning: 'none' });
  const key = row.id === 'openai-codex' ? `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.signature` : 'fixture-key';
  const cloud = row.apiId === G || row.apiId === 'google-vertex' || row.apiId === 'bedrock-converse-stream' || row.id === 'azure';
  const credential = cloud ? serializeCloudCredential(config.name, row.apiId === 'google-vertex' || row.apiId === 'bedrock-converse-stream' ? { type: 'bearer', token: key } : { type: 'api-key', key }) : key;
  await expect(runWithProviderCredential(config.name, credential, () => createCustomProvider(config).complete([{ role: 'user', content: 'task' }], [], '', undefined, { singleAttempt: true }))).rejects.toThrow('fixture authentication rejection');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toBe(row.expected);
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  const header = row.header ?? 'authorization';
  expect(headers.get(header)).toBe(header === 'authorization' || header === 'cf-aig-authorization' ? `Bearer ${key}` : key);
  for (const other of ['authorization', 'x-api-key', 'api-key', 'cf-aig-authorization', 'x-goog-api-key']) if (other !== header) expect(headers.has(other)).toBe(false);
});
