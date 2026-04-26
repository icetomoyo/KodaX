/**
 * Contract test for CAP-050: RuntimeSessionState construction
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-050-runtimesessionstate-construction
 *
 * Test obligations:
 * - CAP-RUNTIME-STATE-001: initial construction has all expected fields
 *   (queuedMessages, extensionState, activeTools, editRecoveryAttempts,
 *   blockedEditWrites, modelSelection, thinkingLevel)
 * - CAP-RUNTIME-STATE-002: loaded extension records preserved (and cloned)
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/runtime-session-state.ts (extracted from
 * agent.ts:1578-1593 inline construction — pre-FEATURE_100 baseline — during
 * FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER session loading; BEFORE controller bind (CAP-041).
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXJsonValue } from '@kodax/agent';

import {
  buildRuntimeSessionState,
  createRuntimeExtensionState,
  getExtensionStateBucket,
  snapshotRuntimeExtensionState,
} from '../runtime-session-state.js';

type ExtensionStateMap = Map<string, Map<string, KodaXJsonValue>>;

describe('CAP-050: RuntimeSessionState construction contract', () => {
  it('CAP-RUNTIME-STATE-001: initial state has every field shape required by downstream consumers', () => {
    const state = buildRuntimeSessionState({
      activeTools: ['read', 'edit'],
      modelSelection: { provider: 'deepseek', model: 'v4' },
      thinkingLevel: 'balanced',
    });

    expect(state.queuedMessages).toEqual([]);
    expect(state.extensionState).toBeInstanceOf(Map);
    expect(state.extensionState.size).toBe(0);
    expect(state.extensionRecords).toEqual([]);
    expect(state.activeTools).toEqual(['read', 'edit']);
    expect(state.editRecoveryAttempts).toBeInstanceOf(Map);
    expect(state.editRecoveryAttempts.size).toBe(0);
    expect(state.blockedEditWrites).toBeInstanceOf(Set);
    expect(state.blockedEditWrites.size).toBe(0);
    expect(state.modelSelection).toEqual({ provider: 'deepseek', model: 'v4' });
    expect(state.thinkingLevel).toBe('balanced');
  });

  it('CAP-RUNTIME-STATE-002: loaded extensionRecords from storage are top-level cloned (no aliasing with caller-owned record objects)', () => {
    // Spread clone is shallow — `data` (a KodaXJsonValue) is NOT
    // recursively cloned. This test pins the shallow contract; if the
    // extension record mutation model ever changes to write `data`
    // in-place, a deeper clone (or freeze) will be required.
    const original = [
      { id: 'r1', extensionId: 'ext-a', type: 'event', ts: 0, data: {} },
    ];
    const state = buildRuntimeSessionState({
      loadedExtensionRecords: original,
      activeTools: [],
      modelSelection: {},
    });

    expect(state.extensionRecords).toHaveLength(1);
    // Mutating the top-level fields of the original record must NOT
    // affect the state copy (verifies the spread clone happened).
    original[0]!.id = 'MUTATED';
    expect(state.extensionRecords[0]!.id).toBe('r1');
  });

  it('CAP-RUNTIME-STATE-EXTSTATE: createRuntimeExtensionState rehydrates persisted plain object into nested Maps', () => {
    const state = createRuntimeExtensionState({
      'ext-a': { counter: 1, label: 'x' },
      'ext-b': {},
    });

    expect(state.size).toBe(2);
    expect(state.get('ext-a')?.get('counter')).toBe(1);
    expect(state.get('ext-a')?.get('label')).toBe('x');
    expect(state.get('ext-b')?.size).toBe(0);
  });

  it('CAP-RUNTIME-STATE-EXTSTATE-EMPTY: undefined persisted state yields an empty top-level Map (not null/throw)', () => {
    const state = createRuntimeExtensionState(undefined);
    expect(state).toBeInstanceOf(Map);
    expect(state.size).toBe(0);
  });

  it('CAP-RUNTIME-STATE-SNAPSHOT-EMPTY-DROPPED: snapshotRuntimeExtensionState drops buckets with size 0', () => {
    const stateMap: ExtensionStateMap = new Map();
    stateMap.set('ext-empty', new Map());
    const bucket = new Map<string, KodaXJsonValue>();
    bucket.set('k', 1);
    stateMap.set('ext-real', bucket);

    const snapshot = snapshotRuntimeExtensionState(stateMap);
    expect(snapshot).toEqual({ 'ext-real': { k: 1 } });
    expect(snapshot && 'ext-empty' in snapshot).toBe(false);
  });

  it('CAP-RUNTIME-STATE-SNAPSHOT-ALL-EMPTY: snapshot returns undefined when every bucket is empty (signals "no state to persist")', () => {
    const stateMap: ExtensionStateMap = new Map();
    stateMap.set('ext-a', new Map());
    stateMap.set('ext-b', new Map());

    const snapshot = snapshotRuntimeExtensionState(stateMap);
    expect(snapshot).toBeUndefined();
  });

  it('CAP-RUNTIME-STATE-BUCKET: getExtensionStateBucket lazily creates and persists a sub-Map for a new extensionId', () => {
    const stateMap: ExtensionStateMap = new Map();
    const a = getExtensionStateBucket(stateMap, 'ext-a');
    expect(a).toBeInstanceOf(Map);
    expect(stateMap.get('ext-a')).toBe(a);

    // Subsequent calls return the SAME bucket instance (identity, not equality)
    const aAgain = getExtensionStateBucket(stateMap, 'ext-a');
    expect(aAgain).toBe(a);
  });
});
