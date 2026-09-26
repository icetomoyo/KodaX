import { describe, expect, it, vi } from 'vitest';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import type { ClientObservationStatus, ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { attachClassicPlaneDisplay, createClassicPlaneDisplayDiffer } from './classic-plane-display.js';
import { applyClientSessionViewSettings } from '../ui/client-session-settings.js';
import type { CurrentConfig } from '../commands/types.js';
import { createClassicPlaneDialogSurface } from './classic-plane-interactions.js';

it('updates a Verifier classification without repeating unchanged or restored notices', async () => {
  const lines: string[] = [];
  const display = createClassicPlaneDisplayDiffer(line => lines.push(line));
  const item = { id: 'verifier', type: 'sidecar' as const, text: 'Same advice' };
  await display([{ ...item, sidecar: { verdict: 'revise' } }]);
  await display([{ ...item, sidecar: { verdict: 'revise' } }]);
  expect(lines).toEqual([]);
  await display([{ ...item, sidecar: { verdict: 'blocked' } }]);
  await display([{ ...item, sidecar: { verdict: 'blocked' } }]);
  expect(lines).toEqual(['sidecar:Sidecar Verifier — blocked\nSame advice']);
  await display([{ ...item, sidecar: { verdict: 'blocked', delivery: 'budget-exhausted' } }]);
  expect(lines.at(-1)).toBe('sidecar:Sidecar Verifier — budget exhausted\nSame advice');
  expect(lines).toHaveLength(2);
});

it('announces observed compaction once per active phase, including first attach, without replay on reattach', async () => {
  const lines: string[] = [];
  const display = createClassicPlaneDisplayDiffer(line => lines.push(line));
  await display([], { runId: 'first', compacting: true });
  await display([], { runId: 'first', compacting: true });
  expect(lines).toEqual(['info:[KodaX] Compacting context...']);
  await display([], { runId: 'first', compacting: false });
  await display([], { runId: 'first', compacting: true });
  expect(lines).toHaveLength(2);
  await display([], { runId: 'second', compacting: true });
  expect(lines).toHaveLength(3);
  await display([], { runId: 'second', compacting: false });
  expect(lines).toHaveLength(3);
});

it.each(['client', 'unavailable'] as const)('retires answered questions and %s observations without stale answers', async reason => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = readline.createInterface({ input, output, terminal: false });
  let printed = '';
  output.on('data', chunk => { printed += String(chunk); });
  let receive: ((view: ClientSessionView) => void) | undefined;
  let status: ((state: ClientObservationStatus) => void) | undefined;
  const onNotice = vi.fn();
  const respondInteraction = vi.fn(async () => true);
  const close = await attachClassicPlaneDisplay({
    observe: async (_sessionId, listener, options) => { receive = listener; status = options?.onStatus; return () => undefined; },
    readItem: async () => null, respondInteraction,
  }, 'session', { onNotice, dialogs: createClassicPlaneDialogSurface({ rl, permissionMode: () => 'accept-edits' }) });
  const question = (requestId: string) => ({ requestId, sessionId: 'session', runId: 'run',
    kind: 'question_input' as const, options: { question: requestId }, createdAt: '2026-09-14T00:00:00Z',
    expiresAt: '2026-09-14T01:00:00Z' });
  const view: ClientSessionView = { session: { id: 'session', title: '' }, settings: {},
    items: [], queue: [], runs: [], interactions: [question('first')] };
  try {
    receive?.(view);
    await vi.waitFor(() => expect(printed).toContain('first:'));
    receive?.({ ...view, interactions: [question('second')] });
    await vi.waitFor(() => expect(printed).toContain('second:'), { timeout: 300 });
    expect(respondInteraction).not.toHaveBeenCalled();
    if (reason === 'client') close();
    else status?.({ state: 'closed', reason });
    input.write('late answer\n');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(respondInteraction).not.toHaveBeenCalled();
    if (reason === 'unavailable') expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  } finally { close(); rl.close(); input.destroy(); output.destroy(); }
});

it('updates classic settings from its existing display observation without writing them back', async () => {
  let config: CurrentConfig = { provider: 'anthropic', model: 'startup', permissionMode: 'accept-edits',
    agentMode: 'sa', thinking: false, reasoningMode: 'off' };
  let receive: ((view: ClientSessionView) => void) | undefined;
  let subscriptions = 0;
  const close = await attachClassicPlaneDisplay({
    observe: async (_sessionId, listener) => { subscriptions += 1; receive = listener; return () => undefined; },
    readItem: async () => null,
    respondInteraction: async () => false,
  }, 'session', { onView: view => { config = applyClientSessionViewSettings(config, view); } });
  const view: ClientSessionView = { session: { id: 'session', title: '' }, settings: { model: 'peer-model', permissionMode: 'plan' },
    items: [], queue: [], runs: [], interactions: [] };
  receive?.(view);
  expect(config).toMatchObject({ model: 'peer-model', permissionMode: 'plan' });
  expect(subscriptions).toBe(1);
  close();
  receive?.({ ...view, settings: { model: 'too-late' } });
  expect(config.model).toBe('peer-model');
});

function item(overrides: Partial<ClientViewItem> & Pick<ClientViewItem, 'id' | 'type' | 'text'>): ClientViewItem {
  return { timestamp: 1_700_000_000_000, ...overrides };
}

describe('createClassicPlaneDisplayDiffer (T18)', () => {
  it('rejects a body page whose declared length contradicts the captured view', async () => {
    const lines: string[] = [];
    const display = createClassicPlaneDisplayDiffer(line => lines.push(line), async (id, options) => ({
      id, offset: options.offset ?? 0, text: 'whole-body', totalLength: 2,
    }));
    await display([]);
    await expect(display([item({ id: 'body', type: 'assistant', text: 'body', textOffset: 6, totalTextLength: 10 })]))
      .rejects.toThrow(/inconsistent|changed|incomplete/i);
    expect(lines).toEqual([]);
  });

  it('prints explicit same-item revisions and resumes appending without replaying settled snapshots', async () => {
    const lines: string[] = [];
    const readItem = vi.fn(async () => null);
    const display = createClassicPlaneDisplayDiffer(line => lines.push(line), readItem);
    const output = (id: string, text: string) => item({ id, type: 'assistant', text });
    await display([]);
    await display([output('first', 'abc')]);
    await display([output('first', 'xyz')]);
    await display([output('first', 'xy')]);
    await display([output('first', 'xy!')]);
    // Settlement and reconnect replace the view with the same identities.
    await display([output('first', 'xy!')]);
    await display([output('first', 'xy!'), output('second', 'xy!')]);
    await display([output('first', 'xy!'), output('second', 'xy!')]);
    expect(lines).toEqual(['assistant:abc', 'assistant:\n[Updated response]\nxyz',
      'assistant:\n[Updated response]\nxy', 'assistant:!', 'assistant:xy!']);
    expect(readItem).not.toHaveBeenCalled();
  });

  it('reads an omitted prefix once when the Host revises it and keeps ordinary bounded appends local', async () => {
    const lines: string[] = [];
    const readItem = vi.fn(async (id: string, options: { offset?: number }) => ({
      id, text: 'XYZdefgh'.slice(options.offset), offset: options.offset ?? 0, totalLength: 8, textRevision: 1,
    }));
    const display = createClassicPlaneDisplayDiffer(line => lines.push(line), readItem);
    const output = (text: string, offset: number, length: number, revision: number) => item({
      id: 'output', type: 'assistant', text, textOffset: offset, totalTextLength: length,
      ...{ textRevision: revision },
    });
    await display([]);
    await display([output('abcdef', 0, 6, 0)]);
    await display([output('fgh', 5, 8, 0)]);
    expect(readItem).not.toHaveBeenCalled();
    // The retained suffix is identical, but the Host changed the omitted prefix.
    await display([output('fgh', 5, 8, 1)]);
    await display([output('fgh', 5, 8, 1)]);
    await display([output('ghi', 6, 9, 1)]);
    expect(lines).toEqual(['assistant:abcdef', 'assistant:gh',
      'assistant:\n[Updated response]\nXYZdefgh', 'assistant:i']);
    expect(readItem).toHaveBeenCalledOnce();
    expect(readItem).toHaveBeenCalledWith('output', { offset: 0, part: 'text' });
  });

  it.each([false, true])('verifies a bounded draft-to-commit handoff once after revision reset (changed=%s)', async changed => {
    const lines: string[] = [];
    const read = vi.fn(async (id: string) => ({ id, text: changed ? 'XYZdefgh' : 'abcdefgh', offset: 0,
      totalLength: 8, textRevision: 0, ...{ outputState: 'committed' as const },
    }));
    const display = createClassicPlaneDisplayDiffer(line => lines.push(line), read);
    const base = { id: 'output', type: 'assistant' as const, textRevision: 0 };
    await display([]);
    await display([{ ...base, text: 'abcdef', outputState: 'draft' }]);
    await display([{ ...base, text: 'fgh', textOffset: 5, totalTextLength: 8, outputState: 'draft' }]);
    expect(read).not.toHaveBeenCalled();
    const committed = { ...base, text: 'fgh', textOffset: 5, totalTextLength: 8, outputState: 'committed' as const };
    await display([committed]);
    await display([committed]);
    expect(read).toHaveBeenCalledOnce();
    expect(lines).toEqual(['assistant:abcdef', 'assistant:gh',
      ...(changed ? ['assistant:\n[Updated response]\nXYZdefgh'] : [])]);
  });
  it.each(['revision', 'state'] as const)('rejects mixed assistant pages when %s changes without replaying printed text', async change => {
    const lines: string[] = [];
    const read = vi.fn(async (id: string, options: { offset?: number }) => {
      const offset = options.offset ?? 0;
      return { id, text: offset === 4 ? 'efgh' : 'tail', offset, totalLength: 12,
        ...(offset === 4 ? { nextOffset: 8 } : {}), textRevision: offset === 8 && change === 'revision' ? 1 : 0,
        ...{ outputState: offset === 8 && change === 'state' ? 'committed' as const : 'draft' as const },
      };
    });
    const display = createClassicPlaneDisplayDiffer(line => lines.push(line), read);
    const base = { id: 'output', type: 'assistant' as const, textRevision: 0, outputState: 'draft' as const };
    await display([]);
    await display([{ ...base, text: 'abcd' }]);
    await expect(display([{ ...base, text: 'tail', textOffset: 8, totalTextLength: 12 }])).rejects.toThrow('changed');
    expect(lines).toEqual(['assistant:abcd']);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('keeps split UTF-16 characters unchanged when confirming the committed prefix', async () => {
    const lines: string[] = [];
    const display = createClassicPlaneDisplayDiffer(line => lines.push(line), async id => ({
      id, text: '😀tail', offset: 0, totalLength: 6, outputState: 'committed', textRevision: 0,
    }));
    const draft = { id: 'unicode', type: 'assistant' as const, outputState: 'draft' as const, textRevision: 0 };
    await display([]);
    await display([{ ...draft, text: '\uD83D' }]);
    await display([{ ...draft, text: '😀' }]);
    await display([{ ...draft, text: 'tail', textOffset: 2, totalTextLength: 6 }]);
    await display([{ ...draft, text: 'tail', textOffset: 2, totalTextLength: 6, outputState: 'committed' }]);
    expect(lines).toEqual(['assistant:\uD83D', 'assistant:\uDE00', 'assistant:tail']);
  });

  it('prints one count snapshot per streaming phase, retaining it across reconnect snapshots', async () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer(line => lines.push(line));
    const thinking = { runId: 'run', streaming: { kind: 'thinking' as const, providerRequestId: 'request', itemId: 'thought', charCount: 5 } };
    await differ([], thinking);
    await differ([], { ...thinking, streaming: { ...thinking.streaming, charCount: 1000 } });
    // Reconnected initial snapshots reuse this same session differ.
    await differ([], thinking);
    const tool = { runId: 'run', streaming: { kind: 'tool-input' as const, providerRequestId: 'request', toolName: 'read', callId: 'one', charCount: 8 } };
    await differ([], tool);
    await differ([], { ...tool, streaming: { ...tool.streaming, charCount: 1000 } });
    await differ([], { ...tool, streaming: { ...tool.streaming, callId: 'two', charCount: 2 } });
    await differ([], { runId: 'run' });
    await differ([], tool);
    expect(lines).toEqual(['info:Thinking (5 chars received so far)', 'info:Receiving read (8 chars received so far)',
      'info:Receiving read (2 chars received so far)', 'info:Receiving read (8 chars received so far)']);
  });

  it('does not invent a cumulative count for anonymous tool input', async () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer(line => lines.push(line));
    const activity = { runId: 'run', streaming: { kind: 'tool-input' as const, providerRequestId: 'request', toolName: 'read' } };
    await differ([], activity);
    await differ([], activity);
    expect(lines).toEqual(['info:Receiving read']);
  });

  it('prints each interleaved call only once until its request changes or streaming ends', async () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer(line => lines.push(line));
    const first = { runId: 'run', streaming: { kind: 'tool-input' as const,
      providerRequestId: 'request', toolName: 'read', callId: 'one', charCount: 2 } };
    const second = { ...first, streaming: { ...first.streaming, callId: 'two', charCount: 3 } };
    await differ([], first);
    await differ([], second);
    await differ([], { ...first, streaming: { ...first.streaming, charCount: 1000 } });
    await differ([], second);
    expect(lines).toEqual(['info:Receiving read (2 chars received so far)',
      'info:Receiving read (3 chars received so far)']);
    await differ([], { ...first, streaming: { ...first.streaming, providerRequestId: 'next' } });
    await differ([]);
    await differ([], first);
    expect(lines).toHaveLength(4);
  });

  it('prints complete bounded tool arguments and final output', async () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer(line => lines.push(line), async (id, options) => {
      const full = options.part === 'input' ? 'full-args' : 'full-output';
      return { id, text: full.slice(options.offset), offset: options.offset ?? 0, totalLength: full.length };
    });
    await differ([]);
    await differ([item({ id: 't', type: 'tool', text: '', tool: {
      callId: 'c', name: 'read', status: 'running', inputText: 'full', totalInputLength: 9,
    } })]);
    await differ([item({ id: 't', type: 'tool', text: 'put', textOffset: 8, totalTextLength: 11, tool: {
      callId: 'c', name: 'read', status: 'success', inputText: 'full', totalInputLength: 9,
    } })]);
    expect(lines).toEqual(['tool:▶ read full-args', 'tool:✓ read full-output']);
  });
  it('prints every assistant character when the Host view advances a bounded tail', async () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line), async (id, options) => ({
      id, text: 'abcdefghi'.slice(options.offset), offset: options.offset ?? 0, totalLength: 9,
    }));
    await differ([]);
    await differ([item({ id: 'a', type: 'assistant', text: 'def', textOffset: 3, totalTextLength: 6 })]);
    await differ([item({ id: 'a', type: 'assistant', text: 'ghi', textOffset: 6, totalTextLength: 9 })]);
    expect(lines.map((line) => line.slice('assistant:'.length)).join('')).toBe('abcdefghi');
  });
  it('skips the baseline view so restored history does not reprint', () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line));
    differ([
      item({ id: 'u1', type: 'user', text: 'old question' }),
      item({ id: 'a1', type: 'assistant', text: 'old answer' }),
    ]);
    expect(lines).toEqual([]);
  });

  it('streams assistant suffixes as the trailing item grows', () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line));
    differ([item({ id: 'a1', type: 'assistant', text: 'old' })]);
    differ([
      item({ id: 'a1', type: 'assistant', text: 'old' }),
      item({ id: 'u2', type: 'user', text: 'new question' }),
      item({ id: 'a2', type: 'assistant', text: 'Repo' }),
    ]);
    differ([
      item({ id: 'a1', type: 'assistant', text: 'old' }),
      item({ id: 'u2', type: 'user', text: 'new question' }),
      item({ id: 'a2', type: 'assistant', text: 'Repository summary.' }),
    ]);
    expect(lines).toEqual(['assistant:Repo', 'assistant:sitory summary.']);
  });

  it('prints tool lifecycle once per stage and final output', () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line));
    differ([]);
    differ([
      item({
        id: 't1', type: 'tool', text: '',
        tool: { callId: 'c1', name: 'bash', status: 'running', inputText: 'npm test' },
      }),
    ]);
    differ([
      item({
        id: 't1', type: 'tool', text: 'all passing',
        tool: { callId: 'c1', name: 'bash', status: 'success', inputText: 'npm test', endedAt: 1 },
      }),
    ]);
    expect(lines).toEqual([
      'tool:▶ bash npm test',
      'tool:✓ bash all passing',
    ]);
  });

  it('prints notice kinds once and thinking as a dim preview', () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line));
    differ([]);
    differ([item({ id: 'i1', type: 'info', text: 'Context compacted.' })]);
    differ([item({ id: 'i1', type: 'info', text: 'Context compacted.' })]);
    differ([item({ id: 'k1', type: 'thinking', text: 'long reasoning '.repeat(20) })]);
    expect(lines).toEqual([
      'info:Context compacted.',
      `thinking:[Thinking] ${'long reasoning '.repeat(20).slice(0, 100)}...`,
    ]);
  });

  it('keeps awaiting_approval live and prints cancelled with a neutral mark', () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line));
    differ([]);
    differ([
      item({
        id: 't3', type: 'tool', text: '',
        tool: { callId: 'c3', name: 'bash', status: 'awaiting_approval', inputText: 'rm -rf x' },
      }),
    ]);
    differ([
      item({
        id: 't3', type: 'tool', text: '',
        tool: { callId: 'c3', name: 'bash', status: 'running', inputText: 'rm -rf x' },
      }),
    ]);
    differ([
      item({
        id: 't3', type: 'tool', text: 'gone',
        tool: { callId: 'c3', name: 'bash', status: 'cancelled', inputText: 'rm -rf x', endedAt: 1 },
      }),
    ]);
    expect(lines).toEqual([
      'tool:▶ bash rm -rf x',
      'tool:• bash gone',
    ]);
  });

  it('does not reprint restored completed tools after the baseline', () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line));
    const restored = item({
      id: 't-old', type: 'tool', text: 'past output',
      tool: { callId: 'c-old', name: 'bash', status: 'success', inputText: 'npm test', endedAt: 1 },
    });
    differ([restored]);
    // Production observe pushes keep restored items in the window; the
    // baseline :done priming must suppress the terminal line reprint.
    differ([
      restored,
      item({ id: 'a9', type: 'assistant', text: 'new' }),
    ]);
    expect(lines).toEqual(['assistant:new']);
  });

  it('prints tool error status with its output', () => {
    const lines: string[] = [];
    const differ = createClassicPlaneDisplayDiffer((line) => lines.push(line));
    differ([]);
    differ([
      item({
        id: 't2', type: 'tool', text: 'command failed',
        tool: { callId: 'c2', name: 'bash', status: 'error', inputText: 'npm run dev' },
      }),
    ]);
    expect(lines).toEqual(['tool:✗ bash command failed']);
  });
});
