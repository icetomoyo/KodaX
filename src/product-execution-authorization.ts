import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeStartRunInput } from './sdk-runtime.js';
import type { ExtensionRuntimeContract } from '@kodax-ai/coding';
import type { ClientSubmitInput } from '@kodax-ai/coding/client-contract';
import type { RuntimeExecutionAuthorization, RuntimeExecutionBindingRequest, RuntimeExecutionBindingSnapshot, RuntimeExecutionProfile } from './client-host-authorization.js';

/** Captured explicitly by the queue. ALS carries it through the Host admission paths. */
export interface ProductExecutionContext {
  readonly defaultSkill?: import('./client-host-authorization.js').RuntimeDefaultSkill;
  readonly key?: string;
  readonly intentKey?: string;
  readonly profile?: RuntimeExecutionProfile;
  readonly authorization?: RuntimeExecutionAuthorization;
  readonly bindingSnapshot?: RuntimeExecutionBindingSnapshot;
  readonly resolve?: (request: RuntimeExecutionBindingRequest, signal?: AbortSignal) => Promise<ProductExecutionContext>;
  readonly principalId?: string;
  readonly sessionId?: string;
  readonly assertAdmission?: () => void;
  readonly bindRun: (input: RuntimeStartRunInput, runId: string, baseRuntime?: ExtensionRuntimeContract) => Promise<RuntimeStartRunInput>;
}

export function productExecutionIntentKey(context: ProductExecutionContext | undefined): string | undefined {
  return context?.intentKey ?? context?.key;
}

export async function resolveProductExecution(input: ClientSubmitInput, context: ProductExecutionContext | undefined,
  signal?: AbortSignal): Promise<ProductExecutionContext | undefined> {
  return context?.resolve === undefined ? context : context.resolve({ phase: 'admission', sessionId: input.sessionId,
    input: structuredClone(input) }, signal);
}

const execution = new AsyncLocalStorage<ProductExecutionContext | undefined>();

export function currentProductExecution(): ProductExecutionContext | undefined {
  return execution.getStore();
}

export function withProductExecution<T>(context: ProductExecutionContext | undefined, action: () => T): T {
  return execution.run(context, action);
}
