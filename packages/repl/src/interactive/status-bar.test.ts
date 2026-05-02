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

    expect(content).toContain('reason:auto');
  });

  it('shows reasoning mode when enabled', () => {
    const state = createStatusBarState('20260321_123456', 'accept-edits', 'openai', 'gpt-5.4', 'balanced');
    const content = buildStatusBarContent(state, 160);

    expect(content).toContain('reason:balanced');
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

describe('status bar — auto-mode engine indicator (FEATURE_092 phase 2b.8)', () => {
  it('renders auto[llm] when permissionMode=auto and engine=llm', () => {
    const state = createStatusBarState('s1', 'auto', 'kimi-code', 'kimi-for-coding', 'off');
    const content = buildStatusBarContent({ ...state, autoModeEngine: 'llm' }, 200);
    expect(content).toContain('auto');
    expect(content).toContain('[llm]');
  });

  it('renders auto[rules] when permissionMode=auto and engine=rules (downgraded)', () => {
    const state = createStatusBarState('s1', 'auto', 'kimi-code', 'kimi-for-coding', 'off');
    const content = buildStatusBarContent({ ...state, autoModeEngine: 'rules' }, 200);
    expect(content).toContain('auto');
    expect(content).toContain('[rules]');
  });

  it('renders auto-in-project[llm] for the deprecated alias too', () => {
    const state = createStatusBarState('s1', 'auto-in-project', 'kimi-code', 'kimi-for-coding', 'off');
    const content = buildStatusBarContent({ ...state, autoModeEngine: 'llm' }, 200);
    expect(content).toContain('auto-in-project');
    expect(content).toContain('[llm]');
  });

  it('omits the engine suffix entirely when autoModeEngine is undefined', () => {
    const state = createStatusBarState('s1', 'auto', 'kimi-code', 'kimi-for-coding', 'off');
    const content = buildStatusBarContent(state, 200);
    expect(content).toContain('auto');
    expect(content).not.toContain('[llm]');
    expect(content).not.toContain('[rules]');
  });

  it('does NOT render engine suffix outside auto modes (plan / accept-edits)', () => {
    const planState = createStatusBarState('s1', 'plan', 'kimi-code', 'kimi-for-coding', 'off');
    const editsState = createStatusBarState('s1', 'accept-edits', 'kimi-code', 'kimi-for-coding', 'off');
    // Even if autoModeEngine is somehow set, the suffix is gated on the mode.
    const planContent = buildStatusBarContent({ ...planState, autoModeEngine: 'rules' }, 200);
    const editsContent = buildStatusBarContent({ ...editsState, autoModeEngine: 'rules' }, 200);
    expect(planContent).not.toContain('[rules]');
    expect(editsContent).not.toContain('[rules]');
  });
});
