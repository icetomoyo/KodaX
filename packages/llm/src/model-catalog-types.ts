import type { KodaXModelDescriptor } from './types.js';
import type { CostRate } from './cost-rates.js';
import type { KodaXOperationConnection } from './operations/types.js';

export type KodaXModelCatalogApi = 'openai-models' | 'openrouter-user-models' | 'radius-config';
export interface KodaXModelCatalogConnection extends KodaXOperationConnection {
  api: KodaXModelCatalogApi;
  /** Trusted current registration/account partition, not an unverified token claim. */
  accountScope: string;
  curatedModels?: readonly KodaXModelDescriptor[];
}
export interface KodaXCatalogQuote {
  source: 'catalog'; currency: 'USD'; unit: 'million-tokens'; checkedAt: number;
  rates: Partial<Pick<CostRate, 'inputPer1M' | 'outputPer1M' | 'cacheReadPer1M' | 'cacheWritePer1M'>>;
  /** Conditional source quotes remain explicit; never silently applied as an unconditional rate. */
  conditions?: readonly { when: Readonly<Record<string, unknown>>; rates: KodaXCatalogQuote['rates'] }[];
}
export interface KodaXCatalogModel {
  id: string; available: boolean; curated?: KodaXModelDescriptor;
  advertised: { displayName?: string; contextWindow?: number; outputTokenLimit?: number; imageInput?: boolean;
    reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> };
  quote?: KodaXCatalogQuote;
}
export interface KodaXModelCatalogSnapshot {
  version: 1; revision: string; scope: string; checkedAt: number;
  source: { api: KodaXModelCatalogApi; origin: string; pathHash: string };
  models: readonly KodaXCatalogModel[]; etag?: string; lastModified?: string;
  /** Same-origin declaration only. Applying a new route remains an explicit connection change. */
  suggestedBaseUrl?: string;
}
export interface KodaXModelCatalogStore {
  read(scope: string, signal?: AbortSignal): Promise<KodaXModelCatalogSnapshot | undefined>;
  /** Implementations must check signal + isCurrent at the atomic commit point, then persist before publication. */
  compareAndSwap(scope: string, expectedRevision: string | undefined, snapshot: KodaXModelCatalogSnapshot,
    options: { signal?: AbortSignal; isCurrent(): boolean }): Promise<boolean>;
}
export interface KodaXRefreshModelCatalogOptions {
  store?: KodaXModelCatalogStore; signal?: AbortSignal; timeoutMs?: number;
  /** Trusted Host fences account/connection changes and revocation, including late store writes. */
  isCurrent?(): boolean;
}
export interface KodaXRefreshModelCatalogResult {
  status: 'updated' | 'not-modified' | 'unavailable' | 'stale';
  snapshot?: KodaXModelCatalogSnapshot;
  httpStatus?: number;
}
