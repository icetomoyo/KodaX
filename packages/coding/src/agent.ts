/**
 * KodaX Agent — public re-export shim post-FEATURE_100 P3.6r.
 *
 * The substrate executor body lives in
 * `agent-runtime/run-substrate.ts`. This module is preserved as a
 * thin re-export so SDK consumers (`from '@kodax/coding/agent.js'`)
 * and internal callers (`./agent.js`) see no API break.
 *
 * Re-exports below mirror the public surface that pre-FEATURE_100
 * `agent.ts` exposed:
 *   - `runKodaX` — the substrate entry function.
 *   - Capability-specific helpers that historically lived in agent.ts
 *     and were moved into agent-runtime/ during P2/P3; these stay
 *     re-exported here for the same backward-compat reason.
 */

export { runKodaX } from './agent-runtime/run-substrate.js';

export { buildAutoRepoIntelligenceContext } from './agent-runtime/middleware/repo-intelligence.js';
export {
  estimateProviderPayloadBytes,
  bucketProviderPayloadSize,
} from './agent-runtime/provider-payload.js';
export { checkPromiseSignal } from './agent-runtime/thinking-mode-replay.js';
export { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
export { saveSessionSnapshot } from './agent-runtime/middleware/session-snapshot.js';
export { describeTransientProviderRetry } from './agent-runtime/provider-retry-policy.js';
export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './agent-runtime/history-cleanup.js';
