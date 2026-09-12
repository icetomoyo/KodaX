import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExtensionExecutionScope } from './execution-contract.js';

const invocations = new AsyncLocalStorage<ExtensionExecutionScope>();

export function getExtensionExecutionScope(extensionId?: string): ExtensionExecutionScope | undefined {
  const scope = invocations.getStore();
  return extensionId === undefined || scope?.extensionId === extensionId ? scope : undefined;
}

/** Join even unawaited managed tool effects before the contribution settles. */
export async function withExtensionExecutionScope<T>(
  bindings: ExtensionExecutionScope,
  execute: (scope: ExtensionExecutionScope) => Promise<T>,
): Promise<T> {
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  let open = true;
  const scope: ExtensionExecutionScope = Object.freeze({
    ...bindings,
    reportProgress: (progress: Parameters<ExtensionExecutionScope['reportProgress']>[0]) => {
      if (!open) throw new Error('Extension invocation is closed; progress cannot be published.');
      bindings.reportProgress(progress);
    },
    invokeTool: (name: string, input: Record<string, unknown>) => {
      if (!open || bindings.signal.aborted) {
        return Promise.resolve('[Cancelled] Extension invocation is no longer accepting effects.');
      }
      const operation = Promise.resolve().then(() => bindings.invokeTool(name, input));
      pending.add(operation);
      void operation.then(() => { pending.delete(operation); }, (error: unknown) => {
        failures.push(error);
        pending.delete(operation);
      });
      return operation;
    },
  });
  return invocations.run(scope, async () => {
    try { return await execute(scope); }
    finally {
      open = false;
      await Promise.allSettled([...pending]);
      if (failures.length > 0) throw failures[0];
    }
  });
}
