import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStatusBarContent, createStatusBarState, supportsStatusBar } from './status-bar.js';

const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function restoreStdoutIsTTY(): void {
  if (stdoutIsTTYDescriptor) {
    Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTYDescriptor);
    return;
  }

  delete (process.stdout as { isTTY?: boolean }).isTTY;
}

describe('status bar', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreStdoutIsTTY();
  });

  it('shows sequential execution mode by default', () => {
    const state = createStatusBarState('20260321_123456', 'accept-edits', 'openai', 'gpt-5.4', 'auto');
    const content = buildStatusBarContent(state, 160);

    expect(content).toContain('exec:sequential');
  });

  it('shows parallel execution mode when enabled', () => {
    const state = createStatusBarState('20260321_123456', 'accept-edits', 'openai', 'gpt-5.4', 'auto', true);
    const content = buildStatusBarContent(state, 160);

    expect(content).toContain('exec:parallel');
  });

  it('disables the classic status bar in VS Code terminals to preserve scrollback', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('WT_SESSION', undefined);

    expect(supportsStatusBar()).toBe(false);
  });

  it('disables the classic status bar in Windows Terminal sessions to preserve scrollback', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('TERM_PROGRAM', '');
    vi.stubEnv('WT_SESSION', '1');

    expect(supportsStatusBar()).toBe(false);
  });
});
