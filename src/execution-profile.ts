import type { KodaXToolVisibilityMeta, KodaXToolVisibilityPolicy } from '@kodax-ai/coding/client-contract';
import type { RuntimeExecutionProfile, RuntimeExecutionProfileSource, RuntimeHostToolDescriptor } from './client-host-authorization.js';

export function hostToolMetadata(tool: RuntimeHostToolDescriptor): KodaXToolVisibilityMeta {
  return { name: tool.name, sideEffect: tool.sideEffect === 'none' ? 'readonly' : 'mutates-state',
    planModeAllowed: tool.sideEffect === 'none' };
}

/** Pure builder. Predicates require a Host catalog; Main's registry is never authoritative. */
export function createExecutionProfile(
  context: RuntimeExecutionProfileSource,
  catalog?: readonly KodaXToolVisibilityMeta[],
): RuntimeExecutionProfile {
  const restricted = context.toolVisibilityPolicy !== undefined || (context.excludeTools?.length ?? 0) > 0;
  if (restricted && catalog === undefined) throw new Error('A tool policy requires the Host catalog. Use authorizeExecution services.createExecutionProfile.');
  const metadata = catalog?.map(tool => ({ name: tool.name, sideEffect: tool.sideEffect, planModeAllowed: tool.planModeAllowed === true }))
    .filter(tool => !context.excludeTools?.includes(tool.name)
    && (context.toolVisibilityPolicy?.(tool) ?? true));
  return structuredClone({
    ...(context.agentProfile === undefined ? {} : { agentProfile: context.agentProfile }),
    ...(context.taskVerification === undefined ? {} : { taskVerification: context.taskVerification }),
    ...(restricted ? { tools: metadata!.map(tool => tool.name), toolMetadata: metadata } : {}),
  });
}

/** Exact metadata equality preserves every input to the original visibility predicate. */
export function executionProfileAllowsTool(profile: RuntimeExecutionProfile | undefined, tool: KodaXToolVisibilityMeta): boolean {
  return (profile?.tools === undefined || profile.tools.includes(tool.name))
    && (profile?.toolMetadata === undefined || profile.toolMetadata.some(allowed => allowed.name === tool.name
      && allowed.sideEffect === tool.sideEffect && allowed.planModeAllowed === tool.planModeAllowed));
}

/** Recovery keeps every admitted ceiling while requiring newly bound authority. */
export function intersectExecutionToolCeilings(
  original: Pick<RuntimeExecutionProfile, 'tools' | 'toolMetadata'> | undefined,
  fresh: Pick<RuntimeExecutionProfile, 'tools' | 'toolMetadata'> | undefined,
): Pick<RuntimeExecutionProfile, 'tools' | 'toolMetadata'> | undefined {
  if (original === undefined) return fresh;
  if (fresh === undefined) return original;
  const tools = original.tools === undefined ? fresh.tools
    : fresh.tools === undefined ? original.tools : original.tools.filter(name => fresh.tools!.includes(name));
  const toolMetadata = original.toolMetadata === undefined ? fresh.toolMetadata
    : fresh.toolMetadata === undefined ? original.toolMetadata
      : original.toolMetadata.filter(tool => fresh.toolMetadata!.some(candidate => candidate.name === tool.name
        && candidate.sideEffect === tool.sideEffect && candidate.planModeAllowed === tool.planModeAllowed));
  return { ...(tools === undefined ? {} : { tools }), ...(toolMetadata === undefined ? {} : { toolMetadata }) };
}

// Only these complete, declarative policies can be reconstructed after restart.
const executionToolPolicies = new WeakMap<KodaXToolVisibilityPolicy, Pick<RuntimeExecutionProfile, 'tools' | 'toolMetadata'>>();

export function executionToolPolicyCeiling(policy: unknown): Pick<RuntimeExecutionProfile, 'tools' | 'toolMetadata'> | undefined {
  return typeof policy === 'function' ? executionToolPolicies.get(policy as KodaXToolVisibilityPolicy) : undefined;
}

export function createExecutionToolPolicy(
  ceiling: Pick<RuntimeExecutionProfile, 'tools' | 'toolMetadata'>,
  previous?: KodaXToolVisibilityPolicy,
): KodaXToolVisibilityPolicy {
  const previousCeiling = executionToolPolicyCeiling(previous);
  const combined = intersectExecutionToolCeilings(ceiling, previousCeiling)!;
  const policy: KodaXToolVisibilityPolicy = tool => executionProfileAllowsTool(combined, tool) && (previous === undefined || previous(tool) === true);
  if (previous === undefined || previousCeiling !== undefined) executionToolPolicies.set(policy, combined);
  return policy;
}
