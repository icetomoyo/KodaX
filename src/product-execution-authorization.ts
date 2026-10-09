import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeStartRunInput } from './sdk-runtime.js';
import type { ExtensionRuntimeContract } from '@kodax-ai/coding';

/** Captured explicitly by the queue. ALS carries it through the Host admission paths. */
export interface ProductExecutionContext {
  readonly key?: string;
  readonly principalId?: string;
  readonly sessionId?: string;
  readonly assertAdmission?: () => void;
  readonly bindRun: (input: RuntimeStartRunInput, runId: string, baseRuntime?: ExtensionRuntimeContract) => Promise<RuntimeStartRunInput>;
}

const execution = new AsyncLocalStorage<ProductExecutionContext | undefined>();

export function currentProductExecution(): ProductExecutionContext | undefined {
  return execution.getStore();
}

export function withProductExecution<T>(context: ProductExecutionContext | undefined, action: () => T): T {
  return execution.run(context, action);
}
