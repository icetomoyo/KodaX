import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { countTokens, estimateTokens } from '../tokenizer.js';

export type RuntimeContextOptimizationProfile =
  | 'off'
  | 'report_only'
  | 'balanced'
  | 'small_window'
  | 'aggressive';

export type RuntimeContextPressure = 'low' | 'medium' | 'high' | 'critical';

export interface RuntimeContextBudgetBreakdown {
  readonly systemPrompt: number;
  readonly toolSchemas: number;
  readonly skillCatalog: number;
  readonly mcpCatalog: number;
  readonly transcript: number;
  readonly pendingInput: number;
  readonly recentToolResults: number;
  readonly reservedResponse: number;
  readonly total: number;
}

export interface RuntimeContextBudgetSnapshot {
  /** The policy used by the execution owner, including its actual physical reserves. */
  readonly compactionBudget?: {
    readonly triggerPercent: number;
    readonly absoluteTriggerTokens?: number;
    readonly triggerTokens: number;
    readonly physicalCapacityTokens: number;
    readonly reservedResponseTokens: number;
    readonly reservedMemoryTokens: number;
  };
  readonly sessionId?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly profile: RuntimeContextOptimizationProfile;
  readonly contextWindow: number;
  readonly smallWindow: boolean;
  readonly pressure: RuntimeContextPressure;
  readonly tokenBreakdown: RuntimeContextBudgetBreakdown;
  readonly usedTokens: number;
  /** Diagnostic slack for the existing snapshot; never an append budget. */
  readonly availableTokens: number;
  readonly usedRatio: number;
  readonly toolSchemaRatio: number;
  readonly recommendations: readonly RuntimeContextBudgetRecommendation[];
  readonly createdAt: string;
}

export type RuntimeContextBudgetRecommendation =
  | 'prefer_progressive_tool_exposure'
  | 'compact_or_summarize_history'
  | 'trim_recent_tool_results'
  | 'reserve_response_budget';

export interface RuntimeContextBudgetSnapshotInput {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: RuntimeContextOptimizationProfile;
  readonly contextWindow: number;
  readonly systemPrompt?: string;
  readonly toolDefinitions?: readonly KodaXToolDefinition[];
  readonly skillCatalogText?: string;
  readonly mcpCatalogText?: string;
  readonly messages?: readonly KodaXMessage[];
  readonly messageTokenBreakdown?: RuntimeContextBudgetMessageBreakdown;
  readonly pendingInput?: string;
  readonly recentToolResults?: readonly string[];
  readonly reservedResponseTokens?: number;
  readonly now?: () => Date;
}

export interface RuntimeContextBudgetMessageBreakdown {
  readonly transcript: number;
  readonly pendingInput: number;
  readonly recentToolResults: number;
  readonly skillCatalog: number;
  readonly mcpCatalog: number;
}

export function partitionContextBudgetMessages(
  messages: readonly KodaXMessage[],
  catalogs?: {
    readonly skillTexts?: readonly string[];
    readonly mcpTexts?: readonly string[];
  },
): RuntimeContextBudgetMessageBreakdown {
  const currentTurnId = [...messages]
    .reverse()
    .find((message) => message.turnId !== undefined)
    ?.turnId;
  const fallbackPendingStart = findLastRealUserMessageIndex(messages);
  const currentTurnStart = currentTurnId === undefined
    ? fallbackPendingStart
    : messages.findIndex((message) => message.turnId === currentTurnId);
  const latestAssistantIndex = findLastAssistantIndex(messages);
  const pendingStart = currentTurnStart < 0
    ? messages.length
    : latestAssistantIndex >= currentTurnStart
      ? latestAssistantIndex + 1
      : currentTurnStart;
  const totals = {
    transcript: 0,
    pendingInput: 0,
    recentToolResults: 0,
    skillCatalog: 0,
    mcpCatalog: 0,
  };

  messages.forEach((message, index) => {
    const messageTokens = estimateTokens([message]);
    if (containsToolResult(message)) {
      totals.recentToolResults += messageTokens;
      return;
    }
    const catalogTokens = countCatalogTokens(message, catalogs);
    const mcpTokens = Math.min(messageTokens, catalogTokens.mcpCatalog);
    const skillTokens = Math.min(
      messageTokens - mcpTokens,
      catalogTokens.skillCatalog,
    );
    totals.mcpCatalog += mcpTokens;
    totals.skillCatalog += skillTokens;
    const ordinaryTokens = messageTokens - mcpTokens - skillTokens;
    if (pendingStart >= 0 && index >= pendingStart) {
      totals.pendingInput += ordinaryTokens;
    } else {
      totals.transcript += ordinaryTokens;
    }
  });

  return totals;
}

export function estimateToolSchemaTokens(
  definition: KodaXToolDefinition,
  descriptionOverride?: string,
): number {
  return estimateStringTokens(JSON.stringify({
    name: definition.name,
    description: descriptionOverride ?? definition.description,
    parameters: definition.input_schema,
  }));
}

export function createRuntimeContextBudgetSnapshot(
  input: RuntimeContextBudgetSnapshotInput,
): RuntimeContextBudgetSnapshot {
  const contextWindow = toNonNegativeInteger(input.contextWindow);
  const reservedResponse = toNonNegativeInteger(input.reservedResponseTokens ?? 0);
  const systemPrompt = estimateStringTokens(input.systemPrompt ?? '');
  const toolSchemas = sumTokens(input.toolDefinitions ?? [], estimateToolSchemaTokens);
  const skillCatalog = input.messageTokenBreakdown
    ? toNonNegativeInteger(input.messageTokenBreakdown.skillCatalog)
    : estimateStringTokens(input.skillCatalogText ?? '');
  const mcpCatalog = input.messageTokenBreakdown
    ? toNonNegativeInteger(input.messageTokenBreakdown.mcpCatalog)
    : estimateStringTokens(input.mcpCatalogText ?? '');
  const transcript = input.messageTokenBreakdown
    ? toNonNegativeInteger(input.messageTokenBreakdown.transcript)
    : estimateTokens(input.messages ?? []);
  const pendingInput = input.messageTokenBreakdown
    ? toNonNegativeInteger(input.messageTokenBreakdown.pendingInput)
    : estimateStringTokens(input.pendingInput ?? '');
  const recentToolResults = input.messageTokenBreakdown
    ? toNonNegativeInteger(input.messageTokenBreakdown.recentToolResults)
    : sumTokens(input.recentToolResults ?? [], estimateStringTokens);
  const total = systemPrompt
    + toolSchemas
    + skillCatalog
    + mcpCatalog
    + transcript
    + pendingInput
    + recentToolResults
    + reservedResponse;
  const availableTokens = contextWindow > 0 ? Math.max(0, contextWindow - total) : 0;
  const usedRatio = contextWindow > 0 ? clampRatio(total / contextWindow) : 1;
  const toolSchemaRatio = contextWindow > 0 ? clampRatio(toolSchemas / contextWindow) : 0;
  const smallWindow = contextWindow > 0 && contextWindow <= 32_000;
  const pressure = classifyContextPressure({
    availableTokens,
    contextWindow,
    smallWindow,
    usedRatio,
  });

  return {
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    ...(input.contextKind !== undefined ? { contextKind: input.contextKind } : {}),
    ...(input.parentContextId !== undefined
      ? { parentContextId: input.parentContextId }
      : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    provider: input.provider,
    model: input.model,
    profile: input.profile ?? 'report_only',
    contextWindow,
    smallWindow,
    pressure,
    tokenBreakdown: {
      systemPrompt,
      toolSchemas,
      skillCatalog,
      mcpCatalog,
      transcript,
      pendingInput,
      recentToolResults,
      reservedResponse,
      total,
    },
    usedTokens: total,
    availableTokens,
    usedRatio,
    toolSchemaRatio,
    recommendations: buildRecommendations({
      pressure,
      recentToolResults,
      reservedResponse,
      toolSchemaRatio,
    }),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

function containsToolResult(message: KodaXMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_result');
}

function findLastRealUserMessageIndex(messages: readonly KodaXMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && message._synthetic !== true && !containsToolResult(message)) {
      let start = index;
      while (start > 0 && messages[start - 1]?.role === 'user') start -= 1;
      return start;
    }
  }
  return -1;
}

function findLastAssistantIndex(messages: readonly KodaXMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index;
  }
  return -1;
}

interface CatalogMatch {
  readonly start: number;
  readonly end: number;
  readonly kind: 'skillCatalog' | 'mcpCatalog';
}

function countCatalogTokens(
  message: KodaXMessage,
  catalogs: {
    readonly skillTexts?: readonly string[];
    readonly mcpTexts?: readonly string[];
  } | undefined,
): { readonly skillCatalog: number; readonly mcpCatalog: number } {
  const text = messageText(message);
  if (text.length === 0 || catalogs === undefined) {
    return { skillCatalog: 0, mcpCatalog: 0 };
  }
  const candidates = [
    ...findTextMatches(text, catalogs.skillTexts, 'skillCatalog'),
    ...findTextMatches(text, catalogs.mcpTexts, 'mcpCatalog'),
  ].sort((left, right) => left.start - right.start || right.end - left.end);
  const accepted: CatalogMatch[] = [];
  for (const candidate of candidates) {
    if (accepted.some((match) => candidate.start < match.end && candidate.end > match.start)) {
      continue;
    }
    accepted.push(candidate);
  }
  return accepted.reduce(
    (totals, match) => ({
      ...totals,
      [match.kind]: totals[match.kind] + countTokens(text.slice(match.start, match.end)),
    }),
    { skillCatalog: 0, mcpCatalog: 0 },
  );
}

function findTextMatches(
  text: string,
  needles: readonly string[] | undefined,
  kind: CatalogMatch['kind'],
): CatalogMatch[] {
  const matches: CatalogMatch[] = [];
  for (const needle of new Set(needles?.map((value) => value.trim()).filter(Boolean) ?? [])) {
    let start = text.indexOf(needle);
    while (start >= 0) {
      matches.push({ start, end: start + needle.length, kind });
      start = text.indexOf(needle, start + needle.length);
    }
  }
  return matches;
}

function messageText(message: KodaXMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
      block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function estimateStringTokens(value: string): number {
  if (value.length === 0) return 0;
  return Math.max(0, countTokens(value));
}

function sumTokens<T>(
  values: readonly T[],
  estimator: (value: T) => number,
): number {
  let total = 0;
  for (const value of values) {
    total += estimator(value);
  }
  return total;
}

function classifyContextPressure(input: {
  readonly availableTokens: number;
  readonly contextWindow: number;
  readonly smallWindow: boolean;
  readonly usedRatio: number;
}): RuntimeContextPressure {
  if (input.contextWindow <= 0 || input.availableTokens <= 0 || input.usedRatio >= 0.9) {
    return 'critical';
  }
  if (input.availableTokens <= Math.max(1_024, input.contextWindow * 0.05)) {
    return 'critical';
  }
  if (input.usedRatio >= 0.75) {
    return 'high';
  }
  if (input.availableTokens <= Math.max(2_048, input.contextWindow * 0.15)) {
    return 'high';
  }
  if (input.usedRatio >= 0.55 || (input.smallWindow && input.usedRatio >= 0.4)) {
    return 'medium';
  }
  return 'low';
}

function buildRecommendations(input: {
  readonly pressure: RuntimeContextPressure;
  readonly recentToolResults: number;
  readonly reservedResponse: number;
  readonly toolSchemaRatio: number;
}): readonly RuntimeContextBudgetRecommendation[] {
  if (input.pressure === 'low') return [];

  const recommendations: RuntimeContextBudgetRecommendation[] = [];
  if (input.toolSchemaRatio >= 0.08) {
    recommendations.push('prefer_progressive_tool_exposure');
  }
  if (input.pressure === 'high' || input.pressure === 'critical') {
    recommendations.push('compact_or_summarize_history');
  }
  if (input.recentToolResults > 0) {
    recommendations.push('trim_recent_tool_results');
  }
  if (input.reservedResponse === 0) {
    recommendations.push('reserve_response_budget');
  }
  return recommendations;
}

function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  return value > 1 ? 1 : value;
}
