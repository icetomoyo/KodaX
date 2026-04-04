/**
 * Tests for Argument Completer - 参数补全器测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ArgumentCompleter } from '../completers/argument-completer.js';

describe('ArgumentCompleter', () => {
  let completer: ArgumentCompleter;

  beforeEach(() => {
    completer = new ArgumentCompleter();
  });

  describe('canComplete', () => {
    it('should trigger on /mode command with space', () => {
      expect(completer.canComplete('/mode ', 6)).toBe(true);
      expect(completer.canComplete('/mode a', 7)).toBe(true);
    });

    it('should trigger on /thinking command with space', () => {
      expect(completer.canComplete('/thinking ', 10)).toBe(true);
    });

    it('should trigger on /reasoning and /reason commands with space', () => {
      expect(completer.canComplete('/reasoning ', 11)).toBe(true);
      expect(completer.canComplete('/reason ', 8)).toBe(true);
    });

    it('should trigger on exact commands that support enum-style arguments', () => {
      expect(completer.canComplete('/mode', 5)).toBe(true);
      expect(completer.canComplete('/reasoning', 10)).toBe(true);
    });

    it('should trigger on any command with space (filtering happens in getCompletions)', () => {
      // canComplete only checks format, not whether the command is known
      expect(completer.canComplete('/unknown ', 9)).toBe(true);
    });

    it('should trigger on /model command', () => {
      expect(completer.canComplete('/model ', 7)).toBe(true);
    });

    it('should trigger on /delete command', () => {
      expect(completer.canComplete('/delete ', 8)).toBe(true);
    });

    it('should not expose retired /project argument completion', async () => {
      expect(completer.canComplete('/project ', 9)).toBe(true);
      const completions = await completer.getCompletions('/project ', 9);
      expect(completions).toEqual([]);
    });

    it('should trigger on /repointel command and alias', () => {
      expect(completer.canComplete('/repointel ', 11)).toBe(true);
      expect(completer.canComplete('/ri ', 4)).toBe(true);
      expect(completer.canComplete('/repointel mode ', 16)).toBe(true);
    });

    it('should trigger on aliased commands', () => {
      expect(completer.canComplete('/t ', 3)).toBe(true); // thinking alias
    });

    it('should trigger after a newline boundary', () => {
      expect(completer.canComplete('hello\n/mode ', 12)).toBe(true);
    });
  });

  describe('getCompletions', () => {
    describe('/mode command', () => {
      it('should return all mode arguments', async () => {
        const completions = await completer.getCompletions('/mode ', 6);

        expect(completions.length).toBeGreaterThan(0);
        // Check for known mode arguments (default mode removed)
        expect(completions.some(c => c.display === 'plan')).toBe(true);
        expect(completions.some(c => c.display === 'accept-edits')).toBe(true);
        expect(completions.some(c => c.display === 'auto-in-project')).toBe(true);
      });

      it('should filter by substring (case-insensitive)', async () => {
        const completions = await completer.getCompletions('/mode a', 7);

        expect(completions.length).toBeGreaterThan(0);
        // Implementation uses includes(), not startsWith()
        expect(completions.every(c => c.display.toLowerCase().includes('a'))).toBe(true);
      });

      it('should exclude already used arguments', async () => {
        // Get all completions first
        const allCompletions = await completer.getCompletions('/mode ', 6);
        const firstArg = allCompletions[0]?.display;

        if (firstArg) {
          // Check that used argument is excluded
          const filteredCompletions = await completer.getCompletions(`/mode ${firstArg} `, 6 + firstArg.length + 1);

          // The same argument should not appear again
          expect(filteredCompletions.every(c => c.display !== firstArg)).toBe(true);
        }
      });

      it('should sort prefix matches first', async () => {
        const completions = await completer.getCompletions('/mode ac', 8);

        // accept-edits starts with 'ac'
        expect(completions.length).toBeGreaterThan(0);
        // First result should be a prefix match if any exist
        const hasPrefixMatch = completions.some(c => c.display.startsWith('ac'));
        if (hasPrefixMatch) {
          expect(completions[0]?.display.startsWith('ac')).toBe(true);
        }
      });
    });

    describe('/thinking command', () => {
      it('should return thinking arguments', async () => {
        const completions = await completer.getCompletions('/thinking ', 10);

        expect(completions.length).toBe(6);
        expect(completions.some(c => c.display === 'on')).toBe(true);
        expect(completions.some(c => c.display === 'off')).toBe(true);
        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'quick')).toBe(true);
        expect(completions.some(c => c.display === 'balanced')).toBe(true);
        expect(completions.some(c => c.display === 'deep')).toBe(true);
      });
    });

    describe('/reasoning command', () => {
      it('should return reasoning arguments for /reasoning with a space', async () => {
        const completions = await completer.getCompletions('/reasoning ', 11);

        expect(completions.some(c => c.display === 'off')).toBe(true);
        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'quick')).toBe(true);
        expect(completions.some(c => c.display === 'balanced')).toBe(true);
        expect(completions.some(c => c.display === 'deep')).toBe(true);
      });

      it('should return reasoning arguments for /reasoning without a trailing space', async () => {
        const completions = await completer.getCompletions('/reasoning', 10);

        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'balanced')).toBe(true);
      });

      it('should return reasoning arguments for /reason alias', async () => {
        const completions = await completer.getCompletions('/reason', 7);

        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'deep')).toBe(true);
      });
    });

    describe('/model command', () => {
      it('should return model arguments from providers', async () => {
        const completions = await completer.getCompletions('/model ', 7);

        expect(completions.length).toBeGreaterThan(0);
        // All completions should be provider names
        expect(completions.every(c => c.type === 'argument')).toBe(true);
      });

      it('should return provider names (not provider/model) for bare /model input', async () => {
        const completions = await completer.getCompletions('/model ', 7);

        // Provider name completions should not contain "/"
        expect(completions.every(c => !c.display.includes('/'))).toBe(true);
      });

      it('should activate canComplete for provider/model format input', () => {
        // findCommandSlashIndex correctly identifies the command prefix /
        // even when the argument contains / (e.g., provider/model)
        expect(completer.canComplete('/model anthropic/cl', 20)).toBe(true);
        expect(completer.canComplete('/model anthropic/', 19)).toBe(true);
        expect(completer.canComplete('/model zhipu-coding/glm-5', 26)).toBe(true);
      });

      it('should return models for a known provider with / separator', async () => {
        const completions = await completer.getCompletions('/model anthropic/', 18);

        expect(completions.length).toBeGreaterThan(0);
        // Two-stage: results should be in provider/model format
        expect(completions.every(c => c.display.startsWith('anthropic/'))).toBe(true);
        // Should include all known anthropic models
        const modelNames = completions.map(c => c.display.replace('anthropic/', ''));
        expect(modelNames).toContain('claude-sonnet-4-6');
        expect(modelNames).toContain('claude-opus-4-6');
        expect(modelNames).toContain('claude-haiku-4-5');
      });

      it('should include the current MiniMax model lineup for minimax-coding', async () => {
        const completions = await completer.getCompletions('/model minimax-coding/', 23);

        expect(completions.length).toBeGreaterThan(0);
        expect(completions.every(c => c.display.startsWith('minimax-coding/'))).toBe(true);

        const modelNames = completions.map(c => c.display.replace('minimax-coding/', ''));
        expect(modelNames).toContain('MiniMax-M2.7');
        expect(modelNames).toContain('MiniMax-M2.7-highspeed');
        expect(modelNames).toContain('MiniMax-M2.5');
      });

      it('should expose the default CLI bridge model for codex-cli two-stage completion', async () => {
        const completions = await completer.getCompletions('/model codex-cli/', 18);

        expect(completions.map(c => c.display)).toContain('codex-cli/gpt-5.4');
      });

      it('should expose the default CLI bridge model for gemini-cli two-stage completion', async () => {
        const completions = await completer.getCompletions('/model gemini-cli/', 19);

        expect(completions.map(c => c.display)).toContain('gemini-cli/auto-gemini-3');
      });

      it('should filter MiniMax models by provider/model partial', async () => {
        const completions = await completer.getCompletions('/model minimax-coding/M2.7', 27);

        expect(completions.map(c => c.display)).toEqual([
          'minimax-coding/MiniMax-M2.7',
          'minimax-coding/MiniMax-M2.7-highspeed',
        ]);
      });

      it('should filter models by partial text after provider/', async () => {
        const completions = await completer.getCompletions('/model anthropic/cl', 20);

        expect(completions.length).toBeGreaterThan(0);
        // All results should be anthropic models containing "cl"
        expect(completions.every(c => {
          expect(c.display.startsWith('anthropic/')).toBe(true);
          return c.display.toLowerCase().includes('cl');
        })).toBe(true);
        // Should match claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5
        expect(completions.length).toBe(3);
      });

      it('should filter models by partial matching haiku', async () => {
        const completions = await completer.getCompletions('/model anthropic/ha', 21);

        expect(completions.length).toBe(1);
        expect(completions[0]?.display).toBe('anthropic/claude-haiku-4-5');
      });

      it('should return empty for unknown provider after /', async () => {
        const completions = await completer.getCompletions('/model nonexistent_xyz/', 24);

        // Unknown provider with / format — no completions (user should backspace)
        expect(completions.length).toBe(0);
      });

      it('should return empty for unknown provider with model partial', async () => {
        const completions = await completer.getCompletions('/model nonexistent_xyz/cl', 26);

        // Unknown provider with / format — no completions
        expect(completions.length).toBe(0);
      });
    });

    describe('/plan command', () => {
      it('should return plan arguments', async () => {
        const completions = await completer.getCompletions('/plan ', 6);

        expect(completions.length).toBeGreaterThan(0);
        expect(completions.some(c => c.display === 'on')).toBe(true);
        expect(completions.some(c => c.display === 'off')).toBe(true);
        expect(completions.some(c => c.display === 'once')).toBe(true);
      });
    });

    describe('/repointel command', () => {
      it('should return top-level subcommands', async () => {
        const completions = await completer.getCompletions('/repointel ', 11);

        expect(completions.some(c => c.display === 'status')).toBe(true);
        expect(completions.some(c => c.display === 'warm')).toBe(true);
        expect(completions.some(c => c.display === 'mode')).toBe(true);
        expect(completions.some(c => c.display === 'trace')).toBe(true);
        expect(completions.some(c => c.display === 'endpoint')).toBe(true);
        expect(completions.some(c => c.display === 'bin')).toBe(true);
      });

      it('should support alias completion through /ri', async () => {
        const completions = await completer.getCompletions('/ri ', 4);

        expect(completions.some(c => c.display === 'status')).toBe(true);
        expect(completions.some(c => c.display === 'mode')).toBe(true);
      });

      it('should return runtime modes after /repointel mode', async () => {
        const completions = await completer.getCompletions('/repointel mode ', 16);

        expect(completions.some(c => c.display === 'auto')).toBe(true);
        expect(completions.some(c => c.display === 'oss')).toBe(true);
        expect(completions.some(c => c.display === 'premium-shared')).toBe(true);
        expect(completions.some(c => c.display === 'premium-native')).toBe(true);
      });

      it('should filter runtime modes by partial input', async () => {
        const completions = await completer.getCompletions('/repointel mode pre', 19);

        expect(completions.map(c => c.display)).toEqual([
          'premium-shared',
          'premium-native',
        ]);
      });

      it('should return trace toggles after /repointel trace', async () => {
        const completions = await completer.getCompletions('/repointel trace ', 17);

        expect(completions.map(c => c.display)).toContain('on');
        expect(completions.map(c => c.display)).toContain('off');
        expect(completions.map(c => c.display)).toContain('toggle');
      });

      it('should return endpoint reset helpers after /repointel endpoint', async () => {
        const completions = await completer.getCompletions('/repointel endpoint ', 20);

        expect(completions.map(c => c.display)).toContain('default');
        expect(completions.map(c => c.display)).toContain('http://127.0.0.1:47891');
      });

      it('should stop suggesting after a complete second-level repointel argument', async () => {
        const completions = await completer.getCompletions('/repointel mode premium-native ', 31);
        expect(completions).toEqual([]);
      });
    });

    describe('format', () => {
      it('should return completion with correct type', async () => {
        const completions = await completer.getCompletions('/mode ', 6);

        expect(completions.every(c => c.type === 'argument')).toBe(true);
      });

      it('should include description', async () => {
        const completions = await completer.getCompletions('/mode ', 6);

        // All completions should have descriptions
        expect(completions.every(c => c.description)).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should return empty array for unknown command', async () => {
        const completions = await completer.getCompletions('/unknown ', 9);
        expect(completions).toEqual([]);
      });

      it('should return empty array when no matches', async () => {
        const completions = await completer.getCompletions('/mode xyz', 9);
        expect(completions).toEqual([]);
      });

      it('should handle case-insensitive filtering', async () => {
        const completions = await completer.getCompletions('/mode AC', 8);

        // 'accept-edits' contains 'ac'
        expect(completions.length).toBeGreaterThan(0);
        expect(completions.some(c => c.display === 'accept-edits')).toBe(true);
      });

      it('should keep thinking alias completions working', async () => {
        const completions = await completer.getCompletions('/t ', 3);
        expect(completions.length).toBeGreaterThan(0);
        expect(completions.some(c => c.display === 'on')).toBe(true);
      });
    });
  });
});
