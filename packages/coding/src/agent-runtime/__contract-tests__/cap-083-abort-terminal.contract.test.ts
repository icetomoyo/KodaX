/**
 * Contract test for CAP-083: AbortError silent terminal branch (Gemini CLI parity — interrupt as success)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-083-aborterror-silent-terminal-branch-gemini-cli-parity--interrupt-as-success
 *
 * Test obligations:
 * - CAP-ABORT-TERMINAL-001: Ctrl+C returns success:true with interrupted flag
 * - CAP-ABORT-TERMINAL-002: onStreamEnd fires before return
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:2864-2883
 *
 * Time-ordering constraint: AFTER catch cleanup chain (CAP-082); BEFORE generic error path (CAP-084).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handleAbortTerminal } from '../abort-terminal.js';

describe('CAP-083: AbortError silent terminal branch contract', () => {
  it.todo('CAP-ABORT-TERMINAL-001: caught AbortError returns { success: true, interrupted: true } — NOT success: false (Gemini CLI parity: interrupts are not failures)');
  it.todo('CAP-ABORT-TERMINAL-002: events.onStreamEnd and stream:end extension event are emitted before the AbortError terminal return');
});
