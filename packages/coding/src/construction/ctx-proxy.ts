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
import { executeTool } from '../tools/registry.js';
import type { Capabilities } from './types.js';
import { CapabilityDeniedError } from './types.js';

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
  const hostCtx = (ctx ?? {}) as KodaXToolExecutionContext;
  const allowedTools = new Set(capabilities.tools);

  // Build a guarded `tools` object: only whitelisted names are reachable,
  // and each call dispatches through `executeTool()` so the constructed
  // handler reuses the SAME pipeline a builtin invocation would walk —
  // truncation, error mapping, and any per-tool safety policies.
  //
  // We pass the ORIGINAL `hostCtx` (not the frozen proxied wrapper) into
  // `executeTool` so builtin handlers see a normal mutable ctx. The proxy
  // is only the lens the constructed handler observes.
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
      return executeTool(name, normalizedInput, hostCtx);
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
