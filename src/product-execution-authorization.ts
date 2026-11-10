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
  /** Captures the original authenticated Main connection, never a timeout heuristic. */
  readonly bindingAvailable?: () => boolean;
  readonly principalId?: string;
  readonly sessionId?: string;
  /** Fresh Host-default admission for a different Session on this same connection. */
  readonly defaultForSession?: (sessionId: string) => ProductExecutionContext;
  readonly assertAdmission?: () => void;
  readonly bindRun: (input: RuntimeStartRunInput, runId: string, baseRuntime?: ExtensionRuntimeContract) => Promise<RuntimeStartRunInput>;
}

export function productExecutionIntentKey(context: ProductExecutionContext | undefined): string | undefined {
  return context?.intentKey ?? context?.key;
}

/** Replacing a connection cannot remove a mode constraint committed with pending intent. */
export function retainExecutionWorkMode(context: ProductExecutionContext | undefined,
  required: RuntimeExecutionProfile['requiredWorkMode']): ProductExecutionContext | undefined {
  if (context === undefined || required === undefined) return context;
  return { ...context, profile: { ...context.profile, requiredWorkMode: required },
    ...(context.resolve === undefined ? {} : { resolve: async (request: RuntimeExecutionBindingRequest, signal?: AbortSignal) =>
      retainExecutionWorkMode(await context.resolve!(request, signal), required)! }),
    bindRun: async (input, runId, baseRuntime) => {
      const bound = await context.bindRun(input, runId, baseRuntime);
      return { ...bound, options: { ...bound.options, executionWorkMode: required } };
    } };
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
