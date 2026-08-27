/**
 * ToolCallDisplay rendering tests.
 *
 * The live transcript renders tool result content through the flat
 * TranscriptRow[] model (transcript-layout.ts buildToolRows / pushDiffRows),
 * NOT through this component tree — the FEATURE_141 ToolOutputBlock /
 * DiffHunk path was unreachable in the live UI and was removed. What
 * remains here is the non-leak contract: tool.output must never render
 * through ToolCallDisplay, and non-success states surface tool.error
 * instead of partial results.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ToolCallDisplay } from './ToolGroup.js';
import { ToolCallStatus, type ToolCall } from '../types.js';

const baseTool = (overrides: Partial<ToolCall>): ToolCall => ({
  id: 't1',
  name: 'edit',
  status: ToolCallStatus.Success,
  startTime: 1,
  endTime: 2,
  ...overrides,
});

describe('ToolCallDisplay — output non-leak contract', () => {
  it('does NOT render tool.output for a successful call (diff rows render via the transcript row model)', () => {
    const tool = baseTool({
      output: [
        'File edited: foo.ts',
        '  (+2 lines, -1 lines)',
        '',
        '--- foo.ts',
        '+++ foo.ts',
        '@@ -1,3 +1,4 @@',
        '-const b = 2;',
        '+const b = 3;',
      ].join('\n'),
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('edit');
    expect(out).not.toContain('File edited: foo.ts');
    expect(out).not.toContain('+const b = 3;');
  });

  it('does NOT render tool.output for an Executing tool', () => {
    const tool = baseTool({
      status: ToolCallStatus.Executing,
      output: 'partial output should not leak',
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);
    const out = lastFrame() ?? '';
    expect(out).not.toContain('partial output should not leak');
  });

  it('does NOT render tool.output for an Error tool (output is for the LLM, error message goes through tool.error)', () => {
    const tool = baseTool({
      status: ToolCallStatus.Error,
      error: '[Tool Error] read: ENOENT',
      output: '<should not show>',
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('[Tool Error] read: ENOENT');
    expect(out).not.toContain('<should not show>');
  });

  it('skips output rendering when output is non-string or empty', () => {
    const t1 = baseTool({ output: '' });
    const r1 = render(<ToolCallDisplay tool={t1} />).lastFrame() ?? '';
    expect(r1).toContain('edit'); // tool name still renders
    // No crash; no extra content section.

    const t2 = baseTool({ output: undefined });
    const r2 = render(<ToolCallDisplay tool={t2} />).lastFrame() ?? '';
    expect(r2).toContain('edit');

    const t3 = baseTool({ output: { not: 'a string' } as unknown as string });
    const r3 = render(<ToolCallDisplay tool={t3} />).lastFrame() ?? '';
    expect(r3).toContain('edit');
    // Object outputs are intentionally skipped (string-only contract).
  });
});
