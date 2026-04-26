/**
 * Contract test for CAP-071: non-streaming fallback path
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-071-non-streaming-fallback-path
 *
 * Test obligations:
 * - CAP-NON-STREAM-FB-001: provider that returns same shape works via complete() call
 * - CAP-NON-STREAM-FB-002: fallback failure rolls back into retry pipeline
 * - CAP-NON-STREAM-FB-003: independent timer clears stream timers before fallback
 *
 * Risk: HIGH (provider semantics differ between stream / complete; tool dispatch must work identically)
 *
 * Class: 1
 *
 * Verified location: agent.ts:2127-2189 (full fallback block including independent fallbackHardTimer)
 *
 * Time-ordering constraint: WITHIN catch block; clears stream timers before fallback;
 * on fallback failure, error propagates back into recovery pipeline (CAP-069).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { executeNonStreamingFallback } from '../non-streaming-fallback.js';

describe('CAP-071: non-streaming fallback path contract', () => {
  it.todo('CAP-NON-STREAM-FB-001: provider that supports supportsNonStreamingFallback() returns same KodaXStreamResult shape via complete() call');
  it.todo('CAP-NON-STREAM-FB-002: fallback failure rolls error back into the recovery pipeline (CAP-069) for further retry decisions');
  it.todo('CAP-NON-STREAM-FB-003: independent fallbackHardTimer is armed and stream timers are cleared before fallback completes() is called');
});
