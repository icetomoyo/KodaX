// Harness-only oracle. Never copy this source or golden implementation into the model workspace.
export const RECOVERY_ORACLE = `import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.env.NATURAL_ORACLE_WORKSPACE;
if (!workspace) throw new Error('NATURAL_ORACLE_WORKSPACE is required');
const { recoverShutdown } = await import(pathToFileURL(path.join(workspace, 'src/recovery.js')).href);
const receipt = { process: { pid: 41, startedAt: 'session-a' }, taskOutcome: 'unknown', cleanup: { state: 'unknown' }, attempts: 99 };
const safe = { process: { ...receipt.process, state: 'exited' }, treeState: 'exited', resourcesState: 'released' };
test('verified exit permits restart without rewriting unknown history', () => {
  const frozen = Object.freeze({ ...receipt, process: Object.freeze({ ...receipt.process }), cleanup: Object.freeze({ ...receipt.cleanup }) });
  const result = recoverShutdown(frozen, safe);
  assert.equal(result.readyToStart, true);
  assert.equal(result.nextAction, 'start');
  assert.equal(result.receipt, frozen);
  assert.deepEqual(result.receipt, receipt);
});
test('running, uncertain and unrelated processes remain blocked', () => {
  for (const process of [
    { ...safe.process, state: 'running' }, { ...safe.process, state: 'unknown' },
    { ...safe.process, pid: 42 }, { ...safe.process, startedAt: 'replacement-session' }, undefined,
  ]) {
    assert.equal(recoverShutdown(receipt, { ...safe, process }).readyToStart, false, JSON.stringify(process));
  }
});
test('missing identity or unreleased resources cannot be bypassed by retries or complete receipt', () => {
  for (const state of ['unknown', 'running']) assert.equal(recoverShutdown(receipt, { ...safe, treeState: state }).readyToStart, false);
  for (const state of ['unknown', 'held']) assert.equal(recoverShutdown(receipt, { ...safe, resourcesState: state }).readyToStart, false);
  for (const observation of [undefined, {}, { ...safe, treeState: undefined }, { ...safe, resourcesState: undefined }]) {
    assert.equal(recoverShutdown({ ...receipt, cleanup: { state: 'complete' } }, observation).readyToStart, false);
  }
  assert.equal(recoverShutdown({ ...receipt, process: { pid: 41 } }, { ...safe, process: { pid: 41, state: 'exited' } }).readyToStart, false);
});
test('repeated observations and late cleanup preserve original unknown outcome', () => {
  const first = recoverShutdown(receipt, safe);
  const repeated = recoverShutdown(receipt, safe);
  assert.deepEqual(repeated, first);
  const lateReceipt = { ...receipt, cleanup: { state: 'complete' } };
  assert.equal(recoverShutdown(lateReceipt, safe).readyToStart, true);
  assert.equal(first.receipt.cleanup.state, 'unknown');
  assert.equal(first.receipt.taskOutcome, 'unknown');
  assert.equal(recoverShutdown(lateReceipt, safe).receipt.taskOutcome, 'unknown');
});
test('replacement host requires its own evidence and old observation cannot authorize it', () => {
  const replacement = { ...receipt, process: { pid: 41, startedAt: 'session-b' } };
  assert.equal(recoverShutdown(replacement, safe).readyToStart, false);
  assert.equal(recoverShutdown(replacement, { ...safe, process: { ...replacement.process, state: 'running' } }).readyToStart, false);
});
`;
