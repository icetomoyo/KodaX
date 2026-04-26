/**
 * Contract test for CAP-074: L5 max_tokens continuation
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-074-l5-max_tokens-continuation
 *
 * Test obligations:
 * - CAP-MAX-TOKENS-CONT-001: synthetic continuation message uses "resume mid-thought" wording
 * - CAP-MAX-TOKENS-CONT-002: skipped when tool_blocks present
 * - CAP-MAX-TOKENS-CONT-003: 3-retry cap enforced
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:2332-2364
 *
 * Time-ordering constraint: AFTER assistant push to history; BEFORE next turn.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handleMaxTokensContinuation } from '../max-tokens-continuation.js';

describe('CAP-074: L5 max_tokens continuation contract', () => {
  it.todo('CAP-MAX-TOKENS-CONT-001: synthetic user message on max_tokens retry instructs "Resume directly — no apology, no recap... pick up mid-thought... break remaining work into smaller pieces"');
  it.todo('CAP-MAX-TOKENS-CONT-002: continuation branch is skipped when result.toolBlocks is non-empty (partial-json salvage handles next turn naturally)');
  it.todo('CAP-MAX-TOKENS-CONT-003: KODAX_MAX_MAXTOKENS_RETRIES = 3 cap enforced; after exhaustion falls through to text-only response handling');
});
