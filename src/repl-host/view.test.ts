import { describe, expect, it } from 'vitest';
import type { ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';

import { LocalSessionView } from '../host-protocol/view.js';
import { toSessionView } from '../runtime-daemon/host-view.js';
import { createClientViewMapper, toClientSession } from './view.js';

const STARTED = '2026-11-22T08:00:00.000Z';

function v1View(items: readonly ClientViewItem[], rest: Partial<ClientSessionView> = {}): ClientSessionView {
  return {
    session: { id: 'session-1', title: 'View' }, settings: {}, interactions: [], queue: [], runs: [], items, ...rest,
  } as ClientSessionView;
}

/** What the Host sends a local client for a v1 view. */
function v2(view: ClientSessionView): LocalSessionView {
  return LocalSessionView.parse(toSessionView(view));
}

describe('a v2 view in the shapes the REPL renders', () => {
  it('names the Session, its Runs, its queue and its questions as v1 did', () => {
    const source = v1View([], {
      session: {
        id: 'session-1', title: 'View', archived: false, msgCount: 4, metadataRevision: '3',
        createdAt: STARTED, lastMessageAt: STARTED, recovery: { state: 'stalled', since: STARTED, code: 'actor_settlement_not_persisted' },
        workspaceRoot: 'C:/work', executionCwd: 'C:/work',
      } as ClientSessionView['session'],
      runs: [{ runId: 'run-1', phase: 'running', provider: 'anthropic', model: 'sonnet' }],
      queue: [{ inputId: 'input-1', text: 'next', enqueuedAt: 5 }],
      interactions: [{
        requestId: 'ask-1', sessionId: 'session-1', runId: 'run-1', createdAt: STARTED, kind: 'question',
        options: { question: 'Which?', options: [{ label: 'A', value: 'a' }] },
      } as ClientSessionView['interactions'][number]],
    });
    const view = createClientViewMapper()(v2(source));
    expect(view.session).toEqual(source.session);
    expect(view.runs).toEqual(source.runs);
    expect(view.queue).toEqual(source.queue);
    expect(view.interactions).toEqual(source.interactions);
  });

  it('keeps where a long reply starts, who wrote it and the input it answers', () => {
    const items: ClientViewItem[] = [
      { id: 'user-1', type: 'user', text: 'hi', timestamp: 1, inputId: 'input-1' },
      {
        id: 'reply-1', type: 'assistant', text: 'tail', textOffset: 96, totalTextLength: 100,
        timestamp: 2, sourceRunId: 'run-1', outputState: 'committed',
      },
      {
        id: 'tool-1', type: 'tool', text: 'out', timestamp: 3, sourceRunId: 'run-1',
        tool: { callId: 'call-1', name: 'read', status: 'success', inputText: '{}', totalInputLength: 2, startedAt: 3, endedAt: 4 },
      },
    ];
    const view = createClientViewMapper()(v2(v1View(items)));
    expect(view.items).toEqual(items.map(item => ({ ...item, textRevision: 0 })));
  });

  it('marks output a Run is still writing as a draft', () => {
    const draft: ClientViewItem = { id: 'reply-1', type: 'assistant', text: 'par', sourceRunId: 'run-1', outputState: 'draft' };
    const view = createClientViewMapper()(v2(v1View([draft], {
      runs: [{ runId: 'run-1', phase: 'running', provider: 'anthropic' }],
    })));
    expect(view.items[0]?.outputState).toBe('draft');
  });

  it('shows a retry or a compaction with the icon v1 gave it', () => {
    const notices: ClientViewItem[] = [
      { id: 'notice-1', type: 'info', text: 'Retrying', icon: '⏳' },
      { id: 'notice-2', type: 'info', text: 'Compacted', icon: '✨' },
    ];
    const view = createClientViewMapper()(v2(v1View(notices)));
    expect(view.items.map(item => item.icon)).toEqual(['⏳', '✨']);
  });

  it('counts a rewrite of an item it saw, and not an extension of it', () => {
    const map = createClientViewMapper();
    const reply = (text: string): ClientViewItem => ({ id: 'reply-1', type: 'assistant', text, outputState: 'committed' });
    expect(map(v2(v1View([reply('Hello')]))).items[0]?.textRevision).toBe(0);
    expect(map(v2(v1View([reply('Hello there')]))).items[0]?.textRevision).toBe(0);
    expect(map(v2(v1View([reply('Goodbye')]))).items[0]?.textRevision).toBe(1);
    expect(map(v2(v1View([reply('Hel')]))).items[0]?.textRevision).toBe(2);
    expect(map.textVersion('reply-1')).toEqual({ textRevision: 2, outputState: 'committed' });
    expect(map.textVersion('gone')).toBeUndefined();
  });

  it('compares only the text both versions of a long reply hold', () => {
    const map = createClientViewMapper();
    const tail = (text: string, total: number): ClientViewItem => ({
      id: 'reply-1', type: 'assistant', text, textOffset: total - text.length, totalTextLength: total,
    });
    map(v2(v1View([tail('abcdef', 10)])));
    expect(map(v2(v1View([tail('efgh', 12)]))).items[0]?.textRevision).toBe(0);
    expect(map(v2(v1View([tail('XXgh', 12)]))).items[0]?.textRevision).toBe(1);
  });

  it('gives the file a tool changed, or would change, by its path on the Host, as v1 did', () => {
    const change = { path: 'C:/work/app/a.txt', added: 1, removed: 0, unified: '@@ -0,0 +1,1 @@\n+a' };
    const source = v1View([{
      id: 'tool-1', type: 'tool', text: 'ok', sourceRunId: 'run-1',
      tool: { callId: 'call-1', name: 'write', status: 'success', fileChange: change },
    }], {
      interactions: [{
        requestId: 'allow-1', sessionId: 'session-1', runId: 'run-1', createdAt: STARTED, kind: 'permission',
        options: { toolName: 'write', toolCallId: 'call-2', inputPreview: '{}', diff: change },
      } as ClientSessionView['interactions'][number]],
    });
    const view = createClientViewMapper()(LocalSessionView.parse(toSessionView(source, 'C:/work')));
    expect(view.items[0]?.tool?.fileChange).toEqual(change);
    expect(view.interactions).toEqual(source.interactions);
  });

  it('turns a listed Session into the v1 Session the resume picker reads', () => {
    expect(toClientSession({ id: 'session-2', title: 'Old', archived: false, messageCount: 7, lastMessageAt: Date.parse(STARTED) }))
      .toEqual({ id: 'session-2', title: 'Old', archived: false, msgCount: 7, lastMessageAt: STARTED });
  });
});
