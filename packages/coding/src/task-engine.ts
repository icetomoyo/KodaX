/**
 * FEATURE_076 + FEATURE_084 (v0.7.26):
 *
 * `runManagedTask` is the single public entry point for managed task runs.
 * Its body collapsed dramatically in Shard 6d when the legacy state-machine
 * orchestration (formerly ~6000 lines of role dispatch, protocol parsing,
 * harness escalation, budget accounting, and manual evaluator reshaping)
 * was replaced by the Runner-driven path in `./task-engine/runner-driven.ts`.
 *
 * Dispatch: every agent mode runs `runManagedTaskViaRunner` (single Worker via
 * Layer-A Runner, with optional Actor children). The retired `sa` and `amaw`
 * inputs resolve to AMA (FEATURE_310).
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
import { deriveRunScopedConfig } from './run-scoped-config.js';
import { KodaXSkillInvocationError } from './skill-invocation-error.js';
import {
  applyRuntimeSkillInvocationPolicy,
  awaitRuntimeSkillInvocationPolicy,
} from './skill-invocation-policy.js';
import { hasExplicitNaturalLanguageWorkflowIntent } from './workflows/invocation-policy.js';
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
  KodaXHarnessProfile,
  KodaXOptions,
  KodaXResult,
} from './types.js';
import { normalizeKodaXAgentMode } from './types.js';

/**
 * Retired labels must not reach the Worker, which gates Actor and Workflow hosts
 * on `'ama'` and reports the label in effectiveConfig: `'sa'` runs exactly like
 * an unlabeled call and `'amaw'` as `'ama'`.
 */
function withCanonicalAgentMode(options: KodaXOptions): KodaXOptions {
  const agentMode = normalizeKodaXAgentMode(options.agentMode);
  if (agentMode === options.agentMode) return options;
  const { agentMode: _retired, ...unlabeled } = options;
  return agentMode === undefined ? unlabeled : { ...unlabeled, agentMode };
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
  if (!boundRegistry) {
    try { await registry.discover(); }
    catch (cause: unknown) {
      const invocation = options.context?.skillInvocation;
      if (!invocation?.runtimePolicy?.enforceAtRuntime || cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw new KodaXSkillInvocationError('skill_registry_unavailable', invocation.name, { cause });
    }
  }

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
  // this and the direct `runKodaX` entry never diverge on which fields are scoped.
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
 * (and CAP-089 / CAP-091 contract suites) inject mocks to verify the
 * dispatch without spinning up the full substrate.
 *
 * FEATURE_100 P3.6t: extracted from inline `executeRunManagedTask` so
 * CAP-DISPATCH-001 / CAP-DISPATCH-002 /
 * CAP-MANAGED-REASONING-002 can be activated as function-level
 * contracts without hoisted vi.mock.
 */
export interface ManagedDispatchDeps {
  readonly runAMA: typeof runManagedTaskViaRunner;
  readonly buildPlan: typeof buildManagedReasoningPlan;
}

export const defaultManagedDispatchDeps: ManagedDispatchDeps = {
  runAMA: runManagedTaskViaRunner,
  buildPlan: buildManagedReasoningPlan,
};

export async function dispatchManagedTask(
  options: KodaXOptions,
  prompt: string,
  deps: ManagedDispatchDeps = defaultManagedDispatchDeps,
): Promise<KodaXResult> {
  // The AMA Worker runs the same `createReasoningPlan` as the direct engine.
  // Its decision (`primaryTask`, `mutationSurface`, `riskLevel`, `taskFamily`,
  // `harnessProfile`) feeds the Worker contract; without it the Runner path
  // fell back to placeholder `conversation` / `simple` / `low` values.
  //
  // The plan also carries `promptOverlay`, the per-task routing notes
  // (task-family guidance, work intent, brainstorm directives, provider
  // policy notes). `runManagedTaskViaRunner` renders it into the Worker's
  // role prompt, the same surface the direct engine uses.
  const canonical = withCanonicalAgentMode(options);
  const naturalLanguageInput = canonical.context?.rawUserInput ?? prompt;
  const workflowIntent = canonical.context?.workflowIntent
    ?? (hasExplicitNaturalLanguageWorkflowIntent(naturalLanguageInput) ? 'explicit' : undefined);
  const amaOptions: KodaXOptions = workflowIntent === undefined
    ? canonical
    : {
        ...canonical,
        context: { ...canonical.context, workflowIntent },
      };
  const plan = await deps.buildPlan(amaOptions, prompt);
  return deps.runAMA(amaOptions, prompt, undefined, plan);
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
