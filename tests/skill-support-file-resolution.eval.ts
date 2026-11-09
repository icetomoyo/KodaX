/**
 * Eval: skill support files outside the five conventional folders.
 *
 * Why Layer 1 is not enough
 *
 * Unit tests prove the activation block now lists a root-level `REFERENCE.md`
 * with its absolute path. They cannot show whether the model uses that path,
 * or whether the reworded instruction over-generalizes and sends project files
 * such as `FEATURE_LIST.md` to the skill root.
 *
 * Fixed input
 *
 * - system: one line naming the project working directory
 * - user: production `expandSkillForLLM` output for a feature-manager-style
 *   skill with a root-level `REFERENCE.md`, followed by the user task
 * - baseline arm: the same block without the support section, which is the
 *   exact block the previous loader produced for this skill
 * - tools: production `read` tool definition only
 *
 * Mechanical observation per case
 *
 * - bundled-reference: a `read` call targets `<skill root>/REFERENCE.md`
 * - project-file: every `read` of `FEATURE_LIST.md` stays out of the skill root
 *
 * Budget: 2 cases x 2 arms x 2 runs x 2 aliases = 16 provider calls,
 * maxOutputTokens 1024, timeout 120s. Raw dumps land under
 * `os.tmpdir()/kodax-eval-dumps/skill-support-file-resolution/`.
 *
 *   npm run test:eval -- skill-support-file-resolution
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { expandSkillForLLM } from '../packages/agent/src/capabilities/skills/skill-expander.js';
import { loadFullSkill } from '../packages/agent/src/capabilities/skills/skill-loader.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';

const PILOT_ALIASES: ModelAlias[] = ['ark/v4flash', 'zhipu/glm53flash'];
const RUNS_PER_ARM = 2;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'skill-support-file-resolution');
const FIXTURE_ROOT = join(tmpdir(), 'kodax-eval-fixtures', 'skill-support-file-resolution');
const PROJECT_DIR = join(FIXTURE_ROOT, 'work', 'shop-app');
const SKILL_DIR = join(FIXTURE_ROOT, 'home', '.kodax', 'skills', 'feature-manager');

const SKILL_MD = `---
name: feature-manager
description: Track and plan features in FEATURE_LIST.md
---

# Feature Manager

The project tracks features in \`FEATURE_LIST.md\` at the project root.

## List features

Read the project's \`FEATURE_LIST.md\` and print one line per feature.

## Categories

Feature categories and priority levels are defined in \`REFERENCE.md\`. Load it before classifying anything.
`;

const CASES = [
  { id: 'bundled-reference', task: 'Which feature categories does this skill define? Load what you need first.' },
  { id: 'project-file', task: 'List the features currently tracked in this project.' },
] as const;

const normalize = (filePath: string) => filePath.replace(/\\/g, '/').toLowerCase();

function readPaths(toolCalls: ReadonlyArray<{ name: string; input: unknown }>): string[] {
  return toolCalls
    .filter((call) => call.name === 'read')
    .map((call) => (call.input as Record<string, unknown> | null)?.path)
    .filter((value): value is string => typeof value === 'string');
}

function observe(caseId: string, paths: string[]): { observed: boolean; passed: boolean } {
  const skillRoot = normalize(SKILL_DIR);
  if (caseId === 'bundled-reference') {
    const hit = paths.some((p) => normalize(p) === `${skillRoot}/reference.md`);
    return { observed: paths.length > 0, passed: hit };
  }
  const featureReads = paths.filter((p) => normalize(p).endsWith('feature_list.md'));
  return {
    observed: featureReads.length > 0,
    passed: featureReads.length > 0 && featureReads.every((p) => !normalize(p).startsWith(skillRoot)),
  };
}

function withoutSupportSection(block: string): string {
  const start = block.indexOf('Skill support files are rooted');
  const inventory = block.indexOf('Support file inventory:', start);
  const end = block.indexOf('\n\n', inventory);
  if (start < 0 || inventory < 0 || end < 0) throw new Error('Candidate block has no support section to strip');
  return block.slice(0, start) + block.slice(end + 2);
}

async function buildBlocks(): Promise<{ baseline: string; candidate: string }> {
  await mkdir(PROJECT_DIR, { recursive: true });
  await mkdir(SKILL_DIR, { recursive: true });
  await writeFile(join(SKILL_DIR, 'SKILL.md'), SKILL_MD, 'utf8');
  await writeFile(join(SKILL_DIR, 'REFERENCE.md'), '# Reference\n', 'utf8');
  const skill = await loadFullSkill(SKILL_DIR, 'user');
  if (!skill) throw new Error('Fixture skill failed to load');
  const expanded = await expandSkillForLLM(skill, '', {
    workingDirectory: PROJECT_DIR, projectRoot: PROJECT_DIR, disableDynamicContext: true,
  });
  return { baseline: withoutSupportSection(expanded.content), candidate: expanded.content };
}

describe('Eval: skill support file resolution', () => {
  const aliases = availableAliases(...PILOT_ALIASES);
  const readTool = getToolDefinition('read');

  if (aliases.length === 0 || !readTool) {
    it('skips: missing pilot alias credentials or read tool definition', () => {
      expect(readTool?.name ?? 'read').toBe('read');
    });
    return;
  }

  for (const alias of aliases) {
    for (const testCase of CASES) {
      for (const arm of ['baseline', 'candidate'] as const) {
        it(`${alias} ${testCase.id} ${arm}`, { timeout: 300_000 }, async () => {
          const blocks = await buildBlocks();
          const userMessage = `${blocks[arm]}\n\n${testCase.task}`;
          const runs = [];
          for (let run = 0; run < RUNS_PER_ARM; run += 1) {
            const out = await runOneShot(alias, {
              systemPrompt: `You are a coding agent. The project working directory is ${PROJECT_DIR.replace(/\\/g, '/')}.`,
              userMessage,
              tools: [readTool],
              maxOutputTokens: 1024,
              timeoutMs: 120_000,
            });
            const paths = readPaths(out.toolCalls);
            runs.push({ run, text: out.text, toolCalls: out.toolCalls, readPaths: paths,
              durationMs: out.durationMs, ...observe(testCase.id, paths) });
          }

          mkdirSync(DUMP_ROOT, { recursive: true });
          writeFileSync(
            join(DUMP_ROOT, `${alias.replace(/[\\/]/g, '__')}--${testCase.id}--${arm}.json`),
            JSON.stringify({ case: testCase.id, arm, alias, userMessage, runs }, null, 2),
            'utf8',
          );
          // Observation only: the A/B verdict comes from reviewing the paired dumps.
          expect(runs).toHaveLength(RUNS_PER_ARM);
        });
      }
    }
  }
});
