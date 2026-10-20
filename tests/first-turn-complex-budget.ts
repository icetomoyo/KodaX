import type { ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';

/** Eval-only settlement. Hard-cap reservation must happen before dispatch. */
export function settleComplexAttempt(input: {
  reservedTokens: number; reservedUsd: number; facts: readonly ProviderRequestObservation[];
  tools: readonly string[]; reasoning: unknown; outputCap: number;
  requestCancelled: boolean; taskCancelled: boolean; failed: boolean;
  actualUsd?: number;
}) {
  const physical = input.facts.filter(f => f.boundary === 'physical_attempt');
  const attempts = new Set(physical.filter(f => f.state === 'started').map(f => f.requestId));
  const terminal = physical.filter(f => f.state !== 'started').at(-1);
  const usage = !input.failed && attempts.size === 1 && terminal?.state === 'succeeded'
    && attempts.has(terminal.requestId) ? terminal.usage : undefined;
  const { actualUsd } = input;
  const known = usage !== undefined && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
    && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
    && Number.isFinite(usage.totalTokens) && usage.totalTokens === usage.inputTokens + usage.outputTokens && usage.totalTokens > 0
    && actualUsd !== undefined && Number.isFinite(actualUsd) && actualUsd >= 0;
  const operation = input.facts.at(-1);
  // A completed native adapter cancellation can happen after queue release but
  // before SDK fetch. Unavailable/custom adapter boundaries remain ambiguous.
  const nativePreDispatchCancellation = physical.length === 0 && operation?.state === 'cancelled'
    && operation.wireObservation === 'pending'
    && input.facts.some(f => f.state === 'started' && f.wireObservation === 'pending')
    && input.facts.every(f => f.boundary === 'provider_operation' && f.purpose === 'sidecar'
      && f.requestId === operation.requestId && f.logicalRequestId === operation.logicalRequestId);
  const boundedAuxiliaryCancellation = input.failed && input.requestCancelled && !input.taskCancelled
    && input.tools.length === 1 && input.tools[0] === 'report_stall_judgment'
    && input.reasoning === false && input.outputCap > 0 && input.outputCap <= 1024
    && (nativePreDispatchCancellation || (attempts.size === 1 && terminal?.state === 'cancelled'
      && attempts.has(terminal.requestId) && physical.every(f => f.purpose === 'sidecar')));
  return {
    chargedTokens: known ? usage.totalTokens : input.reservedTokens,
    chargedUsd: known ? actualUsd : input.reservedUsd,
    unknownUsage: !known,
    stop: !boundedAuxiliaryCancellation && (attempts.size !== 1 || input.failed || !known || terminal?.state !== 'succeeded'),
    boundedAuxiliaryCancellation,
  };
}
