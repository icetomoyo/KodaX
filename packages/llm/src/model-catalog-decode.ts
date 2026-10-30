import type { KodaXModelCatalogConnection, KodaXCatalogModel, KodaXCatalogQuote } from './model-catalog-types.js';
import { object } from './operations/request.js';
import { resolveProviderModelDescriptors } from './providers/resolver.js';

function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function price(value: unknown, perToken: boolean): number | undefined {
  if (perToken && (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))) return undefined;
  const rate = perToken ? Number(value) * 1_000_000 : value;
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}
function readRates(data: Record<string, unknown>, perToken: boolean): KodaXCatalogQuote['rates'] {
  const rates: KodaXCatalogQuote['rates'] = {};
  for (const [native, key] of (perToken ? [['prompt', 'inputPer1M'], ['completion', 'outputPer1M'], ['input_cache_read', 'cacheReadPer1M'], ['input_cache_write', 'cacheWritePer1M']]
    : [['input', 'inputPer1M'], ['output', 'outputPer1M'], ['cacheRead', 'cacheReadPer1M'], ['cacheWrite', 'cacheWritePer1M']]) as Array<[string, keyof KodaXCatalogQuote['rates']]>) {
    const rate = price(data[native], perToken); if (rate !== undefined) Object.assign(rates, { [key]: rate });
  }
  return rates;
}
function quote(value: unknown, perToken: boolean, checkedAt: number): KodaXCatalogQuote | undefined {
  if (value === undefined || value === null) return undefined;
  const data = object(value), rates = readRates(data, perToken);
  const conditions = data.overrides ?? data.tiers;
  if (conditions != null && !Array.isArray(conditions)) throw new Error('Invalid conditional catalog pricing.');
  return { source: 'catalog', currency: 'USD', unit: 'million-tokens', checkedAt, rates,
    ...(Array.isArray(conditions) ? { conditions: conditions.map(item => {
      const condition = object(item), when = { ...condition };
      for (const key of perToken ? ['prompt', 'completion', 'input_cache_read', 'input_cache_write'] : ['input', 'output', 'cacheRead', 'cacheWrite']) delete when[key];
      return { when, rates: readRates(condition, perToken) };
    }) } : {}) };
}
export function decodeModelCatalog(connection: KodaXModelCatalogConnection, body: Record<string, unknown>, checkedAt: number): {
  models: KodaXCatalogModel[]; suggestedBaseUrl?: string;
} {
  const radius = connection.api === 'radius-config';
  const entries = radius ? body.models : body.data;
  if (!Array.isArray(entries)) throw new Error('Invalid model catalog list.');
  const curated = connection.curatedModels ?? resolveProviderModelDescriptors(connection.name);
  const byId = new Map(curated.map(model => [model.id, model]));
  const models = new Map<string, KodaXCatalogModel>();
  for (const value of entries) {
    const model = object(value), id = model.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id) || models.has(id)) throw new Error('Invalid or duplicate model catalog identifier.');
    const top = model.top_provider == null ? {} : object(model.top_provider);
    const contextWindow = positive(top.context_length) ?? positive(model.context_length) ?? (radius ? positive(model.contextWindow) : undefined);
    const outputTokenLimit = positive(top.max_completion_tokens) ?? (radius ? positive(model.maxTokens) : undefined);
    const rates = radius ? quote(model.cost, false, checkedAt) : connection.api === 'openrouter-user-models' ? quote(model.pricing, true, checkedAt) : undefined;
    const displayName = typeof model.name === 'string' && model.name.length <= 512 && !/[\u0000-\u001f\u007f]/.test(model.name) ? model.name : undefined;
    models.set(id, { id, available: true, ...(byId.has(id) ? { curated: structuredClone(byId.get(id)!) } : {}), advertised: {
      ...(displayName ? { displayName } : {}), ...(contextWindow ? { contextWindow } : {}), ...(outputTokenLimit ? { outputTokenLimit } : {}),
      ...(radius && Array.isArray(model.input) ? { imageInput: model.input.includes('image') } : {}),
      ...(radius && typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
      ...(radius && model.thinkingLevelMap ? { thinkingLevelMap: structuredClone(object(model.thinkingLevelMap)) } : {}),
    }, ...(rates ? { quote: rates } : {}) });
  }
  for (const model of curated) if (!models.has(model.id)) models.set(model.id, { id: model.id, available: false, curated: structuredClone(model), advertised: {} });
  let suggestedBaseUrl: string | undefined;
  if (radius) {
    if (typeof body.baseUrl !== 'string') throw new Error('Radius catalog requires a declared message endpoint.');
    const route = new URL(body.baseUrl), origin = new URL(connection.baseUrl);
    if (route.origin !== origin.origin || route.username || route.password || route.search || route.hash) throw new Error('Radius catalog returned a foreign or secret-bearing route.');
    suggestedBaseUrl = route.href.replace(/\/$/, '');
  }
  return { models: [...models.values()], ...(suggestedBaseUrl ? { suggestedBaseUrl } : {}) };
}
