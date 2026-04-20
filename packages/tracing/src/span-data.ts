/**
 * SpanData variants — payload shapes carried by each `Span`.
 *
 * FEATURE_083 (v0.7.24): the Agent-era tracing model uses a discriminated
 * union so consumers (OpenTelemetry adapter, Langfuse adapter, KodaX
 * built-in file processor) can render each span kind with type safety.
 *
 * Variants mirror the semantic events KodaX emits today:
 *   - AgentSpanData     : one `Runner.run(agent, ...)` round
 *   - GenerationSpanData: one provider LLM call
 *   - ToolCallSpanData  : one tool invocation (including MCP tool)
 *   - HandoffSpanData   : continuation or as-tool handoff between agents
 *   - CompactionSpanData: one compaction pass (token-threshold or lineage)
 *   - GuardrailSpanData : one guardrail check at input/output/tool
 *   - EvidenceSpanData  : repo-intelligence / evidence acquisition
 *   - FanoutSpanData    : parallel fanout bracket (winner-cancel capable)
 *
 * API surface is `@experimental` until v0.8.0 — shape may be refined as
 * FEATURE_084 (v0.7.26) starts emitting these.
 */

export interface AgentSpanData {
  readonly kind: 'agent';
  readonly agentName: string;
  readonly model?: string;
  readonly provider?: string;
  readonly tools?: readonly string[];
  readonly handoffs?: readonly string[];
  readonly outputMessages?: number;
  readonly error?: string;
}

export interface GenerationSpanData {
  readonly kind: 'generation';
  readonly agentName: string;
  readonly provider: string;
  readonly model: string;
  readonly inputMessages?: number;
  readonly outputTokens?: number;
  readonly inputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedTokens?: number;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly reasoningTokens?: number;
    readonly cachedTokens?: number;
    readonly costUsd?: number;
  };
  readonly finishReason?: string;
  readonly error?: string;
}

export interface ToolCallSpanData {
  readonly kind: 'tool_call';
  readonly toolName: string;
  readonly providerId?: string;
  readonly capabilityId?: string;
  readonly inputPreview?: string;
  readonly outputPreview?: string;
  readonly status: 'ok' | 'error';
  readonly error?: string;
}

export interface HandoffSpanData {
  readonly kind: 'handoff';
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly handoffKind: 'continuation' | 'as-tool';
  readonly description?: string;
}

export interface CompactionSpanData {
  readonly kind: 'compaction';
  readonly policyName: string;
  readonly tokensUsed: number;
  readonly budget: number;
  readonly replacedMessageCount: number;
  readonly summaryLength: number;
  readonly error?: string;
}

export interface GuardrailSpanData {
  readonly kind: 'guardrail';
  readonly guardrailName: string;
  readonly hookPoint: 'input' | 'output' | 'tool';
  readonly decision: 'pass' | 'veto' | 'rewrite';
  readonly reason?: string;
}

export interface EvidenceSpanData {
  readonly kind: 'evidence';
  readonly source: string;
  readonly queryPreview?: string;
  readonly resultCount?: number;
  readonly cacheHit?: boolean;
  readonly error?: string;
}

export interface FanoutSpanData {
  readonly kind: 'fanout';
  readonly agentName: string;
  readonly childCount: number;
  readonly winnerChildId?: string;
  readonly cancelledChildIds?: readonly string[];
}

/**
 * Discriminated union of all span payload shapes. Additional variants may
 * be added in future features — consumers should check `kind` before
 * reading specific fields.
 */
export type SpanData =
  | AgentSpanData
  | GenerationSpanData
  | ToolCallSpanData
  | HandoffSpanData
  | CompactionSpanData
  | GuardrailSpanData
  | EvidenceSpanData
  | FanoutSpanData;
