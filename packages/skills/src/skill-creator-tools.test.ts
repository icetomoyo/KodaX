import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateSkillDirectory } from './builtin/skill-creator/scripts/quick-validate.js';
import {
  buildBenchmarkDocument,
  loadRunResults,
  renderBenchmarkMarkdown,
} from './builtin/skill-creator/scripts/aggregate-benchmark.js';
import {
  buildPayload,
  renderHtml,
} from './builtin/skill-creator/scripts/generate-review.js';
import {
  extractDescriptionCandidate,
  improveDescription,
} from './builtin/skill-creator/scripts/improve-description.js';
import {
  installSkill,
  readSkillPackageBuffer,
} from './builtin/skill-creator/scripts/install-skill.js';
import {
  buildSkillPackage,
} from './builtin/skill-creator/scripts/package-skill.js';
import {
  runDescriptionLoop,
  splitEvalSet,
} from './builtin/skill-creator/scripts/run-loop.js';
import {
  parseTriggerDecision,
  runTriggerEval,
} from './builtin/skill-creator/scripts/run-trigger-eval.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createExampleSkill(skillDir: string, description = 'Use this skill when users ask for release notes or changelog help.') {
  await mkdir(join(skillDir, 'references'), { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---
name: example-skill
description: ${description}
allowed-tools:
  - Read
  - Grep
compatibility: Optimized for KodaX and Agent Skills style directories.
---

# Example Skill

Follow the workflow.
`,
    'utf8'
  );
  await writeFile(join(skillDir, 'references', 'checklist.md'), 'Check the rollout notes.', 'utf8');
}

describe('skill-creator scripts', () => {
  it('validates a well-formed skill directory', async () => {
    const skillDir = await createTempDir('kodax-skill-creator-');
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: example-skill
description: Use this skill whenever the user asks to process example tasks.
allowed-tools:
  - Read
  - Grep
---

# Example Skill

Follow the workflow.
`,
      'utf8'
    );

    const result = await validateSkillDirectory(skillDir);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('aggregates run results into benchmark summaries', async () => {
    const iterationDir = await createTempDir('kodax-benchmark-');

    const withSkillRun = join(iterationDir, 'eval-0', 'with_skill', 'run-1');
    const withoutSkillRun = join(iterationDir, 'eval-0', 'without_skill', 'run-1');

    await mkdir(join(withSkillRun, 'outputs'), { recursive: true });
    await mkdir(join(withoutSkillRun, 'outputs'), { recursive: true });
    await writeFile(
      join(iterationDir, 'eval-0', 'eval_metadata.json'),
      JSON.stringify({ eval_id: 0, prompt: 'Test prompt', assertions: [] }, null, 2),
      'utf8'
    );
    await writeFile(
      join(withSkillRun, 'grading.json'),
      JSON.stringify({
        summary: { passed: 3, failed: 0, total: 3, pass_rate: 1 },
        execution_metrics: { total_tool_calls: 2, output_chars: 500, errors_encountered: 0 },
        expectations: [],
      }, null, 2),
      'utf8'
    );
    await writeFile(
      join(withSkillRun, 'timing.json'),
      JSON.stringify({ total_tokens: 1000, total_duration_seconds: 12.5 }, null, 2),
      'utf8'
    );
    await writeFile(
      join(withoutSkillRun, 'grading.json'),
      JSON.stringify({
        summary: { passed: 1, failed: 2, total: 3, pass_rate: 0.3333 },
        execution_metrics: { total_tool_calls: 1, output_chars: 300, errors_encountered: 0 },
        expectations: [],
      }, null, 2),
      'utf8'
    );
    await writeFile(
      join(withoutSkillRun, 'timing.json'),
      JSON.stringify({ total_tokens: 700, total_duration_seconds: 9.5 }, null, 2),
      'utf8'
    );

    const runResults = await loadRunResults(iterationDir);
    const benchmark = buildBenchmarkDocument(iterationDir, 'example-skill', runResults);
    const markdown = renderBenchmarkMarkdown(benchmark);

    expect(Object.keys(runResults)).toEqual(['with_skill', 'without_skill']);
    expect(benchmark.configs.with_skill.pass_rate.mean).toBe(1);
    expect(benchmark.configs.without_skill.pass_rate.mean).toBe(0.3333);
    expect(benchmark.delta.pass_rate).toBe('+0.6667');
    expect(markdown).toContain('# Benchmark: example-skill');
  });

  it('builds static review payloads and html from a workspace', async () => {
    const workspace = await createTempDir('kodax-review-');
    const runDir = join(workspace, 'eval-0', 'with_skill', 'run-1');

    await mkdir(join(runDir, 'outputs'), { recursive: true });
    await writeFile(
      join(workspace, 'eval-0', 'eval_metadata.json'),
      JSON.stringify({ eval_id: 0, prompt: 'Review prompt', assertions: [] }, null, 2),
      'utf8'
    );
    await writeFile(join(runDir, 'outputs', 'result.md'), '# Output', 'utf8');
    await writeFile(
      join(workspace, 'benchmark.json'),
      JSON.stringify({
        configs: {
          with_skill: {
            pass_rate: { mean: 1, stddev: 0 },
            time_seconds: { mean: 10, stddev: 0 },
            tokens: { mean: 500, stddev: 0 },
          },
        },
        delta: { pass_rate: '+0.5000', time_seconds: '+1.0000', tokens: '+200.0000' },
      }, null, 2),
      'utf8'
    );

    const payload = await buildPayload(workspace, {
      skillName: 'skill-creator',
      benchmark: null,
    });
    const html = renderHtml(payload, true);

    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]?.prompt).toBe('Review prompt');
    expect(html).toContain('skill-creator');
    expect(html).toContain('Review prompt');
  });

  it('parses trigger decisions and evaluates trigger samples', async () => {
    const skillDir = await createTempDir('kodax-trigger-skill-');
    const evalDir = await createTempDir('kodax-trigger-evals-');
    await createExampleSkill(skillDir);
    await writeFile(
      join(evalDir, 'evals.json'),
      JSON.stringify({
        evals: [
          { query: '帮我写 release notes', should_trigger: true },
          { query: '解释一下 git rebase', should_trigger: false },
        ],
      }, null, 2),
      'utf8'
    );

    expect(parseTriggerDecision('preface {"trigger": true, "reason": "matched"} suffix')).toEqual({
      trigger: true,
      reason: 'matched',
    });

    const report = await runTriggerEval(
      {
        skillPath: skillDir,
        evalsPath: join(evalDir, 'evals.json'),
        runsPerQuery: 2,
        triggerThreshold: 0.5,
      },
      async (prompt) => {
        if (prompt.includes('User query: 帮我写 release notes')) {
          return '{"trigger": true, "reason": "matches release notes"}';
        }
        return '{"trigger": false, "reason": "not relevant"}';
      }
    );

    expect(report.summary.passed).toBe(2);
    expect(report.summary.pass_rate).toBe(1);
    expect(report.summary.precision).toBe(1);
    expect(report.summary.recall).toBe(1);
  });

  it('improves descriptions without requiring a pre-existing history file', async () => {
    const skillDir = await createTempDir('kodax-improve-skill-');
    const workspace = await createTempDir('kodax-improve-workspace-');
    await createExampleSkill(skillDir, 'Use this skill when users ask for notes.');
    await writeFile(
      join(workspace, 'eval-results.json'),
      JSON.stringify({
        description: 'Use this skill when users ask for notes.',
        results: [
          { query: '帮我写 release notes', pass: false, should_trigger: true, triggers: 0, runs: 1, attempts: [] },
        ],
      }, null, 2),
      'utf8'
    );

    expect(extractDescriptionCandidate('<new_description>Better trigger text</new_description>')).toBe('Better trigger text');

    const result = await improveDescription(
      {
        skillPath: skillDir,
        evalResultsPath: join(workspace, 'eval-results.json'),
        historyPath: join(workspace, 'missing-history.json'),
      },
      async () => '<new_description>Use this skill when users ask to draft release notes, changelogs, or rollout summaries.</new_description>'
    );

    expect(result.description).toContain('release notes');
    expect(result.prompt).toContain('Current description');
  });

  it('splits eval sets deterministically and handles single-sided samples safely', () => {
    const evals = [
      { query: 'a', should_trigger: true },
      { query: 'b', should_trigger: true },
      { query: 'c', should_trigger: false },
      { query: 'd', should_trigger: false },
      { query: 'e', should_trigger: false },
    ];

    const first = splitEvalSet(evals, 0.4, 7);
    const second = splitEvalSet(evals, 0.4, 7);
    expect(first).toEqual(second);

    const oneSided = splitEvalSet([{ query: 'only', should_trigger: true }], 0.5, 1);
    expect(oneSided.test).toEqual([]);
    expect(oneSided.train).toHaveLength(1);
  });

  it('runs the description optimization loop and can write back the best description', async () => {
    const skillDir = await createTempDir('kodax-loop-skill-');
    const workspace = await createTempDir('kodax-loop-workspace-');
    await createExampleSkill(skillDir, 'Use this skill when users ask for notes.');
    await writeFile(
      join(workspace, 'evals.json'),
      JSON.stringify({
        evals: [
          { query: '帮我写 release notes', should_trigger: true },
          { query: '帮我整理 changelog', should_trigger: true },
          { query: '解释 git rebase', should_trigger: false },
          { query: '什么是 TypeScript', should_trigger: false },
        ],
      }, null, 2),
      'utf8'
    );

    const report = await runDescriptionLoop(
      {
        skillPath: skillDir,
        evalsPath: join(workspace, 'evals.json'),
        workspaceDir: workspace,
        maxIterations: 2,
        holdout: 0,
        writeBest: true,
      },
      {
        runTriggerEvalFn: async (options) => {
          const improved = String(options.descriptionOverride).includes('release notes');
          return {
            skill_name: 'example-skill',
            description: String(options.descriptionOverride),
            results: [],
            summary: improved
              ? { passed: 4, failed: 0, total: 4, pass_rate: 1, precision: 1, recall: 1 }
              : { passed: 2, failed: 2, total: 4, pass_rate: 0.5, precision: 0.5, recall: 0.5 },
            meta: {
              runs_per_query: 1,
              trigger_threshold: 0.5,
              note: 'test',
            },
          };
        },
        improveDescriptionFn: async () => ({
          description: 'Use this skill when users ask to draft release notes, changelogs, or release summaries.',
          rawResponse: '',
          prompt: '',
        }),
      }
    );

    const skillMarkdown = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    expect(report.history).toHaveLength(2);
    expect(report.best_description).toContain('release notes');
    expect(skillMarkdown).toContain('release notes, changelogs');
  });

  it('packages a skill archive and installs it into a target skills directory', async () => {
    const skillDir = await createTempDir('kodax-package-skill-');
    const installRoot = await createTempDir('kodax-installed-skills-');
    const archiveDir = await createTempDir('kodax-skill-archive-');
    await createExampleSkill(skillDir);

    const packaged = await buildSkillPackage(skillDir, {
      createdAt: '2026-03-17T00:00:00.000Z',
    });
    const archive = readSkillPackageBuffer(packaged.bytes);

    expect(packaged.manifest.skill.name).toBe('example-skill');
    expect(archive.entries.some((entry) => entry.relativePath === 'references/checklist.md')).toBe(true);

    const archivePath = join(archiveDir, 'example-skill.skill');
    await writeFile(archivePath, packaged.bytes);

    const installed = await installSkill(archivePath, {
      skillsDir: installRoot,
    });

    expect(installed.skillName).toBe('example-skill');
    expect(await readFile(join(installRoot, 'example-skill', 'SKILL.md'), 'utf8')).toContain('example-skill');
    expect(await readFile(join(installRoot, 'example-skill', 'references', 'checklist.md'), 'utf8')).toContain('rollout');
  });
});
