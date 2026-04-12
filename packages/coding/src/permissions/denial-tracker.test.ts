import { describe, it, expect } from 'vitest';
import {
  createDenialTracker,
  recordDenial,
  isDeniedRecently,
  getDenialContext,
  computeInputSignature,
} from './denial-tracker.js';

describe('denial-tracker', () => {
  describe('createDenialTracker', () => {
    it('should create empty tracker', () => {
      const tracker = createDenialTracker();
      expect(tracker.records).toEqual([]);
    });
  });

  describe('computeInputSignature', () => {
    it('should compute bash signature from first 3 tokens', () => {
      const sig = computeInputSignature('bash', {
        command: 'rm -rf node_modules extra args',
      });
      expect(sig).toBe('bash:rm -rf node_modules');
    });

    it('should compute bash signature with fewer tokens', () => {
      const sig = computeInputSignature('bash', { command: 'ls -la' });
      expect(sig).toBe('bash:ls -la');
    });

    it('should compute bash signature with single token', () => {
      const sig = computeInputSignature('bash', { command: 'pwd' });
      expect(sig).toBe('bash:pwd');
    });

    it('should handle empty bash command', () => {
      const sig = computeInputSignature('bash', { command: '' });
      expect(sig).toBe('bash:');
    });

    it('should handle bash command with leading/trailing whitespace', () => {
      const sig = computeInputSignature('bash', {
        command: '  git status  ',
      });
      expect(sig).toBe('bash:git status');
    });

    it('should compute edit signature from file path', () => {
      const sig = computeInputSignature('edit', {
        file_path: '/path/to/file.ts',
      });
      expect(sig).toBe('edit:/path/to/file.ts');
    });

    it('should compute write signature from file path', () => {
      const sig = computeInputSignature('write', {
        file_path: '/path/to/file.ts',
      });
      expect(sig).toBe('write:/path/to/file.ts');
    });

    it('should compute read signature from file path', () => {
      const sig = computeInputSignature('read', {
        file_path: '/path/to/file.ts',
      });
      expect(sig).toBe('read:/path/to/file.ts');
    });

    it('should handle missing file_path for edit', () => {
      const sig = computeInputSignature('edit', {});
      expect(sig).toBe('edit:');
    });

    it('should compute generic signature with hash', () => {
      const sig = computeInputSignature('unknown_tool', {
        param1: 'value1',
        param2: 'value2',
      });
      expect(sig).toMatch(/^unknown_tool:[a-f0-9]{1,8}$/);
    });

    it('should produce consistent hash for same input', () => {
      const sig1 = computeInputSignature('unknown_tool', { param: 'value' });
      const sig2 = computeInputSignature('unknown_tool', { param: 'value' });
      expect(sig1).toBe(sig2);
    });

    it('should produce different hash for different input', () => {
      const sig1 = computeInputSignature('unknown_tool', { param: 'value1' });
      const sig2 = computeInputSignature('unknown_tool', { param: 'value2' });
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('recordDenial', () => {
    it('should add denial to tracker immutably', () => {
      const tracker1 = createDenialTracker();
      const tracker2 = recordDenial(tracker1, 'bash', {
        command: 'rm -rf /',
      });

      // Original unchanged
      expect(tracker1.records.length).toBe(0);
      // New tracker has record
      expect(tracker2.records.length).toBe(1);
      expect(tracker2.records[0].toolName).toBe('bash');
    });

    it('should record with reason', () => {
      const tracker = createDenialTracker();
      const updated = recordDenial(
        tracker,
        'bash',
        { command: 'rm -rf /' },
        'Too dangerous',
      );

      expect(updated.records[0].reason).toBe('Too dangerous');
    });

    it('should record without reason', () => {
      const tracker = createDenialTracker();
      const updated = recordDenial(tracker, 'bash', { command: 'rm -rf /' });

      expect(updated.records[0].reason).toBeUndefined();
    });

    it('should set timestamp', () => {
      const before = Date.now();
      const tracker = createDenialTracker();
      const updated = recordDenial(tracker, 'bash', { command: 'rm -rf /' });
      const after = Date.now();

      expect(updated.records[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(updated.records[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('should accumulate multiple denials', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /' });
      tracker = recordDenial(tracker, 'bash', { command: 'git push --force' });
      tracker = recordDenial(tracker, 'edit', { file_path: '/secret.key' });

      expect(tracker.records.length).toBe(3);
    });
  });

  describe('isDeniedRecently', () => {
    it('should return false for empty tracker', () => {
      const tracker = createDenialTracker();
      const denied = isDeniedRecently(tracker, 'bash', {
        command: 'rm -rf /',
      });
      expect(denied).toBe(false);
    });

    it('should return true for recorded denial', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /' });

      const denied = isDeniedRecently(tracker, 'bash', {
        command: 'rm -rf /',
      });
      expect(denied).toBe(true);
    });

    it('should return false for similar but different command', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /tmp' });

      const denied = isDeniedRecently(tracker, 'bash', {
        command: 'rm -rf /home',
      });
      expect(denied).toBe(false);
    });

    it('should return true for same file denial', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'edit', { file_path: '/path/to/file.ts' });

      const denied = isDeniedRecently(tracker, 'edit', {
        file_path: '/path/to/file.ts',
      });
      expect(denied).toBe(true);
    });

    it('should return false for different file', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'edit', { file_path: '/path/to/file1.ts' });

      const denied = isDeniedRecently(tracker, 'edit', {
        file_path: '/path/to/file2.ts',
      });
      expect(denied).toBe(false);
    });

    it('should handle bash commands by first 3 tokens', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', {
        command: 'rm -rf /tmp extra args',
      });

      // Same first 3 tokens should be denied
      const denied = isDeniedRecently(tracker, 'bash', {
        command: 'rm -rf /tmp different args',
      });
      expect(denied).toBe(true);
    });
  });

  describe('getDenialContext', () => {
    it('should return empty string for empty tracker', () => {
      const tracker = createDenialTracker();
      const context = getDenialContext(tracker);
      expect(context).toBe('');
    });

    it('should list single denial', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /' });

      const context = getDenialContext(tracker);
      expect(context).toContain('user has denied');
      expect(context).toContain('bash:rm -rf /');
      expect(context).toContain('Do not retry');
    });

    it('should include reason in context', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(
        tracker,
        'bash',
        { command: 'rm -rf /' },
        'Too dangerous',
      );

      const context = getDenialContext(tracker);
      expect(context).toContain('Too dangerous');
    });

    it('should list multiple denials', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /' });
      tracker = recordDenial(tracker, 'bash', { command: 'git push --force' });

      const context = getDenialContext(tracker);
      expect(context).toContain('bash:rm -rf');
      expect(context).toContain('bash:git push');
    });

    it('should deduplicate same signatures', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /tmp arg1' });
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /tmp arg2' });
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /tmp arg3' });

      const context = getDenialContext(tracker);
      const lines = context.split('\n');
      // Should have header + 1 denial + footer = 3 lines
      expect(lines.length).toBe(3);
    });

    it('should format as multi-line string', () => {
      let tracker = createDenialTracker();
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /' });
      tracker = recordDenial(tracker, 'edit', { file_path: '/secret.key' });

      const context = getDenialContext(tracker);
      const lines = context.split('\n');
      expect(lines.length).toBeGreaterThan(2);
    });
  });

  describe('integration', () => {
    it('should track denial and prevent re-execution', () => {
      let tracker = createDenialTracker();

      // User denies first time
      expect(isDeniedRecently(tracker, 'bash', { command: 'rm -rf /' })).toBe(
        false,
      );
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /' });

      // Should be denied on second attempt
      expect(isDeniedRecently(tracker, 'bash', { command: 'rm -rf /' })).toBe(
        true,
      );

      // Context should be available
      const context = getDenialContext(tracker);
      expect(context.length).toBeGreaterThan(0);
    });

    it('should track multiple operations independently', () => {
      let tracker = createDenialTracker();

      // Deny first operation
      tracker = recordDenial(tracker, 'bash', { command: 'rm -rf /' });

      // Second operation not denied yet
      expect(isDeniedRecently(tracker, 'edit', { file_path: '/file.ts' })).toBe(
        false,
      );

      // Deny second operation
      tracker = recordDenial(tracker, 'edit', { file_path: '/file.ts' });

      // Both should be denied now
      expect(isDeniedRecently(tracker, 'bash', { command: 'rm -rf /' })).toBe(
        true,
      );
      expect(isDeniedRecently(tracker, 'edit', { file_path: '/file.ts' })).toBe(
        true,
      );
    });

    it('should immutably track session denials', () => {
      const tracker1 = createDenialTracker();
      const tracker2 = recordDenial(tracker1, 'bash', {
        command: 'rm -rf /',
      });
      const tracker3 = recordDenial(tracker2, 'edit', {
        file_path: '/file.ts',
      });

      // Each tracker is independent
      expect(tracker1.records.length).toBe(0);
      expect(tracker2.records.length).toBe(1);
      expect(tracker3.records.length).toBe(2);

      // Can check denial in latest tracker
      expect(isDeniedRecently(tracker3, 'bash', { command: 'rm -rf /' })).toBe(
        true,
      );
      expect(isDeniedRecently(tracker3, 'edit', { file_path: '/file.ts' })).toBe(
        true,
      );
    });
  });
});
