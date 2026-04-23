/**
 * Guardrail Runtime — FEATURE_085 (v0.7.26).
 *
 * Three-tier runtime for Agent guardrails:
 *
 *   - `InputGuardrail`: runs once before the first LLM turn, inspects the
 *     full input transcript, may allow / rewrite / block / escalate.
 *   - `OutputGuardrail`: runs once before returning, inspects the final
 *     assistant message, may allow / rewrite / block / escalate.
 *   - `ToolGuardrail`: runs before and/or after each tool invocation,
 *     inspects the call / result, may allow / rewrite / block / escalate.
 *
 * The four verdict actions:
 *
 *   - `allow`: continue with the current value.
 *   - `rewrite`: replace the current value with `payload`.
 *   - `block`: throw `GuardrailBlockedError` (for input/output) or surface
 *     an error tool_result (for tool-before); the LLM / caller sees a
 *     rejection and must adapt.
 *   - `escalate`: throw `GuardrailEscalateError`; the SDK consumer catches
 *     and decides whether to prompt the user, retry under different
 *     constraints, etc.
 *
 * Every guardrail invocation emits a `GuardrailSpan` under the agent's
 * span when tracing is active.
 *
 * @experimental API shape may adjust during v0.7.x rollout.
 */

import type { Span } from '@kodax/tracing';

import type { Agent, AgentMessage, Guardrail } from './agent.js';
import type { RunnerToolCall, RunnerToolResult } from './runner-tool-loop.js';

/**
 * Shared execution context passed to every guardrail.
 */
export interface GuardrailContext {
  readonly agent: Agent;
  readonly abortSignal?: AbortSignal;
}

/**
 * Outcome of a single guardrail check. `payload` shape depends on the hook
 * point — see the specific guardrail interface for the expected type.
 */
export type GuardrailVerdict =
  | { readonly action: 'allow' }
  | { readonly action: 'rewrite'; readonly payload: unknown; readonly reason?: string }
  | { readonly action: 'block'; readonly reason: string }
  | { readonly action: 'escalate'; readonly reason: string };

/**
 * Input-side guardrail. Expected `rewrite` payload shape:
 * `readonly AgentMessage[]` — the replacement transcript.
 */
export interface InputGuardrail extends Guardrail {
  readonly kind: 'input';
  check(
    input: readonly AgentMessage[],
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict>;
}

/**
 * Output-side guardrail. Expected `rewrite` payload shape:
 * `AgentMessage` — the replacement final assistant message.
 */
export interface OutputGuardrail extends Guardrail {
  readonly kind: 'output';
  check(
    output: AgentMessage,
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict>;
}

/**
 * Tool-side guardrail. `beforeTool` rewrite payload shape: `RunnerToolCall`
 * (replacement call). `afterTool` rewrite payload shape: `RunnerToolResult`
 * (replacement result). Either hook is optional.
 */
export interface ToolGuardrail extends Guardrail {
  readonly kind: 'tool';
  beforeTool?(
    call: RunnerToolCall,
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict>;
  afterTool?(
    call: RunnerToolCall,
    result: RunnerToolResult,
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict>;
}

/**
 * Thrown when any guardrail returns `{ action: 'block' }`. The Runner
 * propagates this up to the caller — the run is aborted at that point.
 */
export class GuardrailBlockedError extends Error {
  readonly guardrailName: string;
  readonly hookPoint: 'input' | 'output' | 'tool';

  constructor(guardrailName: string, hookPoint: 'input' | 'output' | 'tool', reason: string) {
    super(`Guardrail "${guardrailName}" blocked at ${hookPoint}: ${reason}`);
    this.name = 'GuardrailBlockedError';
    this.guardrailName = guardrailName;
    this.hookPoint = hookPoint;
  }
}

/**
 * Thrown when any guardrail returns `{ action: 'escalate' }`. Callers can
 * catch and prompt the user or apply a stricter policy before retrying.
 */
export class GuardrailEscalateError extends Error {
  readonly guardrailName: string;
  readonly hookPoint: 'input' | 'output' | 'tool';

  constructor(guardrailName: string, hookPoint: 'input' | 'output' | 'tool', reason: string) {
    super(`Guardrail "${guardrailName}" escalated at ${hookPoint}: ${reason}`);
    this.name = 'GuardrailEscalateError';
    this.guardrailName = guardrailName;
    this.hookPoint = hookPoint;
  }
}

function isInputGuardrail(g: Guardrail): g is InputGuardrail {
  return g.kind === 'input' && typeof (g as InputGuardrail).check === 'function';
}
function isOutputGuardrail(g: Guardrail): g is OutputGuardrail {
  return g.kind === 'output' && typeof (g as OutputGuardrail).check === 'function';
}
function isToolGuardrail(g: Guardrail): g is ToolGuardrail {
  return g.kind === 'tool';
}

/** Filter a guardrail list by hook-point. */
export function collectGuardrails(guardrails: readonly Guardrail[] | undefined): {
  input: readonly InputGuardrail[];
  output: readonly OutputGuardrail[];
  tool: readonly ToolGuardrail[];
} {
  if (!guardrails || guardrails.length === 0) {
    return { input: [], output: [], tool: [] };
  }
  const input: InputGuardrail[] = [];
  const output: OutputGuardrail[] = [];
  const tool: ToolGuardrail[] = [];
  for (const g of guardrails) {
    if (isInputGuardrail(g)) input.push(g);
    else if (isOutputGuardrail(g)) output.push(g);
    else if (isToolGuardrail(g)) tool.push(g);
  }
  return { input, output, tool };
}

function emitGuardrailSpan(
  agentSpan: Span | null,
  guardrailName: string,
  hookPoint: 'input' | 'output' | 'tool',
  verdict: GuardrailVerdict,
): void {
  if (!agentSpan) return;
  const decision: 'pass' | 'veto' | 'rewrite' =
    verdict.action === 'allow'
      ? 'pass'
      : verdict.action === 'rewrite'
        ? 'rewrite'
        : 'veto';
  const reason = verdict.action === 'allow' ? undefined : (verdict as { reason?: string }).reason;
  const span = agentSpan.addChild(`guardrail:${guardrailName}`, {
    kind: 'guardrail',
    guardrailName,
    hookPoint,
    decision,
    reason,
  });
  span.end();
}

/**
 * MED-3 observability: a guardrail callback throwing is a bug in the
 * guardrail author's code. We preserve the fail-loud semantic (re-throw
 * so the run aborts with the original error instead of silently
 * passing), but surface a `decision: 'error'` span so operators can
 * see which guardrail misbehaved without scraping stack traces.
 */
function emitGuardrailErrorSpan(
  agentSpan: Span | null,
  guardrailName: string,
  hookPoint: 'input' | 'output' | 'tool',
  error: unknown,
): void {
  if (!agentSpan) return;
  const span = agentSpan.addChild(`guardrail:${guardrailName}`, {
    kind: 'guardrail',
    guardrailName,
    hookPoint,
    decision: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
  span.end();
}

/**
 * Run all input guardrails in declaration order. Returns the (possibly
 * rewritten) transcript. Throws on block / escalate.
 */
export async function runInputGuardrails(
  transcript: readonly AgentMessage[],
  guardrails: readonly InputGuardrail[],
  ctx: GuardrailContext,
  agentSpan: Span | null,
): Promise<readonly AgentMessage[]> {
  let current = transcript;
  for (const guardrail of guardrails) {
    let verdict: GuardrailVerdict;
    try {
      verdict = await guardrail.check(current, ctx);
    } catch (err) {
      emitGuardrailErrorSpan(agentSpan, guardrail.name, 'input', err);
      throw err;
    }
    emitGuardrailSpan(agentSpan, guardrail.name, 'input', verdict);
    if (verdict.action === 'allow') {
      continue;
    }
    if (verdict.action === 'rewrite') {
      if (!Array.isArray(verdict.payload)) {
        throw new Error(
          `InputGuardrail "${guardrail.name}" returned rewrite with non-array payload; expected AgentMessage[].`,
        );
      }
      current = verdict.payload as readonly AgentMessage[];
      continue;
    }
    if (verdict.action === 'block') {
      throw new GuardrailBlockedError(guardrail.name, 'input', verdict.reason);
    }
    if (verdict.action === 'escalate') {
      throw new GuardrailEscalateError(guardrail.name, 'input', verdict.reason);
    }
  }
  return current;
}

/**
 * Run all output guardrails in declaration order. Returns the (possibly
 * rewritten) final assistant message. Throws on block / escalate.
 */
export async function runOutputGuardrails(
  output: AgentMessage,
  guardrails: readonly OutputGuardrail[],
  ctx: GuardrailContext,
  agentSpan: Span | null,
): Promise<AgentMessage> {
  let current = output;
  for (const guardrail of guardrails) {
    let verdict: GuardrailVerdict;
    try {
      verdict = await guardrail.check(current, ctx);
    } catch (err) {
      emitGuardrailErrorSpan(agentSpan, guardrail.name, 'output', err);
      throw err;
    }
    emitGuardrailSpan(agentSpan, guardrail.name, 'output', verdict);
    if (verdict.action === 'allow') {
      continue;
    }
    if (verdict.action === 'rewrite') {
      const payload = verdict.payload as AgentMessage | undefined;
      if (!payload || typeof payload !== 'object' || !('role' in payload)) {
        throw new Error(
          `OutputGuardrail "${guardrail.name}" returned rewrite with invalid payload; expected AgentMessage.`,
        );
      }
      current = payload;
      continue;
    }
    if (verdict.action === 'block') {
      throw new GuardrailBlockedError(guardrail.name, 'output', verdict.reason);
    }
    if (verdict.action === 'escalate') {
      throw new GuardrailEscalateError(guardrail.name, 'output', verdict.reason);
    }
  }
  return current;
}

/**
 * Outcome of the before-tool guardrail stage.
 *   - `{ kind: 'allow', call }`: continue to executeRunnerToolCall with `call`
 *   - `{ kind: 'block', result }`: skip execution; return `result` as the
 *     tool_result to the LLM (so it sees the rejection and can adapt)
 */
export type ToolBeforeOutcome =
  | { readonly kind: 'allow'; readonly call: RunnerToolCall }
  | { readonly kind: 'block'; readonly result: RunnerToolResult };

/**
 * Run before-tool guardrails in declaration order. Rewrite replaces the
 * tool call. Block surfaces an error tool_result to the LLM instead of
 * throwing — the LLM sees the rejection and adapts. Escalate still throws.
 */
export async function runToolBeforeGuardrails(
  call: RunnerToolCall,
  guardrails: readonly ToolGuardrail[],
  ctx: GuardrailContext,
  agentSpan: Span | null,
): Promise<ToolBeforeOutcome> {
  let currentCall = call;
  for (const guardrail of guardrails) {
    if (!guardrail.beforeTool) continue;
    let verdict: GuardrailVerdict;
    try {
      verdict = await guardrail.beforeTool(currentCall, ctx);
    } catch (err) {
      emitGuardrailErrorSpan(agentSpan, guardrail.name, 'tool', err);
      throw err;
    }
    emitGuardrailSpan(agentSpan, guardrail.name, 'tool', verdict);
    if (verdict.action === 'allow') continue;
    if (verdict.action === 'rewrite') {
      const payload = verdict.payload as RunnerToolCall | undefined;
      if (!payload || typeof payload !== 'object' || typeof payload.name !== 'string') {
        throw new Error(
          `ToolGuardrail "${guardrail.name}" returned rewrite with invalid payload; expected RunnerToolCall.`,
        );
      }
      currentCall = payload;
      continue;
    }
    if (verdict.action === 'block') {
      return {
        kind: 'block',
        result: {
          content: `[Guardrail ${guardrail.name}] ${verdict.reason}`,
          isError: true,
        },
      };
    }
    if (verdict.action === 'escalate') {
      throw new GuardrailEscalateError(guardrail.name, 'tool', verdict.reason);
    }
  }
  return { kind: 'allow', call: currentCall };
}

/**
 * Run after-tool guardrails in declaration order. Rewrite replaces the
 * result content. Block replaces with an error result. Escalate throws.
 */
export async function runToolAfterGuardrails(
  call: RunnerToolCall,
  result: RunnerToolResult,
  guardrails: readonly ToolGuardrail[],
  ctx: GuardrailContext,
  agentSpan: Span | null,
): Promise<RunnerToolResult> {
  let current = result;
  for (const guardrail of guardrails) {
    if (!guardrail.afterTool) continue;
    let verdict: GuardrailVerdict;
    try {
      verdict = await guardrail.afterTool(call, current, ctx);
    } catch (err) {
      emitGuardrailErrorSpan(agentSpan, guardrail.name, 'tool', err);
      throw err;
    }
    emitGuardrailSpan(agentSpan, guardrail.name, 'tool', verdict);
    if (verdict.action === 'allow') continue;
    if (verdict.action === 'rewrite') {
      const payload = verdict.payload as RunnerToolResult | undefined;
      if (!payload || typeof payload !== 'object' || typeof payload.content !== 'string') {
        throw new Error(
          `ToolGuardrail "${guardrail.name}" returned rewrite with invalid payload; expected RunnerToolResult.`,
        );
      }
      current = payload;
      continue;
    }
    if (verdict.action === 'block') {
      current = {
        content: `[Guardrail ${guardrail.name}] ${verdict.reason}`,
        isError: true,
      };
      continue;
    }
    if (verdict.action === 'escalate') {
      throw new GuardrailEscalateError(guardrail.name, 'tool', verdict.reason);
    }
  }
  return current;
}
