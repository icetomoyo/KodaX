/**
 * SDK subpath entry — `@kodax-ai/kodax/repl`
 *
 * Re-exports the entire `@kodax-ai/repl` public API — full interactive
 * terminal experience built on Ink: `runInkInteractiveMode`, configuration
 * loaders (`loadConfig` / `saveConfig`), session storage primitives,
 * provider resolution, etc.
 *
 * Note: this subpath pulls Ink + React as transitive deps via the
 * `@kodax-ai/repl` package. SDK consumers who only need configuration
 * helpers (no UI) get fine-grained named imports — ESM tree-shaking
 * is friendly to the side-effect-free helper exports.
 *
 * Usage:
 * ```ts
 * import {
 *   loadConfig,
 *   FileSessionStorage,
 *   resolveUserSkillInvocation,
 *   prepareInvocationExecution,
 * } from '@kodax-ai/kodax/repl';
 * ```
 *
 * See docs/ADR.md ADR-024 for the SDK formalization decision.
 */

export * from '@kodax-ai/repl';
export { runInkInteractiveMode, runInteractiveMode } from './trusted-repl-entry.js';

// v0.7.42 — user-defined slash command loader. Lives in this layer (not
// inside @kodax-ai/repl) because it depends on the SDK's `KodaXResult` type
// and is consumed by the bin entry alongside REPL bootstrap.
export {
  loadCommands,
  processCommandCall,
  parseCommandCall,
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  type KodaXCommand,
  type KodaXCommandContext,
} from './cli_commands.js';
