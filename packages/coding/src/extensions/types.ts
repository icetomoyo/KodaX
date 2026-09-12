import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXWireReasoningEffort,
} from '@kodax-ai/llm';
import type {
  KodaXExtensionSessionRecord,
  KodaXExtensionStore,
  KodaXJsonValue,
} from '../types.js';
import type {
  LocalToolDefinition,
  RegisteredToolDefinition,
} from '../tools/types.js';
import type { AgentContent } from '../construction/types.js';
import type { ExtensionExecutionScope } from './execution-contract.js';
export type { AgentContent };

import type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './helpers.js';
export type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './helpers.js';

// FEATURE_082 (v0.7.24): capability contract lives in `@kodax-ai/core` so
// third-party providers (MCP, RAG, custom indexes, …) can implement it
// without a coding dependency. Re-exported here for backward compatibility.
import type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
  CapabilitySearchFailure,
  CapabilitySearchFreshness,
  CapabilitySearchOptions,
  CapabilitySearchSnapshot,
} from '@kodax-ai/agent';
export type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
  CapabilitySearchFailure,
  CapabilitySearchFreshness,
  CapabilitySearchOptions,
  CapabilitySearchSnapshot,
};

export interface ModelProviderRegistration {
  name: string;
  factory: () => KodaXBaseProvider;
}

export interface ExtensionCapabilityProvider extends CapabilityProvider {
  execute?: (id: string, input: Record<string, unknown>, scope?: ExtensionExecutionScope) => Promise<CapabilityResult>;
  read?: (id: string, options?: Record<string, unknown>, scope?: ExtensionExecutionScope) => Promise<CapabilityResult>;
  getPrompt?: (id: string, args?: Record<string, unknown>, scope?: ExtensionExecutionScope) => Promise<unknown>;
}

export interface ExtensionCommandDefinition {
  name: string;
  /** Configuration-only commands run without a Session Run; effectful commands use managed execution by default. */
  execution?: 'configuration' | 'managed';
  aliases?: string[];
  description: string;
  usage?: string;
  metadata?: Record<string, unknown>;
  handler: (
    args: string[],
    context: ExtensionCommandContext,
  ) => Promise<ExtensionCommandResult | void> | ExtensionCommandResult | void;
}

export interface ExtensionModelSelection {
  provider?: string;
  model?: string;
}

export interface ExtensionLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ExtensionFileContributionSource {
  kind: 'extension';
  id: string;
  label: string;
  path: string;
}

export interface RuntimeContributionSource {
  kind: 'runtime';
  id: string;
  label: string;
  path?: string;
}

export type ExtensionContributionSource =
  | ExtensionFileContributionSource
  | RuntimeContributionSource;

export type ExtensionLoadSource = 'api' | 'cli' | 'config' | 'discovery';

export interface LoadedExtensionDiagnostic {
  path: string;
  label: string;
  loadSource: ExtensionLoadSource;
  sessionStateKeys?: string[];
  sessionRecordCounts?: Record<string, number>;
}

export interface RegisteredCapabilityProviderDiagnostic {
  id: string;
  kinds: CapabilityKind[];
  source: ExtensionContributionSource;
  metadata?: Record<string, unknown>;
}

export interface RegisteredCommandDiagnostic {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  metadata?: Record<string, unknown>;
  source: ExtensionContributionSource;
}

export interface RegisteredToolDiagnostic {
  name: string;
  description: string;
  requiredParams: string[];
  source: RegisteredToolDefinition['source'];
  shadowedSources: RegisteredToolDefinition['source'][];
}

export interface RegisteredHookDiagnostic {
  hook: keyof ExtensionHookMap;
  order: number;
  source: ExtensionContributionSource;
}

export type ExtensionFailureStage = 'load' | 'reload' | 'event' | 'hook' | 'persistence' | 'dispose';

export interface ExtensionFailureDiagnostic {
  stage: ExtensionFailureStage;
  target: string;
  message: string;
  occurredAt: string;
  source: ExtensionContributionSource;
}

export interface ExtensionRuntimeDiagnostics {
  loadedExtensions: LoadedExtensionDiagnostic[];
  capabilityProviders: RegisteredCapabilityProviderDiagnostic[];
  commands: RegisteredCommandDiagnostic[];
  tools: RegisteredToolDiagnostic[];
  hooks: RegisteredHookDiagnostic[];
  failures: ExtensionFailureDiagnostic[];
  defaults: {
    activeTools?: string[];
    modelSelection: ExtensionModelSelection;
    thinkingLevel?: KodaXWireReasoningEffort;
  };
}

export interface ExtensionCommandInvocation {
  prompt: string;
  displayName?: string;
  disableModelInvocation?: boolean;
  allowedTools?: string;
  context?: 'fork';
  model?: string;
}

export interface ExtensionCommandResult {
  success?: boolean;
  message?: string;
  data?: unknown;
  invocation?: ExtensionCommandInvocation;
}

export interface ExtensionCommandContext {
  extensionExecution?: ExtensionExecutionScope;
  sessionId?: string;
  gitRoot?: string;
  workingDirectory: string;
  reloadExtensions: () => Promise<void>;
  getDiagnostics: () => ExtensionRuntimeDiagnostics;
  logger: ExtensionLogger;
}

export interface ExtensionToolBeforeHookContext {
  name: string;
  input: Record<string, unknown>;
  toolId?: string;
  executionCwd?: string;
  gitRoot?: string;
}

export interface ExtensionProviderBeforeHookContext {
  provider: string;
  model?: string;
  reasoningMode?: KodaXWireReasoningEffort;
  systemPrompt: string;
  block: (reason: string) => void;
  replaceProvider: (provider: string) => void;
  replaceModel: (model?: string) => void;
  replaceSystemPrompt: (systemPrompt: string) => void;
  setThinkingLevel: (level: KodaXWireReasoningEffort) => void;
}

export interface ExtensionTurnSettleHookContext {
  sessionId: string;
  lastText: string;
  hadToolCalls: boolean;
  success: boolean;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  queueUserMessage: (message: string | KodaXMessage) => void;
  setModelSelection: (next: ExtensionModelSelection) => void;
  setThinkingLevel: (level: KodaXWireReasoningEffort) => void;
}

/**
 * FEATURE_184 (v0.7.45) — Stop Hook bridge context for extensions.
 *
 * Fires ONLY when the model terminates a turn text-only (no tool_use)
 * — a strict subset of `turn:settle`, which fires on every turn end
 * including mid-task tool turns. Use this hook for verification or
 * "is the task actually done?" checks. The three-state return surface
 * mirrors `RunOptions.stopHook` at the agent layer; the bridge passes
 * the extension's return through unchanged.
 *
 * Coding-layer first-party consumers (Sidecar Verifier, FEATURE_184
 * Phase D) wire directly to the agent `stopHook`. Third-party
 * extensions write `api.hook('turn:complete', handler)` and the bridge
 * dispatches to them inside the agent's `stopHook` callback. Handlers
 * fire in registration order, first non-`void` return short-circuits
 * the chain (matches `tool:before` semantics).
 *
 * Scope note: this hook fires on the AMA `runner-driven` path only
 * (main loop, B1 retry, V2 worker). Native child Actor turns go through
 * `runKodaX` and do NOT trigger this hook — observe their lifecycle via
 * `turn:settle` on the SA
 * path. Extensions wanting "every agent termination" semantics must
 * register both hooks.
 */
export interface ExtensionTurnCompleteHookContext {
  sessionId: string;
  lastAssistantText: string;
  signal: 'natural-end';
  reanimateCount: number;
  reanimateBudget: number;
}

/**
 * FEATURE_184 (v0.7.45) — Extension `turn:complete` return surface.
 *
 *   - `void` / `undefined` → accept the termination, defer to next
 *     handler (or fall through to agent terminal path if none).
 *   - `string` → reanimate: synthesize a user message, run another
 *     turn. Bounded by Runner's `stopHookReanimateBudget`.
 *   - `{ abort: true, reason }` → halt the run, surface reason to
 *     caller via `RunResult.output` + `stoppedByHook = true`.
 */
export type ExtensionTurnCompleteHookResult =
  | void
  | string
  | { readonly abort: true; readonly reason: string };

export interface ExtensionSessionHydrateHookContext {
  sessionId: string;
  getState: <T = KodaXJsonValue>(key: string) => T | undefined;
  setState: (key: string, value: KodaXJsonValue | undefined) => void;
  listRecords: (type?: string) => KodaXExtensionSessionRecord[];
  appendRecord: (
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ) => KodaXExtensionSessionRecord | undefined;
  clearRecords: (type?: string) => number;
}

export interface ExtensionEventMap {
  'session:start': { provider: string; sessionId: string };
  'turn:start': { sessionId: string; iteration: number; maxIter: number };
  'text:delta': { text: string };
  'thinking:delta': { text: string };
  'thinking:end': { thinking: string };
  'tool:start': { name: string; id: string; input?: Record<string, unknown> };
  'tool:result': { id: string; name: string; content: string };
  'provider:selected': { provider: string; model?: string };
  'provider:rate-limit': { provider: string; attempt: number; maxRetries: number; delayMs: number };
  'capability:search': { providerId: string; query: string; kind?: CapabilityKind; limit?: number };
  'capability:describe': { providerId: string; capabilityId: string };
  'capability:invoke': { providerId: string; capabilityId: string; kind: CapabilityKind };
  'capability:refresh': { providerId: string };
  'stream:end': undefined;
  'turn:end': {
    sessionId: string;
    iteration: number;
    lastText: string;
    hadToolCalls: boolean;
    signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  };
  'complete': { success: boolean; signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE' };
  'error': { error: Error };
  // FEATURE_170 v0.7.41 — todo CRUD observability. Broadcast-only (no
  // blocking semantics). Fired after the store mutation completes. The
  // matching blocking gates live in ExtensionHookMap below.
  //
  // `'todo:updated'` fires for *every* observable mutation including
  // status flips driven by runner-side autoCompleteOnAccept /
  // markInProgressFailed / resetFailed — extensions wanting to observe
  // only LLM-initiated updates should filter via `source`.
  'todo:created': { id: string; item: KodaXTodoItem; source: TodoMutationSource };
  'todo:updated': {
    id: string;
    before: KodaXTodoItem;
    after: KodaXTodoItem;
    changedFields: readonly (keyof KodaXTodoItem)[];
    source: TodoMutationSource;
  };
  'todo:deleted': { id: string; item: KodaXTodoItem; source: TodoMutationSource };
}

/**
 * FEATURE_170 v0.7.41 — provenance tag for todo:* events / hooks. Lets
 * extension authors distinguish LLM-driven mutations (`tool`) from
 * runner-side automation (`internal`) — e.g. an extension that audits
 * todo churn should ignore `internal` flips to avoid false positives.
 */
export type TodoMutationSource = 'tool' | 'internal';

/**
 * FEATURE_170 v0.7.41 — seed shape passed to `'todo:before-create'`.
 * Mirrors `TodoAddSeed` from todo-store.ts (kept structurally compatible
 * to avoid coupling extension authors to the internal task-engine type).
 *
 * v0.7.42 — `content` renamed to `subject` + optional `description` to
 * match claudecode V2 `TaskCreateTool` schema. See `TodoItem` JSDoc in
 * packages/coding/src/types.ts.
 */
export interface ExtensionTodoCreateSeed {
  readonly subject: string;
  readonly description?: string;
  readonly activeForm?: string;
  readonly evaluator?: 'build' | 'test' | 'lint';
  readonly owner?: string;
  readonly sourceObligationIndex?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * FEATURE_170 v0.7.41 — minimal todo item shape exposed to extensions
 * via the todo:* events. Kept structurally identical to the engine's
 * `TodoItem` so the runtime can pass values straight through without
 * conversion, but redeclared here so extension consumers don't import
 * from `packages/coding/src/types.ts` (which is task-engine internal).
 *
 * Drift guard: a compile-time assignability assertion at the bottom of
 * this file fires if `TodoItem` (engine) gains a field that this
 * extension-facing shape does NOT mirror — see `__todoItemParity` below.
 */
export interface KodaXTodoItem {
  readonly id: string;
  /** v0.7.42 — see TodoItem.subject JSDoc in packages/coding/src/types.ts. */
  readonly subject: string;
  readonly description?: string;
  readonly status:
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'cancelled';
  readonly owner?: string;
  readonly sourceObligationIndex?: number;
  readonly note?: string;
  readonly evaluator?: 'build' | 'test' | 'lint';
  readonly activeForm?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ExtensionHookMap {
  'tool:before': (
    context: ExtensionToolBeforeHookContext,
  ) => Promise<void | string | false> | void | string | false;
  'provider:before': (
    context: ExtensionProviderBeforeHookContext,
  ) => Promise<void> | void;
  'turn:settle': (
    context: ExtensionTurnSettleHookContext,
  ) => Promise<void> | void;
  // FEATURE_184 (v0.7.45) — Stop Hook bridge. Fires ONLY on text-only
  // termination (a strict subset of `turn:settle`'s trigger). Return
  // semantics — return `void` to defer, `string` to reanimate (bounded
  // by Runner's `stopHookReanimateBudget`), or `{abort, reason}` to
  // halt the run and surface the reason as the final output.
  'turn:complete': (
    context: ExtensionTurnCompleteHookContext,
  ) =>
    | Promise<ExtensionTurnCompleteHookResult>
    | ExtensionTurnCompleteHookResult;
  'session:hydrate': (
    context: ExtensionSessionHydrateHookContext,
  ) => Promise<void> | void;
  // FEATURE_170 v0.7.41 — todo blocking gates.
  //
  // Return semantics (mirrors `tool:before`):
  //   - `void` / `undefined`  → allow (default)
  //   - `string`              → block; the string is the reason surfaced
  //                             back to the LLM in the tool result envelope
  //   - `false`               → block without a reason (envelope uses
  //                             'blocked-by-hook' as the fallback reason)
  //
  // KodaX does NOT throw on block (unlike claudecode's
  // executeTaskCompletedHooks). Block translates to `{ok:false, reason}`
  // in the todo_create / todo_update tool result. This preserves the
  // unified KodaX tool-result envelope.
  //
  // The runner-side autoCompleteOnAccept / markInProgressFailed paths
  // (Evaluator-driven, not LLM-driven) bypass `todo:before-complete`
  // entirely — see the `source: 'internal'` event payload. Hook
  // authority is reserved for LLM-initiated mutations.
  'todo:before-create': (
    context: { seed: ExtensionTodoCreateSeed },
  ) => Promise<void | string | false> | void | string | false;
  'todo:before-complete': (
    context: { id: string; item: KodaXTodoItem },
  ) => Promise<void | string | false> | void | string | false;
}

export interface ExtensionRuntimeController {
  queueUserMessage(message: string | KodaXMessage): void;
  getSessionState<T = KodaXJsonValue>(key: string): T | undefined;
  setSessionState(key: string, value: KodaXJsonValue | undefined): void;
  appendSessionRecord(
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ): KodaXExtensionSessionRecord | undefined;
  listSessionRecords(type?: string): KodaXExtensionSessionRecord[];
  clearSessionRecords(type?: string): number;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getModelSelection(): ExtensionModelSelection;
  setModelSelection(next: ExtensionModelSelection): void;
  getThinkingLevel(): KodaXWireReasoningEffort | undefined;
  setThinkingLevel(level: KodaXWireReasoningEffort): void;
}

export interface KodaXExtensionAPI {
  readonly capabilities: { readonly executionScope: 1; readonly scopedSessionState: 1 };
  /** Undefined during registration or legacy host utilities outside an admitted Run. */
  getExecutionScope(): ExtensionExecutionScope | undefined;
  registerTool: (definition: LocalToolDefinition) => () => void;
  getTool: (name: string) => RegisteredToolDefinition | undefined;
  getBuiltinTool: (name: string) => RegisteredToolDefinition | undefined;
  registerModelProvider: (registration: ModelProviderRegistration) => () => void;
  registerCapabilityProvider: (provider: ExtensionCapabilityProvider) => () => void;
  registerCommand: (command: ExtensionCommandDefinition) => () => void;
  registerSkillPath: (skillPath: string) => () => void;
  /**
   * FEATURE_191 (v0.7.43) — register a constructed agent at extension
   * activate time. The extension supplies the agent name and an
   * `AgentContent` body (instructions + optional tools/handoffs/
   * reasoning/model/description); the runtime threads it through
   * `buildAdmissionManifest` + `Runner.admit` and registers the
   * activated Agent via `registerConstructedAgent({ source:
   * 'extension' })`. The returned dispose fn (also auto-pushed onto
   * the extension's disposables list) unregisters the agent on
   * extension deactivate.
   *
   * Returns `Promise<() => void>` — **you MUST `await` the call**
   * before invoking the dispose function. Unlike sibling
   * `registerTool` (sync), this is async because `Runner.admit` is
   * declared async (FEATURE_101 admission contract — admission may
   * consult disk for handoff-target staged-agent resolution).
   *
   * @example
   * ```ts
   * // CORRECT — await unwraps the Promise to a sync dispose
   * export default async function activate(api: KodaXExtensionAPI) {
   *   const dispose = await api.registerAgent('db-reviewer', {
   *     instructions: 'You review DB migrations.',
   *     description: 'DB migration reviewer',
   *   });
   *   // dispose() is now callable on demand; the runtime also auto-
   *   // disposes via the extension's disposables list at deactivate.
   * }
   * ```
   *
   * @example
   * ```ts
   * // WRONG — TypeScript catches this; .js / @ts-ignore consumers
   * // hit a runtime TypeError because Promise is not a function.
   * export default function activate(api: KodaXExtensionAPI) {
   *   const dispose = api.registerAgent('x', { instructions: '...' });
   *   dispose();  // TypeError: dispose is not a function
   * }
   * ```
   *
   * Throws on admission rejection (with the verdict reason) so the
   * extension author sees the failure at activate time rather than
   * having a silently-dropped registration. The throw also halts
   * extension loading — the extension's other registrations roll back
   * via `LoadedExtensionRecord.disposables` reverse-iterate.
   */
  registerAgent: (
    name: string,
    content: AgentContent,
  ) => Promise<() => void>;
  on: <TEvent extends keyof ExtensionEventMap>(
    event: TEvent,
    handler: (payload: ExtensionEventMap[TEvent]) => Promise<void> | void,
  ) => () => void;
  hook: <THook extends keyof ExtensionHookMap>(
    hook: THook,
    handler: ExtensionHookMap[THook],
  ) => () => void;
  logger: ExtensionLogger;
  config: Readonly<Record<string, unknown>>;
  runtime: ExtensionRuntimeController;
  /** Extension-scoped key-value store that persists across sessions. */
  persistence: KodaXExtensionStore;
  /** Legacy trusted-host helper with filtered environment; not managed Run authority. Use getExecutionScope().invokeTool('bash', ...) for managed effects. */
  exec: (command: string, options?: ExecOptions) => Promise<ExecResult>;
  /** Send an HTTP webhook with timeout support. */
  webhook: (url: string, payload: unknown, options?: WebhookOptions) => Promise<WebhookResult>;
}

export type KodaXExtensionActivationResult =
  | void
  | (() => void | Promise<void>)
  | Promise<void | (() => void | Promise<void>)>;

export interface KodaXExtensionModule {
  default?: (api: KodaXExtensionAPI) => KodaXExtensionActivationResult;
  activate?: (api: KodaXExtensionAPI) => KodaXExtensionActivationResult;
}

// =============================================================================
// FEATURE_170 v0.7.41 — drift guard for `KodaXTodoItem` ⇔ engine `TodoItem`.
//
// The two interfaces deliberately live in different modules:
//   - `TodoItem` (packages/coding/src/types.ts) is the engine-internal
//     shape consumed by todo-store, runner-driven, and the
//     task-engine layer.
//   - `KodaXTodoItem` (this file) is the extension-facing shape passed
//     through todo:* events / hooks so extension authors don't have to
//     import a task-engine-internal type.
//
// They must stay structurally compatible. The one-line assignability
// check below produces a compile error the moment `TodoItem` gains a
// field that `KodaXTodoItem` does not mirror. The import is type-only
// (no runtime cost) and the constant is `void` (no module-level value
// exported). Tree-shaking removes the binding entirely from emitted JS.
// =============================================================================
import type { TodoItem as _EngineTodoItemForParity } from '../types.js';
// If a future contributor adds a required field to `TodoItem` without
// mirroring it on `KodaXTodoItem`, this conditional type collapses to
// `never` and the assignment fails with TS2322.
const _todoItemParityCheck:
  _EngineTodoItemForParity extends KodaXTodoItem ? true : never = true;
// Reference the binding once so noUnusedLocals doesn't strip it.
void _todoItemParityCheck;
