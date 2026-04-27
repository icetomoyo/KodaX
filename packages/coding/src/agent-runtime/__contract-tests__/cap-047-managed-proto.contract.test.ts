/**
 * Contract test for CAP-047: managed protocol payload merge lifecycle
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-047-managed-protocol-payload-merge-lifecycle
 *
 * Test obligations:
 * - CAP-MANAGED-PROTO-001: merge accumulates across multiple
 *   emit_managed_protocol calls (FUNCTION-LEVEL — active here against
 *   `mergeManagedProtocolPayload`).
 * - CAP-MANAGED-PROTO-002: terminal path includes merged payload in
 *   result (INTEGRATION-LEVEL — depends on running runKodaX with a
 *   managed-protocol-emitting tool; deferred to substrate-executor
 *   migration when steps can be tested in isolation).
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: managed-protocol.ts:29 (mergeManagedProtocolPayload).
 * The agent.ts call sites (init, callback, finalize) thread this merge
 * through `turnState.managedProtocolPayload` — that integration is
 * pinned by CAP-MANAGED-PROTO-002 once it's activable.
 *
 * Time-ordering constraint: emit per tool call; merge cumulatively;
 * finalize at every terminal return path.
 *
 * STATUS: ACTIVE-PARTIAL since FEATURE_100 P3.6k.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXManagedProtocolPayload } from '../../types.js';
import { mergeManagedProtocolPayload } from '../../managed-protocol.js';

describe('CAP-047: managed protocol payload merge lifecycle contract', () => {
  it('CAP-MANAGED-PROTO-001a: merging onto undefined base seeds the payload from the patch', () => {
    const patch: Partial<KodaXManagedProtocolPayload> = {
      verdict: { source: 'evaluator', status: 'accept', followups: [], userFacingText: 'all good' },
    };
    const merged = mergeManagedProtocolPayload(undefined, patch);
    expect(merged?.verdict?.status).toBe('accept');
    expect(merged?.verdict?.userFacingText).toBe('all good');
    expect(merged?.scout).toBeUndefined();
  });

  it('CAP-MANAGED-PROTO-001b: successive merges accumulate sibling sections (verdict + scout + contract + handoff)', () => {
    let payload: KodaXManagedProtocolPayload | undefined;
    payload = mergeManagedProtocolPayload(payload, {
      verdict: { source: 'evaluator', status: 'accept', followups: [], userFacingText: 'done' },
    });
    payload = mergeManagedProtocolPayload(payload, {
      scout: { summary: 'scouting complete', scope: [], requiredEvidence: [] },
    });
    payload = mergeManagedProtocolPayload(payload, {
      contract: { summary: 'investigate', successCriteria: [], requiredEvidence: [], constraints: [] },
    });
    expect(payload?.verdict?.status).toBe('accept');
    expect(payload?.scout?.summary).toBe('scouting complete');
    expect(payload?.contract?.summary).toBe('investigate');
    expect(payload?.handoff).toBeUndefined();
  });

  it('CAP-MANAGED-PROTO-001c: a later patch overrides matching fields within a section but preserves siblings', () => {
    let payload: KodaXManagedProtocolPayload | undefined = {
      verdict: { source: 'evaluator', status: 'revise', followups: [], userFacingText: 'first text' },
    };
    payload = mergeManagedProtocolPayload(payload, {
      verdict: { status: 'accept' } as Partial<KodaXManagedProtocolPayload['verdict']> as KodaXManagedProtocolPayload['verdict'],
    });
    // status was overridden; userFacingText preserved (sibling field)
    expect(payload?.verdict?.status).toBe('accept');
    expect(payload?.verdict?.userFacingText).toBe('first text');
  });

  it('CAP-MANAGED-PROTO-001d: merging undefined onto undefined returns undefined (no synthetic empty payload)', () => {
    expect(mergeManagedProtocolPayload(undefined, undefined)).toBeUndefined();
  });

  it.todo(
    'CAP-MANAGED-PROTO-002: every terminal return path of runKodaX includes the merged managedProtocolPayload in the result — INTEGRATION-LEVEL, deferred until substrate-executor migration extracts the per-step pipeline so terminals can be exercised in isolation.',
  );
});
