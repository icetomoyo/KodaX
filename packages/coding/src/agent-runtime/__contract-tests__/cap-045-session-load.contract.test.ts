/**
 * Contract test for CAP-045: session loading + post-load message normalization
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-045-session-loading--post-load-message-normalization
 *
 * Test obligations:
 * - CAP-SESSION-LOAD-001: clean session load produces expected messages + metadata fields
 * - CAP-SESSION-LOAD-002: FEATURE_076 normalization drops worker-trace tails from pre-v0.7.25 sessions
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1489-1500 (load + normalize)
 *
 * Time-ordering constraint: AFTER session id resolution; BEFORE first user message push.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { loadSession } from '../middleware/auto-resume.js';

describe('CAP-045: session loading + post-load message normalization contract', () => {
  it.todo('CAP-SESSION-LOAD-001: clean session storage.load() yields expected messages, title, errorMetadata, and extension state fields');
  it.todo('CAP-SESSION-LOAD-002: FEATURE_076 normalizeLoadedSessionMessages drops trailing role-prompt-shaped worker pairs from pre-v0.7.25 sessions');
});
