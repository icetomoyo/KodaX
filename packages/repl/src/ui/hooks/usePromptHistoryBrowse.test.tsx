import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { ClientHistoryPage } from '@kodax-ai/coding/client-contract';
import type { TranscriptSnapshot } from '../utils/transcript-surface.js';
import { usePromptHistoryBrowse } from './usePromptHistoryBrowse.js';

const snapshot: TranscriptSnapshot = {
  items: [{ id: 'live', type: 'assistant', text: 'Captured response', outputId: 'output', timestamp: 0 }],
  managedLiveEvents: [], isLoading: true, isThinking: false, thinkingCharCount: 0,
  thinkingContent: '', currentResponse: '', activeToolCalls: [], toolInputCharCount: 0,
  toolInputContent: '', iterationHistory: [], currentIteration: 0, isCompacting: false,
};
const anchor = { source: 'assistant:output', character: -1, screenRow: 0 };
const page: ClientHistoryPage = { revision: 'r1', oversized: [], items: [
  { id: 'saved', outputId: 'output', type: 'assistant', text: 'Saved response' },
] };

function setup(readHistory: () => Promise<ClientHistoryPage>) {
  let api: ReturnType<typeof usePromptHistoryBrowse>;
  const plane = { readHistory };
  function Surface({ session = 's', enabled = true, status = 'running', draft = 'draft' }) {
    api = usePromptHistoryBrowse(plane, session, enabled);
    return <Text>{api.display?.snapshot.items.map(item => item.type !== 'tool_group' ? item.text : '').join('')
      ?? 'Latest response'}|{status}|{draft}</Text>;
  }
  const view = render(<Surface />);
  return { get api() { return api!; }, view, Surface };
}

describe('ordinary history body ownership', () => {
  it('freezes content on zero-height intent while controls and draft remain live; repeated gestures share one read', async () => {
    let resolve!: (value: ClientHistoryPage) => void;
    const read = vi.fn(() => new Promise<ClientHistoryPage>(done => { resolve = done; }));
    const host = setup(read);
    await new Promise(done => setTimeout(done, 0));
    host.api.browse(snapshot, anchor, true);
    host.api.browse(snapshot, anchor, true);
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Captured response'));
    host.view.rerender(<host.Surface status="permission requested" draft="edited draft" />);
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Captured response|permission requested|edited draft'));
    expect(read).toHaveBeenCalledTimes(1);
    resolve(page);
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Saved response|permission requested|edited draft'));
    host.view.unmount();
  });

  it.each(['end', 'session', 'surface'])('discards late reads after %s invalidation', async mode => {
    let resolve!: (value: ClientHistoryPage) => void;
    const host = setup(() => new Promise<ClientHistoryPage>(done => { resolve = done; }));
    await new Promise(done => setTimeout(done, 0));
    host.api.browse(snapshot, anchor, true);
    await vi.waitFor(() => expect(host.api.display).not.toBeNull());
    if (mode === 'end') host.api.reset();
    else host.view.rerender(<host.Surface session={mode === 'session' ? 'other' : 's'} enabled={mode !== 'surface'} />);
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Latest response'));
    resolve(page);
    await new Promise(done => setTimeout(done, 20));
    expect(host.api.display).toBeNull();
    expect(host.view.lastFrame()).toContain('Latest response');
    host.view.unmount();
  });

  it('keeps the captured body on read failure and retries only on another gesture', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('resync_required')).mockResolvedValue(page);
    const host = setup(read);
    await new Promise(done => setTimeout(done, 0));
    host.api.browse(snapshot, anchor, true);
    await vi.waitFor(() => expect(host.api.display?.hint).toContain('resync_required'));
    expect(host.view.lastFrame()).toContain('Captured response');
    expect(read).toHaveBeenCalledTimes(1);
    host.api.browse(snapshot, anchor, true);
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Saved response'));
    host.view.unmount();
  });
});
