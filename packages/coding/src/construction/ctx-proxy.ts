/**
 * CtxProxy — runtime gate for constructed tool handlers.
 *
 * Constructed handlers run in the host process (no JS-level sandbox; see
 * DD §14.5 for why we deliberately avoid worker_threads / isolated-vm).
 * Safety derives from a four-layer model — Guardrail static check,
 * `capabilities.tools` whitelist declaration, this CtxProxy at runtime,
 * and policy gate on activate.
 *
 * Behavior (v0.7.28, single-dim capabilities) — see DD §14.5.3:
 *   - `ctx.tools.<name>(...)` — capability check first, then dispatch
 *     through `executeTool()` so the call traverses the SAME registry
 *     pipeline as a builtin tool invocation. This "completes the chain":
 *     the constructed handler reuses every safety policy that already
 *     ships with builtins (e.g. bash OS sandbox, write path policy,
 *     truncation, error mapping).
 *   - Plan-mode predicate (`hostCtx.planModeBlockCheck`) is consulted
 *     before every dispatch so a constructed handler cannot reach a
 *     write tool that the parent plan-mode would have blocked. The
 *     predicate closes over live parent state, so toggles propagate
 *     mid-call.
 *   - Constructed→constructed call chains are bounded by
 *     {@link MAX_CONSTRUCTED_DEPTH}. Builtin callees are not counted.
 *     Exceeding the limit returns a tool error rather than throwing —
 *     keeps the parent agent loop alive and reportable.
 *   - Direct `ctx.tools` enumeration / introspection is gated; the
 *     proxied `tools` object only exposes whitelisted names.
 *   - All other `ctx.<x>` properties (executionCwd, abortSignal, etc.)
 *     pass through unchanged — they are framework infra, not tool calls.
 *
 * Anti-tampering:
 *   - Returned proxy is `Object.freeze`d at the top level so handlers
 *     cannot reassign `ctx.tools`.
 *   - `Object.getPrototypeOf(proxiedTools)` returns null (no prototype
 *     pollution surface).
 *
 * NOT a security boundary in the V8 / sandbox sense — it is a contract
 * gate. Bypass attempts are part of the threat model addressed by
 * Guardrail static check + LLM review.
 */

import type { KodaXToolExecutionContext } from '../types.js';
import { executeTool, getRegisteredToolDefinition } from '../tools/registry.js';
import type { Capabilities } from './types.js';
import { CapabilityDeniedError } from './types.js';

/**
 * Maximum number of nested constructed-tool calls in a single chain.
 * A constructed tool calling a builtin (e.g. `bash`, `read`) does NOT
 * count toward this depth — only constructed→constructed transitions do.
 *
 * 5 is way above realistic business need (typical chains are 1-2 deep)
 * and well below V8's stack ceiling (~10k frames), so it triggers on
 * accidental recursion (A→B→A→B→…) without restricting legitimate
 * composition.
 */
export const MAX_CONSTRUCTED_DEPTH = 5;

/**
 * Internal symbol-keyed field on `KodaXToolExecutionContext` carrying
 * the current constructed-call depth. Read by CtxProxy at call time and
 * forwarded (incremented) when dispatching into another constructed
 * tool. Builtin tools never observe this — it is part of the
 * construction subsystem's internal contract.
 */
const CONSTRUCTED_DEPTH_KEY = '__constructedDepth' as const;

export interface CreateCtxProxyOptions {
  /**
   * When set, capability denial is reported through this callback before
   * the error is thrown. Lets the runtime emit a tracer span without
   * coupling CtxProxy to the tracer module.
   */
  readonly onDenied?: (event: { toolName: string; declaredTools: readonly string[] }) => void;
}

export function createCtxProxy(
  ctx: unknown,
  capabilities: Capabilities,
  options: CreateCtxProxyOptions = {},
): unknown {
  const hostCtx = (ctx ?? {}) as KodaXToolExecutionContext & {
    [CONSTRUCTED_DEPTH_KEY]?: number;
  };
  const allowedTools = new Set(capabilities.tools);
  const currentDepth = hostCtx[CONSTRUCTED_DEPTH_KEY] ?? 0;

  // Build a guarded `tools` object: only whitelisted names are reachable,
  // and each call dispatches through `executeTool()` so the constructed
  // handler reuses the SAME pipeline a builtin invocation would walk —
  // truncation, error mapping, and any per-tool safety policies.
  //
  // We pass a NEW ctx (immutable update) into `executeTool` so depth
  // tracking and any per-call overlay propagates cleanly without
  // mutating the caller's ctx — multiple parallel ctx.tools.X calls
  // would otherwise race on the same depth counter.
  const guardedTools: Record<string, unknown> = Object.create(null);

  for (const name of allowedTools) {
    guardedTools[name] = async (input?: unknown): Promise<string> => {
      // Defense in depth: re-check capability membership in case the
      // capabilities set was somehow mutated between proxy creation and
      // this call (it is `readonly` in TS but arrays are runtime-mutable).
      if (!allowedTools.has(name)) {
        options.onDenied?.({ toolName: name, declaredTools: capabilities.tools });
        throw new CapabilityDeniedError(name, capabilities.tools);
      }
      const normalizedInput =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : ({} as Record<string, unknown>);

      // Plan-mode propagation: when the parent REPL injected a plan-mode
      // predicate, every tool call inside a constructed handler must
      // honor it too. Without this hop, a constructed tool whose name is
      // in the plan-mode allowlist could silently bypass the gate by
      // calling `ctx.tools.bash(...)` from inside its handler. The
      // predicate closes over live parent state, so mid-run mode toggles
      // propagate.
      const planCheck = hostCtx.planModeBlockCheck;
      if (planCheck) {
        const reason = planCheck(name, normalizedInput);
        if (reason) {
          return `[Tool Error] ${reason} (called from constructed handler — plan-mode applies transitively).`;
        }
      }

      // Depth tracking: only count constructed→constructed transitions.
      // Builtin callees use registry-resolved handlers and do not create
      // a CtxProxy of their own, so they cannot recurse via ctx.tools.
      const callee = getRegisteredToolDefinition(name);
      const calleeIsConstructed = callee?.source.kind === 'constructed';
      const nextDepth = calleeIsConstructed ? currentDepth + 1 : currentDepth;
      if (calleeIsConstructed && nextDepth > MAX_CONSTRUCTED_DEPTH) {
        return `[Tool Error] Constructed tool depth limit (${MAX_CONSTRUCTED_DEPTH}) exceeded calling '${name}'. Possible recursive composition (A→B→A); break the cycle or factor through a builtin tool.`;
      }

      const childCtx = {
        ...hostCtx,
        [CONSTRUCTED_DEPTH_KEY]: nextDepth,
      } as KodaXToolExecutionContext;
      return executeTool(name, normalizedInput, childCtx);
    };
  }

  // Trap on the guarded tools so accessing a non-whitelisted name is a
  // CapabilityDeniedError instead of `undefined`.
  const toolsProxy = new Proxy(guardedTools, {
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key);
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        return target[key];
      }
      // Unknown access. Treat as denial only if it would have been a
      // tool — let typeof / inspect symbols pass quietly.
      options.onDenied?.({ toolName: key, declaredTools: capabilities.tools });
      throw new CapabilityDeniedError(key, capabilities.tools);
    },
    set() {
      throw new Error('Constructed handler attempted to mutate ctx.tools');
    },
    deleteProperty() {
      throw new Error('Constructed handler attempted to delete ctx.tools entries');
    },
    has(target, key) {
      return Object.prototype.hasOwnProperty.call(target, key);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getPrototypeOf() {
      return null;
    },
  });

  // Compose the final ctx: pass through everything else, override tools.
  // Frozen to prevent handler from reassigning ctx.tools.
  const composed = Object.freeze({
    ...(hostCtx as unknown as Record<string, unknown>),
    tools: toolsProxy,
  });

  return composed;
}
