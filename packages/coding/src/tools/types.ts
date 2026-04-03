/**
 * KodaX Tool Types
 */

import type { KodaXToolDefinition } from '@kodax/ai';
import type { KodaXToolExecutionContext } from '../types.js';

export type ToolHandler = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext
) => Promise<string>;

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
  | 'mcp_read_resource';

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
