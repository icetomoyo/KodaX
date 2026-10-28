

import { isToolResultErrorContent } from '../../../agent-runtime/tool-result-classify.js';
import type {
  Agent,
  Handoff,
  RunnableTool,
  RunnerToolContext,
  RunnerToolResult,
} from '@kodax-ai/agent';
// FEATURE_193 (v0.7.43): SCOUT_AGENT_NAME / PLANNER_AGENT_NAME /
// GENERATOR_AGENT_NAME imports removed alongside the V1 chain agents —
// the Worker is the only V2 chain agent.
import { WORKER_AGENT_NAME } from '../../../agents/task-engine-agents.js';
import { toolTodoUpdate } from '../../../tools/todo-update.js';
import { toolTodoCreate } from '../../../tools/todo-create.js';
import {
  getToolDefinition,
  getRegisteredToolDefinition,
  isMcpToolName,
  listToolDefinitions,
} from '../../../tools/registry.js';
import {
  executeRunScopedTool,
  listRunScopedTools,
  lookupRunScopedTool,
  toModelToolDefinition,
} from '../../../agent-runtime/run-scoped-tools.js';
import { DEFERRED_TOOL_HINTS, isDeferredTool } from '../../../tools/deferred-tools.js';
import { TOOL_CALL_NAME, TOOL_DESCRIBE_NAME } from '../../../tools/tool-bridge.js';
import { isToolDiscoverable } from '../../../tools/tool-search.js';
import { withManualToolBranding } from '../../../self-knowledge/tool-description.js';
import { markRegistryManagedAgent, projectModelToolDefinition } from '../../../tools/model-tool-definition.js';
import { filterModelToolAliases } from '../../../agent-runtime/tool-resolution.js';
import type {
  KodaXEvents,
  KodaXToolExecutionContext,
  KodaXTaskVerificationContract,
} from '../../../types.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import {
  incrementManagedBudgetUsage,
  type ManagedTaskBudgetController,
} from './budget.js';
import {
  resetTodoReminderState,
  type TodoReminderState,
} from '../../todo-throttle-reminder.js';
import {
  formatDeterministicEvaluatorResult,
  runDeterministicEvaluator,
  type DeterministicEvaluatorHint,
  type DeterministicEvaluatorResult,
  type RunDeterministicEvaluatorInput,
} from '../../deterministic-evaluator.js';
import type { TodoStore } from '../../todo-store.js';
import {
  // FEATURE_193 (v0.7.43): SCOUT_INSTRUCTIONS_FALLBACK, PLANNER_INSTRUCTIONS_FALLBACK,
  // GENERATOR_INSTRUCTIONS_FALLBACK removed — V1 chain roles retired.
  WORKER_INSTRUCTIONS_FALLBACK,
  resolveRoleInstructions,
} from './role-prompts.js';
import { getAmaRoleEffectiveExclude } from './role-exclude.js';
import { wrapCodingToolAsRunnable } from './tool-wrappers.js';
import { getToolExecutionOverride } from '../../../agent-runtime/permission-gate.js';
import { NULL_OBSERVER } from './observer-bridge.js';
import type { AmaRole, ObserverBridge, RunnerChainPromptContext } from './types.js';
import type { ExtensionRuntimeContract } from '../../../extensions/runtime-contract.js';

interface TodoToolBundle {
  readonly todoUpdate: RunnableTool;
  readonly todoCreate: RunnableTool;
}

type ManagedToolDefinition = ReturnType<typeof listToolDefinitions>[number];

function buildTodoToolBundle(
  baseCtx: KodaXToolExecutionContext,
  budget?: ManagedTaskBudgetController,
  events?: KodaXEvents,
): TodoToolBundle {
  const todoUpdate = getToolDefinition('todo_update');
  const todoCreate = getToolDefinition('todo_create');
  if (!todoUpdate || !todoCreate) {
    throw new Error(
      'Runner-driven path: expected todo_update/todo_create tools to be registered',
    );
  }

  return {
    todoUpdate: wrapCodingToolAsRunnable(todoUpdate, toolTodoUpdate, baseCtx, budget, events),
    todoCreate: wrapCodingToolAsRunnable(todoCreate, toolTodoCreate, baseCtx, budget, events),
  };
}

/**
 * FEATURE_250 — is this tool deferred (hint-swapped) on the managed path?
 *
 * The managed path defers the SAME tools the SA path defers, EXCEPT mcp_*.
 * mcp_call can mutate remote state and the mcp_* family was not covered by the
 * two-hop reachability eval, so they stay resident with full descriptions here.
 * Everything else in the deferred set (repo-intel + web/code/workflow) is
 * hint-swapped — eval-verified DEFER_SAFE across the coding-plan panel.
 */
function shouldDeferOnManagedPath(name: string): boolean {
  return isDeferredTool(name) && !isMcpToolName(name) && DEFERRED_TOOL_HINTS[name] !== undefined
    && getRegisteredToolDefinition(name)?.source.kind === 'builtin';
}

function isManagedToolVisibleForContext(
  name: string,
  exclude: ReadonlySet<string>,
  ctx: KodaXToolExecutionContext,
): boolean {
  if (exclude.has(name)) return false;
  const activeTools = (ctx.extensionRuntime as ExtensionRuntimeContract | undefined)?.getDefaults?.().activeTools;
  if (activeTools && !activeTools.includes(name) && !lookupRunScopedTool(ctx.extensionRuntime, name)) return false;
  return isToolDiscoverable(name, ctx);
}

function readManagedBridgeToolNames(input: Record<string, unknown>): string[] {
  const names: string[] = [];
  const append = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) {
      names.push(value.trim());
    }
  };
  append(input.name);
  append(input.tool_name);
  for (const key of ['names', 'tools']) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const item of value) append(item);
    }
  }
  return [...new Set(names)];
}

function describeManagedBridgeTools(
  input: Record<string, unknown>,
  activeDefinitions: readonly ManagedToolDefinition[],
  ctx: KodaXToolExecutionContext,
): string {
  const names = readManagedBridgeToolNames(input);
  if (names.length === 0) {
    return '[Tool Error] tool_describe: `name` or `names` is required.';
  }

  const active = new Map(activeDefinitions.map((definition) => [definition.name, definition]));
  const lines: string[] = [];
  for (const name of names) {
    const definition = active.get(name);
    if (!definition) {
      lines.push(`<!-- ${name}: not active in the current runtime -->`);
      continue;
    }
    const branded = withManualToolBranding(projectModelToolDefinition(definition,
      getRegisteredToolDefinition(definition.name)?.source), ctx.selfManual?.productName);
    lines.push(`<function>${JSON.stringify({
      name: branded.name,
      description: branded.description,
      parameters: branded.input_schema,
    })}</function>`);
  }

  return lines.join('\n');
}

function parseManagedBridgeCallInput(input: Record<string, unknown>): (
  | { readonly ok: true; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }
) {
  const name = typeof input.name === 'string'
    ? input.name.trim()
    : typeof input.tool_name === 'string'
      ? input.tool_name.trim()
      : '';
  if (!name) {
    return { ok: false, error: '`name` is required.' };
  }
  if (name === TOOL_CALL_NAME || name === TOOL_DESCRIBE_NAME) {
    return { ok: false, error: `bridge meta-tools cannot be called through ${TOOL_CALL_NAME}.` };
  }
  const rawInput = input.input ?? input.arguments ?? {};
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { ok: false, error: '`input` must be a JSON object.' };
  }
  return {
    ok: true,
    name,
    input: rawInput as Record<string, unknown>,
  };
}

function buildManagedToolDescribeBridge(
  definition: ManagedToolDefinition,
  activeDefinitions: readonly ManagedToolDefinition[],
  ctx: KodaXToolExecutionContext,
): RunnableTool {
  return {
    ...definition,
    execute: async (input): Promise<RunnerToolResult> => ({
      content: describeManagedBridgeTools(input, activeDefinitions, ctx),
    }),
  };
}

function buildManagedToolCallBridge(
  definition: ManagedToolDefinition,
  activeDefinitions: readonly ManagedToolDefinition[],
  ctx: KodaXToolExecutionContext,
  budget: ManagedTaskBudgetController | undefined,
  events: KodaXEvents | undefined,
  overrides: ReadonlyMap<string, RunnableTool>,
): RunnableTool {
  const active = new Map(activeDefinitions.map((entry) => [entry.name, entry]));
  const rejectCall = (content: string): RunnerToolResult => {
    // Malformed/unavailable bridge attempts still consume one work unit.
    if (budget) incrementManagedBudgetUsage(budget, 1);
    return { content, isError: true };
  };
  return {
    ...definition,
    requiresSerialExecution: input => {
      const target = parseManagedBridgeCallInput(input);
      return target.ok && target.name === 'bash';
    },
    execute: async (
      input: Record<string, unknown>,
      runnerCtx?: RunnerToolContext,
    ): Promise<RunnerToolResult> => {
      throwIfManagedToolAborted(runnerCtx?.abortSignal);
      const parsed = parseManagedBridgeCallInput(input);
      if (!parsed.ok) {
        return rejectCall(`[Tool Error] ${TOOL_CALL_NAME}: ${parsed.error}`);
      }
      const targetDefinition = active.get(parsed.name);
      if (!targetDefinition) {
        return rejectCall(`[Tool Error] ${parsed.name}: Tool is not active in the current runtime.`);
      }
      if (!runnerCtx?.agent) {
        return rejectCall(`[Tool Error] ${TOOL_CALL_NAME}: runner tool context is missing.`);
      }
      const targetToolId = `${runnerCtx?.toolCallId ?? TOOL_CALL_NAME}:${parsed.name}`;
      const targetCall = { id: targetToolId, name: parsed.name, input: parsed.input };
      const targetRunnerCtx: RunnerToolContext = {
        ...runnerCtx,
        toolCallId: targetToolId,
        toolCall: targetCall,
      };
      const permissionOverride = events
        ? await getToolExecutionOverride(
          events,
          parsed.name,
          parsed.input,
          targetToolId,
          ctx.executionCwd,
          ctx.gitRoot,
        )
        : undefined;
      throwIfManagedToolAborted(runnerCtx.abortSignal);
      if (permissionOverride !== undefined) {
        // Like native beforeTool rejection, no executable target was invoked.
        return {
          content: permissionOverride,
          isError: permissionOverride.startsWith('[Tool Error]') || permissionOverride.includes('cancelled'),
        };
      }

      const { toolExecution, createToolEventMeta, createContextForToolCall } = await import('../../../agent-runtime/tool-dispatch.js');
      const targetMeta = createToolEventMeta(events ?? {}, targetToolId, toolExecution(targetCall).id);
      const targetCtx = createContextForToolCall(events ?? {}, targetCall, ctx);
      events?.onToolExecutionStart?.({ id: targetToolId, name: parsed.name }, targetMeta);
      try {
        const overrideRunnable = overrides.get(parsed.name);
        if (overrideRunnable) {
          // Role overrides already charge through their coding-tool wrapper.
          const targetResult = await overrideRunnable.execute(parsed.input, targetRunnerCtx);
          const content = targetResult.content;
          return {
            content,
            isError: targetResult.isError === true || isToolResultErrorContent(content),
            metadata: targetResult.metadata,
          };
        }

        // Registry-first mirrors tool-dispatch and the model-facing table
        // (tool-resolution): a tool registered after the binding wins, so the
        // schema the model saw is the implementation that executes. Run-scoped
        // host tools are the fallback for names the registry cannot resolve.
        const registration = getRegisteredToolDefinition(parsed.name);
        if (registration) {
          if (registration.handler.constructor.name === 'AsyncGeneratorFunction') {
            return rejectCall(`[Tool Error] ${parsed.name}: Tool requires a managed-path wrapper and cannot be called through ${TOOL_CALL_NAME}.`);
          }
          const runnable = wrapCodingToolAsRunnable(
            targetDefinition,
            registration.handler as (
              targetInput: Record<string, unknown>,
              execCtx: KodaXToolExecutionContext,
            ) => Promise<RunnerToolResult['content']>,
            ctx,
            budget,
            events,
          );
          const targetResult = await runnable.execute(parsed.input, targetRunnerCtx);
          const content = targetResult.content;
          return {
            content,
            isError: targetResult.isError === true || isToolResultErrorContent(content),
            metadata: targetResult.metadata,
          };
        }

        const runScopedTarget = lookupRunScopedTool(ctx.extensionRuntime, parsed.name);
        if (runScopedTarget !== undefined) {
          // This branch dispatches directly, without the native coding wrapper.
          if (budget) incrementManagedBudgetUsage(budget, 1);
          const content = await executeRunScopedTool(targetCtx, runScopedTarget, parsed.input);
          return {
            content,
            isError: isToolResultErrorContent(content),
          };
        }

        return rejectCall(`[Tool Error] ${parsed.name}: Tool is not registered or bound to this run.`);
      } finally {
        events?.onToolExecutionEnd?.({ id: targetToolId, name: parsed.name }, targetMeta);
      }
    },
  };
}

function throwIfManagedToolAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Managed tool work cancelled by caller.');
  error.name = 'AbortError';
  throw error;
}

/**
 * FEATURE_168 (v0.7.40 hotfix) — build an AMA role's runtime tool list from the
 * registry, applying role-specific wraps and the role's effective exclude set.
 *
 * @param role       Target AMA role (drives the exclude set).
 * @param ctx        Tool execution context.
 * @param budget     Optional budget controller.
 * @param events     Optional events bus for tool progress.
 * @param overrides  Role-specific wraps keyed by tool name. Any tool present
 *                   in this map replaces the default `wrapCodingToolAsRunnable`
 *                   wrap. Used for streaming dispatch and todo wrappers.
 */
function buildAgentToolsFromRegistry(
  role: AmaRole,
  ctx: KodaXToolExecutionContext,
  budget: ManagedTaskBudgetController | undefined,
  events: KodaXEvents | undefined,
  overrides: ReadonlyMap<string, RunnableTool>,
): RunnableTool[] {
  const exclude = getAmaRoleEffectiveExclude(role);
  const definitions = listToolDefinitions();
  const registeredNames = new Set(definitions.map((definition) => definition.name));
  const runScopedDefinitions = listRunScopedTools(ctx.extensionRuntime)
    .filter((definition) => isManagedToolVisibleForContext(definition.name, exclude, ctx))
    // Defense-in-depth: the server rejects registry-colliding host tool
    // bindings up front; registered tools still win if a stale lease slips through.
    .filter((definition) => !registeredNames.has(definition.name));
  const bridgeTargetDefinitions: readonly ManagedToolDefinition[] = [
    ...definitions.filter((definition) => (
      isManagedToolVisibleForContext(definition.name, exclude, ctx)
    )),
    ...runScopedDefinitions.map(toModelToolDefinition),
  ];
  const discoveryCtx: KodaXToolExecutionContext = {
    ...ctx,
    discoveryToolNames: bridgeTargetDefinitions.map((definition) => definition.name),
  };
  const tools: RunnableTool[] = [];

  for (const def of definitions) {
    if (!isManagedToolVisibleForContext(def.name, exclude, ctx)) continue;

    const override = overrides.get(def.name);
    if (override) {
      tools.push(projectModelToolDefinition(override, getRegisteredToolDefinition(override.name)?.source));
      continue;
    }

    // Streaming tools (async-generator handlers) require role-specific drain
    // wraps and MUST
    // be supplied via overrides — otherwise the generator never resolves
    // and the tool call hangs.
    const registration = getRegisteredToolDefinition(def.name);
    if (!registration) continue;

    if (def.name === TOOL_DESCRIBE_NAME) {
      tools.push(buildManagedToolDescribeBridge(def, bridgeTargetDefinitions, ctx));
      continue;
    }
    if (def.name === TOOL_CALL_NAME) {
      tools.push(buildManagedToolCallBridge(def, bridgeTargetDefinitions, discoveryCtx, budget, events, overrides));
      continue;
    }

    const handler = registration.handler;
    if (handler.constructor.name === 'AsyncGeneratorFunction') {
      throw new Error(
        `buildAgentToolsFromRegistry: streaming tool "${def.name}" requires a role-specific wrap in overrides for role "${role}"`,
      );
    }

    // FEATURE_221: white-label the kodax_manual description per product
    // (no-op for every other tool / the default product name).
    const brandedDef = withManualToolBranding(projectModelToolDefinition(def,
      getRegisteredToolDefinition(def.name)?.source), ctx.selfManual?.productName);
    // FEATURE_250: managed-path progressive disclosure. Swap deferred tool
    // descriptions for their one-line searchHint to shrink the cache-cold
    // tools[] payload. `input_schema` is unchanged so the tool stays directly
    // callable off the hint; the full description is fetched on demand via
    // `tool_search`. The managed tool list is built ONCE (static), so this is
    // a one-time swap — cache-stable, no per-turn churn. mcp_* are EXCLUDED
    // (kept resident): mcp_call can mutate remote state and mcp_* were not
    // covered by the two-hop reachability eval, so they keep full descriptions
    // here. Reachability of the deferred set is eval-verified DEFER_SAFE
    // (5/5 coding-plan aliases, 100% first-tool reach) — see
    // tests/deferred-tool-two-hop-adoption.eval.ts.
    const managedDef = shouldDeferOnManagedPath(brandedDef.name)
      ? { ...brandedDef, description: DEFERRED_TOOL_HINTS[brandedDef.name] }
      : brandedDef;
    tools.push(
      wrapCodingToolAsRunnable(
        managedDef,
        handler as (
          input: Record<string, unknown>,
          execCtx: KodaXToolExecutionContext,
        ) => Promise<RunnerToolResult['content']>,
        def.name === 'tool_search' ? discoveryCtx : ctx,
        budget,
        events,
      ),
    );
  }

  // FEATURE_294: run-scoped host tools materialize per-run alongside the
  // registry tools — they never register globally and disappear naturally
  // once the lease binding is gone.
  for (const definition of runScopedDefinitions) {
    tools.push(
      wrapCodingToolAsRunnable(
        toModelToolDefinition(definition),
        (input, execCtx) => executeRunScopedTool(execCtx, definition, input),
        ctx,
        budget,
        events,
      ),
    );
  }

  return tools;
}

export interface RunnerAgentChain {
  readonly worker: Agent;
}

export function buildRunnerAgentChain(ctx: KodaXToolExecutionContext,
  observer: ObserverBridge = NULL_OBSERVER,
  budget?: ManagedTaskBudgetController,
  verification?: KodaXTaskVerificationContract,
  promptContext?: RunnerChainPromptContext,
  events?: KodaXEvents,
  todoStore?: TodoStore,
  todoReminderState?: TodoReminderState,
  runtimeCwd?: string,
  runDeterministicEvaluatorOverride?: (
    input: RunDeterministicEvaluatorInput,
  ) => Promise<DeterministicEvaluatorResult>
): RunnerAgentChain {
  const codingTools = buildTodoToolBundle(ctx, budget, events);
  // FEATURE_097 (v0.7.34) §5 ② — wrap `todo_update` so every successful
  // call resets the Layer 2 throttle counter. The base tool already
  // returns `{ok:true}` on success and `{ok:false, reason:...}` on
  // failure (unknown id / bad input / store inactive); only the success
  // path resets the counter so a model spamming malformed updates does
  // NOT escape the reminder. Read the JSON envelope to discriminate.
  if (todoReminderState) {
    // FEATURE_170 (v0.7.41) — extend the throttle-reset behavior to
    // `todo_create` too. After migration the LLM commonly emits N
    // todo_create calls (per-item) instead of a single todo_update(init).
    // Without resetting on todo_create, a model that diligently inserts
    // every item via todo_create still triggers the "you have not
    // committed a plan" reminder after the 8-round counter elapses —
    // spurious nag at the worst possible time.
    const wrapForReset = (base: RunnableTool): RunnableTool => ({
      ...base,
      execute: async (input, runnerCtx): Promise<RunnerToolResult> => {
        const result = await base.execute(input, runnerCtx);
        if (!result.isError && typeof result.content === 'string') {
          try {
            const parsed = JSON.parse(result.content) as { ok?: boolean };
            if (parsed.ok === true) {
              resetTodoReminderState(todoReminderState);
            }
          } catch {
            // Tool output should always be JSON, but if a future change
            // breaks that contract we silently skip the reset rather
            // than crash the Runner mid-turn.
          }
        }
        return result;
      },
    });
    const mutable = codingTools as {
      -readonly [K in keyof typeof codingTools]: typeof codingTools[K];
    };
    mutable.todoUpdate = wrapForReset(codingTools.todoUpdate);
    mutable.todoCreate = wrapForReset(codingTools.todoCreate);
  }
  // FEATURE_114 v0.7.36 Slice 3c — deterministic per-step evaluator.
  // When `todoStore` + `runtimeCwd` are wired, wrap `todo_update` so a
  // successful `pending|in_progress → completed` transition on an
  // item with `evaluator: 'build'|'test'|'lint'` triggers the
  // corresponding npm command. The check's outcome (pass / fail with
  // stderr tail / skipped on missing script / error on timeout) is
  // appended to the tool result so the Worker reads it on the next
  // turn and self-corrects. No-op when either dependency is missing
  // — keeps test fixtures + V1 callers untouched.
  //
  // The wrapper composes AFTER the throttle-reminder wrap above so
  // both effects fire on the same tool call.
  if (todoStore && runtimeCwd) {
    const runEvaluator = runDeterministicEvaluatorOverride ?? runDeterministicEvaluator;
    const baseTodoUpdate = codingTools.todoUpdate;
    const wrappedTodoUpdate: RunnableTool = {
      ...baseTodoUpdate,
      execute: async (input, runnerCtx): Promise<RunnerToolResult> => {
        // Snapshot pre-state so we can detect status transitions on
        // the items the tool call touches. Cheap (O(N), N small).
        const preState = new Map<string, { status: string; evaluator?: string }>();
        for (const item of todoStore.getAll()) {
          preState.set(item.id, { status: item.status, evaluator: item.evaluator });
        }
        const result = await baseTodoUpdate.execute(input, runnerCtx);
        if (result.isError) return result;
        // Find items whose status freshly flipped to `completed` AND
        // carry an evaluator hint. In the typical update-op path
        // exactly one item flips per call; on init-op N items can be
        // seeded but they all start at `pending` (no completion to
        // check). Scan all items defensively — cheap.
        const transitions: Array<{ id: string; hint: DeterministicEvaluatorHint }> = [];
        for (const item of todoStore.getAll()) {
          if (item.status !== 'completed') continue;
          if (!item.evaluator) continue;
          const before = preState.get(item.id);
          // Skip items that were already `completed` BEFORE this call —
          // re-running checks on no-op transitions would double the
          // cost and confuse the LLM with stale results.
          if (before?.status === 'completed') continue;
          // Type-narrow the hint — todo-store stores the schema-validated
          // value already, but TS can't prove that across the boundary.
          const hint = item.evaluator;
          if (hint !== 'build' && hint !== 'test' && hint !== 'lint') continue;
          transitions.push({ id: item.id, hint });
        }
        if (transitions.length === 0) return result;
        // Run each check sequentially. Worker prompt guidance steers
        // toward only-one-in_progress-at-a-time, so the typical case
        // is a single transition per call; sequential keeps stdout
        // tails interpretable when multiple do co-occur.
        const evaluatorOutputs: string[] = [];
        for (const { id, hint } of transitions) {
          try {
            const checkResult = await runEvaluator({
              hint,
              cwd: runtimeCwd,
              ...(ctx.shellExecution !== undefined
                ? { shellExecution: ctx.shellExecution }
                : {}),
              ...(ctx.sessionScratchDir !== undefined
                ? { sessionScratchDir: ctx.sessionScratchDir }
                : {}),
              ...(ctx.sandbox !== undefined ? { sandbox: ctx.sandbox } : {}),
            });
            evaluatorOutputs.push(
              `[evaluator:${id}] ${formatDeterministicEvaluatorResult(checkResult)}`,
            );
          } catch (err) {
            // Defensive: a thrown evaluator surfaces as a soft
            // diagnostic in the tool result, not a runner crash.
            const message = err instanceof Error ? err.message : String(err);
            evaluatorOutputs.push(
              `[evaluator:${id}] [deterministic-evaluator:${hint}] error — ${message}`,
            );
          }
        }
        // Thread the evaluator output into the tool result. Preserve
        // the original JSON envelope as the first line so existing
        // parsers (`todoReminderState` reset above) stay happy; the
        // evaluator output is a tail block.
        const baseContent = typeof result.content === 'string' ? result.content : '';
        const enrichedContent = [baseContent, '', ...evaluatorOutputs].join('\n');
        return { ...result, content: enrichedContent };
      },
    };
    (codingTools as { -readonly [K in keyof typeof codingTools]: typeof codingTools[K] }).todoUpdate = wrappedTodoUpdate;
  }
  type WritableAgent = { -readonly [K in keyof Agent]: Agent[K] };

  // FEATURE_114 v0.7.36 — AMA Harness V2 Worker agent.
  //
  // Tool surface: Worker carries the execution tools directly from the
  // registry, plus dispatch (with write fan-out) and todo_update /
  // todo_list. FEATURE_155 (v0.7.38) Slice C1 removed
  // `await_child_task`; Worker now reclaims async-dispatched children
  // via the idle-yield wait mechanic in the outer runner loop
  // (`detectIdleYield` + `waitForWakeEvent`).
  // Discipline (plan-first, scope commitment, dispatch RULE A/B/C, mutation
  // discipline) lives in `worker-role-prompt.ts`; the tool-policy layer
  // returns `undefined` for `'worker'`.
  const worker: WritableAgent = {
    name: WORKER_AGENT_NAME,
    instructions: () => {
      // FEATURE_114 v0.7.36 Slice 3b — Worker resume handling.
      //
      // Order matters: build the prompt BEFORE consuming the ref so
      // the role-prompt context factory's `isResumeAfterReviseFailure`
      // read sees the armed state. If we reset first, the
      // contextFactory reads `false` and the Worker prompt loses the
      // retrospective sentence on the retry turn.
      //
      const actorTree = promptContext ? undefined : ctx.actorControl?.list();
      const resolved = resolveRoleInstructions(
        'worker',
        WORKER_AGENT_NAME,
        WORKER_INSTRUCTIONS_FALLBACK,
        promptContext,
        verification,
        actorTree ? {
          maxConcurrentThreads: actorTree.maxConcurrentThreads,
          activeNonRootTurns: actorTree.activeNonRootTurns,
        } : undefined,
        filterModelToolAliases(worker.tools ?? []).map(tool => tool.name),
      );
      return resolved;
    },
    // FEATURE_168 (v0.7.40 hotfix) — Worker's tool surface is derived from the
    // registry minus `AMA_BASELINE_EXCLUDE`; collaboration is role-wrapped for
    // streaming progress and write fan-out. Collaboration controls now land in
    // the schema (previously missing — see CHANGELOG /
    // commit log). FEATURE_161
    // module_context / symbol_context / process_context / impact_estimate
    // pull tools also now land in the schema (previously missing).
    tools: [
      ...buildAgentToolsFromRegistry(
        'worker',
        ctx,
        budget,
        events,
        new Map<string, RunnableTool>([
          ['todo_update', codingTools.todoUpdate],
          ['todo_create', codingTools.todoCreate],
        ]),
      ),
    ],
    handoffs: undefined,
    // Worker plans + executes, so it can escalate to deep reasoning after a
    // revise signal to break retry loops.
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };

  const workerHandoffs: Handoff[] = [];
  worker.handoffs = workerHandoffs;

  return {
    worker: markRegistryManagedAgent(Object.freeze(worker) as Agent, ctx),
  };
}

// FEATURE_193 v0.7.43: `buildRunnerScoutAgent` deleted — V1 Scout retired.
