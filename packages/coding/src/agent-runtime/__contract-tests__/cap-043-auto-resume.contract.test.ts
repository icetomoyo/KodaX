/**
 * Contract test for CAP-043: autoResume session discovery
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-043-autoresume-session-discovery
 *
 * Test obligations:
 * - CAP-AUTO-RESUME-001: when autoResume is set and no explicit
 *   session.id is provided, picks sessions[0].id from storage.list()
 * - CAP-AUTO-RESUME-002: explicit session.id wins over autoResume
 * - CAP-AUTO-RESUME-003: returns undefined when neither autoResume
 *   nor resume flag is set
 * - CAP-AUTO-RESUME-004: returns undefined when storage is missing
 *   or has no list() method
 * - CAP-AUTO-RESUME-005: returns undefined when storage.list() returns
 *   empty
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/auto-resume.ts (the
 * `discoverAutoResumeSessionId` helper, extracted from agent.ts:391-401
 * during FEATURE_100 P3.6n).
 *
 * Time-ordering constraint: BEFORE session loading (CAP-045); AFTER
 * initial provider resolution.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6n.
 */

import { describe, expect, it, vi } from 'vitest';

import { discoverAutoResumeSessionId } from '../middleware/auto-resume.js';
import type { KodaXOptions } from '../../types.js';

function makeStorage(sessions: { id: string }[]) {
  return {
    list: vi.fn().mockResolvedValue(sessions),
    save: vi.fn(),
    load: vi.fn(),
    delete: vi.fn(),
  };
}

describe('CAP-043: autoResume session discovery contract', () => {
  it('CAP-AUTO-RESUME-001: when autoResume is set and no explicit id, returns sessions[0].id from storage.list()', async () => {
    const storage = makeStorage([{ id: 'sess-newest' }, { id: 'sess-older' }]);
    const id = await discoverAutoResumeSessionId({
      session: { autoResume: true, storage },
    } as unknown as KodaXOptions);
    expect(id).toBe('sess-newest');
    expect(storage.list).toHaveBeenCalledOnce();
  });

  it('CAP-AUTO-RESUME-001b: `resume: true` is treated identically to `autoResume: true`', async () => {
    const storage = makeStorage([{ id: 'first' }]);
    const id = await discoverAutoResumeSessionId({
      session: { resume: true, storage },
    } as unknown as KodaXOptions);
    expect(id).toBe('first');
  });

  it('CAP-AUTO-RESUME-002: explicit session.id wins — list() is NOT called', async () => {
    const storage = makeStorage([{ id: 'should-not-be-used' }]);
    const id = await discoverAutoResumeSessionId({
      session: { id: 'explicit-id', autoResume: true, storage },
    } as unknown as KodaXOptions);
    expect(id).toBe('explicit-id');
    expect(storage.list).not.toHaveBeenCalled();
  });

  it('CAP-AUTO-RESUME-003: returns undefined when neither autoResume nor resume is set', async () => {
    const storage = makeStorage([{ id: 'sess-1' }]);
    const id = await discoverAutoResumeSessionId({
      session: { storage },
    } as unknown as KodaXOptions);
    expect(id).toBeUndefined();
    expect(storage.list).not.toHaveBeenCalled();
  });

  it('CAP-AUTO-RESUME-004a: returns undefined when storage is missing entirely', async () => {
    const id = await discoverAutoResumeSessionId({
      session: { autoResume: true },
    } as unknown as KodaXOptions);
    expect(id).toBeUndefined();
  });

  it('CAP-AUTO-RESUME-004b: returns undefined when storage has no list() method', async () => {
    const id = await discoverAutoResumeSessionId({
      session: {
        autoResume: true,
        storage: { save: vi.fn(), load: vi.fn(), delete: vi.fn() },
      },
    } as unknown as KodaXOptions);
    expect(id).toBeUndefined();
  });

  it('CAP-AUTO-RESUME-005: returns undefined when storage.list() returns empty array', async () => {
    const storage = makeStorage([]);
    const id = await discoverAutoResumeSessionId({
      session: { autoResume: true, storage },
    } as unknown as KodaXOptions);
    expect(id).toBeUndefined();
    expect(storage.list).toHaveBeenCalledOnce();
  });
});
