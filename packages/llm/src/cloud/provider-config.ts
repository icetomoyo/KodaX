import type { KodaXCloudConnection, KodaXCustomProviderConfig } from '../types.js';

export type KodaXCloudProviderInput = { name: string; model: string } & (
  | { service: 'gemini' }
  | { service: 'vertex'; project?: string; location?: string }
  | { service: 'bedrock'; region: string }
  | { service: 'azure'; endpoint: string }
);
function segment(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error('Invalid cloud route component.');
  return value;
}
export function createCloudProviderConfig(input: KodaXCloudProviderInput): KodaXCustomProviderConfig {
  let cloud: KodaXCloudConnection;
  let baseUrl: string;
  switch (input.service) {
    case 'gemini': cloud = { service: input.service }; baseUrl = 'https://generativelanguage.googleapis.com/v1beta'; break;
    case 'vertex': {
      if (!!input.project !== !!input.location) throw new Error('Vertex requires both project and location, or neither for Express API-key mode.');
      cloud = { service: input.service, ...(input.project ? { project: segment(input.project), location: segment(input.location!) } : {}) };
      const host = !input.location || input.location === 'global' ? 'aiplatform' : `${segment(input.location)}-aiplatform`;
      baseUrl = `https://${host}.googleapis.com/v1/${input.project ? `projects/${segment(input.project)}/locations/${segment(input.location!)}/` : ''}publishers/google`;
      break;
    }
    case 'bedrock': {
      const region = segment(input.region);
      cloud = { service: input.service, region };
      baseUrl = `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
      break;
    }
    case 'azure': {
      const url = new URL(input.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !['/', '/openai/v1', '/openai/v1/'].includes(url.pathname)) throw new Error('Azure requires an HTTPS resource endpoint or /openai/v1 endpoint.');
      cloud = { service: input.service }; baseUrl = `${url.origin}/openai/v1`; break;
    }
  }
  return { name: input.name, model: input.model, cloud, protocol: input.service === 'azure' ? 'openai' : input.service === 'bedrock' ? 'bedrock' : 'google',
    ...(input.service === 'azure' ? { api: 'responses' as const } : {}), baseUrl, apiKeyEnv: 'KODAX_CLOUD_BROKER_ONLY',
    verifyStrategy: 'minimal-message' };
}

export function validateCloudProviderConfig(config: KodaXCustomProviderConfig): void {
  const cloud = config.cloud;
  if (cloud !== undefined && (!cloud || typeof cloud !== 'object' || Array.isArray(cloud))) throw new Error('Invalid cloud connection metadata.');
  if (!cloud) {
    if (config.protocol === 'google' || config.protocol === 'bedrock') throw new Error('Native Google/Bedrock requires cloud connection metadata.');
    return;
  }
  const allowed = cloud.service === 'vertex' ? ['service', 'project', 'location'] : cloud.service === 'bedrock' ? ['service', 'region'] : ['service'];
  if (Object.keys(cloud).some(key => !allowed.includes(key))) throw new Error('Cloud connection metadata cannot contain credentials or unknown fields.');
  if (cloud.service !== 'azure' && config.verifyStrategy !== undefined && !['minimal-message', 'unsupported'].includes(config.verifyStrategy)) throw new Error('Native cloud verification supports minimal-message or unsupported.');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || config.oauth) throw new Error('Cloud connections require a non-secret HTTPS endpoint and cannot mix OAuth dialects.');
  const expected = cloud.service === 'azure' ? 'openai' : cloud.service === 'bedrock' ? 'bedrock' : 'google';
  if (!['azure', 'gemini', 'vertex', 'bedrock'].includes(cloud.service) || config.protocol !== expected
    || (cloud.service === 'azure' ? config.api !== 'responses' : config.api !== undefined)) throw new Error('Cloud connection and native protocol do not match.');
  if (cloud.service === 'bedrock') segment(cloud.region);
  if (cloud.service === 'vertex' && (!!cloud.project !== !!cloud.location)) throw new Error('Vertex requires project and location together.');
  if (cloud.service === 'vertex') { if (cloud.project !== undefined) segment(cloud.project); if (cloud.location !== undefined) segment(cloud.location); }
}
