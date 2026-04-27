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
 *     mutationTracker, planModeBlockCheck, registerChildWriteWorktrees,
 *     managedProtocolRole.
 *   - parent agent config snapshot (provider/model/reasoningMode) so
 *     `dispatch_child_task` can spawn children with the parent's
 *     declaration.
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

import type {
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';
import type { ExtensionRuntimeContract } from '../extensions/runtime-contract.js';
import { mergeManagedProtocolPayload } from '../managed-protocol.js';
import { resolveExecutionCwd } from '../runtime-paths.js';

export interface ToolExecutionContextInput {
  readonly options: KodaXOptions;
  /**
   * Extension runtime to bind onto the tool ctx. Typed against the
   * interface (`ExtensionRuntimeContract`) rather than the concrete
   * `KodaXExtensionRuntime` class so AMA — which receives the runtime
   * via `options.extensionRuntime` (interface-typed) — can call this
   * helper without an unsafe cast. SA passes the concrete class
   * unchanged (it implements the interface).
   */
  readonly runtime: ExtensionRuntimeContract | undefined;
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
  const { options, runtime, managedProtocolPayloadRef } = input;
  const events = options.events ?? {};
  const executionCwd = resolveExecutionCwd(options.context);

  return {
    backups: new Map(),
    gitRoot: options.context?.gitRoot ?? undefined,
    executionCwd,
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
    registerChildWriteWorktrees: options.context?.registerChildWriteWorktrees,
    mutationTracker: options.context?.mutationTracker,
    // FEATURE_074: forward parent's plan-mode predicate so
    // dispatch_child_task can enforce plan mode on child tool calls.
    planModeBlockCheck: options.context?.planModeBlockCheck,
    parentAgentConfig: {
      provider: options.provider,
      model: options.model,
      reasoningMode: options.reasoningMode,
    },
    // FEATURE_067: onChildProgress removed — progress flows through
    // reportToolProgress → onToolProgress instead.
    onChildProgress: undefined,
  };
}
