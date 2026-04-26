/**
 * Contract test for CAP-094: default coding agent declaration constructor
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-094-default-coding-agent-declaration-constructor
 *
 * Test obligations:
 * - CAP-DEFAULT-AGENT-001: declaration has expected name + middleware defaults
 * - CAP-DEFAULT-AGENT-002: overrides preserved
 *
 * Risk: MEDIUM (post-FEATURE_100 this becomes the canonical SA Agent declaration; FEATURE_078 v0.7.30 layers reasoning profile on top via overrides)
 *
 * Class: 1
 *
 * Verified location: coding-preset.ts:125-133 (createDefaultCodingAgent)
 *
 * Time-ordering constraint: at SDK entry or substrate frame initialization.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { createDefaultCodingAgent } from '../../agents/default-coding-agent.js';

describe('CAP-094: default coding agent declaration constructor contract', () => {
  it.todo('CAP-DEFAULT-AGENT-001: createDefaultCodingAgent() returns Agent with name "kodax/coding/default" and middleware defaults including auto-reroute, mutation-reflection, pre-answer-judge, and post-tool-judge enabled');
  it.todo('CAP-DEFAULT-AGENT-002: overrides passed to createDefaultCodingAgent are preserved in the returned Agent (e.g. reasoning profile, guardrails, custom middleware)');
});
