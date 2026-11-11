import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { mergeLegacyRuntimeProfileState } from './profile-state-merge.js';

const roots: string[] = [];
const NOW = new Date('2026-11-11T08:00:00Z');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function parseGrant(value: unknown): { readonly id: string; readonly scope: { readonly sessionId?: string } } {
  const grant = value as { id?: unknown; scope?: { sessionId?: unknown } };
  if (typeof grant.id !== 'string' || typeof grant.scope !== 'object') throw new Error('invalid permission grant');
  return grant as { id: string; scope: { sessionId?: string } };
}

function home() {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-profile-merge-'));
  roots.push(configHome);
  const file = (relative: string) => path.join(configHome, 'runtime', 'profiles', ...relative.split('/'));
  const put = (relative: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    fs.writeFileSync(file(relative), `${JSON.stringify(value)}\n`);
  };
  const read = (relative: string): unknown => JSON.parse(fs.readFileSync(file(relative), 'utf8'));
  const exists = (relative: string) => fs.existsSync(file(relative));
  const merge = () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink(diagnostic => { diagnostics.push(diagnostic); });
    try {
      return { reports: mergeLegacyRuntimeProfileState(configHome, parseGrant, NOW), diagnostics };
    } finally {
      restore();
    }
  };
  return { configHome, file, put, read, exists, merge };
}

const input = (inputId: string) => ({ skill: false, input: { sessionId: 's1', inputId, text: inputId } });

it('moves Session state absent in the canonical profile and retires the legacy profile', () => {
  const { put, read, exists, merge } = home();
  put('coder/runs/run-a/status.json', { runId: 'run-a' });
  put('coder/session-stops/abc.json', { sessionId: 's1' });
  put('coder/session-mcp/s1.json', { version: 1 });
  put('coder/session-settings/s1.json', { revision: 2, value: { model: 'm' } });
  put('coder/pending-inputs/s1.json', [input('i1')]);
  put('coder/session-orders/s1.json', 4);
  put('default/run-status-index.json', { runs: [] });

  const { reports } = merge();

  expect(read('default/runs/run-a/status.json')).toEqual({ runId: 'run-a' });
  expect(read('default/session-stops/abc.json')).toEqual({ sessionId: 's1' });
  expect(read('default/session-mcp/s1.json')).toEqual({ version: 1 });
  expect(read('default/session-settings/s1.json')).toEqual({ revision: 2, value: { model: 'm' } });
  expect(read('default/pending-inputs/s1.json')).toEqual([input('i1')]);
  expect(read('default/session-orders/s1.json')).toBe(4);
  // The fail-closed scan rebuilds the index from the merged Runs.
  expect(exists('default/run-status-index.json')).toBe(false);
  expect(exists('coder')).toBe(false);
  expect(exists('coder.merged-20261111')).toBe(true);
  expect(reports).toEqual([expect.objectContaining({
    profile: 'coder', mergedTo: 'coder.merged-20261111', moved: 6, conflicts: [], failed: [],
  })]);
});

it('keeps the target Run, the newer Session settings and the larger Session order on conflict', () => {
  const { file, put, read, merge } = home();
  put('default/runs/run-a/status.json', { owner: 'default' });
  put('coder/runs/run-a/status.json', { owner: 'coder' });
  put('default/session-settings/old.json', { revision: 9, value: { model: 'target' } });
  put('coder/session-settings/old.json', { model: 'legacy-newer' });
  put('default/session-settings/new.json', { revision: 1, value: { model: 'target-newer' } });
  put('coder/session-settings/new.json', { revision: 5, value: { model: 'legacy' } });
  fs.utimesSync(file('default/session-settings/old.json'), new Date(1_000), new Date(1_000));
  fs.utimesSync(file('coder/session-settings/new.json'), new Date(1_000), new Date(1_000));
  put('default/session-orders/low.json', 3);
  put('coder/session-orders/low.json', 8);
  put('default/session-orders/high.json', 12);
  put('coder/session-orders/high.json', 5);

  const { reports } = merge();

  expect(read('default/runs/run-a/status.json')).toEqual({ owner: 'default' });
  expect(read('default/session-settings/old.json')).toEqual({ model: 'legacy-newer' });
  expect(read('default/session-settings/new.json')).toEqual({ revision: 1, value: { model: 'target-newer' } });
  expect(read('default/session-orders/low.json')).toBe(8);
  expect(read('default/session-orders/high.json')).toBe(12);
  expect(reports[0]).toMatchObject({ conflicts: [
    'runs/run-a: kept the canonical copy',
    'session-settings/new.json: kept the newer canonical revision 1 over legacy revision 5',
    'session-settings/old.json: kept the newer legacy revision 0 over canonical revision 9',
  ] });
});

it('keeps queued inputs from both profiles once per input id', () => {
  const { put, read, merge } = home();
  put('default/pending-inputs/s1.json', [input('i1'), input('i2')]);
  put('coder/pending-inputs/s1.json', [input('i2'), input('i3')]);
  put('default/pending-inputs/s2.json', [input('a')]);
  put('coder/pending-inputs/s2.json', { version: 2, pending: [], withdrawn: [{ input: input('w').input }] });

  merge();

  expect(read('default/pending-inputs/s1.json')).toEqual([input('i1'), input('i2'), input('i3')]);
  expect(read('default/pending-inputs/s2.json')).toEqual({
    version: 2, pending: [input('a')], withdrawn: [{ input: input('w').input }],
  });
});

it('imports only Session-scoped permission grants and counts the dropped global grants', () => {
  const { put, read, merge } = home();
  const grant = (id: string, sessionId?: string) => ({ id, createdAt: 'x', scope: sessionId ? { sessionId } : { toolName: 'bash' } });
  put('default/permission-grants.json', { revision: 4, value: [grant('g1', 's1')] });
  put('coder/permission-grants.json', { revision: 7, value: [grant('g1', 's1'), grant('g2', 's2'), grant('g3'), grant('g4')] });

  const { reports } = merge();

  expect(read('default/permission-grants.json')).toEqual({ revision: 5, value: [grant('g1', 's1'), grant('g2', 's2')] });
  expect(reports[0]).toMatchObject({ importedGrants: 1, droppedGlobalGrants: 2 });
});

it('skips a legacy profile whose Host is still running', () => {
  const { configHome, put, exists, merge } = home();
  put('coder/session-orders/s1.json', 4);
  const lock = path.join(configHome, 'runtime', 'daemon', 'coder', 'daemon.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ runtimeId: 'rt_live', pid: process.pid, createdAt: NOW.toISOString(), kind: 'daemon' }));

  const { reports } = merge();

  expect(exists('coder/session-orders/s1.json')).toBe(true);
  expect(exists('default/session-orders/s1.json')).toBe(false);
  expect(reports).toEqual([{ profile: 'coder', skipped: 'live_host' }]);
});

it('leaves a failed item in the legacy profile, merges the rest and retries next startup', () => {
  const { put, read, exists, merge } = home();
  put('default/pending-inputs/s1.json', [input('i1')]);
  put('coder/pending-inputs/s1.json', { broken: true });
  put('coder/session-orders/s1.json', 4);

  const first = merge();

  expect(read('default/session-orders/s1.json')).toBe(4);
  expect(exists('coder/pending-inputs/s1.json')).toBe(true);
  expect(exists('coder.merged-20261111')).toBe(false);
  expect(first.reports[0]).toMatchObject({ moved: 1, failed: [{ item: 'pending-inputs/s1.json', error: expect.any(String) }] });
  expect(first.diagnostics).toEqual([expect.objectContaining({ source: 'runtime.host.state-merged', level: 'warn' })]);

  put('coder/pending-inputs/s1.json', [input('i2')]);
  merge();

  expect(read('default/pending-inputs/s1.json')).toEqual([input('i1'), input('i2')]);
  expect(exists('coder.merged-20261111')).toBe(true);
});

it('is idempotent when a crash interrupted an earlier merge', () => {
  const { put, read, exists, merge } = home();
  // A crash after the order and the queue reached the target but before the source was removed.
  put('default/session-orders/s1.json', 4);
  put('coder/session-orders/s1.json', 4);
  put('default/pending-inputs/s1.json', [input('i1')]);
  put('coder/pending-inputs/s1.json', [input('i1')]);
  put('default/permission-grants.json', { revision: 2, value: [{ id: 'g1', createdAt: 'x', scope: { sessionId: 's1' } }] });
  put('coder/permission-grants.json', { revision: 1, value: [{ id: 'g1', createdAt: 'x', scope: { sessionId: 's1' } }] });

  merge();
  const again = merge();

  expect(read('default/session-orders/s1.json')).toBe(4);
  expect(read('default/pending-inputs/s1.json')).toEqual([input('i1')]);
  expect(read('default/permission-grants.json')).toEqual({ revision: 2, value: [{ id: 'g1', createdAt: 'x', scope: { sessionId: 's1' } }] });
  expect(exists('coder.merged-20261111')).toBe(true);
  expect(again).toEqual({ reports: [], diagnostics: [] });
});

it('reports unknown legacy entries, keeps them in the retired profile and emits one diagnostic', () => {
  const { put, exists, merge } = home();
  put('coder/agents/tasks/t1.json', {});
  put('coder/session-orders/s1.json', 1);
  put('ops/session-orders/s2.json', 1);
  put('coder.merged-20261001/session-orders/s3.json', 1);

  const { reports, diagnostics } = merge();

  expect(exists('coder.merged-20261111/agents/tasks/t1.json')).toBe(true);
  expect(exists('coder.merged-20261001/session-orders/s3.json')).toBe(true);
  expect(reports.map(report => report.profile)).toEqual(['coder', 'ops']);
  expect(reports[0]).toMatchObject({ retained: ['agents'] });
  expect(diagnostics).toEqual([{
    source: 'runtime.host.state-merged', level: 'info',
    message: 'Merged legacy Host profile state into the canonical profile (ADR-075).',
    detail: { profiles: reports },
  }]);
});

it('picks a fresh retired name when a legacy profile is merged twice on one day', () => {
  const { put, exists, merge } = home();
  put('coder/session-orders/s1.json', 1);
  merge();
  put('coder/session-orders/s1.json', 2);

  const { reports } = merge();

  expect(reports[0]).toMatchObject({ mergedTo: 'coder.merged-20261111-2' });
  expect(exists('coder.merged-20261111-2')).toBe(true);
});
