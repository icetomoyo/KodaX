/**
 * Unit tests for `checkIncompleteToolCalls`.
 *
 * Covers the original missing-required-param detection AND the
 * truncation guard: a tool block tagged `_truncated` (salvaged from a
 * max_tokens/length-truncated stream) is ALWAYS treated as incomplete —
 * even when every required param looks present — because the last field
 * may have been silently cut mid-value (e.g. half a `write` payload).
 * Without this guard such a block executes with corrupt input.
 */

import { describe, expect, it } from 'vitest';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import { checkIncompleteToolCalls } from './messages.js';
import { registerTool } from './tools/index.js';

function block(partial: Partial<KodaXToolUseBlock> & { name: string }): KodaXToolUseBlock {
  return { type: 'tool_use', id: 'id-1', input: {}, ...partial } as KodaXToolUseBlock;
}

describe('checkIncompleteToolCalls', () => {
  it('detects missing legacy branch fields while accepting complete consolidated calls', () => {
    expect(checkIncompleteToolCalls([
      block({ name: 'edit', input: { path: '/tmp/x' } }),
      block({ name: 'changed_diff', input: { limit: 20 } }),
    ])).toEqual(["edit: missing 'old_string'", "edit: missing 'new_string'", "changed_diff: missing 'path'"]);
    expect(checkIncompleteToolCalls([
      block({ name: 'edit', input: { path: '/tmp/x', edits: [{ old_string: 'x', new_string: 'y' }] } }),
      block({ name: 'changed_diff', input: { paths: ['x'] } }),
      block({ name: 'edit', input: { path: '/tmp/x', old_string: 'x', new_string: 'y' } }),
      block({ name: 'changed_diff', input: { path: 'x' } }),
    ])).toEqual([]);
  });

  it('detects truncated edit array elements without treating a complete deletion as truncated', () => {
    expect(checkIncompleteToolCalls([
      block({ name: 'edit', input: { path: '/tmp/x', edits: [{ old_string: 'x' }, { new_string: 'y' }] } }),
    ])).toEqual(["edit: missing 'edits[0].new_string'", "edit: missing 'edits[1].old_string'"]);
    expect(checkIncompleteToolCalls([
      block({ name: 'edit', input: { path: '/tmp/x', edits: [{ old_string: 'x', new_string: '' }] } }),
      block({ name: 'edit', input: { path: '/tmp/x', old_string: 'x', new_string: '' } }),
    ])).toEqual([]);
  });

  it.each(['edit', 'changed_diff'])('uses the active custom %s schema instead of builtin branch requirements', (name) => {
    const dispose = registerTool({
      name, description: 'Custom contract',
      input_schema: { type: 'object', properties: { custom: { type: 'string' } }, required: ['custom'] },
      handler: async () => 'ok', sideEffect: 'readonly', toClassifierInput: () => '',
    });
    try {
      expect(checkIncompleteToolCalls([block({ name, input: { custom: 'ok', edits: [{}] } })])).toEqual([]);
      expect(checkIncompleteToolCalls([block({ name, input: { paths: ['x'] } })]))
        .toEqual([`${name}: missing 'custom'`]);
    } finally { dispose(); }
  });
  it('returns empty for a complete tool call', () => {
    expect(checkIncompleteToolCalls([block({ name: 'read', input: { path: '/tmp/x' } })])).toEqual([]);
  });

  it('flags a tool call missing a required param', () => {
    // write requires `content`; only file_path supplied.
    const out = checkIncompleteToolCalls([block({ name: 'write', input: { file_path: '/tmp/x' } })]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(' ')).toMatch(/write/);
  });

  it('flags a _truncated block (any tool) even when all required params look present', () => {
    const out = checkIncompleteToolCalls([
      block({ name: 'write', input: { file_path: '/tmp/x', content: 'half a file…' }, _truncated: true }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/salvaged|truncat/i);
  });

  it('flags a _truncated read-only tool too (truncation is unsafe for any tool)', () => {
    const out = checkIncompleteToolCalls([
      block({ name: 'read', input: { path: '/some/trunca' }, _truncated: true }),
    ]);
    expect(out.length).toBe(1);
  });

  // P1: _salvaged (clean stop, NOT _truncated) — gated by tool side-effect.
  it('flags a _salvaged MUTATING tool on a clean stop (malformed JSON could be silently cut mid-value)', () => {
    const out = checkIncompleteToolCalls([
      block({ name: 'write', input: { file_path: '/tmp/x', content: 'looks complete but salvaged' }, _salvaged: true }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/salvaged|malformed/i);
  });

  it('does NOT flag a _salvaged READ-ONLY tool on a clean stop (low risk; avoids needless retry loop)', () => {
    const out = checkIncompleteToolCalls([
      block({ name: 'read', input: { path: '/tmp/x' }, _salvaged: true }),
    ]);
    expect(out).toEqual([]);
  });

  it('in a mixed turn flags only the untrusted block, not the complete sibling', () => {
    const out = checkIncompleteToolCalls([
      block({ name: 'write', id: 'w1', input: { file_path: '/x', content: 'half…' }, _truncated: true }),
      block({ name: 'read', id: 'r1', input: { path: '/y' } }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/write/);
  });
});
