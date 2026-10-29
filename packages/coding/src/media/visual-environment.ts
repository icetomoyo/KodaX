import { randomUUID } from 'node:crypto';
import { validateImageBytesInRun } from '@kodax-ai/llm';
import { countTokens } from '@kodax-ai/agent';
import { MAX_DIMENSION, TARGET_RAW_SIZE_BYTES, preflightVisualPng, type VisualOutputReservation } from '@kodax-ai/agent/media';
import { getToolResultAdmissionLimits } from '../tools/tool-result-policy.js';
import type { KodaXToolExecutionContext } from '../types.js';
import type { LocalToolDefinition, ToolResult } from '../tools/types.js';

export interface VisualActionFact {
  invocationId: string;
  status: 'not_dispatched' | 'completed' | 'unknown';
  version: string;
  detail?: string;
}
const errorText = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1024 ? `${text.slice(0, 1024)} [truncated]` : text;
};

/** Trusted adapter facts. Version must change on reset and on every relevant external change. */
export interface VisualEnvironmentAdapter {
  state(): { version: string; lastAction?: VisualActionFact };
  capture(signal?: AbortSignal): Promise<{ version: string; bytes: Buffer; mediaType: string }>;
  /** Atomically reject a changed version or pending unknown at the effect boundary; expose pending facts until reconciled. */
  act(action: string, expectedVersion: string, invocationId: string, signal?: AbortSignal): Promise<VisualActionFact>;
}

/** Explicit opt-in consumer. Share this instance across Actors/Runs using the same environment. */
export function createVisualEnvironmentTools(sources: Readonly<Record<string, VisualEnvironmentAdapter>>): LocalToolDefinition[] {
  const owners = new Map(Object.entries(sources).map(([source, adapter]) => [source, {
    adapter, generation: 0, sample: 0, promoted: 0, tail: Promise.resolve(),
    current: undefined as { observationId: string; version: string; ownerId: string } | undefined,
    uncertain: undefined as string | undefined,
  }]));
  const resolve = (input: Record<string, unknown>, ctx: KodaXToolExecutionContext) => {
    const owner = typeof input.source === 'string' ? owners.get(input.source) : undefined;
    if (!owner) throw new Error('Unknown visual environment source.');
    if (!ctx.visualObservationOwner || !ctx.admitVisualObservation || !ctx.reserveVisualOutput) throw new Error('Visual environment requires an admitted Runtime owner and output capacity.');
    return owner;
  };
  type Owner = ReturnType<typeof resolve>;
  const invalidateUnknown = (owner: Owner) => {
    const fact = owner.adapter.state().lastAction;
    if (fact?.status === 'unknown') {
      owner.current = undefined; owner.generation++; owner.uncertain = fact.invocationId;
    }
  };
  const observe = async (source: string, owner: Owner, ctx: KodaXToolExecutionContext,
    actionFact?: VisualActionFact & { dispatchError?: string }): Promise<ToolResult> => {
    ctx.abortSignal?.throwIfAborted();
    invalidateUnknown(owner);
    const reservations: VisualOutputReservation[] = [];
    let reserved = 0;
    const reserve = (version: string, lastAction = owner.adapter.state().lastAction) => {
      const text = JSON.stringify({ source, version, lastAction, actionFact });
      const bytes = Buffer.byteLength(text, 'utf8') * 2 + 1024;
      const tokens = 1500 + countTokens(text) * 2 + 1024;
      const limits = getToolResultAdmissionLimits('visual_observe');
      if (bytes > limits.maxBytes || tokens > limits.perEntryTokens) throw new Error('Visual environment metadata exceeds result capacity.');
      if (tokens > reserved) { reservations.push(ctx.reserveVisualOutput!(tokens - reserved)); reserved = tokens; }
    };
    let retained = false;
    try {
      reserve(owner.adapter.state().version);
      const generation = owner.generation; const ordinal = ++owner.sample;
      const sampledAt = new Date().toISOString(); const startedVersion = owner.adapter.state().version;
      const frame = await owner.adapter.capture(ctx.abortSignal);
      ctx.abortSignal?.throwIfAborted();
      const dimensions = preflightVisualPng(frame.bytes);
      if (frame.mediaType !== 'image/png' || frame.bytes.length > TARGET_RAW_SIZE_BYTES || Math.max(dimensions.width, dimensions.height) > MAX_DIMENSION) {
        throw new Error('Visual environment PNG exceeds the display limit; adapter must provide a bounded frame.');
      }
      const validation = await validateImageBytesInRun(frame.bytes);
      const lastAction = structuredClone(owner.adapter.state().lastAction);
      reserve(frame.version, lastAction);
      const accepted = await ctx.admitVisualObservation!(frame.bytes, { validation, sourceKey: `environment:${source}`,
        mediaType: frame.mediaType, source: ctx.visualSource, sourceVersion: frame.version, sampledAt });
      retained = true;
      invalidateUnknown(owner);
      if (owner.uncertain && lastAction?.invocationId === owner.uncertain && lastAction.status !== 'unknown') owner.uncertain = undefined;
      const current = !owner.uncertain && owner.adapter.state().lastAction?.status !== 'unknown' && generation === owner.generation && ordinal > owner.promoted
        && frame.version === startedVersion && frame.version === owner.adapter.state().version;
      if (current) { owner.current = { observationId: accepted.observation.observationId, version: frame.version,
        ownerId: ctx.visualObservationOwner!.ownerId }; owner.promoted = ordinal; }
      return [{ type: 'text', text: JSON.stringify({ observationId: accepted.observation.observationId, source,
        sourceVersion: frame.version, sampledAt, applicability: current ? 'current_candidate_requires_committed_receipt' : 'historical', lastAction, ...actionFact }) }, ...accepted.content];
    } finally { if (!retained) reservations.forEach(reservation => reservation.cancel()); }
  };
  return [
    { name: 'visual_observe', description: 'Sample an installed environment source. Historical inspection does not refresh its action basis.',
      input_schema: { type: 'object', properties: { source: { type: 'string', enum: Object.keys(sources) } }, required: ['source'] },
      sideEffect: 'readonly', toClassifierInput: () => '',
      handler: async (input, ctx) => observe(String(input.source), resolve(input, ctx), ctx) },
    { name: 'visual_act', description: 'Act once using a committed current observation and source version. Unknown outcomes require reconciliation and fresh observation; never replay to obtain a picture.',
      input_schema: { type: 'object', properties: { source: { type: 'string' }, expectedObservationId: { type: 'string' },
        expectedSourceVersion: { type: 'string' }, action: { type: 'string' } },
        required: ['source', 'expectedObservationId', 'expectedSourceVersion', 'action'] },
      sideEffect: 'mutates-state', requiresSerialExecution: () => true,
      toClassifierInput: input => `Visual action ${String((input as Record<string, unknown>).source)}: ${String((input as Record<string, unknown>).action)}`,
      handler: async (input, ctx) => {
        const owner = resolve(input, ctx); const previous = owner.tail;
        let release!: () => void; owner.tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
          ctx.abortSignal?.throwIfAborted();
          const current = owner.current;
          invalidateUnknown(owner);
          if (owner.uncertain || owner.adapter.state().lastAction?.status === 'unknown' || !current || current.ownerId !== ctx.visualObservationOwner!.ownerId
            || current.observationId !== input.expectedObservationId || current.version !== input.expectedSourceVersion
            || current.version !== owner.adapter.state().version
            || !(await ctx.visualObservationOwner!.list()).some(observation => observation.observationId === current.observationId)) {
            return JSON.stringify({ status: 'not_dispatched', reason: 'Action basis is stale, uncommitted or unknown; observe again after reconciliation.' });
          }
          if (typeof input.action !== 'string' || !input.action.trim()) throw new Error('Visual action must be a nonempty string.');
          const invocationId = ctx.visualSource?.executionId ?? randomUUID();
          owner.current = undefined; owner.generation++; owner.uncertain = invocationId;
          let fact: VisualActionFact & { dispatchError?: string };
          try { fact = await owner.adapter.act(input.action, current.version, invocationId, ctx.abortSignal); }
          catch (error) {
            const reported = owner.adapter.state().lastAction;
            fact = reported?.invocationId === invocationId ? { ...reported, dispatchError: errorText(error) } : { invocationId, status: 'unknown', version: owner.adapter.state().version,
              dispatchError: errorText(error) };
          }
          if (fact.invocationId !== invocationId) throw new Error('Visual adapter returned a mismatched invocation fact.');
          if (fact.status !== 'unknown') owner.uncertain = undefined;
          if (fact.status !== 'completed') return JSON.stringify(fact);
          try {
            return await observe(String(input.source), owner, ctx, fact);
          } catch (error) {
            return JSON.stringify({ ...fact, observation: 'unavailable', recovery: 'Observe again; do not replay the action.',
              observationError: errorText(error) });
          }
        } finally { release(); }
      } },
  ];
}
