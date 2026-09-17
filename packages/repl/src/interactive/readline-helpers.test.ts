import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentConfig } from '../commands/types.js';

const { getTerminalWidthMock } = vi.hoisted(() => ({
  getTerminalWidthMock: vi.fn<() => number>(),
}));

vi.mock('./prompts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prompts.js')>()),
  getTerminalWidth: getTerminalWidthMock,
}));

import { getPrompt, needsContinuation } from './readline-helpers.js';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function createConfig(overrides: Partial<CurrentConfig> = {}): CurrentConfig {
  return {
    provider: 'openai',
    model: 'gpt-5.3-codex',
    thinking: true,
    reasoningMode: 'auto',
    agentMode: 'ama',
    permissionMode: 'accept-edits',
    ...overrides,
  };
}

describe('readline helpers', () => {
  beforeEach(() => {
    getTerminalWidthMock.mockReturnValue(120);
  });

  describe('getPrompt', () => {
    it('shows Host default after clearing an unspecified permission and reasoning selection', () => {
      const prompt = stripAnsi(getPrompt('plan', createConfig({ reasoningMode: 'deep', effort: 'high', hostSettings: {} })));
      expect(prompt).toContain('kodax:Host default');
      expect(prompt).toContain('[effort:Host default]');
      expect(prompt).not.toContain('kodax:plan');
    });
    it('renders the V2 reasoning effort label on wide terminals', () => {
      const prompt = stripAnsi(getPrompt(
        'default',
        createConfig({ effort: 'max', effortOverride: true }),
      ));

      expect(prompt).toContain('kodax:default (openai:gpt-5.3-codex)');
      expect(prompt).toContain('[effort:max->xhigh]');
    });

    it('keeps the compact prompt effort-first on medium terminals', () => {
      getTerminalWidthMock.mockReturnValue(80);

      const prompt = stripAnsi(getPrompt(
        'default',
        createConfig({ effort: 'max', effortOverride: true }),
      ));

      expect(prompt).toContain('kodax:default[max->xhigh]> ');
      expect(prompt).not.toContain('reason:');
    });
  });

  describe('needsContinuation', () => {
    it('continues after a single trailing backslash', () => {
      expect(needsContinuation('echo \\')).toBe(true);
      expect(needsContinuation('echo \\\\')).toBe(false);
    });

    it('continues while brackets or strings remain open', () => {
      expect(needsContinuation('const value = {')).toBe(true);
      expect(needsContinuation('const value = {}')).toBe(false);
      expect(needsContinuation('"unfinished')).toBe(true);
      expect(needsContinuation('"finished"')).toBe(false);
    });
  });
});
