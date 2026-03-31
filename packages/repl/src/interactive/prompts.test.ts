import { describe, expect, it, vi, afterEach } from 'vitest';
import { confirmToolExecution } from './prompts.js';

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

describe('confirmToolExecution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the safety reason only once for protected confirmations', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rl = {
      question: (_prompt: string, callback: (answer: string) => void) => callback('n'),
    } as any;

    await confirmToolExecution(
      rl,
      'write',
      {
        path: 'README.md',
        _reason: 'Outside the project root.',
      },
      {
        isOutsideProject: true,
        reason: 'Outside the project root.',
      },
    );

    const rendered = logSpy.mock.calls
      .flat()
      .map((entry) => stripAnsi(String(entry)))
      .join('\n');
    const matches = rendered.match(/Outside the project root\./g) ?? [];

    expect(matches).toHaveLength(1);
  });

  it('shows protected-path scope even when the flag is passed via options', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rl = {
      question: (_prompt: string, callback: (answer: string) => void) => callback('n'),
    } as any;

    await confirmToolExecution(
      rl,
      'write',
      {
        path: 'README.md',
      },
      {
        isProtectedPath: true,
      },
    );

    const rendered = logSpy.mock.calls
      .flat()
      .map((entry) => stripAnsi(String(entry)))
      .join('\n');

    expect(rendered).toContain('Scope: Protected path');
  });
});
