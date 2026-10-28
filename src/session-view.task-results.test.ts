import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { KodaXMessage, KodaXTaskResultMetadata } from '@kodax-ai/agent';
import { persistSessionViewItems, restoreSessionViewItems } from './session-view.js';
import { projectConversationHistoryPage, readConversationHistoryEntry } from './client-history.js';
import type { RuntimeConversationHistorySlice } from './sdk-runtime.js';

it('projects canonical child metadata as a report rather than its model-facing XML envelope', () => {
  const report = '\n# Child report\n\n```ts\nconst text = "<tag> &amp; literal";\n```\n';
  const message: KodaXMessage = { role: 'user', _synthetic: true, _source: 'agent-completed',
    content: '<agent-completed path="/root/review" turn_id="child-1" state="failed">\n&lt;report&gt;\n</agent-completed>',
    timestamp: '2026-10-28T00:00:00Z', _taskResult: {
      type: 'task_result', source: 'child_task', taskId: 'child-1', title: '/root/review',
      status: 'failed', summary: report,
    } };
  const data = { title: 'Review', gitRoot: '.', messages: [message] };
  const items = restoreSessionViewItems('session', data);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: 'event', text: report, taskResult: {
    source: 'child_task', taskId: 'child-1', status: 'failed', reportFormat: 'markdown',
  } });
  expect(restoreSessionViewItems('session', { ...data, uiHistory: persistSessionViewItems(items) })).toEqual(items);
  expect(restoreSessionViewItems('session', { ...data, messages: [{ ...message, timestamp: undefined }] })[0]?.id).toBe(items[0]?.id);
});

it('reads the complete Markdown report through both existing history item and oversized entry references', async () => {
  const report = '# Report\n```xml\n<tag value="&amp; literal"/>\n```\n' + '图文🙂\n'.repeat(18_000) + 'REPORT_END';
  const message: KodaXMessage = { role: 'user', _source: 'agent-completed', content: '<agent-completed>wire preview</agent-completed>',
    _taskResult: { type: 'task_result', source: 'child_task', taskId: 'large', status: 'completed', summary: report } };
  const page: RuntimeConversationHistorySlice = { revision: 'sha256:12345678', sourceRevision: 'source',
    status: 'resolved', issues: [], hasMore: false, entries: [{ index: 0, byteLength: 200_000, oversized: true,
      entry: { message, auditEntryIds: ['entry'] } }] };
  const read = async () => ({ revision: page.revision, entryIndex: 0, encoding: 'base64-json' as const,
    data: Buffer.from(JSON.stringify({ message })).toString('base64'), hasMore: false });
  const history = await projectConversationHistoryPage('session', page, read);
  expect(history.items[0]).toMatchObject({ totalTextLength: report.length, taskResult: { taskId: 'large' } });
  for (const id of [history.items[0]!.id, history.oversized[0]!.itemId]) {
    let text = '', offset = 0;
    for (;;) {
      const chunk = await readConversationHistoryEntry('session', id, read, { offset });
      expect(chunk).not.toBeNull();
      text += chunk!.text;
      if (chunk!.nextOffset === undefined) break;
      offset = chunk!.nextOffset;
    }
    expect(text.length).toBe(report.length);
    expect(createHash('sha256').update(text).digest('hex')).toBe(createHash('sha256').update(report).digest('hex'));
  }
});

it('keeps single and multiple reports in canonical order without replaying an old UI envelope', async () => {
  const results: KodaXTaskResultMetadata[] = [
    { type: 'task_result', source: 'workflow', taskId: 'task-a', runId: 'workflow-run', status: 'completed', summary: '# Same report' },
    { type: 'task_result', source: 'child_task', taskId: 'task-b', status: 'cancelled', summary: '# Same report' },
    { type: 'task_result', source: 'child_task', taskId: 'task-c', status: 'failed', summary: '[Tool Error] child failed' },
  ];
  const message: KodaXMessage = { role: 'user', _synthetic: true, _source: 'agent-completed',
    content: results.map(result => `<agent-completed turn_id="${result.taskId}">wire report</agent-completed>`).join('\n'),
    _taskResult: results[0], _taskResults: results, timestamp: '2026-10-28T00:00:00Z' };
  const data = { title: 'Reports', gitRoot: '.', messages: [message], uiHistory: [
    { id: 'old-ui', type: 'info' as const, text: String(message.content), presentationOnly: true as const },
  ] };
  const view = restoreSessionViewItems('session', data);
  expect(view.map(item => item.taskResult?.taskId)).toEqual(['task-a', 'task-b', 'task-c']);
  expect(view.map(item => item.taskResult?.status)).toEqual(['completed', 'cancelled', 'failed']);
  expect(new Set(view.map(item => item.id)).size).toBe(3);
  expect(restoreSessionViewItems('session', structuredClone(data))).toEqual(view);
  const page: RuntimeConversationHistorySlice = { revision: 'sha256:12345678', sourceRevision: 'source',
    status: 'resolved', issues: [], hasMore: false, entries: [{ index: 0, byteLength: 1, oversized: false,
      entry: { message, auditEntryIds: ['entry'] } }] };
  const history = await projectConversationHistoryPage('session', page, async () => null);
  expect(history.items.map(({ id: _id, ...item }) => item)).toEqual(view.map(({ id: _id, ...item }) => item));
  const read = async () => ({ sessionId: 'session', revision: page.revision, entryIndex: 0,
    encoding: 'base64-json' as const, data: Buffer.from(JSON.stringify({ message })).toString('base64'), hasMore: false });
  const bodies = await Promise.all(history.items.map(item => readConversationHistoryEntry('session', item.id, read)));
  expect(bodies.map(body => body?.text)).toEqual(results.map(result => result.summary));
});

it.each(['completed', 'failed', 'cancelled', undefined] as const)('reads an explicitly sourced legacy Actor report with state %s', state => {
  const body = '\n```xml\n<node title="&amp; literal">& data</node>\n```\n';
  const escaped = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const message: KodaXMessage = { role: 'user', _synthetic: true, _source: 'agent-completed',
    content: `<agent-completed path="/root/old" turn_id="old-turn"${state ? ` state="${state}"` : ''}>\n${escaped}\n</agent-completed>` };
  const item = restoreSessionViewItems('session', { title: 'Legacy', gitRoot: '.', messages: [message] })[0];
  expect(item).toMatchObject({ type: 'event', text: body,
    taskResult: { source: 'child_task', taskId: 'old-turn', status: state ?? 'unknown', reportFormat: 'markdown' } });
});

it('retains unknown legacy status and never parses an ordinary user message as a task report', () => {
  const content = '<task-completed task_id="old">failed: quoted prose, not a status field</task-completed>';
  const items = restoreSessionViewItems('session', { title: 'Legacy', gitRoot: '.', messages: [
    { role: 'user', _source: 'task-completed', _synthetic: true, content },
    { role: 'user', content },
  ] });
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ type: 'event', text: 'failed: quoted prose, not a status field',
    taskResult: { taskId: 'old', status: 'unknown' } });
  expect(items[1]).toMatchObject({ type: 'user', text: content });
  expect(items[1]).not.toHaveProperty('taskResult');
});
