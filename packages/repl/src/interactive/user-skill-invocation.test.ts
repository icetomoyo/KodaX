import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSkillRegistry } from '@kodax-ai/agent';
import {
  findQueueableUserSkillReference,
  resolveUserSkillReference,
  preserveQueuedSkillContextSnapshot,
  resolveUserSkillInvocation,
  prepareUserSkillInvocationFromInput,
} from './user-skill-invocation.js';
import { prepareInvocationExecution } from './invocation-runtime.js';

const tempDirs: string[] = [];

async function writeProjectSkill(
  root: string,
  name: string,
  frontmatter = '',
): Promise<void> {
  const skillDir = path.join(root, '.kodax', 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---
name: ${name}
description: Explicit-only test skill
disable-model-invocation: true
user-invocable: false
${frontmatter}
---

# Explicit Skill

Handle this request: $ARGUMENTS
`,
    'utf8',
  );
}

describe('resolveUserSkillInvocation', () => {
  beforeEach(() => resetSkillRegistry());

  afterEach(async () => {
    resetSkillRegistry();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('resolves a hidden bare slash Skill in the middle with trailing arguments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-inline-skill-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'writing-great-skills');

    const invocation = await resolveUserSkillInvocation(
      '请用 /writing-great-skills audit grilling',
      {
        workingDirectory: root,
        projectRoot: root,
        sessionId: 'inline-skill-session',
      },
    );

    expect(invocation).toMatchObject({
      source: 'skill',
      displayName: 'writing-great-skills',
      disableModelInvocation: true,
      userInvocable: true,
      skillInvocation: {
        name: 'writing-great-skills',
        arguments: 'audit grilling',
      },
    });
    expect(invocation?.prompt).toContain('Handle this request: audit grilling');
    expect(invocation?.prompt).toContain('User provided arguments: audit grilling');
  });

  it('queues a syntactic Skill candidate only while registry discovery is pending', () => {
    expect(findQueueableUserSkillReference(
      '/writing-great-skills audit',
      () => false,
      false,
    )).toMatchObject({ name: 'writing-great-skills' });
    expect(findQueueableUserSkillReference(
      '/unknown audit',
      () => false,
      true,
    )).toBeUndefined();
    expect(findQueueableUserSkillReference(
      'first /unknown then /writing-great-skills audit',
      (name) => name === 'writing-great-skills',
      true,
    )).toMatchObject({ name: 'writing-great-skills' });
    expect(() => findQueueableUserSkillReference(
      '/first-skill one /second-skill two',
      () => true,
      true,
    )).toThrow('Only one Skill can be active per request; found: first-skill, second-skill.');
  });

  it('resolves a hidden legacy slash Skill at the query head', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-legacy-inline-skill-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'writing-great-skills');

    const invocation = await resolveUserSkillInvocation(
      '/skill:writing-great-skills audit grilling',
      { workingDirectory: root, projectRoot: root },
    );

    expect(invocation?.prompt).toContain('<skill name="writing-great-skills"');
    expect(invocation?.prompt).toContain('Handle this request: audit grilling');
  });

  it('keeps the expanded Skill body only in structured invocation context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-single-skill-body-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'writing-great-skills');
    const invocation = await resolveUserSkillInvocation(
      '/writing-great-skills audit grilling',
      { workingDirectory: root, projectRoot: root },
    );
    expect(invocation).toBeDefined();

    const prepared = await prepareInvocationExecution(
      { provider: 'anthropic', events: { beforeToolExecute: async () => true } },
      invocation!,
      '/writing-great-skills audit grilling',
      vi.fn(),
    );
    const expandedContent = prepared.options?.context?.skillInvocation?.expandedContent ?? '';
    const combinedWireSources = `${prepared.prompt ?? ''}\n${expandedContent}`;

    expect(prepared.prompt).not.toContain('<skill name="writing-great-skills"');
    expect(combinedWireSources.match(/<skill name="writing-great-skills"/g)).toHaveLength(1);
  });

  it('recognizes a known queued Skill without expanding dynamic context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-queued-skill-ref-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'writing-great-skills');
    const executeDynamicContext = vi.fn(async () => 'must not run');

    const reference = await resolveUserSkillReference(
      'please use /writing-great-skills audit grilling',
      {
        workingDirectory: root,
        projectRoot: root,
        executeDynamicContext,
      },
    );

    expect(reference).toMatchObject({
      name: 'writing-great-skills',
      argumentsText: 'audit grilling',
    });
    expect(executeDynamicContext).not.toHaveBeenCalled();
  });

  it('skips earlier unknown or builtin slash tokens and resolves a later known Skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-later-inline-skill-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'writing-great-skills');

    for (const input of [
      'please /unknown then /writing-great-skills audit grilling',
      '先 /help 再 /writing-great-skills audit grilling',
    ]) {
      await expect(resolveUserSkillReference(input, {
        workingDirectory: root,
        projectRoot: root,
      })).resolves.toMatchObject({
        name: 'writing-great-skills',
        argumentsText: 'audit grilling',
      });
    }
  });

  it('rejects multiple known Skill references instead of swallowing the later invocation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-multiple-inline-skills-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'first-skill');
    await writeProjectSkill(root, 'second-skill');

    await expect(resolveUserSkillInvocation(
      '/first-skill one /second-skill two',
      { workingDirectory: root, projectRoot: root },
    )).rejects.toThrow(
      'Only one Skill can be active per request; found: first-skill, second-skill.',
    );
  });

  it('preserves full invocation policy for a middle slash Skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-inline-skill-policy-'));
    tempDirs.push(root);
    await writeProjectSkill(
      root,
      'writing-great-skills',
      'allowed-tools: read\ncontext: fork\nmodel: sonnet\nhooks:\n  UserPromptSubmit:\n    - command: echo hook',
    );

    const invocation = await resolveUserSkillInvocation(
      '请用 /writing-great-skills audit grilling',
      { workingDirectory: root, projectRoot: root },
    );

    expect(invocation).toMatchObject({
      allowedTools: 'read',
      context: 'fork',
      model: 'sonnet',
      hooks: {
        UserPromptSubmit: [{ command: 'echo hook' }],
      },
    });
  });

  it('ignores absolute paths, URLs, and unknown slash tokens', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-non-skill-slash-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'src');

    const invocation = await resolveUserSkillInvocation(
      'inspect /src/file.ts https://example.com/a/b and /not-a-skill',
      { workingDirectory: root, projectRoot: root },
    );

    expect(invocation).toBeUndefined();
  });

  it('preserves main token accounting for queued manual and fork Skill results', () => {
    const mainSnapshot = {
      currentTokens: 321,
      baselineEstimatedTokens: 300,
      source: 'estimate' as const,
    };
    const manual = preserveQueuedSkillContextSnapshot({
      success: false,
      lastText: '',
      messages: [],
      sessionId: 'manual',
    }, mainSnapshot);
    const fork = preserveQueuedSkillContextSnapshot({
      success: true,
      lastText: 'done',
      messages: [],
      sessionId: 'fork',
      contextTokenSnapshot: {
        currentTokens: 9,
        baselineEstimatedTokens: 9,
        source: 'estimate',
      },
    }, mainSnapshot);

    expect(manual.contextTokenSnapshot).toBe(mainSnapshot);
    expect(fork.contextTokenSnapshot).toBe(mainSnapshot);
  });
});

describe('prepareUserSkillInvocationFromInput (local preparation)', () => {
  afterEach(async () => {
    resetSkillRegistry();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('keeps local preparation and returns undefined for unknown skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-t37-binding-'));
    tempDirs.push(root);
    try {
      await writeProjectSkill(root, 'bound-skill');
      const context = { workingDirectory: root, projectRoot: root };

      const localResult = await prepareUserSkillInvocationFromInput('/bound-skill local args', context);
      expect(localResult?.prompt).toContain('Handle this request: local args');

      const unknown = await prepareUserSkillInvocationFromInput('/missing-skill args', context);
      expect(unknown).toBeUndefined();
    } finally {
      // tempDirs is cleaned by the file-level afterEach.
    }
  });
});
