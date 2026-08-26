/**
 * Tool execution context builder — CAP-048
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-048-kodaxtoolexecutioncontext-construction
 *
 * Class 1 (substrate). Constructs the `KodaXToolExecutionContext`
 * passed to every executeToolCall invocation. The context bundles:
 *
 *   - per-run state: `backups` map (write-tool rollback), abort signal,
 *     extension runtime, working directory + git root.
 *   - declarative wiring forwarded from `options.context`:
 *     mutationTracker, planModeBlockCheck, managedProtocolRole.
 *   - parent agent config snapshot (provider/model/reasoningMode) so native
 *     Actor turns inherit the root declaration.
 *   - REPL callbacks: askUser, askUserInput, exitPlanMode.
 *   - `emitManagedProtocol` closure that mutates a shared payload ref
 *     so multiple emissions accumulate across the turn loop.
 *
 * **Two FEATURE flags asserted by CAP-048**:
 *   - FEATURE_074: `set_permission_mode` is NOT forwarded as a callback
 *     (security invariant — see `agent.ts` historical comment block).
 *   - FEATURE_067: `onChildProgress` is intentionally `undefined` —
 *     progress is reported via `onToolProgress` instead.
 *
 * Migration history: extracted from `agent.ts:419-460` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.6p. The `emittedManagedProtocolPayload`
 * was lifted from a function-local `let` into a `{ current }` wrapper
 * (the pattern documented as @mutable-exception (c) on TurnContext) so
 * the `emitManagedProtocol` closure can be defined inside the helper
 * and still observe accumulating mutations.
 */

import { join } from 'node:path';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { getProviderCredentialEnvironmentNames } from '@kodax-ai/llm';

import type {
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXToolExecutionContext,
  WorkflowToolHost,
  WorkflowToolHostResult,
} from '../types.js';
import type { CapabilityRuntimeContract } from '../extensions/runtime-contract.js';
import { mergeManagedProtocolPayload } from '../managed-protocol.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { getSessionScratchDir } from '../session-scratch.js';
import { getDefaultLspService } from '../lsp/service.js';
import {
  createSessionHistoryLoader,
  SESSION_HISTORY_TOOL_NAMES,
} from '../tools/session-history.js';
import { CodingActorSession } from './actor-runtime.js';
import {
  applyToolVisibilityPolicy,
  filterExcludedTools,
} from './tool-resolution.js';

/**
 * Resolve the on-disk run directory for a `resumeFromRunId`, or undefined when
 * the id is absent or fails sanitization. This id is model-supplied, so this is
 * the ONLY sanitization before it is joined onto `runsBaseDir`: reject anything
 * outside the safe run-id charset (no slashes / absolute paths), and defensively
 * reject any '..' segment — a bare '..' passes the charset yet would escape one
 * level via `join`. Extracted + exported so the traversal guard is directly
 * unit-testable (a future charset/loosening regression must fail CI, not
 * silently reopen a path-escape).
 */
export function resolveResumeFromRunDir(
  runsBaseDir: string,
  resumeFromRunId: string | undefined,
): string | undefined {
  if (!resumeFromRunId) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(resumeFromRunId)) return undefined;
  if (resumeFromRunId.includes('..')) return undefined;
  return join(runsBaseDir, resumeFromRunId);
}

export interface ToolExecutionContextInput {
  readonly options: KodaXOptions;
  /**
   * FEATURE_247 (R7) — runtime-resolved session id, threaded onto the tool
   * ctx so host-registered tools can attribute a call to the right session
   * under concurrent Partner/Coder runs. Callers that have not resolved a
   * session id (isolated tool tests) omit it.
   */
  readonly sessionId?: string;
  /**
   * Capability runtime to bind onto the tool ctx. Tool execution only needs
   * capability lookup methods, not the extension lifecycle surface.
   */
  readonly runtime: CapabilityRuntimeContract | undefined;
  /**
   * Mutable wrapper for the accumulated managed-protocol payload.
   * The `emitManagedProtocol` closure inside the constructed context
   * mutates `.current` via `mergeManagedProtocolPayload`. Caller reads
   * `payloadRef.current` at terminal sites (e.g. inside
   * `finalizeManagedProtocolResult`).
   */
  readonly managedProtocolPayloadRef: { current: KodaXManagedProtocolPayload | undefined };
}

export function buildToolExecutionContext(
  input: ToolExecutionContextInput,
): KodaXToolExecutionContext {
  const { options, runtime, managedProtocolPayloadRef, sessionId } = input;
  const events = options.events ?? {};
  const executionCwd = resolveExecutionCwd(options.context);
  const sessionScratchDir = getSessionScratchDir(options);
  const visibleSessionHistoryTools = applyToolVisibilityPolicy(
    filterExcludedTools(
      [...SESSION_HISTORY_TOOL_NAMES],
      options.context?.excludeTools,
    ),
    options.context?.toolVisibilityPolicy,
  );
  const loadSessionHistory = SESSION_HISTORY_TOOL_NAMES.every((name) => (
    visibleSessionHistoryTools.includes(name)
  ))
    ? createSessionHistoryLoader({
        sessionId,
        currentAgentId: options.context?.currentAgentId,
        sessionScope: options.session?.scope,
        storage: options.session?.storage,
      })
    : undefined;

  const context: KodaXToolExecutionContext = {
    backups: new Map(),
    actorControl: options.context?.actorControl,
    actorQueueAgentId: options.context?.actorQueueAgentId,
    contextIdentitySessionId: options.context?.contextIdentitySessionId ?? sessionId,
    actorHost: options.context?.actorHost,
    managedWorkBudget: options.context?.managedWorkBudget,
    permissionIntent: options.context?.permissionIntent,
    gitRoot: options.context?.gitRoot ?? undefined,
    // FEATURE_247 (R7) — session/profile attribution for host-registered tools
    // (Space artifact/source/KB) so concurrent Partner/Coder sessions don't
    // cross. All optional passthrough; absent ⇒ same as before.
    sessionId,
    ...(loadSessionHistory !== undefined ? { loadSessionHistory } : {}),
    taskSurface: options.context?.taskSurface,
    agentProfile: options.context?.agentProfile,
    agentScope: options.context?.agentScope,
    agentExecutorPlane: options.context?.agentExecutorPlane,
    selfManual: options.selfManual,
    // FEATURE_222 skill security — forward the host's skill dynamic-context policy
    // so the LLM-triggered `skill` tool routes `!`cmd`` through the host broker
    // (or refuses) instead of the built-in execSync fallback.
    skillDynamicContext: options.skillDynamicContext,
    skillRegistry: options.context?.skillRegistry,
    admitLearnedSkillInvocation: options.context?.admitLearnedSkillInvocation,
    skillScriptRunner: options.context?.skillScriptRunner,
    assertReadablePath: options.context?.assertReadablePath,
    toolVisibilityPolicy: options.context?.toolVisibilityPolicy,
    excludeTools: options.context?.excludeTools,
    // FEATURE_132 v0.7.47 — LSP service for edit-time diagnostics reflux.
    // Host-injected when present, else the process-wide default (which is
    // a no-op unless a language server is installed; `KODAX_LSP=0` disables).
    lspService: options.context?.lspService ?? getDefaultLspService(),
    executionCwd,
    shellExecution: options.context?.shellExecution,
    sandbox: options.sandbox,
    shellSandbox: options.context?.shellSandbox,
    trustedTextMutationHost: options.context?.trustedTextMutationHost,
    workspaceSandboxRoots: options.context?.workspaceSandboxRoots,
    providerCredentialEnvironmentNames: getProviderCredentialEnvironmentNames(),
    sessionScratchDir,
    extensionRuntime: runtime,
    askUser: events.askUser, // Issue 069
    askUserMulti: events.askUserMulti,
    askUserInput: events.askUserInput, // Issue 112
    // FEATURE_074: only forward exit_plan_mode. set_permission_mode is
    // intentionally NOT forwarded — activating it would silently widen
    // permissions on misfires.
    exitPlanMode: events.exitPlanMode,
    abortSignal: options.abortSignal, // Issue 113
    managedProtocolRole: options.context?.managedProtocolEmission?.enabled
      ? options.context.managedProtocolEmission.role
      : undefined,
    emitManagedProtocol: options.context?.managedProtocolEmission?.enabled
      ? (payload: Partial<KodaXManagedProtocolPayload>) => {
          managedProtocolPayloadRef.current = mergeManagedProtocolPayload(
            managedProtocolPayloadRef.current,
            payload,
          );
        }
      : undefined,
    mutationTracker: options.context?.mutationTracker,
    // Forward the parent's plan-mode predicate to nested Agent turns.
    planModeBlockCheck: options.context?.planModeBlockCheck,
    // Forward parent guardrails so nested Agent turns share auto-mode state.
    guardrails: options.guardrails,
    parentAgentConfig: {
      provider: options.provider,
      model: options.modelOverride ?? options.model,
      reasoningMode: options.reasoningMode,
      effort: options.effort,
      repoIntelligenceMode: options.context?.repoIntelligenceMode,
      repoIntelligenceTrace: options.context?.repoIntelligenceTrace,
      ...(options.compaction !== undefined ? { compaction: { ...options.compaction } } : {}),
      ...(options.context?.contextDiagnostics !== undefined
        ? { contextDiagnostics: options.context.contextDiagnostics }
        : {}),
      ...(options.disablePromptCache !== undefined
        ? { disablePromptCache: options.disablePromptCache }
        : {}),
      ...(options.context?.shellExecution !== undefined
        ? { shellExecution: options.context.shellExecution }
        : {}),
      ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
      ...(options.context?.permissionIntent !== undefined
        ? { permissionIntent: options.context.permissionIntent }
        : {}),
    },
    parentEvents: events,
    // FEATURE_067: onChildProgress removed — progress flows through
    // reportToolProgress → onToolProgress instead.
    onChildProgress: undefined,
    // FEATURE_123 v0.7.44 — agent identity propagation. Top-level
    // Worker leaves both undefined; child-executor forwards
    // `bundle.id` (self) + the parent's currentAgentId (parent) when
    // spawning a sub-runtime.
    currentAgentId: options.context?.currentAgentId,
    parentAgentId: options.context?.parentAgentId,
    // FEATURE_192 v0.7.44 Phase F — pull the goal-tools context from
    // the host-supplied binding (built by `buildGoalRuntimeBinding`).
    // When unset, leave undefined; the 3 goal tools fall back to
    // `makeDisabledGoalToolsContext()` at their own call site.
    sendMessageTurnCounter: { count: 0 },
    goalContext: options.context?.goalRuntime?.goalContext,
    // FEATURE_123 v0.7.44 — per-turn send_message flood throttle
    // counter. Allocated once per runtime; runner-driven.ts resets
    // `count = 0` at each turn boundary via beforeNextTurn.
    // FEATURE_246 Part A2 (ADR-046) — model-launched workflow capability. Wired
    // when the host configured a runs dir AND the turn runs as AMA. The prompt and
    // tool description limit activation to explicit user Workflow intent. SA (solo)
    // never hosts a workflow (fails the agentMode gate + SA_SOLO_EXCLUDE_TOOLS). The
    // lazy import keeps the static graph acyclic (workflows -> agent-runtime).
  };
  if (!context.actorControl && (options.agentMode === 'ama' || options.context?.actorSession)) {
    const actorSession = options.context?.actorSession ?? new CodingActorSession({
      maxConcurrentThreadsPerSession: options.maxConcurrentThreadsPerSession,
      sessionId,
    });
    context.actorHost = actorSession;
    context.actorControl = actorSession.attach(context, options);
  }
  context.workflowHost = buildWorkflowToolHost(
    options,
    sessionId,
    context.actorControl,
    context.actorHost,
  );
  return context;
}

/**
 * FEATURE_247 (R7/R8) — build the `hostMetadata` attribution map stamped onto
 * every workflow process event/snapshot for an inline-started `run_workflow`
 * run, so a host (KodaX-Space) can recover the originating session / surface /
 * project. Each field is included only when known (all values are strings, as
 * `WorkflowProcessSnapshot.hostMetadata` is `Record<string,string>`):
 *   - `sessionId`   — runtime-resolved session id
 *   - `surface`     — SDK-consumer profile surface (e.g. `code` | `partner`)
 *   - `taskSurface` — task surface (`cli` | `repl` | `plan`)
 *   - `projectRoot` — workspace/git root
 */
export function buildWorkflowHostMetadata(
  options: KodaXOptions,
  sessionId: string | undefined,
): Record<string, string> {
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(options.context?.agentProfile?.surface
      ? { surface: options.context.agentProfile.surface }
      : {}),
    ...(options.context?.taskSurface ? { taskSurface: options.context.taskSurface } : {}),
    ...(options.context?.gitRoot ? { projectRoot: options.context.gitRoot } : {}),
  };
}

function buildWorkflowToolHost(
  options: KodaXOptions,
  sessionId?: string,
  actorControl?: KodaXToolExecutionContext['actorControl'],
  actorHost?: KodaXToolExecutionContext['actorHost'],
): WorkflowToolHost | undefined {
  const runsBaseDir = options.workflowRunsBaseDir;
  // Opt-in diagnostic for "the Worker has no run_workflow" reports: shows the
  // exact gate inputs at every tool-context build so a live run pinpoints which
  // condition failed (no runs dir vs not-amaw) without guessing. Set
  // KODAX_DEBUG_WORKFLOW_GATE=1. Off by default (zero cost on the hot path).
  if (process.env.KODAX_DEBUG_WORKFLOW_GATE) {
    const decision = runsBaseDir === undefined
      ? 'no-host: workflowRunsBaseDir undefined'
      : options.agentMode !== 'ama'
        ? `no-host: agentMode=${String(options.agentMode)} (need ama)`
        : options.context?.workflowIntent !== 'explicit'
          ? 'no-host: explicit Workflow intent absent'
          : 'host wired';
    emitKodaXDiagnostic({
      source: 'coding:workflow-gate',
      level: 'debug',
      message: 'Workflow host gate evaluated.',
      detail: {
        agentMode: options.agentMode,
        runsBaseDir,
        decision,
      },
    });
  }
  if (runsBaseDir === undefined) return undefined;
  // run_workflow is available only when the host attributes explicit intent.
  // dispatchManagedTask derives that marker from the standalone Workflow product
  // word; command/SDK paths set it structurally. SA never reaches here with a
  // run_workflow surface: agentMode 'sa' fails this gate, and SA_SOLO_EXCLUDE_TOOLS
  // (task-engine.ts) excludes run_workflow regardless.
  if (options.agentMode !== 'ama') return undefined;
  if (options.context?.workflowIntent !== 'explicit') return undefined;
  // `startInline` starts the run and returns a handle without awaiting it.
  const startInline: WorkflowToolHost['startInline'] = async ({ manifest, source, args, resumeFromRunId, signal }) => {
    // Lazy literal imports break the static cycle: workflow-runner imports
    // buildToolExecutionContext, so agent-runtime must not statically import
    // the workflows host/run-manager.
    const [{ startManagedWorkflow }, { getDefaultWorkflowRunManager }] = await Promise.all([
      import('../workflows/host.js'),
      import('../workflows/run-manager.js'),
    ]);
    // Stop when either the session or the Workflow owner is interrupted.
    const abortSignals = [options.abortSignal, signal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const combinedSignal = abortSignals.length === 0
      ? undefined
      : abortSignals.length === 1
        ? abortSignals[0]
        : AbortSignal.any(abortSignals);
    // FEATURE_246 (P1 review): live workflow progress reaches the REPL through
    // options.events.onWorkflowProcessEvent — already forwarded by the runner
    // (runWorkflowFromOptions). We do NOT subscribe the run manager here as well:
    // that would deliver every process event twice (the gap was the REPL not
    // *consuming* the hook, not the host not *emitting* it). The REPL renders it
    // with the same work-strip the slash path uses.
    const workflowOptions: KodaXOptions = actorControl && actorHost
      ? {
          ...options,
          context: { ...options.context, actorControl, actorHost },
        }
      : options;
    const started = await startManagedWorkflow({
      source: { kind: 'inline', manifest, source },
      args,
      options: workflowOptions,
      runsBaseDir,
      manager: getDefaultWorkflowRunManager(),
      // FEATURE_246 Part D: resume seeds the result cache from the prior run.
      // Path-traversal guard lives in resolveResumeFromRunDir (model-supplied id).
      ...(() => {
        const resumeFromRunDir = resolveResumeFromRunDir(runsBaseDir, resumeFromRunId);
        return resumeFromRunDir ? { resumeFromRunDir } : {};
      })(),
      ...(combinedSignal ? { signal: combinedSignal } : {}),
      // FEATURE_247 (R7/R8): host attribution on workflow process events. The
      // hostMetadata map flows through the tracker onto every emitted
      // WorkflowProcessSnapshot, so a consumer (KodaX-Space) subscribed to
      // onWorkflowProcessEvent can recover which session / surface / project an
      // inline-started run belongs to.
      processMetadata: { hostMetadata: buildWorkflowHostMetadata(options, sessionId) },
    });
    if (started.kind === 'declined') {
      return { kind: 'declined', reason: started.reason };
    }
    const workflowQualityWarnings = started.qualityWarnings?.map(
      (warning) => `${warning.code}: ${warning.message}`,
    );
    const done = started.managed.done.then((outcome): WorkflowToolHostResult => {
      const snap = started.managed.getSnapshot?.();
      // A child agent that completes but fails its sidecar verifier in warn-only
      // mode settles as `completed_unverified` and emits an `agent_unverified`
      // event — but the overall run status is still `completed`. Surface those
      // child names so the Worker's tool reply flags the partial verification
      // failure instead of silently swallowing it.
      const verificationWarnings = outcome.kind === 'completed'
        ? outcome.state.events.reduce<string[]>((names, event) => {
            if (event.type === 'agent_unverified') {
              const name = event.data?.name ?? event.data?.taskId;
              names.push(typeof name === 'string' && name.length > 0 ? name : 'agent');
            }
            return names;
          }, [])
        : [];
      return {
        kind: 'started',
        runId: started.runId,
        ...(snap?.status !== undefined ? { status: snap.status } : {}),
        ...(snap?.resultText !== undefined ? { resultText: snap.resultText } : {}),
        ...(snap?.error !== undefined ? { error: snap.error } : {}),
        ...(verificationWarnings.length > 0 ? { verificationWarnings } : {}),
        ...(workflowQualityWarnings && workflowQualityWarnings.length > 0 ? { workflowQualityWarnings } : {}),
      };
    });
    return {
      kind: 'started',
      runId: started.runId,
      done,
      ...(workflowQualityWarnings && workflowQualityWarnings.length > 0 ? { workflowQualityWarnings } : {}),
    };
  };
  return {
    startInline,
    runInline: async (input) => {
      const s = await startInline(input);
      if (s.kind === 'declined') return { kind: 'declined', reason: s.reason };
      return await s.done;
    },
  };
}
