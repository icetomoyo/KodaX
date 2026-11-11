import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHomeRetention } from './home-retention.js';

const roots: string[] = [];
const DAY = 86_400_000;

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-home-retention-'));
  roots.push(root);
  const put = (relative: string, ageDays: number, content = 'x') => {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    age(file, ageDays);
    return file;
  };
  const age = (target: string, ageDays: number) => {
    const at = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(target, at, at);
  };
  /** Directories get their own mtime from fixture writes; age them like long-idle state. */
  const ageTree = (relative: string, ageDays: number) => {
    const visit = (target: string) => {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(path.join(target, entry.name));
        else age(path.join(target, entry.name), ageDays);
      }
      age(target, ageDays);
    };
    visit(path.join(root, ...relative.split('/')));
  };
  return { root, put, age, ageTree };
}

async function drain(retention: ReturnType<typeof createHomeRetention>) {
  const totals = { examined: 0, removed: 0, retained: 0 };
  for (;;) {
    const round = await retention.runOnce();
    totals.examined += round.examined;
    totals.removed += round.removed;
    totals.retained += round.retained;
    if (round.passComplete) return totals;
  }
}

it('removes aged retired Run journals in every profile and keeps Run records and live ledgers', async () => {
  const { root, put, ageTree } = home();
  const retired = [
    'runtime/profiles/default/runs/run-a/events.jsonl',
    'runtime/profiles/default/runs/run-a/event-journals.json',
    'runtime/profiles/coder/runs/run-b/events.watermark',
    'runtime/profiles/coder/event-sequence',
    'runtime/profiles/coder/session-events/c2Vzc2lvbg/events.jsonl',
  ].map(file => put(file, 40));
  const kept = [
    'runtime/profiles/default/runs/run-a/status.json',
    'runtime/profiles/default/runs/run-a/generation-recovery.json',
    'runtime/profiles/default/agents/tasks/task-a/events.jsonl',
    'workflow-runs/project/run-c/events.jsonl',
    'runtime/profiles/default/session-orders/session.json',
    'sessions/session.jsonl',
  ].map(file => put(file, 400));
  ageTree('runtime/profiles/coder/session-events', 40);

  const totals = await drain(createHomeRetention(root));

  expect(retired.filter(file => fs.existsSync(file))).toEqual([]);
  expect(fs.existsSync(path.join(root, 'runtime/profiles/coder/session-events'))).toBe(false);
  expect(kept.filter(file => !fs.existsSync(file))).toEqual([]);
  expect(fs.existsSync(path.join(root, 'runtime/profiles/default/runs/run-a'))).toBe(true);
  expect(totals).toMatchObject({ removed: 5, retained: 0 });
});

it('keeps legacy files touched within thirty days and judges directories by their newest entry', async () => {
  const { root, put, age, ageTree } = home();
  const recentJournal = put('runtime/profiles/default/runs/run-a/events.jsonl', 29);
  put('runtime/profiles/default/session-events/old/events.jsonl', 300);
  const recentInTree = put('runtime/profiles/default/session-events/new/events.jsonl', 300);
  const recentRunner = put('sandbox-runtime/runner/0.0.65/srt-win.exe', 300);
  ageTree('runtime/profiles/default/session-events', 300);
  ageTree('sandbox-runtime/runner', 300);
  age(recentInTree, 1);
  age(recentRunner, 2);

  await drain(createHomeRetention(root));

  expect(fs.existsSync(recentJournal)).toBe(true);
  expect(fs.existsSync(recentInTree)).toBe(true);
  expect(fs.existsSync(recentRunner)).toBe(true);
});

it('removes retired filesystem-effect and sandbox staging files but never live sandbox state', async () => {
  const { root, put, ageTree } = home();
  const id = randomUUID();
  const retired = [
    'runtime/test-filesystem-effects-12-3456/model-filesystem-effects.json',
    'runtime/model-filesystem-effects.json',
    'runtime/model-filesystem-effects.lock.queue/entry',
    'runtime/model-filesystem-effect.lock.queue/entry',
    `sandbox-runtime/kodax-asrt-observation-15884-${id}.json`,
    `sandbox-runtime/kodax-asrt-shell-9900-${id}.json`,
    `sandbox-runtime/workspace-20844-${id}.json`,
    'sandbox-runtime/runner/0.0.65/srt-win.exe',
  ].map(file => put(file, 60));
  const kept = [
    `sandbox-runtime/kodax-asrt-gate-15884-${id}.json`,
    'sandbox-runtime/acl-poison/marker.json',
    'sandbox-runtime/acl-poison-staging/marker.json',
    'sandbox-runtime/acl-recovery.lock.queue/entry',
    'sandbox-runtime/recovered-markers/marker.json',
    'sandbox-runtime/read-policy-v2.json',
    `sandbox-runtime/workspace-notes-${id}.json`,
    'runtime/run-status-index.json',
    'runtime/construction-budget-locks/entry',
  ].map(file => put(file, 400));
  for (const directory of ['runtime/test-filesystem-effects-12-3456', 'runtime/model-filesystem-effects.lock.queue',
    'runtime/model-filesystem-effect.lock.queue', 'sandbox-runtime/runner']) ageTree(directory, 60);

  await drain(createHomeRetention(root));

  expect(retired.filter(file => fs.existsSync(file))).toEqual([]);
  expect(fs.existsSync(path.join(root, 'sandbox-runtime/runner'))).toBe(false);
  expect(kept.filter(file => !fs.existsSync(file))).toEqual([]);
});

it('expires unresolved child evidence after ninety days and keeps active registrations', async () => {
  const { root, put } = home();
  const children = 'runtime/processes/children';
  const expired = put(`${children}/.unresolved/4321.${randomUUID()}.json`, 91);
  const fresh = put(`${children}/.unresolved/4322.${randomUUID()}.json`, 89);
  const foreign = put(`${children}/.unresolved/notes.json`, 400);
  const active = put(`${children}/4323.${randomUUID()}.json`, 400);

  await drain(createHomeRetention(root));

  expect(fs.existsSync(expired)).toBe(false);
  expect([fresh, foreign, active].every(file => fs.existsSync(file))).toBe(true);
});

it('never follows linked directories out of the agent home', async () => {
  const { root, put } = home();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-home-retention-outside-'));
  roots.push(outside);
  const target = path.join(outside, 'runs', 'run-a', 'events.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x');
  const old = new Date(Date.now() - 400 * DAY);
  fs.utimesSync(target, old, old);
  put('runtime/profiles/default/run-status-index.json', 1);
  fs.symlinkSync(outside, path.join(root, 'runtime/profiles/linked'), 'junction');
  fs.symlinkSync(outside, path.join(root, 'runtime/profiles/default/runs'), 'junction');

  await drain(createHomeRetention(root));

  expect(fs.existsSync(target)).toBe(true);
});

it('bounds each round, resumes where it stopped and starts a new pass only after a day', async () => {
  const { root, put } = home();
  const files = Array.from({ length: 7 }, (_, index) =>
    put(`runtime/profiles/default/runs/run-${index}/events.jsonl`, 40));
  const retention = createHomeRetention(root, 4);

  const first = await retention.runOnce();
  expect(first.examined).toBe(4);
  expect(first.passComplete).toBe(false);
  await drain(retention);
  expect(files.filter(file => fs.existsSync(file))).toEqual([]);

  const late = put('runtime/profiles/default/runs/run-late/events.jsonl', 40);
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + DAY - 60_000 });
  expect(await retention.runOnce()).toMatchObject({ examined: 0, passComplete: false });
  expect(fs.existsSync(late)).toBe(true);
  vi.setSystemTime(Date.now() + 120_000);
  await drain(retention);
  expect(fs.existsSync(late)).toBe(false);
});

it('stops before deleting anything once the Host begins shutting down', async () => {
  const { root, put } = home();
  const file = put('runtime/profiles/default/runs/run-a/events.jsonl', 40);
  const stopping = new AbortController();
  stopping.abort();

  expect(await createHomeRetention(root).runOnce(stopping.signal)).toMatchObject({ examined: 0, removed: 0 });
  expect(fs.existsSync(file)).toBe(true);
});

it('expires a merged legacy Host profile thirty days after the merge and keeps live profiles (ADR-075)', async () => {
  const { root, put, ageTree } = home();
  put('runtime/profiles/coder.merged-20261001/runs/run-a/status.json', 400);
  put('runtime/profiles/ops.merged-20261001-2/session-orders/s.json', 400);
  put('runtime/profiles/space.merged-20261101/session-orders/s.json', 400);
  const kept = [
    'runtime/profiles/coder/session-orders/s.json',
    'runtime/profiles/default/session-orders/s.json',
    'runtime/profiles/space.merged-20261101/session-orders/s.json',
  ].map(file => put(file, 400));
  ageTree('runtime/profiles/coder.merged-20261001', 40);
  ageTree('runtime/profiles/ops.merged-20261001-2', 40);
  ageTree('runtime/profiles/space.merged-20261101', 400);
  fs.utimesSync(path.join(root, 'runtime/profiles/space.merged-20261101'), new Date(), new Date());

  await drain(createHomeRetention(root));

  expect(fs.existsSync(path.join(root, 'runtime/profiles/coder.merged-20261001'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'runtime/profiles/ops.merged-20261001-2'))).toBe(false);
  expect(kept.filter(file => !fs.existsSync(file))).toEqual([]);
});
