import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { KODAX_FEATURES_FILE, KODAX_PROGRESS_FILE } from '../constants.js';
import { buildSystemPrompt, buildSystemPromptSnapshot } from './builder.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('buildSystemPrompt', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it('uses executionCwd instead of process cwd for prompt context', async () => {
    const executionCwd = await createTempDir('kodax-prompt-cwd-');
    cleanupDirs.push(executionCwd);
    await fs.writeFile(
      path.join(executionCwd, 'README.md'),
      '# temp project',
      'utf-8',
    );

    const prompt = await buildSystemPrompt(
      {
        provider: 'openai',
        context: {
          executionCwd,
          gitRoot: executionCwd,
        },
      },
      true,
    );

    expect(prompt).toContain(`Working Directory: ${executionCwd}`);
    expect(prompt).toContain(`Project: ${path.basename(executionCwd)}`);
  });

  it('appends repository intelligence context when provided', async () => {
    const executionCwd = await createTempDir('kodax-prompt-repo-intel-');
    cleanupDirs.push(executionCwd);

    const prompt = await buildSystemPrompt(
      {
        provider: 'openai',
        context: {
          executionCwd,
          gitRoot: executionCwd,
          repoIntelligenceContext:
            '## Repository Intelligence\nRepository overview for sample-workspace',
        },
      },
      false,
    );

    expect(prompt).toContain('## Repository Intelligence');
    expect(prompt).toContain('Repository overview for sample-workspace');
  });

  it('builds ordered prompt sections with explicit provenance and precedence', async () => {
    const executionCwd = await createTempDir('kodax-prompt-sections-');
    cleanupDirs.push(executionCwd);
    await fs.mkdir(path.join(executionCwd, '.kodax'), { recursive: true });
    await fs.writeFile(
      path.join(executionCwd, '.kodax', 'AGENTS.md'),
      'PROJECT RULE: prefer project-scoped constraints.',
      'utf-8',
    );

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: {
          executionCwd,
          gitRoot: executionCwd,
          repoIntelligenceContext: '## Repository Intelligence\nScoped repo truth.',
          promptOverlay: '## Prompt Overlay\nRuntime truth goes here.',
          skillsPrompt: '## Skills\nUse only the necessary specialist workflow.',
        },
      },
      false,
    );

    expect(
      snapshot.sections.map(({ id, slot, owner, feature, stability }) => ({
        id,
        slot,
        owner,
        feature,
        stability,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "feature": "FEATURE_048",
          "id": "base-system",
          "owner": "prompts",
          "slot": "base",
          "stability": "stable",
        },
        {
          "feature": "FEATURE_048",
          "id": "environment-context",
          "owner": "prompts",
          "slot": "runtime-context",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "working-directory",
          "owner": "prompts",
          "slot": "runtime-context",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "repo-intelligence-context",
          "owner": "reasoning",
          "slot": "capability-truth",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "prompt-overlay",
          "owner": "reasoning",
          "slot": "mode-overlay",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "project-agents",
          "owner": "project",
          "slot": "project-rules",
          "stability": "project",
        },
        {
          "feature": "FEATURE_048",
          "id": "skills-addendum",
          "owner": "skills",
          "slot": "skill-addendum",
          "stability": "dynamic",
        },
      ]
    `);

    expect(snapshot.metadata.longRunning).toBe(false);
    expect(snapshot.hash).toHaveLength(64);
    expect(snapshot.rendered.indexOf('## Prompt Overlay')).toBeGreaterThan(-1);
    expect(snapshot.rendered.indexOf('PROJECT RULE: prefer project-scoped constraints.')).toBeGreaterThan(
      snapshot.rendered.indexOf('## Prompt Overlay'),
    );
    expect(snapshot.rendered.indexOf('## Skills')).toBeGreaterThan(
      snapshot.rendered.indexOf('PROJECT RULE: prefer project-scoped constraints.'),
    );
  });

  it('captures long-running context and overlay in the prompt snapshot', async () => {
    const executionCwd = await createTempDir('kodax-prompt-long-running-');
    cleanupDirs.push(executionCwd);
    await fs.writeFile(
      path.join(executionCwd, KODAX_FEATURES_FILE),
      JSON.stringify({
        features: [{ passes: false, description: 'Implement Wave C' }],
      }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(executionCwd, KODAX_PROGRESS_FILE),
      'Wave B shipped cleanly.',
      'utf-8',
    );

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: {
          executionCwd,
          gitRoot: executionCwd,
        },
      },
      true,
    );

    expect(snapshot.metadata.longRunning).toBe(true);
    expect(snapshot.sections.some((section) => section.id === 'long-running-context')).toBe(true);
    expect(snapshot.sections.some((section) => section.id === 'long-running-overlay')).toBe(true);
    expect(snapshot.rendered).toContain('## Feature List (from feature_list.json)');
    expect(snapshot.rendered).toContain('## Long-Running Task Mode');
  });
});
