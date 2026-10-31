/**
 * FEATURE_173 dual-writer regression probe.
 *
 * Reproduces the "resume only loads the first round" report (2026-05-29).
 *
 * After FEATURE_173 Part A consolidated the session id, two INDEPENDENT
 * FileSessionStorage instances write the SAME `<id>.jsonl`:
 *   - runner side: `saveSessionSnapshot` -> `storage.save(id, {messages})`
 *     (FULL rewrite, NO lineage -> rebuilt via createSessionLineage)
 *   - REPL side: `persistContextState` -> `storage.appendSessionDelta(id,
 *     {messages, lineage})` (incremental append against its own watermark)
 *
 * Each instance has its own `appendState` watermark + `writeQueues`, so the
 * two writers are NOT serialized against each other and each call to
 * `createSessionLineage` mints fresh random entry ids. This probe runs the
 * realistic per-round interleavings and asserts that, whatever the order,
 * a subsequent load reconstructs ALL rounds.
 *
 * Interleaving E reproduced the report on pre-fix code (a stale runner
 * full-rewrite landing last regressed `activeEntryId` to the first round).
 * The FEATURE_173 storage no-regress guard (`resolveSnapshotLineage`) makes a
 * lineage-less prefix snapshot reuse the persisted lineage, so all rounds
 * survive regardless of writer ordering. These lock that fix in.
 */

import os from 'os';
import path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXMessage, KodaXSessionLineage } from '@kodax-ai/agent';
import { createSessionLineage } from '@kodax-ai/agent';

// Use the real repo root so load()'s workspace-mismatch check stays quiet;
// the value is only stored as session metadata, never validated by the
// lineage logic under test.
const GIT_ROOT = process.cwd().replace(/\\/g, '/');

function userMsg(text: string): KodaXMessage {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): KodaXMessage {
  return { role: 'assistant', content: text };
}

/** Cumulative transcript after `rounds` user/assistant exchanges. */
function transcript(rounds: number): KodaXMessage[] {
  const out: KodaXMessage[] = [];
  for (let r = 1; r <= rounds; r += 1) {
    out.push(userMsg(`u${r}`), assistantMsg(`a${r}`));
  }
  return out;
}

function loadedTexts(messages: KodaXMessage[]): string[] {
  return messages.map((m) => (typeof m.content === 'string' ? m.content : '[complex]'));
}

describe('FEATURE_173 dual-writer resume probe', () => {
  let tempHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-dualwriter-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    vi.stubEnv('KODAX_HOME', path.join(tempHome, '.kodax'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    await rm(tempHome, { recursive: true, force: true });
  });

  const ROUNDS = 4;
  const SESSION_ID = '20260529_101010';

  // ── Interleaving A: runner saves first, then REPL appends (production
  //    order inside runManagedTask: saveSessionSnapshot at the success
  //    terminal, then the REPL receives the result and persists). ──
  it('A: runner.save -> repl.appendDelta per round keeps all rounds', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const runner = new FileSessionStorage();
    const repl = new FileSessionStorage();

    let replLineage: KodaXSessionLineage | undefined;
    for (let r = 1; r <= ROUNDS; r += 1) {
      const msgs = transcript(r);
      // runner: full save, no lineage (mirrors saveSessionSnapshot)
      await runner.save(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
      });
      // repl: incremental append with its OWN lineage
      replLineage = createSessionLineage(msgs, replLineage);
      await repl.appendSessionDelta(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, lineage: replLineage,
      });
    }

    const reader = new FileSessionStorage();
    const loaded = await reader.load(SESSION_ID);
    // eslint-disable-next-line no-console
    console.log('[A] loaded:', loadedTexts(loaded?.messages ?? []));
    expect(loaded?.messages.length).toBe(ROUNDS * 2);
  });

  // ── Interleaving B: REPL appends first, then runner saves (the runner's
  //    full rewrite lands LAST and carries NO trailing meta_update, so the
  //    persisted activeEntryId is the runner's reconciled chain). ──
  it('B: repl.appendDelta -> runner.save per round keeps all rounds', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const runner = new FileSessionStorage();
    const repl = new FileSessionStorage();

    let replLineage: KodaXSessionLineage | undefined;
    for (let r = 1; r <= ROUNDS; r += 1) {
      const msgs = transcript(r);
      replLineage = createSessionLineage(msgs, replLineage);
      await repl.appendSessionDelta(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, lineage: replLineage,
      });
      await runner.save(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
      });
    }

    const reader = new FileSessionStorage();
    const loaded = await reader.load(SESSION_ID);
    // eslint-disable-next-line no-console
    console.log('[B] loaded:', loadedTexts(loaded?.messages ?? []));
    expect(loaded?.messages.length).toBe(ROUNDS * 2);
  });

  // ── Interleaving C: realistic mid-round background persist. Within each
  //    round the runner does per-iteration saves (run-substrate:1455) while
  //    the REPL background-persists on streaming deltas with a STALE lineage
  //    (context.lineage is only reconciled at round END). ──
  it('C: mid-round stale repl persist interleaved with runner per-iter save keeps all rounds', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const runner = new FileSessionStorage();
    const repl = new FileSessionStorage();

    let replLineage: KodaXSessionLineage | undefined;
    for (let r = 1; r <= ROUNDS; r += 1) {
      const prevMsgs = transcript(r - 1);
      const msgs = transcript(r);

      // mid-round: runner per-iteration save sees the new user msg first
      const midMsgs = [...prevMsgs, userMsg(`u${r}`)];
      await runner.save(SESSION_ID, {
        messages: midMsgs, title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
      });
      // mid-round: repl background persist with STALE (previous-round) lineage
      if (replLineage) {
        await repl.appendSessionDelta(SESSION_ID, {
          messages: prevMsgs, title: 'u1', gitRoot: GIT_ROOT, lineage: replLineage,
        });
      }

      // round end: runner success save (full), then repl reconciles + persists
      await runner.save(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
      });
      replLineage = createSessionLineage(msgs, replLineage);
      await repl.appendSessionDelta(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, lineage: replLineage,
      });
    }

    const reader = new FileSessionStorage();
    const loaded = await reader.load(SESSION_ID);
    // eslint-disable-next-line no-console
    console.log('[C] loaded:', loadedTexts(loaded?.messages ?? []));
    expect(loaded?.messages.length).toBe(ROUNDS * 2);
  });

  // ── Part 2 unit guard: a lineage-less snapshot whose messages are a
  //    strict PREFIX of the persisted active path must reuse the existing
  //    lineage verbatim — never regress activeEntryId. (Concurrent
  //    un-awaited dual-writer races are intentionally NOT asserted here:
  //    Part 1 single-writer ownership eliminates the second writer in
  //    production, so a two-writer race is an unsupported, nondeterministic
  //    scenario rather than a stable contract.) ──
  it('D: lineage-less prefix snapshot does not regress activeEntryId', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const repl = new FileSessionStorage();

    // REPL persists the full 4-round lineage (authoritative writer).
    const full = transcript(ROUNDS);
    const lineage = createSessionLineage(full);
    await repl.appendSessionDelta(SESSION_ID, {
      messages: full, title: 'u1', gitRoot: GIT_ROOT, lineage,
    });
    const activeBefore = lineage.activeEntryId;

    // A stale runner snapshot (no lineage, only round 1) lands afterwards.
    const reader = new FileSessionStorage();
    await reader.save(SESSION_ID, {
      messages: transcript(1), title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
    });

    const loaded = await new FileSessionStorage().load(SESSION_ID);
    // eslint-disable-next-line no-console
    console.log('[D] loaded:', loadedTexts(loaded?.messages ?? []));
    expect(loaded?.messages.length).toBe(ROUNDS * 2);
    expect(loaded?.lineage?.activeEntryId).toBe(activeBefore);
  });

  // ── Empty-message snapshot guard (error-recovery save with no recovered
  //    messages: runner-driven.ts:419 passes `messages: []` + errorMetadata).
  //    Must persist errorMetadata WITHOUT resetting activeEntryId to null. ──
  it('D2: empty-message error snapshot preserves lineage + records errorMetadata', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const repl = new FileSessionStorage();

    const full = transcript(ROUNDS);
    const lineage = createSessionLineage(full);
    await repl.appendSessionDelta(SESSION_ID, {
      messages: full, title: 'u1', gitRoot: GIT_ROOT, lineage,
    });
    const activeBefore = lineage.activeEntryId;

    // Runner error terminal with NO recovered messages.
    await new FileSessionStorage().save(SESSION_ID, {
      messages: [], title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
      errorMetadata: { lastError: 'boom', lastErrorTime: 1, consecutiveErrors: 1 },
    });

    const loaded = await new FileSessionStorage().load(SESSION_ID);
    // eslint-disable-next-line no-console
    console.log('[D2] loaded:', loadedTexts(loaded?.messages ?? []));
    expect(loaded?.lineage?.activeEntryId).toBe(activeBefore);
    expect(loaded?.messages.length).toBe(ROUNDS * 2);
  });

  // ── Interleaving E: "stale runner rename clobbers fresh repl append".
  //    The runner's full rewrite (temp+rename) reflects an EARLIER message
  //    set and lands AFTER the REPL appended the latest round, so rename
  //    replaces the whole file and discards the newer rounds. ──
  it('E: stale runner.save landing last must NOT clobber newer repl rounds', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const runner = new FileSessionStorage();
    const repl = new FileSessionStorage();

    let replLineage: KodaXSessionLineage | undefined;
    // Rounds 1..N persisted cleanly by both, in order.
    for (let r = 1; r <= ROUNDS; r += 1) {
      const msgs = transcript(r);
      replLineage = createSessionLineage(msgs, replLineage);
      await repl.appendSessionDelta(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, lineage: replLineage,
      });
      await runner.save(SESSION_ID, {
        messages: msgs, title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
      });
    }
    // A delayed runner save from round 1 finally lands (full rewrite).
    await runner.save(SESSION_ID, {
      messages: transcript(1), title: 'u1', gitRoot: GIT_ROOT, scope: 'user',
    });

    const reader = new FileSessionStorage();
    const loaded = await reader.load(SESSION_ID);
    // eslint-disable-next-line no-console
    console.log('[E] loaded:', loadedTexts(loaded?.messages ?? []));
    expect(loaded?.messages.length).toBe(ROUNDS * 2);
  });
});
