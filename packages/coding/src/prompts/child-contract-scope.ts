import { AsyncLocalStorage } from 'node:async_hooks';

export interface BuiltinChildContractSource {
  readonly agentId: string;
  readonly system: string;
}

const childContractScope = new AsyncLocalStorage<{
  source: BuiltinChildContractSource | undefined;
  claimed: boolean;
}>();

/** Private executor provenance. Undefined explicitly masks a parent's source. */
export function withBuiltinChildContract<T>(source: BuiltinChildContractSource | undefined, run: () => T): T {
  return childContractScope.run({ source, claimed: false }, run);
}

/** One substrate owns the scope; nested SDK calls cannot inherit its projection. */
export function claimBuiltinChildContract(context: {
  currentAgentId?: string;
  systemPromptOverride?: string;
  agentProfile?: unknown;
  toolVisibilityPolicy?: unknown;
} | undefined): BuiltinChildContractSource | undefined {
  const scope = childContractScope.getStore();
  if (!scope || scope.claimed) return undefined;
  scope.claimed = true;
  const source = scope.source;
  return source && context?.currentAgentId === source.agentId && context.systemPromptOverride === source.system
    && !context.agentProfile && !context.toolVisibilityPolicy ? source : undefined;
}
