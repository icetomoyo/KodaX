import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { SCRIPT_TOOL_NAME } from './script/model.js';
import { calculateMaxContextInputTokens, RESERVE_SHRINK_FLOOR_TOKENS, PROTECTED_TOOL_NAMES } from '@kodax-ai/agent';
import { DEFERRED_TOOL_HINTS, isDeferredTool } from '../tools/deferred-tools.js';
import { getRegisteredToolDefinition } from '../tools/registry.js';
import {
  estimateToolSchemaTokens,
  type RuntimeContextBudgetSnapshot,
  type RuntimeContextOptimizationProfile,
  type RuntimeContextPressure,
} from './context-budget.js';

export type RuntimeToolExposureMode =
  | 'resident'
  | 'hint'
  | 'bridge'
  | 'native_deferred'
  | 'hidden';

export type RuntimeToolExposureReason =
  | 'profile_off'
  | 'protected_core'
  | 'already_unlocked'
  | 'low_pressure'
  | 'deferred_hint'
  | 'portable_bridge'
  | 'native_deferred'
  | 'bridge_unavailable';

export interface RuntimeToolExposureDecision {
  readonly toolName: string;
  readonly mode: RuntimeToolExposureMode;
  readonly recommendedMode: RuntimeToolExposureMode;
  readonly reason: RuntimeToolExposureReason;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly estimatedTokensIfApplied: number;
  readonly modelVisible: boolean;
}

export interface RuntimeToolExposurePlan {
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly profile: RuntimeContextOptimizationProfile;
  readonly reportOnly: boolean;
  readonly pressure: RuntimeContextPressure;
  readonly bridgeAvailable: boolean;
  readonly nativeDeferredAvailable: boolean;
  readonly decisions: readonly RuntimeToolExposureDecision[];
  readonly modelVisibleToolNames: readonly string[];
  readonly estimatedToolSchemaTokensBefore: number;
  readonly estimatedToolSchemaTokensAfter: number;
  readonly estimatedToolSchemaTokensIfApplied: number;
  readonly estimatedTokensSaved: number;
  readonly estimatedTokensSavedIfApplied: number;
  readonly residentToolCount: number;
  readonly hintedToolCount: number;
  readonly bridgeToolCount: number;
  readonly nativeDeferredToolCount: number;
  readonly hiddenToolCount: number;
}

export interface RuntimeToolExposurePlanInput {
  readonly tools: readonly KodaXToolDefinition[];
  readonly budget: RuntimeContextBudgetSnapshot;
  readonly profile?: RuntimeContextOptimizationProfile;
  readonly bridgeAvailable?: boolean;
  readonly nativeDeferredAvailable?: boolean;
  readonly unlockedDeferredTools?: ReadonlySet<string>;
}

const PORTABLE_BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_search',
]);

export const ALWAYS_RESIDENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  SCRIPT_TOOL_NAME,
  'ask_user_question',
  'bash',
  'spawn_agent',
  'edit',
  'exit_plan_mode',
  'glob',
  'grep',
  'insert_after_anchor',
  'multi_edit',
  'read',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'agent_output',
  'todo_create',
  'todo_get',
  'todo_list',
  'todo_update',
  'tool_call',
  'tool_describe',
  'tool_search',
  'undo',
  'worktree_create',
  'worktree_remove',
  'write',
]);

export function selectRuntimeContextOptimizationProfile(
  budget: RuntimeContextBudgetSnapshot,
): RuntimeContextOptimizationProfile {
  if (budget.smallWindow && (budget.pressure !== 'low' || budget.toolSchemaRatio >= 0.08)) {
    return 'small_window';
  }
  if (budget.pressure === 'high' || budget.pressure === 'critical') {
    return 'balanced';
  }
  if (budget.recommendations.includes('prefer_progressive_tool_exposure')) {
    return 'balanced';
  }
  return 'report_only';
}

export function hasPortableToolBridge(tools: readonly KodaXToolDefinition[]): boolean {
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of PORTABLE_BRIDGE_TOOL_NAMES) {
    if (!names.has(name)) return false;
  }
  return getRegisteredToolDefinition('tool_call')?.source.kind === 'builtin'
    && ['tool_search', 'tool_describe'].some(name => names.has(name)
      && getRegisteredToolDefinition(name)?.source.kind === 'builtin');
}

/** Recover an impossible fixed envelope without removing executable capabilities. */
export function fitToolSchemasToContext(
  tools: readonly KodaXToolDefinition[],
  input: { readonly contextWindow: number; readonly reservedResponseTokens: number; readonly systemTokens: number },
): KodaXToolDefinition[] {
  const available = Math.max(0, calculateMaxContextInputTokens(input.contextWindow,
    Math.min(input.reservedResponseTokens, RESERVE_SHRINK_FLOOR_TOKENS)) - input.systemTokens);
  const total = tools.reduce((sum, tool) => sum + estimateToolSchemaTokens(tool), 0);
  if (total <= available || !hasPortableToolBridge(tools)) return [...tools];
  const essential = new Set([...PORTABLE_BRIDGE_TOOL_NAMES, SCRIPT_TOOL_NAME, 'tool_describe', ...PROTECTED_TOOL_NAMES, 'read', 'session_history_read',
    'session_history_search', 'ask_user_question']);
  const hidden = new Set<string>();
  let remaining = total;
  // Leave working room for the task and returned evidence, not only schemas.
  for (const tool of tools.filter(tool => !essential.has(tool.name))
    .sort((a, b) => estimateToolSchemaTokens(b) - estimateToolSchemaTokens(a))) {
    if (remaining <= available / 2) break;
    hidden.add(tool.name);
    remaining -= estimateToolSchemaTokens(tool);
  }
  const discoveryTool = tools.some(tool => tool.name === 'tool_describe'
    && getRegisteredToolDefinition(tool.name)?.source.kind === 'builtin')
    ? 'tool_describe' : 'tool_search';
  return tools.filter(tool => !hidden.has(tool.name)).map(tool => tool.name === discoveryTool
    ? { ...tool, description: tool.description + '\nContext capacity recovery: these active tools remain callable through tool_call after reading their schema: '
      + [...hidden].join(', ') + '.' }
    : tool);
}

export function applyToolExposurePlan(
  tools: readonly KodaXToolDefinition[],
  plan: RuntimeToolExposurePlan,
): KodaXToolDefinition[] {
  if (plan.reportOnly) return [...tools];
  const visible = new Set(plan.modelVisibleToolNames);
  return tools.filter((tool) => visible.has(tool.name));
}

export function planToolExposure(input: RuntimeToolExposurePlanInput): RuntimeToolExposurePlan {
  const profile = input.profile ?? input.budget.profile;
  const reportOnly = profile === 'report_only';
  const bridgeAvailable = input.bridgeAvailable === true;
  const nativeDeferredAvailable = input.nativeDeferredAvailable === true;
  const decisions = input.tools.map((tool) => planTool(tool, {
    bridgeAvailable,
    nativeDeferredAvailable,
    pressure: input.budget.pressure,
    profile,
    reportOnly,
    unlockedDeferredTools: input.unlockedDeferredTools,
  }));
  const modelVisibleToolNames = decisions
    .filter((decision) => decision.modelVisible)
    .map((decision) => decision.toolName);
  const estimatedToolSchemaTokensBefore = sumDecisionTokens(decisions, 'estimatedTokensBefore');
  const estimatedToolSchemaTokensAfter = sumDecisionTokens(decisions, 'estimatedTokensAfter');
  const estimatedToolSchemaTokensIfApplied = sumDecisionTokens(decisions, 'estimatedTokensIfApplied');

  return {
    ...(input.budget.contextId !== undefined ? { contextId: input.budget.contextId } : {}),
    ...(input.budget.contextKind !== undefined
      ? { contextKind: input.budget.contextKind }
      : {}),
    ...(input.budget.parentContextId !== undefined
      ? { parentContextId: input.budget.parentContextId }
      : {}),
    ...(input.budget.agentId !== undefined ? { agentId: input.budget.agentId } : {}),
    profile,
    reportOnly,
    pressure: input.budget.pressure,
    bridgeAvailable,
    nativeDeferredAvailable,
    decisions,
    modelVisibleToolNames,
    estimatedToolSchemaTokensBefore,
    estimatedToolSchemaTokensAfter,
    estimatedToolSchemaTokensIfApplied,
    estimatedTokensSaved: Math.max(0, estimatedToolSchemaTokensBefore - estimatedToolSchemaTokensAfter),
    estimatedTokensSavedIfApplied: Math.max(0, estimatedToolSchemaTokensBefore - estimatedToolSchemaTokensIfApplied),
    residentToolCount: countMode(decisions, 'resident'),
    hintedToolCount: countMode(decisions, 'hint'),
    bridgeToolCount: countMode(decisions, 'bridge'),
    nativeDeferredToolCount: countMode(decisions, 'native_deferred'),
    hiddenToolCount: countMode(decisions, 'hidden'),
  };
}

function planTool(
  tool: KodaXToolDefinition,
  context: {
    readonly bridgeAvailable: boolean;
    readonly nativeDeferredAvailable: boolean;
    readonly pressure: RuntimeContextPressure;
    readonly profile: RuntimeContextOptimizationProfile;
    readonly reportOnly: boolean;
    readonly unlockedDeferredTools?: ReadonlySet<string>;
  },
): RuntimeToolExposureDecision {
  const estimatedTokensBefore = estimateToolSchemaTokens(tool);
  const currentMode = currentExposureMode(tool, context.unlockedDeferredTools);
  const recommendation = recommendedExposureMode(tool, context);
  const mode = context.reportOnly ? currentMode : recommendation.mode;
  const estimatedTokensAfter = estimateTokensForMode(tool, mode);
  const estimatedTokensIfApplied = estimateTokensForMode(tool, recommendation.mode);

  return {
    toolName: tool.name,
    mode,
    recommendedMode: recommendation.mode,
    reason: recommendation.reason,
    estimatedTokensBefore,
    estimatedTokensAfter,
    estimatedTokensIfApplied,
    modelVisible: mode === 'resident' || mode === 'hint' || mode === 'native_deferred',
  };
}

function currentExposureMode(
  tool: KodaXToolDefinition,
  unlockedDeferredTools: ReadonlySet<string> | undefined,
): RuntimeToolExposureMode {
  if (!isDeferredTool(tool.name)) return 'resident';
  if (unlockedDeferredTools?.has(tool.name)) return 'resident';
  return 'hint';
}

function recommendedExposureMode(
  tool: KodaXToolDefinition,
  context: {
    readonly bridgeAvailable: boolean;
    readonly nativeDeferredAvailable: boolean;
    readonly pressure: RuntimeContextPressure;
    readonly profile: RuntimeContextOptimizationProfile;
    readonly unlockedDeferredTools?: ReadonlySet<string>;
  },
): { readonly mode: RuntimeToolExposureMode; readonly reason: RuntimeToolExposureReason } {
  if (context.profile === 'off') {
    return { mode: 'resident', reason: 'profile_off' };
  }
  if (ALWAYS_RESIDENT_TOOL_NAMES.has(tool.name)) {
    return { mode: 'resident', reason: 'protected_core' };
  }
  if (!isDeferredTool(tool.name)) {
    return { mode: 'resident', reason: 'low_pressure' };
  }
  if (context.unlockedDeferredTools?.has(tool.name)) {
    return { mode: 'resident', reason: 'already_unlocked' };
  }
  if (!shouldReduceDeferredToolExposure(context.profile, context.pressure)) {
    return { mode: 'hint', reason: 'deferred_hint' };
  }
  if (context.bridgeAvailable) {
    return { mode: 'bridge', reason: 'portable_bridge' };
  }
  if (context.nativeDeferredAvailable) {
    return { mode: 'native_deferred', reason: 'native_deferred' };
  }
  return { mode: 'hint', reason: 'bridge_unavailable' };
}

function shouldReduceDeferredToolExposure(
  profile: RuntimeContextOptimizationProfile,
  pressure: RuntimeContextPressure,
): boolean {
  if (profile === 'aggressive') return pressure !== 'low';
  if (profile === 'small_window') return true;
  return pressure === 'high' || pressure === 'critical';
}

function estimateTokensForMode(
  tool: KodaXToolDefinition,
  mode: RuntimeToolExposureMode,
): number {
  if (mode === 'bridge' || mode === 'hidden') return 0;
  if (mode === 'hint') {
    return estimateToolSchemaTokens(tool, DEFERRED_TOOL_HINTS[tool.name] ?? tool.description);
  }
  return estimateToolSchemaTokens(tool);
}

function sumDecisionTokens(
  decisions: readonly RuntimeToolExposureDecision[],
  key: 'estimatedTokensBefore' | 'estimatedTokensAfter' | 'estimatedTokensIfApplied',
): number {
  return decisions.reduce((total, decision) => total + decision[key], 0);
}

function countMode(
  decisions: readonly RuntimeToolExposureDecision[],
  mode: RuntimeToolExposureMode,
): number {
  return decisions.filter((decision) => decision.mode === mode).length;
}
