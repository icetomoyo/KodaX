/**
 * Capability Contract Test Helpers
 *
 * Shared utilities for constructing the minimal agent context each contract
 * test needs. Keep this file intentionally small — anything growing here
 * suggests the contract tests are doing too much.
 *
 * Companion: `README.md` in this directory.
 *
 * STATUS: P1 skeleton — interfaces fixed; concrete builders stubbed until
 * P2 migrates middleware modules into `agent-runtime/`.
 */

import type { KodaXMessage, KodaXToolDefinition } from '@kodax/ai';
import type { KodaXEvents, KodaXOptions } from '../../types.js';

// ---------------------------------------------------------------------------
// Minimal agent context — the smallest viable input to any single capability
// ---------------------------------------------------------------------------

export interface MinimalAgentCtx {
  /** KodaXOptions shaped just enough to satisfy the capability under test */
  options: KodaXOptions;
  /** Mutable message buffer (most middlewares read/write this) */
  messages: KodaXMessage[];
  /** Spy events object — every callback is a `vi.fn()` capturing call args */
  events: KodaXEventsSpy;
  /** Tool definitions for the current turn (CAP-021 / CAP-022 consumer) */
  activeTools: KodaXToolDefinition[];
  /** SessionId (used by snapshot / cost tracker capabilities) */
  sessionId: string;
}

/**
 * Spy version of KodaXEvents — every callback is a vi.fn() so contract tests
 * can assert `expect(ctx.events.onXxx).toHaveBeenCalledWith(...)`.
 *
 * The keys mirror `KodaXEvents` exactly; if a new event is added, this type
 * must be updated alongside.
 */
export type KodaXEventsSpy = {
  // STUB: full mapping deferred until vitest's vi.fn() type is wired in P1
  // mid-stage. The shape is: every method of KodaXEvents → vi.Mock with the
  // same signature. P1 implementation uses a Proxy that lazily creates spies
  // on first access so the spy footprint exactly matches what the test reads.
  [K in keyof KodaXEvents]: KodaXEvents[K];
};

export interface BuildOptions {
  /** Initial messages (default: single user message "test") */
  initialMessages?: KodaXMessage[];
  /** Active tools for this turn (default: empty) */
  activeTools?: KodaXToolDefinition[];
  /** Session id (default: 'test-session-<random>') */
  sessionId?: string;
  /** Reasoning plan mode (default: 'auto') */
  reasoningMode?: 'auto' | 'manual';
  /** agentMode flag on options (default: 'sa') */
  agentMode?: 'sa' | 'ama';
}

/**
 * Build a minimal `MinimalAgentCtx` for a contract test.
 *
 * Usage:
 *   const ctx = buildMinimalAgentCtx({ reasoningMode: 'auto' });
 *   await runMicrocompact(ctx);
 *   expect(ctx.messages.length).toBe(...);
 */
export function buildMinimalAgentCtx(_opts: BuildOptions = {}): MinimalAgentCtx {
  // STUB: P1 mid-stage deliverable
  throw new Error(
    'buildMinimalAgentCtx not yet implemented. This is a P1 skeleton; full implementation lands when middleware modules are extracted in P2. See packages/coding/src/agent-runtime/__contract-tests__/README.md.',
  );
}

// ---------------------------------------------------------------------------
// Tool failure simulator — for CAP-018 / CAP-019 contract tests
// ---------------------------------------------------------------------------

export interface ToolFailureSimulation {
  /** Tool name (e.g., 'edit_file') */
  toolName: string;
  /** Args (e.g., { path: '/foo.ts', anchor: 'old line' }) */
  args: Record<string, unknown>;
  /** Failure reason classification */
  failureKind: 'anchor-not-found' | 'permission-denied' | 'execution-error' | 'timeout';
  /** Optional structured error code */
  errorCode?: string;
}

/**
 * Inject a tool failure into the ctx's most recent assistant turn so that
 * the next post-tool middleware run sees strong failure evidence.
 *
 * Useful for CAP-018 (post-tool judge), CAP-019 (auto-reroute), CAP-015
 * (edit recovery) contract tests.
 */
export function simulateToolFailure(
  _ctx: MinimalAgentCtx,
  _failure: ToolFailureSimulation,
): void {
  // STUB: P1 mid-stage deliverable
  throw new Error('simulateToolFailure not yet implemented (P1 skeleton).');
}

// ---------------------------------------------------------------------------
// Per-turn advance helper — for capabilities triggered at turn boundaries
// ---------------------------------------------------------------------------

/**
 * Advance the agent context by one logical turn boundary so capabilities
 * gated on per-turn epilogue (e.g., microcompact, extension queue, judges)
 * fire. Runs the substrate per-turn epilogue chain in the same order as the
 * real executor.
 *
 * The turn-advance does NOT call the real provider — contract tests are not
 * supposed to depend on provider behavior. Use `simulateAssistantText` /
 * `simulateToolFailure` to inject the assistant-side state the capability
 * is reacting to.
 */
export async function advanceTurn(_ctx: MinimalAgentCtx): Promise<void> {
  // STUB: P1 mid-stage deliverable
  throw new Error('advanceTurn not yet implemented (P1 skeleton).');
}

/**
 * Inject a synthetic assistant text into the ctx, as if the provider had
 * just streamed it. Used by CAP-017 (pre-answer judge) and any capability
 * that reacts to assistant-text content.
 */
export function simulateAssistantText(_ctx: MinimalAgentCtx, _text: string): void {
  // STUB: P1 mid-stage deliverable
  throw new Error('simulateAssistantText not yet implemented (P1 skeleton).');
}
