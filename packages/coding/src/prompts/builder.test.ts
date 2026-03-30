import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './builder.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('buildSystemPrompt', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('uses executionCwd instead of process cwd for prompt context', async () => {
    const executionCwd = await createTempDir('kodax-prompt-cwd-');
    cleanupDirs.push(executionCwd);
    await fs.writeFile(path.join(executionCwd, 'README.md'), '# temp project', 'utf-8');

    const prompt = await buildSystemPrompt({
      provider: 'openai',
      context: {
        executionCwd,
        gitRoot: executionCwd,
      },
    }, true);

    expect(prompt).toContain(`Working Directory: ${executionCwd}`);
    expect(prompt).toContain(`Project: ${path.basename(executionCwd)}`);
  });

  it('appends repository intelligence context when provided', async () => {
    const executionCwd = await createTempDir('kodax-prompt-repo-intel-');
    cleanupDirs.push(executionCwd);

    const prompt = await buildSystemPrompt({
      provider: 'openai',
      context: {
        executionCwd,
        gitRoot: executionCwd,
        repoIntelligenceContext: '## Repository Intelligence\nRepository overview for sample-workspace',
      },
    }, false);

    expect(prompt).toContain('## Repository Intelligence');
    expect(prompt).toContain('Repository overview for sample-workspace');
  });
});
