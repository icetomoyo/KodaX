/**
 * loadHandler — turns a manifest's handler script into a callable
 * `ToolHandler` ready to register into `TOOL_REGISTRY`.
 *
 * Pipeline:
 *   1. Validate language === 'javascript' (v0.7.28 hard limit).
 *   2. Materialize the handler source onto disk under
 *      `<cwd>/.kodax/constructed/tools/<name>/<version>.js`.
 *   3. Dynamic `import()` of the file URL — host-process module load,
 *      no worker / vm isolation (DD §14.4).
 *   4. Wrap with `createCtxProxy` + a Promise.race timeout.
 *
 * Design notes:
 *   - Returning `ToolHandlerSync` (not the streaming variant) — v0.7.28
 *     constructed tools are non-streaming computations.
 *   - Handler return value is stringified for the agent loop, mirroring
 *     builtin tool result conventions.
 *   - ESM module cache is intentional: re-loading the same `<version>.js`
 *     returns the cached module. Constructed artifacts are immutable per
 *     version, so this is correct (revoke + new version is the proper
 *     update path).
 *   - Timeout is enforced via Promise.race; the underlying handler
 *     promise is *not* hard-aborted (Node has no general task abort).
 *     Long-running CPU loops will leak past timeout — accepted in the
 *     v0.7.28 threat model (LLM hallucination, not adversarial DoS).
 */

import path from 'path';
import fs from 'fs/promises';
import { pathToFileURL } from 'url';

import type { ToolHandlerSync } from '../tools/types.js';
import type { Capabilities, ScriptSource } from './types.js';
import { DEFAULT_HANDLER_TIMEOUT_MS } from './types.js';
import { createCtxProxy, type CreateCtxProxyOptions } from './ctx-proxy.js';

const CONSTRUCTED_TOOLS_SUBPATH = path.join('.kodax', 'constructed', 'tools');

export interface LoadHandlerScope {
  readonly name: string;
  readonly version: string;
  /** Workspace root; defaults to `process.cwd()`. */
  readonly cwd?: string;
}

export interface LoadHandlerOptions {
  /** Per-tool override; falls back to {@link DEFAULT_HANDLER_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Pass-through to {@link createCtxProxy}. */
  readonly ctxProxyOptions?: CreateCtxProxyOptions;
}

export async function loadHandler(
  scope: LoadHandlerScope,
  source: ScriptSource,
  capabilities: Capabilities,
  options: LoadHandlerOptions = {},
): Promise<ToolHandlerSync> {
  if (source.kind !== 'script' || source.language !== 'javascript') {
    throw new Error(
      `Constructed handler must be { kind: 'script', language: 'javascript' } (got kind='${(source as ScriptSource).kind}', language='${(source as ScriptSource).language}'). v0.7.28 does not support TS handlers.`,
    );
  }

  const cwd = scope.cwd ?? process.cwd();
  const dir = path.resolve(cwd, CONSTRUCTED_TOOLS_SUBPATH, scope.name);
  await fs.mkdir(dir, { recursive: true });
  const modulePath = path.join(dir, `${scope.version}.js`);
  await fs.writeFile(modulePath, source.code, 'utf8');

  const moduleUrl = pathToFileURL(modulePath).href;
  // Cache-busting query is intentionally NOT applied — same name/version
  // is immutable, so reusing the cached module is correct.
  const mod = (await import(moduleUrl)) as { handler?: unknown };

  if (typeof mod.handler !== 'function') {
    throw new Error(
      `Constructed handler '${scope.name}@${scope.version}' did not export 'handler' as a function. Expected: 'export async function handler(input, ctx) { ... }'`,
    );
  }

  const rawHandler = mod.handler as (
    input: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<unknown> | unknown;

  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const handlerLabel = `${scope.name}@${scope.version}`;

  const wrapped: ToolHandlerSync = async (input, ctx) => {
    const proxiedCtx = createCtxProxy(ctx, capabilities, options.ctxProxyOptions);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `Constructed handler '${handlerLabel}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });

    try {
      // Wrap in async IIFE so a *synchronous* throw from rawHandler
      // becomes a rejected promise rather than escaping the race.
      const handlerPromise = (async () => rawHandler(input, proxiedCtx))();
      const result = await Promise.race([handlerPromise, timeoutPromise]);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  };

  return wrapped;
}
