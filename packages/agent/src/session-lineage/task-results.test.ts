import { expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import { readTaskResultReports } from './task-results.js';

it('retains an explicitly missing status and identity instead of inventing task success', () => {
  const reports = readTaskResultReports({ content: '<agent-completed>failed: prose</agent-completed>', _source: 'agent-completed' });
  expect(reports).toEqual([{ type: 'task_result', source: 'child_task', status: 'unknown',
    reportFormat: 'markdown', summary: 'failed: prose' }]);
});

it('normalizes metadata with a missing status and preserves literal entity text', () => {
  const message = { content: '<agent-completed state="completed">envelope</agent-completed>', _source: 'agent-completed',
    _taskResult: { type: 'task_result', source: 'child_task', taskId: 'old', summary: '&lt;literal&gt;' } } as KodaXMessage;
  expect(readTaskResultReports(message)).toEqual([{ type: 'task_result', source: 'child_task', taskId: 'old',
    status: 'unknown', reportFormat: 'markdown', summary: '&lt;literal&gt;' }]);
});

it('uses an explicitly sourced envelope only to fill a missing metadata report', () => {
  const message: KodaXMessage = { role: 'user', _source: 'agent-completed',
    content: '<agent-completed id="delivery-only" state="completed">&lt;body&gt;</agent-completed>',
    _taskResult: { type: 'task_result', source: 'child_task', taskId: 'child', status: 'failed' } };
  expect(readTaskResultReports(message)[0]).toMatchObject({ status: 'failed', summary: '<body>' });
});

it('retains artifact references and does not let malformed metadata hide a sourced legacy report', () => {
  const metadata = { type: 'task_result' as const, source: 'workflow' as const, taskId: 'workflow', runId: 'run',
    status: 'completed' as const, title: 'Review', artifactRefs: ['report.md', 'preview.png'], summary: '# Complete' };
  const report = readTaskResultReports({ content: '', _taskResult: metadata })[0]!;
  expect(report).toMatchObject({ ...metadata, reportFormat: 'markdown' });
  expect(report.artifactRefs).not.toBe(metadata.artifactRefs);
  const message = { content: '<task-completed task_id="old">kept</task-completed>', _source: 'task-completed',
    _taskResults: [null, { type: 'wrong' }] } as unknown as KodaXMessage;
  expect(readTaskResultReports(message)).toMatchObject([{ taskId: 'old', status: 'unknown', summary: 'kept' }]);
});

it('keeps an empty structured report as a terminal task fact', () => {
  expect(readTaskResultReports({ content: '', _taskResults: [{ type: 'task_result', source: 'child_task',
    taskId: 'empty', status: 'cancelled', summary: '' }] })).toEqual([{ type: 'task_result', source: 'child_task',
    taskId: 'empty', status: 'cancelled', reportFormat: 'markdown', summary: '' }]);
});

it('retains explicitly sourced text-block reports and workflow envelope fields', () => {
  expect(readTaskResultReports({ _source: 'agent-completed', content: [{ type: 'text', text: 'raw report' }] }))
    .toEqual([{ type: 'task_result', source: 'child_task', status: 'unknown', reportFormat: 'markdown', summary: 'raw report' }]);
  expect(readTaskResultReports({ _source: 'task-completed',
    content: "<task-completed source='workflow' run_id='run' task_id='task' path='Review &quot;title&quot;' status='cancelled'>body</task-completed>" }))
    .toEqual([{ type: 'task_result', source: 'workflow', runId: 'run', taskId: 'task', title: 'Review "title"',
      status: 'cancelled', reportFormat: 'markdown', summary: 'body' }]);
});

it('does not relabel a mailbox delivery ID as a missing Actor turn identity', () => {
  const report = readTaskResultReports({ _source: 'agent-completed',
    content: '<agent-completed id="message-only" path="/root/old">body</agent-completed>' })[0]!;
  expect(report.taskId).toBeUndefined();
  expect(report).toMatchObject({ title: '/root/old', status: 'unknown', summary: 'body' });
});

it.each([true, false])('keeps mixed old/new reports in delivery order (old first: %s)', oldFirst => {
  const old = '<agent-completed turn_id="old" state="completed">old &amp; report</agent-completed>';
  const current = '<agent-completed turn_id="new" state="failed">wire new</agent-completed>';
  const result = readTaskResultReports({ _source: 'agent-completed', content: oldFirst ? old + current : current + old,
    _taskResults: [{ type: 'task_result', source: 'child_task', taskId: 'new', status: 'failed', summary: '# New report' }] });
  expect(result.map(report => report.taskId)).toEqual(oldFirst ? ['old', 'new'] : ['new', 'old']);
  expect(result.find(report => report.taskId === 'new')?.summary).toBe('# New report');
  expect(result.find(report => report.taskId === 'old')?.summary).toBe('old & report');
});

it('preserves the existing interrupted Actor envelope as an explicit cancellation', () => {
  expect(readTaskResultReports({ _source: 'agent-completed',
    content: '<agent-completed turn_id="old" state="interrupted">stopped</agent-completed>' })[0])
    .toMatchObject({ taskId: 'old', status: 'cancelled' });
});

it('keeps older task envelopes when an Actor wake carries both envelope generations', () => {
  const reports = readTaskResultReports({ _source: 'agent-completed',
    content: '<task-completed task_id="old">old</task-completed><agent-completed turn_id="new">wire new</agent-completed>',
    _taskResult: { type: 'task_result', source: 'child_task', taskId: 'new', status: 'completed', summary: 'new' } });
  expect(reports.map(report => [report.taskId, report.summary, report.status]))
    .toEqual([['old', 'old', 'unknown'], ['new', 'new', 'completed']]);
});

it('keeps metadata order when model-only envelope budgeting reorders report fragments', () => {
  const reports = readTaskResultReports({ _source: 'agent-completed',
    content: '<agent-completed turn_id="second">second</agent-completed><agent-completed turn_id="first">first</agent-completed>',
    _taskResults: [
      { type: 'task_result', source: 'child_task', taskId: 'first', status: 'failed', summary: 'first' },
      { type: 'task_result', source: 'child_task', taskId: 'second', status: 'cancelled', summary: 'second' },
    ] });
  expect(reports.map(report => report.taskId)).toEqual(['first', 'second']);
});

it('does not invent another task from an unframed model-only summary when metadata is present', () => {
  expect(readTaskResultReports({ _source: 'agent-completed', content: 'Budgeted model-only summary.', _taskResults: [
    { type: 'task_result', source: 'child_task', taskId: 'first', status: 'completed', summary: 'first' },
    { type: 'task_result', source: 'child_task', taskId: 'second', status: 'failed', summary: 'second' },
  ] }).map(report => report.taskId)).toEqual(['first', 'second']);
});

it.each([
  { source: 'child_task' as const, taskId: 'same', runId: undefined, oldSource: 'workflow', oldId: 'same', oldRun: 'old' },
  { source: 'workflow' as const, taskId: 'same', runId: 'new', oldSource: 'workflow', oldId: 'same', oldRun: 'old' },
  { source: 'child_task' as const, taskId: 'new', runId: undefined, oldSource: 'child_task', oldId: 'old', oldRun: undefined },
])('keeps reports whose known task identity fields conflict: %j', sample => {
  const result = readTaskResultReports({ _source: 'agent-completed',
    content: `<task-completed source="${sample.oldSource}" task_id="${sample.oldId}"${sample.oldRun ? ` run_id="${sample.oldRun}"` : ''}>old report</task-completed>`,
    _taskResult: { type: 'task_result', source: sample.source, taskId: sample.taskId, runId: sample.runId,
      status: 'completed', summary: 'new report' } });
  expect(result).toHaveLength(2);
  expect(result.map(report => report.summary)).toEqual(['new report', 'old report']);
  expect(result[1]).toMatchObject({ source: sample.oldSource, taskId: sample.oldId });
  if (sample.oldRun) expect(result[1]?.runId).toBe(sample.oldRun);
});
