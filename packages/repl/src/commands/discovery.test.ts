/**
 * Command Discovery Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseCommandFile,
  discoverCommands,
  registerDiscoveredCommands,
  type CommandDiscoveryPath,
} from './discovery.js';
import { CommandRegistry } from './registry.js';

describe('Command Discovery', () => {
  let tempDir: string;
  let registry: CommandRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-test-'));
    registry = new CommandRegistry();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('parseCommandFile', () => {
    it('should parse valid command file with frontmatter', () => {
      const commandPath = path.join(tempDir, 'test-cmd.md');
      fs.writeFileSync(commandPath, `---
name: test-command
description: Test command description
aliases: [tc, testcmd]
priority: high
---

# Test Command Content

This is the test command content.
`);

      const result = parseCommandFile(commandPath, 'user');

      expect(result).toBeDefined();
      expect(result?.name).toBe('test-command');
      expect(result?.description).toBe('Test command description');
      expect(result?.aliases).toEqual(['tc', 'testcmd']);
      expect(result?.priority).toBe('high');
      expect(result?.content).toContain('# Test Command Content');
      expect(result?.location).toBe('user');
      expect(result?.path).toBe(commandPath);
      expect(result?.execution.userInvocable).toBe(true);
    });

    it('should parse command file without frontmatter (use filename)', () => {
      const commandPath = path.join(tempDir, 'my-cmd.md');
      fs.writeFileSync(commandPath, `Just the content here.`);

      const result = parseCommandFile(commandPath, 'project');

      expect(result).toBeDefined();
      expect(result?.name).toBe('my-cmd');
      expect(result?.description).toContain('project level');
      expect(result?.content).toBe('Just the content here.');
      expect(result?.location).toBe('project');
    });

    it('should return undefined for empty content', () => {
      const commandPath = path.join(tempDir, 'empty.md');
      fs.writeFileSync(commandPath, `---
name: empty-command
---

`);

      const result = parseCommandFile(commandPath, 'user');

      expect(result).toBeUndefined();
    });

    it('should handle command file with array aliases', () => {
      const commandPath = path.join(tempDir, 'array-aliases.md');
      fs.writeFileSync(commandPath, `---
name: test
aliases: [a, b, c]
---

Content`);

      const result = parseCommandFile(commandPath, 'user');

      expect(result?.aliases).toEqual(['a', 'b', 'c']);
    });

    it('should parse CRLF and Claude-style frontmatter safely', () => {
      const commandPath = path.join(tempDir, 'claude-compatible.md');
      fs.writeFileSync(commandPath, '---\r\n'
        + 'description: "Use hooks: before, after"\r\n'
        + 'aliases:\r\n'
        + '  - cc\r\n'
        + '  - compat\r\n'
        + 'user-invocable: true\r\n'
        + 'allowed-tools: "Read, Grep, Bash(node:*)"\r\n'
        + 'model: claude-sonnet-4-6\r\n'
        + 'context: fork\r\n'
        + 'hooks:\r\n'
        + '  UserPromptSubmit:\r\n'
        + '    - command: echo hi\r\n'
        + '---\r\n\r\n'
        + 'Body content\r\n');

      const result = parseCommandFile(commandPath, 'user');

      expect(result).toBeDefined();
      expect(result?.name).toBe('claude-compatible');
      expect(result?.description).toBe('Use hooks: before, after');
      expect(result?.aliases).toEqual(['cc', 'compat']);
      expect(result?.content).toBe('Body content');
      expect(result?.execution.userInvocable).toBe(true);
      expect(result?.execution.allowedTools).toBe('Read, Grep, Bash(node:*)');
      expect(result?.execution.model).toBe('claude-sonnet-4-6');
      expect(result?.execution.context).toBe('fork');
      expect(result?.execution.hooks?.UserPromptSubmit?.[0]?.command).toBe('echo hi');
    });

    it('should tolerate unquoted colons in string values', () => {
      const commandPath = path.join(tempDir, 'sanitized.md');
      fs.writeFileSync(commandPath, `---
description: Implement a feature from FEATURE_LIST.md: pass an ID if needed
---

Body content`);

      const result = parseCommandFile(commandPath, 'user');

      expect(result).toBeDefined();
      expect(result?.description).toBe('Implement a feature from FEATURE_LIST.md: pass an ID if needed');
    });
  });

  describe('discoverCommands', () => {
    it('should discover commands from multiple directories', () => {
      const userDir = path.join(tempDir, 'user');
      const projectDir = path.join(tempDir, 'project');

      fs.mkdirSync(userDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });

      fs.writeFileSync(path.join(userDir, 'cmd1.md'), `---
name: user-cmd
description: User command
---

User content`);

      fs.writeFileSync(path.join(projectDir, 'cmd2.md'), `---
name: project-cmd
description: Project command
---

Project content`);

      const commands = discoverCommands([
        { path: userDir, location: 'user' },
        { path: projectDir, location: 'project' },
      ] satisfies CommandDiscoveryPath[]);

      expect(commands).toHaveLength(2);
      expect(commands.map(c => c.name)).toContain('user-cmd');
      expect(commands.map(c => c.name)).toContain('project-cmd');

      const userCmd = commands.find(c => c.name === 'user-cmd');
      expect(userCmd?.location).toBe('user');

      const projectCmd = commands.find(c => c.name === 'project-cmd');
      expect(projectCmd?.location).toBe('project');
    });

    it('should skip non-markdown files', () => {
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'Not a command');
      fs.writeFileSync(path.join(tempDir, 'valid.md'), `---
name: valid
---

Content`);

      const commands = discoverCommands([{ path: tempDir, location: 'project' }]);

      expect(commands).toHaveLength(1);
      expect(commands[0]?.name).toBe('valid');
    });

    it('should handle non-existent directories gracefully', () => {
      const commands = discoverCommands([
        '/non/existent/path1',
        '/non/existent/path2'
      ]);

      expect(commands).toHaveLength(0);
    });

    it('should keep backward compatibility for string path arrays', () => {
      const userDir = path.join(tempDir, 'legacy-user');
      const projectDir = path.join(tempDir, 'legacy-project');

      fs.mkdirSync(userDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });

      fs.writeFileSync(path.join(userDir, 'cmd1.md'), 'Legacy user');
      fs.writeFileSync(path.join(projectDir, 'cmd2.md'), 'Legacy project');

      const commands = discoverCommands([userDir, projectDir]);

      expect(commands.find(c => c.name === 'cmd1')?.location).toBe('user');
      expect(commands.find(c => c.name === 'cmd2')?.location).toBe('project');
    });

    it('should skip duplicate directories when project and user paths resolve to the same folder', () => {
      const sharedDir = path.join(tempDir, '.kodax', 'commands');
      fs.mkdirSync(sharedDir, { recursive: true });

      fs.writeFileSync(path.join(sharedDir, 'shared.md'), `---
name: shared-command
description: Shared command
---

Shared content`);

      const commands = discoverCommands([
        { path: sharedDir, location: 'project' },
        { path: sharedDir, location: 'user' },
      ] satisfies CommandDiscoveryPath[]);

      expect(commands).toHaveLength(1);
      expect(commands[0]?.name).toBe('shared-command');
      expect(commands[0]?.location).toBe('project');
    });
  });

  describe('registerDiscoveredCommands', () => {
    it('should register discovered commands to registry', () => {
      const commands = [
        {
          name: 'test1',
          description: 'Test 1',
          content: 'Content 1',
          location: 'user' as const,
          path: '/path/to/test1.md',
          execution: {}
        },
        {
          name: 'test2',
          description: 'Test 2',
          content: 'Content 2',
          location: 'project' as const,
          path: '/path/to/test2.md',
          aliases: ['t2'],
          execution: {
            userInvocable: false,
            allowedTools: 'Read, Grep',
          }
        }
      ];

      registerDiscoveredCommands(commands, registry);

      const registered = registry.get('test1');
      expect(registered).toBeDefined();
      expect(registered?.name).toBe('test1');
      expect(registered?.source).toBe('extension');
      expect(registered?.location).toBe('user');

      const registered2 = registry.get('test2');
      expect(registered2).toBeDefined();
      expect(registered2?.aliases).toEqual(['t2']);
      expect(registered2?.userInvocable).toBe(false);
      expect(registered2?.allowedTools).toBe('Read, Grep');
    });

    it('should return invocation metadata when handler is executed', async () => {
      const commands = [
        {
          name: 'test',
          description: 'Test',
          content: 'Test skill content',
          location: 'user' as const,
          path: '/path/to/test.md',
          execution: {
            allowedTools: 'Read, Grep',
            context: 'fork' as const,
          }
        }
      ];

      registerDiscoveredCommands(commands, registry);

      const registered = registry.get('test');
      expect(registered).toBeDefined();

      const result = await registered?.handler([], {} as any, {} as any, {} as any);

      expect(result).toEqual({
        success: true,
        invocation: {
          allowedTools: 'Read, Grep',
          context: 'fork',
          prompt: 'Test skill content',
          source: 'prompt',
          displayName: 'test',
          path: '/path/to/test.md',
        }
      });
    });
  });
});
