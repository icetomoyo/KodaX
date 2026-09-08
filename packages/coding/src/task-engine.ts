/**
 * FEATURE_076 + FEATURE_084 (v0.7.26):
 *
 * `runManagedTask` is the single public entry point for AMA/AMAW/SA task runs.
 * Its body collapsed dramatically in Shard 6d when the legacy state-machine
 * orchestration (formerly ~6000 lines of role dispatch, protocol parsing,
 * harness escalation, budget accounting, and manual evaluator reshaping)
 * was replaced by the Runner-driven path in `./task-engine/runner-driven.ts`.
 *
 * Dispatch:
 *   - SA mode  -> `runKodaX` with a direct-path prompt overlay.
 *   - AMA mode -> `runManagedTaskViaRunner` (Scout → Planner? → Generator
 *                 → Evaluator via Layer-A Runner + protocol emit tools).
 *
 * The outer wrapper also runs `reshapeToUserConversation` so
 * `result.messages` surfaces a clean user-facing {user, assistant} pair
 * regardless of the internal round shape.
 *
 * `__checkpointTestables` is re-exported for `checkpoint.test.ts`; the
 * underlying helpers live in `./task-engine/_internal/managed-task/checkpoint.ts`
 * and are still used at runtime by the Runner path.
 */
import { mapLegacyReasoningModeToEffortIntent, runWithScopedConfig } from '@kodax-ai/llm';
import { SkillRegistry, formatSkillsSystemPrompt } from '@kodax-ai/agent';
import { runKodaX } from './agent.js';
import { deriveRunScopedConfig } from './run-scoped-config.js';
import {
  applyRuntimeSkillInvocationPolicy,
  awaitRuntimeSkillInvocationPolicy,
} from './skill-invocation-policy.js';
import { listToolDefinitions } from './tools/index.js';
import { hasExplicitNaturalLanguageWorkflowIntent } from './workflows/invocation-policy.js';
import { emitEffectiveTaskConfig } from './agent-runtime/effective-config.js';
import {
  applyToolVisibilityPolicy,
  getRuntimeActiveToolNames,
} from './agent-runtime/tool-resolution.js';
import {
  buildFallbackRoutingDecision,
  createReasoningPlan,
  inferIntentGate,
  resolveReasoningMode,
} from './reasoning.js';
import { resolveProvider } from './providers/index.js';
import { reshapeToUserConversation } from './task-engine/_internal/round-boundary.js';
import { runManagedTaskViaRunner } from './task-engine/runner-driven.js';
import {
  getRepoRoutingSignals,
  resolveKodaXAutoRepoMode,
  resolveKodaXHotPathRepoMode,
} from './repo-intelligence/runtime.js';
import {
  emitManagedRepoIntelligenceTrace,
} from './task-engine/_internal/managed-task/repo-intelligence.js';
import {
  CHECKPOINT_FILE,
  CHECKPOINT_MAX_AGE_MS,
  getGitHeadCommit,
  writeCheckpoint,
  deleteCheckpoint,
  findValidCheckpoint,
} from './task-engine/_internal/managed-task/checkpoint.js';
import type {
  KodaXCanonicalAgentMode,
  KodaXHarnessProfile,
  KodaXOptions,
  KodaXResult,
  KodaXTaskRoutingDecision,
} from './types.js';
import { normalizeKodaXAgentMode } from './types.js';

export function resolveManagedAgentMode(options: KodaXOptions): KodaXCanonicalAgentMode {
  return normalizeKodaXAgentMode(options.agentMode) ?? 'ama';
}

export function buildDirectPathTaskFamilyPromptOverlay(
  family: KodaXTaskRoutingDecision['taskFamily'] | undefined,
  sections: Array<string | undefined>,
): string {
  const familyRule = family === 'review'
    ? '[Direct Path Rule] Return a review report, not a plan. Findings first when issues exist; otherwise explicitly say no findings.'
    : family === 'lookup'
      ? '[Direct Path Rule] Return a concise factual answer with the relevant file path(s) and only the minimum supporting detail.'
      : family === 'planning'
        ? '[Direct Path Rule] Return a concrete plan, not an implementation report.'
        : family === 'investigation'
          ? '[Direct Path Rule] Return diagnosis, evidence, and next steps.'
          : undefined;

  return [...sections, familyRule].filter(Boolean).join('\n\n');
}

/**
 * FEATURE_100 P3.6t: extracted from `buildManagedReasoningPlan` so
 * CAP-091-002 can verify the "last 10" constraint at function level.
 *
 * Returns `undefined` when initialMessages is missing / empty, otherwise
 * slices to the most recent 10 messages.
 */
export function extractRecentMessagesForPlan<T>(
  initialMessages: readonly T[] | undefined,
): readonly T[] | undefined {
  if (!Array.isArray(initialMessages) || initialMessages.length === 0) {
    return undefined;
  }
  return initialMessages.slice(-10);
}

export const __checkpointTestables = {
  writeCheckpoint,
  deleteCheckpoint,
  findValidCheckpoint,
  getGitHeadCommit,
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_FILE,
};

/** Bind the default model-visible Skill catalog for every managed entry point. */
export async function ensureManagedSkillCatalog(
  options: KodaXOptions,
): Promise<KodaXOptions> {
  if (options.context?.skillsPrompt !== undefined) return options;

  const boundRegistry = options.context?.skillRegistry;
  const projectRoot = options.context?.gitRoot
    ?? options.context?.executionCwd
    ?? process.cwd();
  const registry = boundRegistry ?? new SkillRegistry(projectRoot);
  if (!boundRegistry) await registry.discover();

  return {
    ...options,
    context: {
      ...options.context,
      skillRegistry: registry,
      skillsPrompt: formatSkillsSystemPrompt(registry.list()),
    },
  };
}

export async function runManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const catalogOptions = await ensureManagedSkillCatalog(options);
  const runtimeOptions = await applyRuntimeSkillInvocationPolicy(catalogOptions, prompt);
  // Run-scoped config via AsyncLocalStorage (concurrency-safe): each concurrent
  // SDK session carries its own tier / token / prompt-cache / lsp overrides in
  // its own async context, so they never clobber one another through the global
  // process.env. Readers (model-hint-routing, provider max-output-tokens +
  // prompt-cache, lsp service) check this store first, then fall back to env for
  // the CLI / config.json path (env-bridged, single-session). Only the fields
  // the caller actually set enter the store, so the CLI path stays on env.
  // Shared derivation (deriveRunScopedConfig) is the single source of truth so
  // this and the `runKodaX` SA entry never diverge on which fields are scoped.
  let failure: unknown;
  try {
    return await runWithScopedConfig(
      deriveRunScopedConfig(runtimeOptions),
      async () => {
        const result = await executeRunManagedTask(runtimeOptions, prompt);
        const reshaped = reshapeToUserConversation(result, runtimeOptions, prompt);
        // FEATURE_247 (R1): echo the SDK-consumer profile back so the embedder can
        // confirm which profile actually ran (Partner vs default Coding Agent).
        // Pure passthrough — omitted entirely for the default path.
        return runtimeOptions.context?.agentProfile
          ? { ...reshaped, agentProfile: runtimeOptions.context.agentProfile }
          : reshaped;
      },
    );
  } catch (error: unknown) {
    failure = error;
    throw error;
  } finally {
    await awaitRuntimeSkillInvocationPolicy(runtimeOptions, failure);
  }
}

/**
 * Dispatcher dependencies. Defaulted to the production wiring; tests
 * (and CAP-089 / CAP-090 / CAP-091 contract suites) inject mocks to
 * verify the agentMode → executor routing without spinning up the
 * full substrate.
 *
 * FEATURE_100 P3.6t: extracted from inline `executeRunManagedTask` so
 * CAP-DISPATCH-001 / CAP-DISPATCH-002 / CAP-DIRECT-PATH-RULE-006 /
 * CAP-MANAGED-REASONING-002 can be activated as function-level
 * contracts without hoisted vi.mock.
 */
export interface ManagedDispatchDeps {
  readonly runSA: (options: KodaXOptions, prompt: string) => Promise<KodaXResult>;
  readonly runAMA: typeof runManagedTaskViaRunner;
  readonly buildPlan: typeof buildManagedReasoningPlan;
}

export const defaultManagedDispatchDeps: ManagedDispatchDeps = {
  runSA: runKodaX,
  runAMA: runManagedTaskViaRunner,
  buildPlan: buildManagedReasoningPlan,
};

// FEATURE_246: Solo (SA) is a single agent — no workflows, sub-agents, or peers.
// Strip the collaboration cluster from its model-visible tool surface. This is
// intentionally stricter than Runtime Actor children, which retain the injected
// collaboration control plane.
const SA_SOLO_EXCLUDE_TOOLS: readonly string[] = [
  'list_dispatchable_agents',
  'spawn_agent',
  'run_workflow',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'agent_output',
  'emit_managed_protocol',
];

export async function dispatchManagedTask(
  options: KodaXOptions,
  prompt: string,
  deps: ManagedDispatchDeps = defaultManagedDispatchDeps,
): Promise<KodaXResult> {
  const agentMode = resolveManagedAgentMode(options);
  if (agentMode === 'sa') {
    const intentGate = inferIntentGate(prompt);
    const excludeTools = [
      ...(options.context?.excludeTools ?? []),
      ...SA_SOLO_EXCLUDE_TOOLS,
    ];
    const saOptions: KodaXOptions = {
      ...options,
      context: {
        ...options.context,
        promptOverlay: buildDirectPathTaskFamilyPromptOverlay(
          intentGate.taskFamily,
          [options.context?.promptOverlay],
        ),
        // FEATURE_247 (R1): on the SA path a profile's instructions map to the
        // already-honored `systemPromptOverride` (consumed in
        // reasoning-plan-entry.ts). An explicit caller-set override still wins;
        // when neither is set this stays undefined ⇒ byte-identical default.
        systemPromptOverride: options.context?.systemPromptOverride
          ?? options.context?.agentProfile?.instructions,
        excludeTools,
      },
    };
    // FEATURE_247 (R4): report the effective profile / tool scope / verification
    // once at run start. Fires only when a subscriber is set ⇒ inert by default.
    emitEffectiveTaskConfig(saOptions, {
      agentMode: 'sa',
      toolScope: computeVisibleToolScope(saOptions, excludeTools),
    });
    return deps.runSA(saOptions, prompt);
  }

  // Shard 6d-L: AMA entry must run the same `createReasoningPlan` the legacy
  // task engine ran (task-engine.ts:1670-1702). The reasoning plan produces
  // `decision.primaryTask` / `decision.mutationSurface` / `decision.riskLevel`
  // / `decision.taskFamily` / `decision.harnessProfile` etc. Without this the
  // Runner-driven path used placeholder `conversation` / `simple` / `low`
  // values, which broke every downstream branch that read `contract.primaryTask`
  // (agent.ts has 10+ such branches in SA guardrails).
  //
  // `createReasoningPlan` also computes `plan.promptOverlay` — a block of
  // per-task routing notes (task-family guidance, work intent, brainstorm
  // directives, provider policy notes) legacy injected into every managed
  // worker's prompt. We thread it into the Runner chain so Scout/Planner/
  // Generator/Evaluator see the same contextual overlay as legacy workers.
  // FEATURE_247 (R4): report the effective config for the AMA/AMAW path too.
  const naturalLanguageInput = options.context?.rawUserInput ?? prompt;
  const workflowIntent = options.context?.workflowIntent
    ?? (hasExplicitNaturalLanguageWorkflowIntent(naturalLanguageInput) ? 'explicit' : undefined);
  const amaOptions: KodaXOptions = workflowIntent === undefined
    ? options
    : {
        ...options,
        context: { ...options.context, workflowIntent },
      };
  emitEffectiveTaskConfig(amaOptions, {
    agentMode,
    toolScope: computeVisibleToolScope(amaOptions, amaOptions.context?.excludeTools ?? []),
  });
  const plan = await deps.buildPlan(amaOptions, prompt);
  return deps.runAMA(amaOptions, prompt, undefined, plan);
}

/**
 * FEATURE_247 (R4) — the model-visible tool scope reported at run start.
 *
 * Mirrors the runner's real pipeline so the report matches what the model
 * actually sees: registered tools, minus `excludeTools` (way IN), minus tools
 * hidden by the profile `toolVisibilityPolicy` (way IN), minus the per-turn
 * runtime OUT filters (`getRuntimeActiveToolNames`: MCP tools stripped without a
 * capability runtime, repo-intelligence tools stripped when auto-repo is off,
 * construction/self-modify tools stripped unless `toolConstructionMode`). This
 * is a start-of-run snapshot; later per-turn repo-intel mode changes aren't
 * tracked.
 */
function computeVisibleToolScope(
  options: KodaXOptions,
  excludeTools: readonly string[],
): string[] {
  const excluded = new Set(excludeTools);
  const afterExcludeAndPolicy = applyToolVisibilityPolicy(
    listToolDefinitions()
      .map((tool) => tool.name)
      .filter((name) => !excluded.has(name))
      // The managed agent-chain applies the same host-backed gate when it
      // builds the real model surface. Keep the start-of-run effective-config
      // snapshot honest instead of reporting a tool the model cannot call.
      .filter((name) => name !== 'run_workflow' || options.context?.workflowIntent === 'explicit'),
    options.context?.toolVisibilityPolicy,
  );
  return getRuntimeActiveToolNames(
    afterExcludeAndPolicy,
    options.context?.repoIntelligenceMode,
    Boolean(options.extensionRuntime),
    options.context?.toolConstructionMode,
    options.context?.agentExecutorPlane !== undefined,
  );
}

async function executeRunManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  return dispatchManagedTask(options, prompt);
}

export async function buildManagedReasoningPlan(options: KodaXOptions, prompt: string) {
  // Mirror the conditional repo-routing-signal capture from legacy
  // `createManagedReasoningPlan` (task-engine.ts:1670-1689): read signals
  // only when the workspace is available AND repo-intel auto mode is not
  // disabled. The routing-signal stage fires its own `onRepoIntelligenceTrace`
  // event so downstream observers can see where routing context came from.
  const intentGate = inferIntentGate(prompt);
  const shouldLoadRepoSignals = intentGate.shouldUseRepoSignals && Boolean(
    options.context?.executionCwd || options.context?.gitRoot,
  );
  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  const hotPathRepoMode = resolveKodaXHotPathRepoMode(options.context?.repoIntelligenceMode);
  const repoRoutingSignals = options.context?.repoRoutingSignals
    ?? (
      shouldLoadRepoSignals && autoRepoMode !== 'off'
        ? await getRepoRoutingSignals({
          executionCwd: options.context?.executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }, {
          mode: hotPathRepoMode,
        }).catch(() => null)
        : null
    );
  emitManagedRepoIntelligenceTrace(
    options.events,
    options,
    'routing',
    repoRoutingSignals,
    repoRoutingSignals?.activeModuleId
      ? `active_module=${repoRoutingSignals.activeModuleId}`
      : undefined,
  );

  try {
    const provider = resolveProvider(options.provider);
    const recentMessagesReadonly = extractRecentMessagesForPlan(options.session?.initialMessages);
    // createReasoningPlan accepts a mutable array — copy from the
    // readonly slice so we don't widen its signature for one caller.
    const recentMessages = recentMessagesReadonly ? [...recentMessagesReadonly] : undefined;
    return await createReasoningPlan(options, prompt, provider, {
      repoSignals: repoRoutingSignals ?? undefined,
      recentMessages,
    });
  } catch {
    // Match legacy resilience (task-engine.ts:1721-1762): reasoning failure
    // must not abort the AMA run. Previously returned `undefined` on
    // provider-resolution failure, which forced runner-driven.ts:4127 to
    // skip `chainPromptContext` and fall back to SCOUT_INSTRUCTIONS_FALLBACK
    // — a minimal prompt that omits collaboration guidance and
    // evidence strategies. Instead, build a prompt-only heuristic plan so
    // downstream role prompts still receive the full v0.7.22-parity
    // context (decision summary, tool-policy, dispatch rules).
    const fallbackDecision = buildFallbackRoutingDecision(prompt);
    return {
      effort: options.effort ?? mapLegacyReasoningModeToEffortIntent(resolveReasoningMode(options)),
      decision: fallbackDecision,
      promptOverlay: '',
    };
  }
}
