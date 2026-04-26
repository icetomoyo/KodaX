/**
 * Contract test for CAP-043: autoResume session discovery
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-043-autoresume-session-discovery
 *
 * Test obligations:
 * - CAP-AUTO-RESUME-001: autoResume picks most recent session when no id given
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1464-1474
 *
 * Time-ordering constraint: BEFORE session loading (CAP-045); AFTER initial provider resolution.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { autoResumeSessionDiscovery } from '../middleware/auto-resume.js';

describe('CAP-043: autoResume session discovery contract', () => {
  it.todo('CAP-AUTO-RESUME-001: when autoResume is set and no explicit session.id provided, picks sessions[0].id from storage.list()');
});
