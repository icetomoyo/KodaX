/**
 * Transient provider retry description — CAP-031
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-031-transient-provider-retry-description
 *
 * Class 1 (substrate middleware). Maps a `Error` thrown by a provider
 * stream into a short, human-readable retry-reason string suitable for
 * the resilience-retry banner shown in the REPL (and consumed by
 * `runner-driven.ts` for the same purpose).
 *
 * The classification is by error name + lower-cased message-substring
 * matching, in the original priority order:
 *   1. `StreamIncompleteError` / `'stream incomplete'`
 *   2. `'stream stalled'` / `'delayed response'` / `'60s idle'`
 *   3. `'hard timeout'` / `'10 minutes'`
 *   4. network-class substrings (socket hang up, ECONNREFUSED, ENOTFOUND,
 *      fetch failed, network)
 *   5. timeout-class substrings (`'timed out'`, `'timeout'`, `'etimedout'`)
 *   6. `'aborted'`
 *   7. fallthrough → `'Transient provider error'`
 *
 * The fall-through label is what shows up if the classifier doesn't
 * match — it's intentionally generic so the banner stays useful when
 * a provider invents a new error string.
 *
 * Migration history: extracted from `agent.ts:287-315` (pre-FEATURE_100
 * baseline) during FEATURE_100 P2.
 *
 * Re-exported from `agent.ts` so `task-engine/runner-driven.ts:67` (and
 * its retry-banner emission at `runner-driven.ts:2592`) keeps working
 * with the original import path.
 */

export function describeTransientProviderRetry(error: Error): string {
  const message = error.message.toLowerCase();
  if (error.name === 'StreamIncompleteError' || message.includes('stream incomplete')) {
    return 'Stream interrupted before completion';
  }
  if (message.includes('stream stalled') || message.includes('delayed response') || message.includes('60s idle')) {
    return 'Stream stalled';
  }
  if (message.includes('hard timeout') || message.includes('10 minutes')) {
    return 'Provider response timed out';
  }
  if (
    message.includes('socket hang up')
    || message.includes('connection error')
    || message.includes('econnrefused')
    || message.includes('enotfound')
    || message.includes('fetch failed')
    || message.includes('network')
  ) {
    return 'Provider connection error';
  }
  if (message.includes('timed out') || message.includes('timeout') || message.includes('etimedout')) {
    return 'Provider request timed out';
  }
  if (message.includes('aborted')) {
    return 'Provider stream aborted';
  }
  return 'Transient provider error';
}
