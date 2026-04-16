/**
 * KodaX Tool Types
 */

import type { KodaXToolDefinition } from '@kodax/ai';
import type { KodaXToolExecutionContext } from '../types.js';

/**
 * Progress yield from a streaming (async generator) tool.
 * Each yield appears as a real-time status update in the REPL transcript.
 */
export interface ToolProgress {
  readonly stage: string;
  readonly message: string;
}

/** Standard tool handler — returns a single result string. */
export type ToolHandlerSync = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext,
) => Promise<string>;

/** Streaming tool handler — yields progress updates, returns final result string. */
export type ToolHandlerStreaming = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext,
) => AsyncGenerator<ToolProgress, string, void>;

/** Union of both handler types. Existing tools use ToolHandlerSync; new long-running tools may use ToolHandlerStreaming. */
export type ToolHandler = ToolHandlerSync | ToolHandlerStreaming;

export interface LocalToolDefinition extends KodaXToolDefinition {
  handler: ToolHandler;
}

export interface ToolDefinitionSource {
  kind: 'builtin' | 'extension';
  id?: string;
  label?: string;
}

export interface RegisteredToolDefinition extends LocalToolDefinition {
  registrationId: string;
  requiredParams: string[];
  source: ToolDefinitionSource;
}

export interface ToolRegistrationOptions {
  source?: ToolDefinitionSource;
}

export type ToolRegistry = Map<string, RegisteredToolDefinition[]>;

export type KodaXRetrievalToolName =
  | 'web_search'
  | 'web_fetch'
  | 'code_search'
  | 'semantic_lookup'
  | 'mcp_search'
  | 'mcp_describe'
  | 'mcp_call'
  | 'mcp_read_resource'
  | 'mcp_get_prompt';

export type KodaXRetrievalScope = 'workspace' | 'remote';
export type KodaXRetrievalTrust = 'workspace' | 'provider' | 'open-world';
export type KodaXRetrievalFreshness = 'fresh' | 'snapshot' | 'unknown';

export interface KodaXRetrievalArtifact {
  kind: 'url' | 'path' | 'symbol' | 'module' | 'process' | 'provider';
  label: string;
  value: string;
}

export interface KodaXRetrievalItem {
  title: string;
  locator?: string;
  snippet?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface KodaXRetrievalResult {
  tool: KodaXRetrievalToolName;
  query?: string;
  scope: KodaXRetrievalScope;
  trust: KodaXRetrievalTrust;
  freshness: KodaXRetrievalFreshness;
  provider?: string;
  summary: string;
  content?: string;
  items: KodaXRetrievalItem[];
  artifacts?: KodaXRetrievalArtifact[];
  metadata?: Record<string, unknown>;
}
