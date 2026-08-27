/**
 * SDK subpath entry — `@kodax-ai/kodax/coding`
 *
 * Re-exports the entire `@kodax-ai/coding` public API — coding tools,
 * prompts, AMA harness primitives, child task dispatch, idle-yield
 * orchestration, etc.
 *
 * Note: the root entry `@kodax-ai/kodax` already does `export * from
 * '@kodax-ai/coding'` for backward compatibility with v0.7.38's single-
 * entry model. This subpath is provided as a tree-shake-friendly
 * alternative when SDK consumers only need coding-package APIs.
 *
 * Usage:
 * ```ts
 * import { runKodaX, dispatchChildTask } from '@kodax-ai/kodax/coding';
 * ```
 *
 * See docs/ADR.md ADR-024 for the SDK formalization decision.
 */

export * from '@kodax-ai/coding';
export {
  Client,
  createDefaultCodingAgent,
  createKodaXTaskRunner,
  KodaXClient,
  runKodaX,
  runManagedTask,
  startKodaX,
} from './trusted-coding-entry.js';
