/**
 * Contract test for CAP-073: assistant content empty guard (Kimi 400 protection)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-073-assistant-content-empty-guard-kimi-400-protection
 *
 * Test obligations:
 * - CAP-EMPTY-CONTENT-GUARD-001: zero-text + zero-visible-tool yields '...' placeholder
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent.ts:2321-2327
 *
 * Time-ordering constraint: BEFORE pushing assistant message into history.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { guardEmptyAssistantContent } from '../assistant-message-builder.js';

describe('CAP-073: assistant content empty guard contract', () => {
  it.todo('CAP-EMPTY-CONTENT-GUARD-001: when assistant produces zero text and zero visible tool blocks, content is replaced with [{ type: "text", text: "..." }] placeholder');
});
