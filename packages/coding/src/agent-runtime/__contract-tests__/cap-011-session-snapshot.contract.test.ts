/**
 * Contract test for CAP-011: saveSessionSnapshot at terminal sites
 * (also covers CAP-013 — error snapshot persistence on crash)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-011-savesessionsnapshot-at-terminal-sites
 *
 * Test obligations:
 * - CAP-SESSION-SNAPSHOT-001: success path persists snapshot with messages + title
 * - CAP-SESSION-SNAPSHOT-002: error path persists snapshot with errorMetadata
 *   (shared with CAP-013 — `/resume` can pick up failed run)
 * - CAP-SESSION-SNAPSHOT-003: storage failure does NOT fail run
 *   — ACTIVE since FEATURE_100 P3.6a. `saveSessionSnapshot` now wraps
 *   `storage.save` in try/catch and logs failures via `console.error`.
 *   Particularly important inside `runCatchCleanup` where a storage
 *   rejection would otherwise clobber the original caught error.
 * - CAP-SESSION-SNAPSHOT-004: limit-reached terminal also persists final state
 *   — covered by exercising the same function at the limit-reached call site.
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:4644-4654` parity-restore evidence:
 * "Legacy agent.ts:851 calls saveSessionSnapshot at three terminal sites"
 *
 * Verified location: agent-runtime/middleware/session-snapshot.ts (extracted from
 * agent.ts:844-872 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Verified call sites: agent.ts:1222 (mid-flow auto-reroute), :2825 (success),
 * :2856 (error — see CAP-013), :2904 (limit-reached)
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import type { KodaXSessionData, KodaXSessionStorage } from '@kodax/agent';
import { describe, expect, it, vi } from 'vitest';

import type { KodaXOptions, SessionErrorMetadata } from '../../types.js';
import { saveSessionSnapshot } from '../middleware/session-snapshot.js';
import {
  type RuntimeSessionState,
  buildRuntimeSessionState,
} from '../runtime-session-state.js';

function buildOptionsWithStorage(storage: Pick<KodaXSessionStorage, 'save' | 'load'>): KodaXOptions {
  return {
    session: { storage: storage as KodaXSessionStorage },
  } as KodaXOptions;
}

function emptyRuntimeSessionState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: [],
    modelSelection: {},
  });
}

describe('CAP-011 + CAP-013: saveSessionSnapshot contract', () => {
  it('CAP-SESSION-SNAPSHOT-001: success terminal writes session data with messages, title, and explicit gitRoot', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const options = buildOptionsWithStorage({ save, load: vi.fn() });

    await saveSessionSnapshot(options, 'sid-1', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Test Session',
      gitRoot: '/repo',
    });

    expect(save).toHaveBeenCalledTimes(1);
    const [calledId, payload] = save.mock.calls[0]!;
    expect(calledId).toBe('sid-1');
    expect(payload).toMatchObject({
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Test Session',
      gitRoot: '/repo',
      scope: 'user',
    });
  });

  it('CAP-SESSION-SNAPSHOT-002: error path forwards errorMetadata so /resume can recover the failed run', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const options = buildOptionsWithStorage({ save, load: vi.fn() });
    const errorMetadata: SessionErrorMetadata = {
      lastError: 'provider timeout',
      lastErrorTime: 1714000000000,
      consecutiveErrors: 2,
    };

    await saveSessionSnapshot(options, 'sid-err', {
      messages: [],
      title: 'Errored Session',
      gitRoot: '/repo',
      errorMetadata,
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toMatchObject({ errorMetadata });
  });

  it('CAP-SESSION-SNAPSHOT-003: storage failure does NOT fail the run — saveSessionSnapshot absorbs storage.save rejections (closed in FEATURE_100 P3.6a)', async () => {
    const save = vi.fn().mockRejectedValue(new Error('FS write failed'));
    const options = {
      session: { storage: { save, load: vi.fn() } as KodaXSessionStorage },
    } as KodaXOptions;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      saveSessionSnapshot(options, 'sid-storage-fail', {
        messages: [{ role: 'user', content: 'hi' }],
        title: 'Test Session',
        gitRoot: '/repo',
      }),
    ).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SessionSnapshot]'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('CAP-SESSION-SNAPSHOT-NO-STORAGE: when options.session.storage is undefined, returns silently without throwing', async () => {
    const options = { session: {} } as KodaXOptions;
    await expect(
      saveSessionSnapshot(options, 'sid-nostorage', {
        messages: [],
        title: 'no storage',
        gitRoot: '/repo',
      }),
    ).resolves.toBeUndefined();
  });

  it('CAP-SESSION-SNAPSHOT-EXTSTATE: extensionState empty bucket yields undefined (drops empty maps)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const options = buildOptionsWithStorage({ save, load: vi.fn() });
    const runtimeSessionState = emptyRuntimeSessionState();
    runtimeSessionState.extensionState.set('ext-a', new Map()); // empty bucket

    await saveSessionSnapshot(options, 'sid-empty', {
      messages: [],
      title: 't',
      gitRoot: '/repo',
      runtimeSessionState,
    });

    const payload = save.mock.calls[0]![1] as KodaXSessionData;
    expect(payload.extensionState).toBeUndefined();
  });

  it('CAP-SESSION-SNAPSHOT-EXTSTATE-NONEMPTY: non-empty extensionState is serialised as a plain object snapshot', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const options = buildOptionsWithStorage({ save, load: vi.fn() });
    const runtimeSessionState = emptyRuntimeSessionState();
    const bucket = new Map<string, unknown>();
    bucket.set('counter', 7);
    bucket.set('label', 'foo');
    runtimeSessionState.extensionState.set('ext-a', bucket as Map<string, never>);

    await saveSessionSnapshot(options, 'sid-ext', {
      messages: [],
      title: 't',
      gitRoot: '/repo',
      runtimeSessionState,
    });

    const payload = save.mock.calls[0]![1] as KodaXSessionData;
    expect(payload.extensionState).toEqual({ 'ext-a': { counter: 7, label: 'foo' } });
  });

  it('CAP-SESSION-SNAPSHOT-EXTRECORDS: extensionRecords are top-level cloned at persist time (post-call mutation does not leak into the captured snapshot)', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const options = buildOptionsWithStorage({ save, load: vi.fn() });
    const runtimeSessionState = emptyRuntimeSessionState();
    // KodaXExtensionSessionRecord shape: id / extensionId / type / ts / data?
    const record = { id: 'r1', extensionId: 'ext-a', type: 'event', ts: 0, data: { v: 1 } };
    runtimeSessionState.extensionRecords.push(record);

    await saveSessionSnapshot(options, 'sid-rec', {
      messages: [],
      title: 't',
      gitRoot: '/repo',
      runtimeSessionState,
    });

    // Mutate after persistence — top-level fields of the original record
    // should NOT be visible in the captured snapshot (verifies spread clone
    // at persist time). Note: this is a SHALLOW clone — `data` is not
    // recursively cloned. See CAP-050 test of the same behavior.
    record.id = 'MUTATED';

    const payload = save.mock.calls[0]![1] as KodaXSessionData;
    expect(payload.extensionRecords).toHaveLength(1);
    expect(payload.extensionRecords?.[0]?.id).toBe('r1');
  });

  it('CAP-SESSION-SNAPSHOT-SCOPE: scope defaults to "user" when not configured; respects explicit override', async () => {
    const save = vi.fn().mockResolvedValue(undefined);

    // Default — no explicit scope on options.session
    await saveSessionSnapshot(
      buildOptionsWithStorage({ save, load: vi.fn() }),
      'sid-scope-default',
      { messages: [], title: 't', gitRoot: '/repo' },
    );
    expect((save.mock.calls[0]![1] as KodaXSessionData).scope).toBe('user');

    // Explicit "project" scope
    const optionsProject = {
      session: { storage: { save, load: vi.fn() }, scope: 'project' },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(optionsProject, 'sid-scope-project', {
      messages: [],
      title: 't',
      gitRoot: '/repo',
    });
    expect((save.mock.calls[1]![1] as KodaXSessionData).scope).toBe('project');
  });
});
