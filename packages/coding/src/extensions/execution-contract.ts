import type { AgentActorClient, KodaXJsonValue } from '@kodax-ai/agent';
import type { KodaXToolResultContentItem } from '@kodax-ai/llm';

export type ExtensionToolResult = string | readonly KodaXToolResultContentItem[];

/** Authority comes from the admitted host invocation, never extension input. */
export interface ExtensionExecutionScope {
  readonly version: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly extensionId: string;
  readonly signal: AbortSignal;
  readonly actors?: AgentActorClient;
  invokeTool(name: string, input: Record<string, unknown>): Promise<ExtensionToolResult>;
  reportProgress(progress: { message: string; data?: KodaXJsonValue }): void;
}
