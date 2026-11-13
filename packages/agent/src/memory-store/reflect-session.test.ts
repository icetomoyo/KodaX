import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KodaXMessage } from '@kodax-ai/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURSOR_FILE } from './reflection-cursor.js';
import { reflectSession, REFLECT_AGAIN_AFTER_TURNS, type ReflectionJudge } from './reflect-session.js';
import { createNoteStore } from './store.js';

const turns = (count: number): KodaXMessage[] =>
  Array.from({ length: count }, (_, index) => ({ role: 'user', content: `request number ${index}` }) as KodaXMessage);

describe('reflectSession: long sessions and the cost cap', () => {
  let dir: string;
  let calls: number;
  const judge: ReflectionJudge = async () => { calls += 1; return []; };
  const stores = (): Parameters<typeof reflectSession>[0]['stores'] => ({
    project: createNoteStore(path.join(dir, 'project'), 'project'),
    user: createNoteStore(path.join(dir, 'user'), 'user'),
  });
  const run = (messages: KodaXMessage[], extra: Partial<Parameters<typeof reflectSession>[0]> = {}) =>
    reflectSession({ sessionId: 's1', messages, stores: stores(), cursorRoot: dir, judge, ...extra });

  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f306-reflect-')); calls = 0; });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('reads a session again only after it has grown by a few user turns', async () => {
    expect(await run(turns(2))).toMatchObject({ status: 'done' });
    expect(await run(turns(2 + REFLECT_AGAIN_AFTER_TURNS - 1))).toEqual({ status: 'skipped', reason: 'already-reflected' });
    expect(await run(turns(2 + REFLECT_AGAIN_AFTER_TURNS))).toMatchObject({ status: 'done' });
    expect(calls).toBe(2);
  });

  it('does not spend a call on a session with nothing to learn from', async () => {
    expect(await run(turns(1))).toEqual({ status: 'skipped', reason: 'no-signal' });
    expect(calls).toBe(0);
  });

  it('stops at the daily cap and starts over the next day', async () => {
    const day = (iso: string) => () => new Date(iso);
    expect(await run(turns(2), { sessionId: 'a', dailyCap: 2, now: day('2026-11-12T08:00:00Z') })).toMatchObject({ status: 'done' });
    expect(await run(turns(2), { sessionId: 'b', dailyCap: 2, now: day('2026-11-12T09:00:00Z') })).toMatchObject({ status: 'done' });
    expect(await run(turns(2), { sessionId: 'c', dailyCap: 2, now: day('2026-11-12T10:00:00Z') })).toEqual({ status: 'skipped', reason: 'daily-cap' });
    expect(await run(turns(2), { sessionId: 'c', dailyCap: 2, now: day('2026-11-13T00:30:00Z') })).toMatchObject({ status: 'done' });
    expect(calls).toBe(3);
  });

  it('lets a judge failure through, keeps the session unmarked, and still spends the slot', async () => {
    const failing: ReflectionJudge = async () => { throw new Error('provider down'); };
    await expect(run(turns(2), { judge: failing, dailyCap: 1 })).rejects.toThrow('provider down');
    expect(await run(turns(2), { dailyCap: 1 })).toEqual({ status: 'skipped', reason: 'daily-cap' });
    expect(await run(turns(2), { dailyCap: 5 })).toMatchObject({ status: 'done' });
  });

  it('keeps going and saves the cursor when one operation throws', async () => {
    const project = stores().project;
    await project.write({ id: 'a', type: 'project', description: 'one', body: 'b' });
    await project.write({ id: 'b', type: 'project', description: 'two', body: 'b' });
    const throwing = { ...project, edit: async () => { throw new Error('disk gone'); } };
    const twoOps: ReflectionJudge = async () => [{ operation: 'dispute', id: 'a', quote: 'request number 1' }, { operation: 'dispute', id: 'b', quote: 'request number 1' }];
    const outcome = await run(turns(2), { judge: twoOps, stores: { project: throwing, user: stores().user } });
    expect(outcome).toMatchObject({ status: 'done', applied: 0 });
    expect(outcome.status === 'done' && outcome.rejected.join('\n')).toContain('disk gone');
    expect(JSON.parse(await fs.readFile(path.join(dir, CURSOR_FILE), 'utf8'))).toHaveProperty('s1');
  });
});
