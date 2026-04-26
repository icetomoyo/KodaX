/**
 * Contract test for CAP-066: stream timer infrastructure (hard + idle + stream-max-duration + abort signal composition)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-066-stream-timer-infrastructure-hard--idle--stream-max-duration--abort-signal-composition
 *
 * Test obligations:
 * - CAP-STREAM-TIMERS-001: hard timer fires at 10 min cap
 * - CAP-STREAM-TIMERS-002: idle timer reset by content events but not by heartbeat-pause
 * - CAP-STREAM-TIMERS-003: stream-max-duration aborts before provider kill window
 *
 * Risk: HIGH (timing-sensitive, interacts with provider stream contracts)
 *
 * Class: 1
 *
 * Verified location: agent.ts:1977-1980 (hard timer), :1990-1998 (stream max duration),
 * :2003-2009 (idle timer), :2011-2019 (resetIdleTimer), :2021-2023 (AbortSignal composition)
 *
 * Time-ordering constraint: armed BEFORE stream call; cleared in finally/break paths to avoid
 * stale aborts.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildStreamTimers } from '../stream-timers.js';

describe('CAP-066: stream timer infrastructure contract', () => {
  it.todo('CAP-STREAM-TIMERS-001: hard timer (API_HARD_TIMEOUT_MS = 10 min) fires and aborts the stream via retryTimeoutController');
  it.todo('CAP-STREAM-TIMERS-002: idle timer is reset by content events (text/thinking/tool delta) but NOT reset by heartbeat with pause: true');
  it.todo('CAP-STREAM-TIMERS-003: stream-max-duration from provider fires BEFORE server-side kill window to route through clean fallback path');
});
