/**
 * Contract test for CAP-061: post-compact attachment construction + injection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-061-post-compact-attachment-construction--injection
 *
 * Test obligations:
 * - CAP-POST-COMPACT-001: budget allocated correctly
 * - CAP-POST-COMPACT-002: file content fits within remaining budget
 * - CAP-POST-COMPACT-003: lineage attachments populated for FEATURE_072
 *
 * Risk: MEDIUM (interacts with FEATURE_072 lineage compaction post-compact attachments)
 *
 * Class: 1
 *
 * Verified location: agent.ts:1761-1804 (construction); :1797 (injectPostCompactAttachments call)
 *
 * Time-ordering constraint: WITHIN compact orchestration, AFTER intelligentCompact returns success;
 * BEFORE setting compacted.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildPostCompactAttachments, injectPostCompactAttachments } from '../middleware/post-compact-attachments.js';

describe('CAP-061: post-compact attachment construction + injection contract', () => {
  it.todo('CAP-POST-COMPACT-001: totalPostCompactBudget = min(freedTokens × budgetRatio, POST_COMPACT_TOKEN_BUDGET) allocated correctly');
  it.todo('CAP-POST-COMPACT-002: file content messages fit within remaining budget after ledger attachment claims its share');
  it.todo('CAP-POST-COMPACT-003: postCompactAttachmentsForLineage is populated in compactionUpdate for FEATURE_072 lineage consumption');
});
