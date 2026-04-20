/**
 * Layer A Primitive: Capability provider contract.
 *
 * FEATURE_082 (v0.7.24): extracted from `@kodax/coding/src/extensions/types.ts`
 * so third-party capability sources (MCP, RAG, custom indexes, …) can
 * implement `CapabilityProvider` without importing from the coding preset.
 *
 * The richer "extension runtime" concept (command registration, file
 * contributions, logger plumbing) stays in `@kodax/coding/src/extensions/`
 * because it is coupled to the coding CLI surface.
 */

export type CapabilityKind = 'tool' | 'resource' | 'prompt';

export interface CapabilityResult {
  kind: CapabilityKind;
  content?: string;
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
    options?: { kind?: CapabilityKind; limit?: number; server?: string },
  ) => Promise<unknown[]>;
  describe?: (id: string) => Promise<unknown>;
  execute?: (id: string, input: Record<string, unknown>) => Promise<CapabilityResult>;
  read?: (id: string, options?: Record<string, unknown>) => Promise<CapabilityResult>;
  getPrompt?: (id: string, args?: Record<string, unknown>) => Promise<unknown>;
  getPromptContext?: () => Promise<string | undefined> | string | undefined;
  getDiagnostics?: () => Record<string, unknown> | undefined;
  refresh?: () => Promise<void>;
  dispose?: () => Promise<void>;
}
