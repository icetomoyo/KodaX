/**
 * Contract test for CAP-059: compaction trigger decision
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-059-compaction-trigger-decision
 *
 * Test obligations:
 * - CAP-COMPACT-TRIGGER-001: trigger fires at threshold
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1734-1742 (needsCompaction call)
 *
 * Time-ordering constraint: AFTER microcompact (CAP-014); BEFORE intelligentCompact orchestration
 * (CAP-060).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { needsCompaction } from '../compaction-trigger.js';

describe('CAP-059: compaction trigger decision contract', () => {
  it.todo('CAP-COMPACT-TRIGGER-001: needsCompaction returns true when currentTokens exceed compaction threshold derived from contextWindow and compactionConfig');
});
