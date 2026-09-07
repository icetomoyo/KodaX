import { describe, expect, it } from 'vitest';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { createClassicPlaneDisplayDiffer } from './classic-plane-display.js';

function item(overrides: Partial<ClientViewItem> & Pick<ClientViewItem, 'id' | 'type' | 'text'>): ClientViewItem {
  return { timestamp: 1_700_000_000_000, ...overrides };
}

describe('createClassicPlaneDisplayDiffer (T18)', () => {
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
