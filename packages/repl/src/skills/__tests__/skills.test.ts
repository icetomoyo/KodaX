/**
 * Skills Module Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import {
  parseSkillMarkdown,
  loadSkillMetadata,
} from '../skill-loader.js';
import { discoverSkills } from '../discovery.js';
import { SkillRegistry, resetSkillRegistry } from '../skill-registry.js';
import { parseArguments, VariableResolver } from '../skill-resolver.js';

describe('Skill Loader', () => {
  describe('parseSkillMarkdown', () => {
    it('should parse valid SKILL.md content', () => {
      const content = `---
name: test-skill
description: A test skill for unit testing
user-invocable: true
allowed-tools: "Read, Grep"
---

# Test Skill

This is the skill content.

Use $ARGUMENTS to process input.
`;

      const result = parseSkillMarkdown(content);

      expect(result.frontmatter.name).toBe('test-skill');
      expect(result.frontmatter.description).toBe('A test skill for unit testing');
      expect(result.frontmatter.userInvocable).toBe(true);
      expect(result.frontmatter.allowedTools).toBe('Read, Grep');
      expect(result.body).toContain('# Test Skill');
      expect(result.body).toContain('$ARGUMENTS');
    });

    it('should throw error for missing required fields', () => {
      const content = `---
name: test-skill
---

Missing description field.
`;

      expect(() => parseSkillMarkdown(content)).toThrow('missing required "description" field');
    });

    it('should throw error for missing frontmatter', () => {
      const content = `# No Frontmatter

Just content.`;

      expect(() => parseSkillMarkdown(content)).toThrow('missing YAML frontmatter');
    });

    it('should handle boolean fields correctly', () => {
      const content = `---
name: bool-test
description: Testing boolean parsing
disable-model-invocation: true
user-invocable: false
---

Content.`;

      const result = parseSkillMarkdown(content);

      expect(result.frontmatter.disableModelInvocation).toBe(true);
      expect(result.frontmatter.userInvocable).toBe(false);
    });
  });
});

describe('Variable Resolver', () => {
  const context = {
    workingDirectory: '/test/project',
    sessionId: 'test-session-123',
  };

  describe('parseArguments', () => {
    it('should parse simple arguments', () => {
      const result = parseArguments('file1.ts file2.ts');
      expect(result).toEqual(['file1.ts', 'file2.ts']);
    });

    it('should handle quoted arguments', () => {
      const result = parseArguments('"file with spaces.ts" file2.ts');
      expect(result).toEqual(['file with spaces.ts', 'file2.ts']);
    });

    it('should handle single quotes', () => {
      const result = parseArguments("'single quoted' normal");
      expect(result).toEqual(['single quoted', 'normal']);
    });
  });

  describe('VariableResolver', () => {
    it('should resolve $ARGUMENTS', async () => {
      const resolver = new VariableResolver(context);
      const result = await resolver.resolve('Process: $ARGUMENTS', 'test-input');

      expect(result).toBe('Process: test-input');
    });

    it('should resolve positional arguments', async () => {
      const resolver = new VariableResolver(context);
      const result = await resolver.resolve('First: $0, Second: $1', 'arg1 arg2');

      expect(result).toBe('First: arg1, Second: arg2');
    });

    it('should resolve environment variables', async () => {
      const resolver = new VariableResolver(context);
      const result = await resolver.resolve('Session: ${CLAUDE_SESSION_ID}', '');

      expect(result).toBe(`Session: ${context.sessionId}`);
    });
  });
});

describe('Skill Discovery', () => {
  it('should discover built-in skills', async () => {
    // Use empty user/project paths to avoid loading user skills
    const builtinPath = join(__dirname, '..', 'builtin');
    const result = await discoverSkills(undefined, {
      enterprisePaths: [],
      userPaths: [],
      projectPaths: [],
      pluginPaths: [],
      builtinPath,
    });

    // Should find at least the 3 built-in skills
    expect(result.skills.size).toBeGreaterThanOrEqual(3);
    expect(result.skills.has('code-review')).toBe(true);
    expect(result.skills.has('git-workflow')).toBe(true);
    expect(result.skills.has('tdd')).toBe(true);
  });
});

describe('Skill Registry', () => {
  beforeAll(() => {
    resetSkillRegistry();
  });

  const testPaths = {
    enterprisePaths: [],
    userPaths: [],
    projectPaths: [],
    pluginPaths: [],
    builtinPath: join(__dirname, '..', 'builtin'),
  };

  it('should create and discover skills', async () => {
    const registry = new SkillRegistry(undefined, testPaths);
    await registry.discover();

    expect(registry.size).toBeGreaterThanOrEqual(3);
  });

  it('should get skill metadata', async () => {
    const registry = new SkillRegistry(undefined, testPaths);
    await registry.discover();

    const skill = registry.get('code-review');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('code-review');
    expect(skill?.description).toContain('代码审查');
  });

  it('should load full skill content', async () => {
    const registry = new SkillRegistry(undefined, testPaths);
    await registry.discover();

    const skill = await registry.loadFull('code-review');
    expect(skill.content).toContain('代码审查');
    expect(skill.loaded).toBe(true);
  });

  it('should generate system prompt snippet', async () => {
    const registry = new SkillRegistry(undefined, testPaths);
    await registry.discover();

    const snippet = registry.getSystemPromptSnippet();

    expect(snippet).toContain('Available Skills');
    expect(snippet).toContain('code-review');
    expect(snippet).toContain('git-workflow');
    expect(snippet).toContain('tdd');
  });
});
