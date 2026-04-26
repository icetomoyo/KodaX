/**
 * Contract test for CAP-054: extension event lifecycle (emitActiveExtensionEvent)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-054-extension-event-lifecycle-emitactiveextensionevent
 *
 * Test obligations:
 * - CAP-EXT-EVENTS-001: session:start fires once per frame
 * - CAP-EXT-EVENTS-002: turn:start/turn:end are paired per turn
 * - CAP-EXT-EVENTS-003: delta events fire during stream
 * - CAP-EXT-EVENTS-004: complete fires on every terminal
 *
 * Risk: MEDIUM (extension contract — third-party extensions depend on event names + arg shapes)
 *
 * Class: 1
 *
 * Verified location: agent.ts:1678 (session:start), :1722 (turn:start), :1938 (provider:selected),
 * :2046 (text:delta), :2052 (thinking:delta), :2057 (thinking:end), :2067 (provider:rate-limit),
 * :2241 (stream:end), :2270/2281 (turn:end), :2289 (complete)
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { emitActiveExtensionEvent } from '../extension-event-bridge.js';

describe('CAP-054: extension event lifecycle contract', () => {
  it.todo('CAP-EXT-EVENTS-001: session:start fires exactly once per Runner frame entry (before first turn)');
  it.todo('CAP-EXT-EVENTS-002: turn:start and turn:end are paired for each turn (N turns → N start + N end)');
  it.todo('CAP-EXT-EVENTS-003: text:delta, thinking:delta, thinking:end extension events fire during provider stream');
  it.todo('CAP-EXT-EVENTS-004: complete extension event fires on every terminal path (success / cancellation / error)');
});
