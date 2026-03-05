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

    it('should not trigger on command without space', () => {
      expect(completer.canComplete('/mode', 5)).toBe(false);
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

    it('should trigger on aliased commands', () => {
      expect(completer.canComplete('/m ', 3)).toBe(true); // mode alias
      expect(completer.canComplete('/t ', 3)).toBe(true); // thinking alias
    });
  });

  describe('getCompletions', () => {
    describe('/mode command', () => {
      it('should return all mode arguments', async () => {
        const completions = await completer.getCompletions('/mode ', 6);

        expect(completions.length).toBeGreaterThan(0);
        // Check for known mode arguments
        expect(completions.some(c => c.display === 'plan')).toBe(true);
        expect(completions.some(c => c.display === 'default')).toBe(true);
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

        expect(completions.length).toBe(2);
        expect(completions.some(c => c.display === 'on')).toBe(true);
        expect(completions.some(c => c.display === 'off')).toBe(true);
      });
    });

    describe('/model command', () => {
      it('should return model arguments from providers', async () => {
        const completions = await completer.getCompletions('/model ', 7);

        expect(completions.length).toBeGreaterThan(0);
        // All completions should be provider names
        expect(completions.every(c => c.type === 'argument')).toBe(true);
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

      it('should work with command aliases', async () => {
        const completions = await completer.getCompletions('/m ', 3);
        // /m is alias for /mode
        expect(completions.length).toBeGreaterThan(0);
        expect(completions.some(c => c.display === 'plan')).toBe(true);
      });
    });
  });
});
