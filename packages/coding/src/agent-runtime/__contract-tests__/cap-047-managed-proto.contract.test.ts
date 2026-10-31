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
 *   managed-protocol-emitting tool; active in agent.managed-protocol-terminals.test.ts).
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: managed-protocol.ts:29 (mergeManagedProtocolPayload).
 * The agent.ts call sites (init, callback, finalize) thread this merge
 * through `turnState.managedProtocolPayload` — that integration is
 * pinned by the public terminal matrix in CAP-MANAGED-PROTO-002.
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
  });

  it('CAP-MANAGED-PROTO-001b: a later verdict merge overrides earlier sibling fields and preserves prior values when patch is partial', () => {
    // FEATURE_193 (v0.7.43) deep V1 cleanup: the V1 scout/contract/handoff
    // slices were physically removed from `KodaXManagedProtocolPayload`,
    // so the accumulation contract is now exercised entirely through the
    // single surviving `verdict` slot — successive emissions either
    // override or extend the verdict fields. The covering contract for
    // partial-patch override is in CAP-MANAGED-PROTO-001c below; this
    // pins the "second emission lands cleanly on top of the first" path.
    let payload: KodaXManagedProtocolPayload | undefined;
    payload = mergeManagedProtocolPayload(payload, {
      verdict: { source: 'evaluator', status: 'revise', followups: [], userFacingText: 'first take' },
    });
    payload = mergeManagedProtocolPayload(payload, {
      verdict: { source: 'evaluator', status: 'accept', followups: [], userFacingText: 'second take' },
    });
    expect(payload?.verdict?.status).toBe('accept');
    expect(payload?.verdict?.userFacingText).toBe('second take');
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

  // CAP-MANAGED-PROTO-002: agent.managed-protocol-terminals.test.ts exercises
  // public runKodaX completion/error/abort/iteration-limit results after real
  // extension-tool emissions. It preserves compatibility without V1 role calls.
});
