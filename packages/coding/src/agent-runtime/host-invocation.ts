import { randomUUID } from 'node:crypto';
import type { Agent, RunnerToolObserver } from '@kodax-ai/agent';
import type { KodaXOptions, KodaXToolExecutionContext } from '../types.js';
import type { KodaXMessage } from '@kodax-ai/llm';
import { listTools } from '../tools/registry.js';
import { bindActiveExtensionExecutionRuntime, getActiveExtensionRuntime, withExtensionRuntimeContext } from '../extensions/runtime.js';
import { buildRuntimeSessionState, type RuntimeSessionState } from './runtime-session-state.js';
import { buildToolExecutionContext } from './tool-execution-context.js';
import { applyToolVisibilityPolicy, filterExcludedTools } from './tool-resolution.js';
import { listRunScopedTools, runScopedToolMap } from './run-scoped-tools.js';
import { appendPromptIfNotDuplicate, resolveInitialMessages } from './middleware/auto-resume.js';
import { createExtensionRuntimeSessionController } from './middleware/extension-queue.js';
import { saveRequiredSessionSnapshot } from './middleware/session-snapshot.js';
import { bindVisualObservationAdmission } from '../media/visual-owner.js';

export interface HostInvocation {
  readonly options: KodaXOptions;
  readonly sessionId: string;
  readonly runId: string;
  readonly ctx: KodaXToolExecutionContext;
  readonly state: RuntimeSessionState;
  readonly messages: KodaXMessage[];
  readonly save: () => Promise<void>;
  readonly agent?: Agent;
  /** Semantic AMA observers only; permissions and host events already run in dispatch. */
  readonly toolObserver?: RunnerToolObserver;
}

/** Shared explicit-invocation lifetime; callers settle every effect before returning. */
export function withHostInvocation<T>(original: KodaXOptions, prompt: string, execute: (host: HostInvocation) => Promise<T>): Promise<T> {
  const sessionId = original.session?.id ?? randomUUID();
  const runId = original.context?.runtimeRunId ?? randomUUID();
  const options = { ...original, context: { ...original.context, runtimeRunId: runId } };
  const runtime = options.extensionRuntime ?? getActiveExtensionRuntime() ?? undefined;
  return withExtensionRuntimeContext(async () => {
    const releaseExecution = bindActiveExtensionExecutionRuntime(runtime);
    let releaseController: (() => void) | void = undefined;
    try {
      options.abortSignal?.throwIfAborted();
      const resumed = await resolveInitialMessages(options, sessionId);
      const runTools = listRunScopedTools(runtime);
      const activeTools = applyToolVisibilityPolicy(filterExcludedTools([
        ...(runtime?.getDefaults?.().activeTools ?? listTools()), ...runTools.map(tool => tool.name),
      ], options.context.excludeTools), options.context.toolVisibilityPolicy, runScopedToolMap(runTools));
      const state = buildRuntimeSessionState({ ...resumed, activeTools,
        modelSelection: runtime?.getDefaults?.().modelSelection ?? {},
        loadedExtensionState: resumed.loadedExtensionState, loadedExtensionRecords: resumed.loadedExtensionRecords });
      releaseController = runtime?.bindController?.(createExtensionRuntimeSessionController(state));
      await runtime?.hydrateSession?.(sessionId);
      const ctx = buildToolExecutionContext({ options, sessionId, runtime, managedProtocolPayloadRef: { current: undefined } });
      bindVisualObservationAdmission(ctx, options, state);
      const messages = appendPromptIfNotDuplicate(resumed.messages, prompt, options.context.inputArtifacts,
        undefined, options.session?.inputId);
      const save = async (): Promise<void> => {
        if (options.session?.storage) await saveRequiredSessionSnapshot(options, sessionId, {
          messages, title: resumed.title || prompt.slice(0, 80), gitRoot: options.context.gitRoot ?? undefined, runtimeSessionState: state,
        });
      };
      return await execute({ options, sessionId, runId, ctx, state, messages, save });
    } finally { releaseController?.(); releaseExecution(); }
  }, runtime, runId);
}
