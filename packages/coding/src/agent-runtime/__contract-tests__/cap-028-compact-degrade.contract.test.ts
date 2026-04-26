/**
 * Contract test for CAP-028: graceful compaction degradation
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-028-graceful-compaction-degradation
 *
 * Test obligations:
 * - CAP-COMPACT-DEGRADE-001: LLM compaction failure falls through to truncation
 *
 * Risk: MEDIUM (interacts with FEATURE_072 lineage compaction)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/compaction-fallback.ts (extracted from
 * agent.ts:201-266 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER primary compaction failure; BEFORE
 * next provider call.
 *
 * Active here: the truncation strategy invariants —
 *   1. Summary preservation (system OR `[对话历史摘要]` user message at
 *      index 0 is never dropped).
 *   2. Tool pairing invariant — `tool_use` (assistant) and `tool_result`
 *      (user) must stay paired; orphans are skipped, not dropped.
 *   3. Recent-context preservation — loop terminates as soon as token
 *      estimate dips below `triggerPercent * 80%` of the context window.
 *
 * Deferred (P3 — needs primary-compactor mock + warning emission):
 * - CAP-COMPACT-DEGRADE-001 end-to-end "primary fails → fallback fires
 *   + warning emitted" requires the primary compactor (FEATURE_072
 *   `intelligentCompact`) to be mockable from a Runner-frame fixture;
 *   that wiring lives in the call site at agent.ts (currently around
 *   `runKodaX`'s compaction branch). The unit-level invariants of the
 *   fallback function itself are pinned here.
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the truncation invariants.
 */

import type { KodaXMessage } from '@kodax/ai';
import type { CompactionConfig } from '@kodax/agent';
import { describe, expect, it } from 'vitest';

import { gracefulCompactDegradation } from '../compaction-fallback.js';

function config(triggerPercent = 80): CompactionConfig {
  return { enabled: true, triggerPercent } as CompactionConfig;
}

function userMsg(content: string): KodaXMessage {
  return { role: 'user', content };
}

function systemMsg(content: string): KodaXMessage {
  return { role: 'system', content };
}

function toolUseMsg(id: string): KodaXMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'tool_use', id, name: 'read', input: {} },
    ],
  } as unknown as KodaXMessage;
}

function toolResultMsg(toolUseId: string, content = 'ok'): KodaXMessage {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: toolUseId, content },
    ],
  } as unknown as KodaXMessage;
}

describe('CAP-028: gracefulCompactDegradation — termination + identity', () => {
  it('CAP-COMPACT-DEGRADE-IDENTITY: when token estimate is already under target, the function is identity (no drops)', () => {
    const messages: KodaXMessage[] = [userMsg('hi'), userMsg('there')];
    // Huge context window → target tokens is much higher than the
    // tiny input → loop never enters.
    const result = gracefulCompactDegradation(messages, 1_000_000, config(80));
    expect(result).toEqual(messages);
  });

  it('CAP-COMPACT-DEGRADE-EMPTY: empty messages array → empty output (no infinite loop)', () => {
    expect(gracefulCompactDegradation([], 1024, config())).toEqual([]);
  });
});

describe('CAP-028: gracefulCompactDegradation — summary preservation invariant', () => {
  it('CAP-COMPACT-DEGRADE-SYSTEM: a leading system message is never the first to be dropped (startIdx=1)', () => {
    const long = 'x'.repeat(500);
    const messages: KodaXMessage[] = [
      systemMsg('SYSTEM-PROMPT'),
      userMsg(long),
      userMsg(long),
      userMsg(long),
    ];
    // Tiny context window forces aggressive trimming.
    const result = gracefulCompactDegradation(messages, 100, config(80));

    // The system message MUST survive even after aggressive truncation.
    expect(result[0]).toEqual({ role: 'system', content: 'SYSTEM-PROMPT' });
  });

  it('CAP-COMPACT-DEGRADE-LINEAGE-MARKER: a leading user message containing `[对话历史摘要]` is treated as a summary and preserved', () => {
    const long = 'y'.repeat(500);
    const messages: KodaXMessage[] = [
      userMsg('[对话历史摘要] previous turns folded'),
      userMsg(long),
      userMsg(long),
      userMsg(long),
    ];
    const result = gracefulCompactDegradation(messages, 100, config(80));
    expect(result[0]?.content).toContain('[对话历史摘要]');
  });
});

describe('CAP-028: gracefulCompactDegradation — tool-pairing invariant', () => {
  it('CAP-COMPACT-DEGRADE-PAIR-FORWARD: assistant(tool_use) followed by user(tool_result) is dropped as a pair', () => {
    const long = 'z'.repeat(500);
    const messages: KodaXMessage[] = [
      toolUseMsg('t1'),
      toolResultMsg('t1'),
      userMsg(long),
      userMsg(long),
    ];
    const result = gracefulCompactDegradation(messages, 100, config(80));

    // Both members of the pair are gone.
    expect(result.find((m) =>
      Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string }).type === 'tool_use'),
    )).toBeUndefined();
    expect(result.find((m) =>
      Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string }).type === 'tool_result'),
    )).toBeUndefined();
  });

  it('CAP-COMPACT-DEGRADE-PAIR-BACKWARD: user(tool_result) at dropIdx with assistant(tool_use) immediately before → both dropped as a pair (backward branch)', () => {
    // The forward branch handles assistant(tool_use) at dropIdx, the
    // backward branch handles user(tool_result) at dropIdx whose paired
    // assistant precedes it. We exercise the backward branch directly
    // by placing a non-tool message at dropIdx=startIdx, so the loop
    // first hits the non-tool drop, advances, and then encounters the
    // tool_result whose paired assistant is at dropIdx-1.
    const long = 'b'.repeat(500);
    const messages: KodaXMessage[] = [
      userMsg('lead'),               // dropped first (non-tool, individual)
      toolUseMsg('t1'),              // becomes dropIdx-1 after lead drop
      toolResultMsg('t1'),           // backward-pair drop with the tool_use above
      userMsg(long),
      userMsg(long),
    ];
    const result = gracefulCompactDegradation(messages, 100, config(80));

    // Both members of the backward-detected pair are gone.
    expect(result.find((m) =>
      Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string }).type === 'tool_use'),
    )).toBeUndefined();
    expect(result.find((m) =>
      Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string }).type === 'tool_result'),
    )).toBeUndefined();
  });

  it('CAP-COMPACT-DEGRADE-ORPHAN-SKIP: an orphan tool_use (no matching following tool_result) is SKIPPED, not dropped — preserves provider 400-error invariant', () => {
    const long = 'w'.repeat(500);
    const messages: KodaXMessage[] = [
      toolUseMsg('orphan-1'),     // orphan: no following tool_result
      userMsg('plain user msg 1'),
      userMsg(long),
      userMsg(long),
    ];
    const result = gracefulCompactDegradation(messages, 100, config(80));

    // The orphan tool_use survives because the loop skipped past it
    // rather than dropping it (which would have orphaned the provider
    // request envelope).
    expect(result.find((m) =>
      Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string; id?: string }).id === 'orphan-1'),
    )).toBeDefined();
  });
});
