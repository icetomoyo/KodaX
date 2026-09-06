import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Host context bound to in-flight MCP client requests. A server may send a
 * reverse request (elicitation, roots, sampling) while host requests are
 * pending; the runtime re-enters the captured context when dispatching them
 * so the host attributes the request to the caller that triggered it. The
 * context is opaque to the MCP layer.
 */
const mcpCallContext = new AsyncLocalStorage<unknown>();

/** Run an operation with a host call context that MCP reverse requests inherit. */
export function runWithMcpCallContext<T>(context: unknown, operation: () => T): T {
  return mcpCallContext.run(context, operation);
}

/** The active host call context, when dispatched inside one. */
export function getActiveMcpCallContext(): unknown {
  return mcpCallContext.getStore();
}
