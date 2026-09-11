/**
 * Layer A Primitive: Capability provider contract.
 *
 * FEATURE_082 (v0.7.24): extracted from `@kodax-ai/coding/src/extensions/types.ts`
 * so third-party capability sources (MCP, RAG, custom indexes, …) can
 * implement `CapabilityProvider` without importing from the coding preset.
 *
 * The richer "extension runtime" concept (command registration, file
 * contributions, logger plumbing) stays in `@kodax-ai/coding/src/extensions/`
 * because it is coupled to the coding CLI surface.
 */

import type { KodaXToolResultContentItem } from './types.js';

export type CapabilityKind = 'tool' | 'resource' | 'prompt';

export interface CapabilitySearchOptions {
  kind?: CapabilityKind;
  limit?: number;
  server?: string;
}

export type CapabilitySearchFreshness = 'live' | 'cached' | 'stale' | 'mixed' | 'unknown';

export interface CapabilitySearchFailure {
  source: string;
  message: string;
}

/** Complete internal search view. Model-facing tools page this snapshot. */
export interface CapabilitySearchSnapshot {
  items: unknown[];
  revision?: string;
  complete: boolean;
  freshness: CapabilitySearchFreshness;
  failures?: CapabilitySearchFailure[];
}

export interface CapabilityResult {
  kind: CapabilityKind;
  content?: string | readonly KodaXToolResultContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
  evidence?: unknown[];
  artifacts?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface CapabilityProvider {
  id: string;
  kinds: CapabilityKind[];
  search?: (
    query: string,
    options?: CapabilitySearchOptions,
  ) => Promise<unknown[]>;
  searchSnapshot?: (
    query: string,
    options?: Omit<CapabilitySearchOptions, 'limit'>,
  ) => Promise<CapabilitySearchSnapshot>;
  describe?: (id: string) => Promise<unknown>;
  execute?: (id: string, input: Record<string, unknown>) => Promise<CapabilityResult>;
  read?: (id: string, options?: Record<string, unknown>) => Promise<CapabilityResult>;
  getPrompt?: (id: string, args?: Record<string, unknown>) => Promise<unknown>;
  getPromptContext?: () => Promise<string | undefined> | string | undefined;
  getDiagnostics?: () => Record<string, unknown> | undefined;
  refresh?: () => Promise<void>;
  dispose?: () => Promise<void>;
}
