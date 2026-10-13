import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { ExtensionExecutionScope, ExtensionToolResult, ManagedProcessInput } from './execution-contract.js';
export type { ManagedProcessInput } from './execution-contract.js';

interface BoundProcess extends ManagedProcessInput { readonly descriptor: string }
const processes = new AsyncLocalStorage<BoundProcess>();

/** Trusted host-only argv binding; model JSON never supplies process authority. */
export function executeManagedProcess(scope: ExtensionExecutionScope, input: ManagedProcessInput): Promise<ExtensionToolResult> {
  return scope.executeProcess ? scope.executeProcess(input) : executeBoundManagedProcess(scope, input);
}
/** Called in the Host's module instance, including when the extension uses another bundle. */
export function executeBoundManagedProcess(scope: ExtensionExecutionScope, input: ManagedProcessInput): Promise<ExtensionToolResult> {
  if (!path.isAbsolute(input.executable) || input.executable.includes('\0')) {
    throw new Error('Managed executable must be an absolute path.');
  }
  if (input.args.length > 128 || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 32_768)) {
    throw new Error('Invalid managed process arguments.');
  }
  const timeoutSeconds = input.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error('Invalid managed process timeout.');
  const args = Object.freeze([...input.args]);
  const descriptor = 'Fixed argv: ' + JSON.stringify([input.executable, ...args]);
  const bound = Object.freeze({ executable: input.executable, args, timeoutSeconds, descriptor });
  if (scope.signal.aborted) return Promise.resolve('[Cancelled] Managed process was not started.');
  return processes.run(bound, () => scope.invokeTool('bash', {
    command: descriptor, timeout: timeoutSeconds, run_in_background: false,
  }));
}

/** Only the exact checked Bash call may consume the host binding. */
export function getManagedProcessInvocation(command: string): ManagedProcessInput | undefined {
  const bound = processes.getStore();
  if (!bound) {
    if (command.startsWith('Fixed argv: ')) throw new Error('Managed process binding is missing from the admitted Host scope.');
    return undefined;
  }
  if (command !== bound.descriptor) throw new Error('Managed process descriptor changed during admission.');
  return bound;
}
