/**
 * Contract test for CAP-067: stream call event handler wiring
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-067-stream-call-event-handler-wiring
 *
 * Test obligations:
 * - CAP-STREAM-HANDLERS-001: text-delta fans to all 3 sinks (consumer events, extension events, boundary tracker)
 * - CAP-STREAM-HANDLERS-002: heartbeat-pause clears idle without reset
 *
 * Risk: HIGH (wide event surface; consumers and extensions both depend on these events)
 *
 * Class: 1
 *
 * Verified location: agent.ts:2036-2089 (stream call with handler block)
 *
 * Time-ordering constraint: per-event during stream.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildStreamHandlerBlock } from '../stream-handler-wiring.js';

describe('CAP-067: stream call event handler wiring contract', () => {
  it.todo('CAP-STREAM-HANDLERS-001: onTextDelta fans to events.onTextDelta + boundaryTracker.markTextDelta + text:delta extension event + idle reset');
  it.todo('CAP-STREAM-HANDLERS-002: onHeartbeat with pause:true clears idle timer but does NOT call resetIdleTimer');
});
