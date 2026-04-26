/**
 * Contract test for CAP-095: child-executor SA invocation contract
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-095-child-executor-sa-invocation-contract
 *
 * Test obligations:
 * - CAP-CHILD-EXEC-001: read child uses agentMode:'sa' and excludes write tools
 * - CAP-CHILD-EXEC-002: write child has isolated worktree
 * - CAP-CHILD-EXEC-003: post-FEATURE_100: child enters Runner frame with full substrate
 *
 * Risk: HIGH (subagent fan-out is the second consumer of substrate after main SA path; must enter Runner frame after FEATURE_100)
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:31-67 (lazy-import bridge getRunKodaX); :196-241 (executeReadChild); :243-... (executeWriteChild)
 *
 * Time-ordering constraint: triggered mid-turn during parent's tool dispatch; child runs to completion before parent's tool result is built.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { executeReadChild, executeWriteChild } from '../../child-executor.js';

describe('CAP-095: child-executor SA invocation contract', () => {
  it.todo('CAP-CHILD-EXEC-001: executeReadChild invokes SA with agentMode: "sa", systemPromptOverride: CHILD_AGENT_SYSTEM_PROMPT, and excludeTools set to CHILD_EXCLUDE_TOOLS_READONLY (no write tools in read child)');
  it.todo('CAP-CHILD-EXEC-002: executeWriteChild creates an isolated worktree with its own executionCwd, gitRoot, and backups before invoking SA (write child is worktree-isolated)');
  it.todo('CAP-CHILD-EXEC-003: post-FEATURE_100 child enters Runner frame (Runner.run(defaultCodingAgent, briefing, ...)) rather than calling runKodaX directly — full substrate including provider loop, microcompact, edit recovery');
});
