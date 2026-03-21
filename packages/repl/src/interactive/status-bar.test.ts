import { describe, expect, it } from 'vitest';
import { buildStatusBarContent, createStatusBarState } from './status-bar.js';

describe('status bar', () => {
  it('shows serial execution mode by default', () => {
    const state = createStatusBarState('20260321_123456', 'accept-edits', 'openai', 'gpt-5.4', 'auto');
    const content = buildStatusBarContent(state, 160);

    expect(content).toContain('exec:serial');
  });

  it('shows parallel execution mode when enabled', () => {
    const state = createStatusBarState('20260321_123456', 'accept-edits', 'openai', 'gpt-5.4', 'auto', true);
    const content = buildStatusBarContent(state, 160);

    expect(content).toContain('exec:parallel');
  });
});
