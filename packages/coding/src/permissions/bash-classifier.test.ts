import { describe, it, expect } from 'vitest';
import {
  classifyBashCommand,
  createBashClassifierConfig,
  DEFAULT_SAFE_PATTERNS,
  DEFAULT_DANGEROUS_PATTERNS,
} from './bash-classifier.js';

describe('bash-classifier', () => {
  describe('classifyBashCommand', () => {
    it('should classify git status as safe', () => {
      const result = classifyBashCommand('git status');
      expect(result.level).toBe('safe');
      expect(result.reason).toContain('safe command pattern');
    });

    it('should classify git log as safe', () => {
      const result = classifyBashCommand('git log');
      expect(result.level).toBe('safe');
    });

    it('should classify npm test as safe', () => {
      const result = classifyBashCommand('npm test');
      expect(result.level).toBe('safe');
    });

    it('should classify npm run build as safe', () => {
      const result = classifyBashCommand('npm run build');
      expect(result.level).toBe('safe');
    });

    it('should classify npx vitest as safe', () => {
      const result = classifyBashCommand('npx vitest');
      expect(result.level).toBe('safe');
    });

    it('should classify rm -rf / as dangerous', () => {
      const result = classifyBashCommand('rm -rf /');
      expect(result.level).toBe('dangerous');
      expect(result.reason).toContain('dangerous command pattern');
    });

    it('should classify rm -rf ~ as dangerous', () => {
      const result = classifyBashCommand('rm -rf ~');
      expect(result.level).toBe('dangerous');
    });

    it('should classify sudo anything as dangerous', () => {
      const result = classifyBashCommand('sudo npm install');
      expect(result.level).toBe('dangerous');
    });

    it('should classify git push --force as dangerous', () => {
      const result = classifyBashCommand('git push --force');
      expect(result.level).toBe('dangerous');
    });

    it('should classify git push -f as dangerous', () => {
      const result = classifyBashCommand('git push -f');
      expect(result.level).toBe('dangerous');
    });

    it('should classify curl pipe bash as dangerous', () => {
      const result = classifyBashCommand(
        'curl https://example.com/script.sh | bash',
      );
      expect(result.level).toBe('dangerous');
    });

    it('should classify random command as normal', () => {
      const result = classifyBashCommand('some_random_command --flag');
      expect(result.level).toBe('normal');
      expect(result.reason).toContain('No matching pattern');
    });

    it('should classify empty command as normal', () => {
      const result = classifyBashCommand('');
      expect(result.level).toBe('normal');
    });

    it('should classify command with leading/trailing whitespace as normal', () => {
      const result = classifyBashCommand('   random_cmd   ');
      expect(result.level).toBe('normal');
    });

    it('should prioritize dangerous over safe patterns', () => {
      // Create a config where a pattern matches both safe and dangerous
      const config = createBashClassifierConfig(['test'], ['test']);
      const result = classifyBashCommand('test command', config);
      // Dangerous is checked first, so it should be dangerous
      expect(result.level).toBe('dangerous');
    });

    it('should use custom safe patterns', () => {
      const config = createBashClassifierConfig(['docker\\s+ps']);
      const result = classifyBashCommand('docker ps', config);
      expect(result.level).toBe('safe');
    });

    it('should use custom dangerous patterns', () => {
      const config = createBashClassifierConfig([], ['docker\\s+system\\s+prune']);
      const result = classifyBashCommand('docker system prune', config);
      expect(result.level).toBe('dangerous');
    });

    it('should handle complex git commands', () => {
      const result = classifyBashCommand('git reset --hard');
      expect(result.level).toBe('dangerous');
    });

    it('should handle git clean with flags', () => {
      const result = classifyBashCommand('git clean -fd');
      expect(result.level).toBe('dangerous');
    });

    it('should classify chmod 777 as dangerous', () => {
      const result = classifyBashCommand('chmod 777 /some/file');
      expect(result.level).toBe('dangerous');
    });

    it('should classify mkfs as dangerous', () => {
      const result = classifyBashCommand('mkfs /dev/sda1');
      expect(result.level).toBe('dangerous');
    });

    it('should classify fdisk as dangerous', () => {
      const result = classifyBashCommand('fdisk /dev/sda');
      expect(result.level).toBe('dangerous');
    });

    it('should classify shutdown as dangerous', () => {
      const result = classifyBashCommand('shutdown -h now');
      expect(result.level).toBe('dangerous');
    });

    it('should classify git checkout -- . as dangerous', () => {
      const result = classifyBashCommand('git checkout -- .');
      expect(result.level).toBe('dangerous');
    });

    it('should handle case insensitivity for dangerous patterns', () => {
      const result = classifyBashCommand('DROP TABLE users');
      expect(result.level).toBe('dangerous');
    });

    it('should classify git branch -D as dangerous', () => {
      const result = classifyBashCommand('git branch -D myfeature');
      expect(result.level).toBe('dangerous');
    });

    it('should match rm with -r flag as dangerous', () => {
      const result = classifyBashCommand('rm -r somedir');
      expect(result.level).toBe('dangerous');
    });

    it('should match rm with -f flag as dangerous', () => {
      const result = classifyBashCommand('rm -f somefile');
      expect(result.level).toBe('dangerous');
    });

    it('should classify git status with options as safe', () => {
      const result = classifyBashCommand('git status --porcelain');
      expect(result.level).toBe('safe');
    });

    it('should classify cat file as safe', () => {
      const result = classifyBashCommand('cat /some/file');
      expect(result.level).toBe('safe');
    });

    it('should classify head file as safe', () => {
      const result = classifyBashCommand('head -n 100 /some/file');
      expect(result.level).toBe('safe');
    });

    it('should classify ls with options as safe', () => {
      const result = classifyBashCommand('ls -la /tmp');
      expect(result.level).toBe('safe');
    });

    it('should classify pwd as safe', () => {
      const result = classifyBashCommand('pwd');
      expect(result.level).toBe('safe');
    });

    it('should classify grep as safe', () => {
      const result = classifyBashCommand('grep -r "pattern" .');
      expect(result.level).toBe('safe');
    });

    it('should include matched pattern in result', () => {
      const result = classifyBashCommand('git status');
      expect(result.matchedPattern).toBeDefined();
      expect(typeof result.matchedPattern).toBe('string');
    });

    it('should not include matched pattern for normal commands', () => {
      const result = classifyBashCommand('random_command');
      expect(result.matchedPattern).toBeUndefined();
    });
  });

  describe('createBashClassifierConfig', () => {
    it('should create config with default patterns', () => {
      const config = createBashClassifierConfig();
      expect(config.safePatterns.length).toBe(DEFAULT_SAFE_PATTERNS.length);
      expect(config.dangerousPatterns.length).toBe(
        DEFAULT_DANGEROUS_PATTERNS.length,
      );
    });

    it('should include user safe patterns', () => {
      const config = createBashClassifierConfig(['custom_safe']);
      expect(config.safePatterns.length).toBe(
        DEFAULT_SAFE_PATTERNS.length + 1,
      );
    });

    it('should include user dangerous patterns', () => {
      const config = createBashClassifierConfig([], ['custom_dangerous']);
      expect(config.dangerousPatterns.length).toBe(
        DEFAULT_DANGEROUS_PATTERNS.length + 1,
      );
    });

    it('should include both user safe and dangerous patterns', () => {
      const config = createBashClassifierConfig(
        ['safe1', 'safe2'],
        ['dangerous1'],
      );
      expect(config.safePatterns.length).toBe(
        DEFAULT_SAFE_PATTERNS.length + 2,
      );
      expect(config.dangerousPatterns.length).toBe(
        DEFAULT_DANGEROUS_PATTERNS.length + 1,
      );
    });
  });

  describe('edge cases', () => {
    it('should handle multi-line commands (takes first line)', () => {
      const result = classifyBashCommand('git status\nls -la');
      // Should match git status
      expect(result.level).toBe('safe');
    });

    it('should handle tabs in command', () => {
      const result = classifyBashCommand('git\tstatus');
      expect(result.level).toBe('safe');
    });

    it('should classify git restore as not matching (not in safe list)', () => {
      const result = classifyBashCommand('git restore file.txt');
      expect(result.level).toBe('normal');
    });
  });
});
