/**
 * KodaX Tool Types
 */

import type { KodaXToolDefinition, KodaXToolResultContentItem } from '@kodax-ai/llm';
import type { KodaXToolExecutionContext } from '../types.js';

/**
 * Progress yield from a streaming (async generator) tool.
 * Each yield appears as a real-time status update in the REPL transcript.
 */
export interface ToolProgress {
  readonly stage: string;
  readonly message: string;
}

/**
 * Final result a tool may return. Either a plain string (the default for
 * text-only tools) OR a typed-array form for multimodal returns (e.g.
 * `read` on an image path returns `[{type:'text',...}, {type:'image',...}]`).
 * Providers serialize each shape to their wire format; OpenAI-compat
 * gateways downgrade image items to a placeholder rather than rejecting.
 *
 * The array form mirrors claudecode's FileReadTool image return — Claude
 * Code packs image data into `tool_result` content so the model can
 * re-fetch images via the tool path. See
 * `c:/Works/claudecode/src/tools/FileReadTool/FileReadTool.ts:866-891`.
 */
export type ToolResult = string | readonly KodaXToolResultContentItem[];

/** Standard tool handler — returns a final result (text or multimodal). */
export type ToolHandlerSync = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext,
) => Promise<ToolResult>;

/** Streaming tool handler — yields progress updates, returns final result. */
export type ToolHandlerStreaming = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext,
) => AsyncGenerator<ToolProgress, ToolResult, void>;

/** Union of both handler types. Existing tools use ToolHandlerSync; new long-running tools may use ToolHandlerStreaming. */
export type ToolHandler = ToolHandlerSync | ToolHandlerStreaming;

// FEATURE_247: `ToolSideEffect` moved to the leaf module `./side-effect.ts` so
// `coding/src/types.ts` can import it (for the tool-visibility policy) without a
// type-import cycle through this file. Re-exported here so existing
// `import { ToolSideEffect } from './tools/types.js'` consumers are unchanged.
import type { ToolSideEffect } from './side-effect.js';
export type { ToolSideEffect };

export interface RuntimeRemoteWorkspaceBroker {
  resolveReadablePath(relativePath: string): Promise<string>;
  stageOutput(suggestedName: string): Promise<{
    readonly stagingId: string;
    readonly path: string;
  }>;
}

export interface RuntimeRemoteToolContext {
  readonly workspaceAccess: 'none' | 'read' | 'write';
  readonly allowedNetworkOrigins: readonly string[];
  readonly workspace: RuntimeRemoteWorkspaceBroker;
  readonly signal: AbortSignal;
}

export type RuntimeRemoteToolDecision =
  | { readonly allowed: true; readonly input: Readonly<Record<string, unknown>> }
  | { readonly allowed: false; readonly reason: string };

/** Explicit opt-in contract required before a non-native tool can serve remote callers. */
export interface RuntimeRemoteToolContract {
  readonly kind: 'managed-service' | 'narrow';
  readonly workspaceEffect: 'none' | 'read' | 'write';
  readonly networkOrigins: readonly string[];
  readonly credentialHandling: 'none' | 'internal-only';
  readonly processImplementation: 'none' | 'fixed-host-operation';
  authorizeCall(
    input: Readonly<Record<string, unknown>>,
    context: RuntimeRemoteToolContext,
  ): Promise<RuntimeRemoteToolDecision>;
}

/**
 * FEATURE_149 (v0.7.38) — interrupt-on-submit policy for in-flight tools.
 *
 * Controls whether submitting a new prompt while THIS tool is mid-execution
 * triggers a fast-abort of the current agent round (so the new prompt starts
 * immediately) or queues the prompt to run after the tool resolves.
 *
 *   - `'cancel'` — long-running tools whose work the user is likely to want
 *     to abandon when they redirect (e.g., `bash` running a 30s script or
 *     sleep-style tools). InkREPL submit handler aborts the round immediately.
 *
 *   - `'wait'` (default) — atomic / fast tools (read, grep, glob, write,
 *     edit, …) where waiting for completion is cheaper than aborting and
 *     redoing.
 *
 * Mirrors Claude Code `interruptBehavior` (`utils/handlePromptSubmit.ts`).
 */
export type ToolInterruptBehavior = 'cancel' | 'wait';

export interface LocalToolDefinition extends KodaXToolDefinition {
  handler: ToolHandler;

  /**
   * v0.7.42 — Required declarative side-effect class. See
   * {@link ToolSideEffect} for category definitions and rationale. Plan
   * mode and SDK embedders' permission brokers consume this; failure to
   * declare is a TypeScript error (by design — `sideEffect` is required,
   * not optional, to prevent silent drift when new tools are added).
   */
  sideEffect: ToolSideEffect;
  /** Absent means this tool is not eligible for remote A2A execution. */
  remoteContract?: RuntimeRemoteToolContract;

  /**
   * v0.7.42 — Optional plan-mode override.
   *
   *   - `undefined` (default): plan-mode permits only `sideEffect ===
   *     'readonly'` tools.
   *   - `true`: explicitly permitted in plan mode even when sideEffect is
   *     not `'readonly'`. Reserve for tools whose effect is itself part of
   *     the planning loop (`exit_plan_mode`, `interrupt_agent`, `todo_update`,
   *     `todo_create`, `ask_user_question`).
   *   - `false`: explicitly blocked in plan mode even when sideEffect is
   *     `'readonly'`. Rare — useful for read-only tools whose output would
   *     leak content the planner should not see.
   */
  planModeAllowed?: boolean;

  /**
   * FEATURE_149 (v0.7.38) — submit-time interrupt policy. See
   * {@link ToolInterruptBehavior}. Default `'wait'` when undefined.
   */
  interruptBehavior?: ToolInterruptBehavior;

  /**
   * Progressive disclosure — when `true`, the tool's full description is
   * replaced with `searchHint` (a one-line summary) in the LLM-visible
   * tool schema until the per-session unlock Set marks the tool name as
   * unlocked. Unlocking happens via the `tool_search` tool: the LLM
   * invokes `tool_search` with a query that selects this tool, and the
   * full description + JSON schema are returned in the tool_result text.
   * The next `getActiveToolDefinitions` call for the same session sees
   * the unlock and emits the full description.
   *
   * Use for tools with rich descriptions (>500 bytes) whose teaching
   * content the model only needs to consume when it actually plans to
   * call the tool. Saves turn-1 context without dropping the tool.
   *
   * Mirrors claudecode `Tool.shouldDefer` — see
   * `c:/Works/claudecode/src/tools/Tool.ts` for the parent design and
   * `c:/Works/claudecode/src/tools/ToolSearchTool/` for the bootstrap.
   */
  shouldDefer?: boolean;

  /**
   * One-line hint shown in place of the full description when this tool
   * is deferred and not yet unlocked. Required when `shouldDefer: true`.
   * Should answer "when would I want to look this up" in ≤ 100 chars
   * so the LLM can decide whether to invoke `tool_search` for the full
   * schema. Example: `'Fetch a specific remote URL — use tool_search to load full schema.'`
   */
  searchHint?: string;

  /**
   * Classifier projection — REQUIRED (FEATURE_092 v0.7.33).
   *
   * Returns a one-line string that the auto-mode classifier sees as the
   * `<action>` to evaluate. The classifier asks: "Given the user's
   * intent + rules, should the agent be allowed to run this?"
   *
   * THREE-TIER STRATEGY (pick by tool's risk profile):
   *
   *   1. ZERO RISK (read-only, structural):
   *      → return '' (Tier 1; classifier is skipped, zero token cost)
   *      Non-readonly tools need an explicit `classifierExemptReason`.
   *      Examples: read, grep, glob, ask_user_question
   *
   *   2. HIGH RISK (mutates state, network, exec, spawn):
   *      → write a CUSTOM projection that surfaces the risk-bearing fields
   *      Examples: bash (`Bash: ${i.command}`), web_fetch (`WebFetch ${i.url}`)
   *      See `classifier-projection.ts` for examples by category.
   *
   *   3. UNKNOWN / EXTENSION INPUT:
   *      → use `safeFallbackToClassifierInput(name, input)`. It retains
   *      operational metadata and body sizes without serializing raw JSON.
   *
   * KEEP IT SHORT: ≤ 100 chars typical. Variable-length user-provided fields
   * (bash command, URL, `spawn_agent` objective) may legitimately
   * exceed this — the projection's job is to make the risk visible, not to
   * fit a fixed budget at the cost of hiding it.
   *
   * NEVER include: raw file contents, secrets, API keys, full LLM-emitted
   * reasoning, or untrusted text passed through verbatim. Use byte/line
   * counts as proxies (`Write ${path} (${content.length} bytes)`).
   *
   * See `docs/features/v0.7.33.md` "Tool 接口扩展" for design rationale.
   */
  toClassifierInput: (input: unknown) => string;

  /**
   * Required justification when a non-readonly tool intentionally returns
   * an empty classifier projection. This makes classifier bypasses auditable
   * instead of allowing an accidental `() => ''` to fail open.
   */
  classifierExemptReason?: string;
}

export interface ToolDefinitionSource {
  /**
   * Origin of the registered tool. `'constructed'` (FEATURE_087, v0.7.28)
   * marks tools materialized at runtime by `ConstructionRuntime` from
   * `.kodax/constructed/tools/<name>/<version>.json` artifacts.
   */
  kind: 'builtin' | 'extension' | 'constructed';
  id?: string;
  label?: string;
  /**
   * Constructed-only: semver of the activated artifact. Used by
   * `findByVersion()` and by `revoke()` to locate a specific stack entry.
   */
  version?: string;
  /**
   * Constructed-only: absolute path to the artifact JSON on disk.
   * Lets revoke / inspect operations round-trip back to the source of
   * truth without re-globbing.
   */
  manifestPath?: string;
}

export interface RegisteredToolDefinition extends LocalToolDefinition {
  registrationId: string;
  requiredParams: string[];
  source: ToolDefinitionSource;
}

export interface ToolRegistrationOptions {
  source?: ToolDefinitionSource;
  /** Host identity; never serialized into model-visible tool definitions. */
  runtimeOwner?: object;
}

export type ToolRegistry = Map<string, RegisteredToolDefinition[]>;

export type KodaXRetrievalToolName =
  | 'web_search'
  | 'web_fetch'
  | 'code_search'
  | 'semantic_lookup'
  | 'mcp_search'
  | 'mcp_describe'
  | 'mcp_call'
  | 'mcp_read_resource'
  | 'mcp_get_prompt';

export type KodaXRetrievalScope = 'workspace' | 'remote';
export type KodaXRetrievalTrust = 'workspace' | 'provider' | 'open-world';
export type KodaXRetrievalFreshness = 'fresh' | 'snapshot' | 'unknown';

export interface KodaXRetrievalArtifact {
  kind: 'url' | 'path' | 'symbol' | 'module' | 'process' | 'provider';
  label: string;
  value: string;
}

export interface KodaXRetrievalItem {
  title: string;
  locator?: string;
  snippet?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface KodaXRetrievalResult {
  tool: KodaXRetrievalToolName;
  query?: string;
  scope: KodaXRetrievalScope;
  trust: KodaXRetrievalTrust;
  freshness: KodaXRetrievalFreshness;
  provider?: string;
  summary: string;
  content?: string;
  items: KodaXRetrievalItem[];
  artifacts?: KodaXRetrievalArtifact[];
  metadata?: Record<string, unknown>;
}
