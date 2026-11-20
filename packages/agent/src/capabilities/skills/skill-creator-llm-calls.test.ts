// skill-creator helper scripts talk to the model in two shapes: judges and the
// description writer send one provider request; trigger and execution evals run
// the product root. These tests pin each shape through the SDK seam.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyzeBenchmark, main as analyzeMain } from './builtin/skill-creator/scripts/analyze-benchmark.js';
import { compareWorkspace, main as compareMain } from './builtin/skill-creator/scripts/compare-runs.js';
import { gradeWorkspace, main as gradeMain } from './builtin/skill-creator/scripts/grade-evals.js';
import { improveDescription } from './builtin/skill-creator/scripts/improve-description.js';
import { runEvalWorkspace } from './builtin/skill-creator/scripts/run-eval.js';
import { runTriggerEval } from './builtin/skill-creator/scripts/run-trigger-eval.js';
import { setKodaXSDKForSkillCreator } from './builtin/skill-creator/scripts/utils.js';

interface StreamRequest { messages: unknown[]; tools: unknown[]; system: string; reasoning: unknown; streamOptions: unknown; provider: string }
interface RootRun { options: Record<string, unknown>; prompt: string; stagedSkill?: string }

let directory: string;
let streamReply = '{}';
let rootToolCalls: Array<[string, Record<string, unknown>]> = [];
const streams: StreamRequest[] = [];
const roots: RootRun[] = [];
const blockedTools: unknown[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kodax-skill-llm-'));
  streams.length = 0;
  roots.length = 0;
  blockedTools.length = 0;
  streamReply = '{}';
  rootToolCalls = [];
  setKodaXSDKForSkillCreator({
    getProvider: (provider: string) => ({
      stream: async (messages: unknown[], tools: unknown[], system: string, reasoning: unknown, streamOptions: unknown) => {
        streams.push({ messages, tools, system, reasoning, streamOptions, provider });
        return { textBlocks: [{ type: 'text', text: streamReply }], toolBlocks: [], thinkingBlocks: [] };
      },
    }),
    mapLegacyReasoningModeToEffortIntent: (mode: string) => `legacy-${mode}`,
    estimateTokens: () => 7,
    runKodaX: async (options: Record<string, unknown>, prompt: string) => {
      const context = options.context as { gitRoot?: string } | undefined;
      const staged = context?.gitRoot ? join(context.gitRoot, '.kodax', 'skills', 'fixture-skill', 'SKILL.md') : '';
      roots.push({ options, prompt, stagedSkill: staged && existsSync(staged) ? await readFile(staged, 'utf8') : undefined });
      const events = options.events as {
        onToolUseStart?: (tool: { name: string; id: string; input?: Record<string, unknown> }) => void;
        beforeToolExecute?: (tool: string, input: Record<string, unknown>) => Promise<boolean | string>;
      } | undefined;
      for (const [tool, input] of rootToolCalls) {
        events?.onToolUseStart?.({ name: tool, id: tool, input });
        blockedTools.push(await events?.beforeToolExecute?.(tool, input));
      }
      return { success: true, lastText: 'done', messages: [{ role: 'user', content: prompt }], sessionId: 'fixture' };
    },
  });
  await writeFile(join(directory, 'benchmark.json'), JSON.stringify({ skill_name: 'fixture' }));
  const evalDir = join(directory, 'eval-0');
  await mkdir(evalDir);
  await writeFile(join(evalDir, 'eval_metadata.json'), JSON.stringify({ prompt: 'fixture', assertions: [] }));
  for (const config of ['with_skill', 'without_skill']) {
    const outputDir = join(evalDir, config, 'run-1', 'outputs');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'result.md'), 'fixture output');
  }
});
afterEach(async () => {
  setKodaXSDKForSkillCreator(null);
  vi.restoreAllMocks();
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unsafe cleanup');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function writeFixtureSkill(extraFrontmatter = ''): Promise<string> {
  const skillDir = join(directory, 'fixture-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'),
    `---\nname: fixture-skill\ndescription: Use for release notes.\n${extraFrontmatter}---\n\n# Fixture\n\nWrite notes.\n`);
  await writeFile(join(directory, 'trigger-evals.json'), JSON.stringify({ evals: [
    { query: 'draft the release notes', should_trigger: true },
    { query: 'explain git rebase', should_trigger: false },
  ] }));
  return skillDir;
}

for (const [name, execute, main] of [
  ['analyze', analyzeBenchmark, analyzeMain],
  ['compare', compareWorkspace, compareMain],
  ['grade', gradeWorkspace, gradeMain],
] as const) {
  it(`${name} sends each assessment as one tool-free provider request at native medium`, async () => {
    await execute({ workspaceDir: directory, provider: 'judge-provider', model: 'judge-model' });
    expect(streams.length).toBeGreaterThan(0);
    expect(roots).toHaveLength(0);
    for (const request of streams) {
      expect(request).toMatchObject({ provider: 'judge-provider', tools: [], reasoning: { effort: 'medium' },
        streamOptions: { modelOverride: 'judge-model' } });
      expect(request.messages).toHaveLength(1);
    }
  });
  it(`${name} preserves an explicit native effort over a legacy input`, async () => {
    await execute({ workspaceDir: directory, effort: 'xhigh', reasoningMode: 'quick' });
    expect(streams.length).toBeGreaterThan(0);
    for (const request of streams) expect(request.reasoning).toEqual({ effort: 'xhigh' });
  });
  it(`${name} maps an explicitly supplied legacy reasoning mode`, async () => {
    await execute({ workspaceDir: directory, reasoningMode: 'deep' });
    expect(streams.length).toBeGreaterThan(0);
    for (const request of streams) expect(request.reasoning).toEqual({ effort: 'legacy-deep' });
  });
  it.each([
    ['--effort', 'max', { effort: 'max' }],
    ['--reasoning', 'deep', { effort: 'legacy-deep' }],
  ] as const)(`${name} parses %s at its actual script entry`, async (flag, value, expected) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await main(['node', `${name}.js`, directory, flag, value]);
    expect(streams.length).toBeGreaterThan(0);
    for (const request of streams) expect(request.reasoning).toEqual(expected);
  });
}

it('improve-description writes its candidate with one provider request', async () => {
  const skillDir = await writeFixtureSkill();
  await writeFile(join(directory, 'results.json'), JSON.stringify({ description: 'Use for notes.', results: [] }));
  streamReply = '<new_description>Use when drafting release notes.</new_description>';
  const result = await improveDescription({ skillPath: skillDir, evalResultsPath: join(directory, 'results.json') });
  expect(result.description).toBe('Use when drafting release notes.');
  expect(roots).toHaveLength(0);
  expect(streams).toHaveLength(1);
  expect(streams[0]).toMatchObject({ tools: [], reasoning: { effort: 'legacy-off' } });
});

it('trigger eval observes the first response of the product root with the candidate staged in its catalog', async () => {
  const skillDir = await writeFixtureSkill();
  rootToolCalls = [['skill', { skill: '/fixture-skill' }], ['read', { path: 'README.md' }]];
  const report = await runTriggerEval({
    skillPath: skillDir,
    evalsPath: join(directory, 'trigger-evals.json'),
    provider: 'trigger-provider',
    descriptionOverride: 'Use when drafting release notes or changelogs.',
  });

  expect(streams).toHaveLength(0);
  expect(roots).toHaveLength(2);
  for (const root of roots) {
    expect(root.options).toMatchObject({ provider: 'trigger-provider', agentMode: 'ama', maxIter: 1 });
    expect(root.stagedSkill).toContain('Use when drafting release notes or changelogs.');
    expect(root.stagedSkill).toContain('Write notes.');
  }
  expect(roots.map(root => root.prompt)).toEqual(['draft the release notes', 'explain git rebase']);
  // Calls are recorded, never run, and the staged project is removed afterwards.
  for (const verdict of blockedTools) expect(typeof verdict).toBe('string');
  const stagedRoot = (roots[0]!.options.context as { gitRoot: string }).gitRoot;
  expect(existsSync(stagedRoot)).toBe(false);

  expect(report.results[0]).toMatchObject({ should_trigger: true, predicted_trigger: true, pass: true });
  expect(report.results[0]!.attempts[0]).toEqual({ trigger: true, tool_calls: ['skill:fixture-skill', 'read'] });
  expect(report.results[1]).toMatchObject({ should_trigger: false, predicted_trigger: true, pass: false });
  expect(report.meta.evaluation_kind).toBe('observed_skill_call');
});

it('trigger eval counts a call to a different Skill as not triggered', async () => {
  const skillDir = await writeFixtureSkill();
  rootToolCalls = [['skill', { skill: 'code-review' }]];
  const report = await runTriggerEval({ skillPath: skillDir, evalsPath: join(directory, 'trigger-evals.json') });
  expect(report.results[0]).toMatchObject({ predicted_trigger: false, pass: false });
  expect(report.results[0]!.attempts[0]).toEqual({ trigger: false, tool_calls: ['skill:code-review'] });
  expect(report.results[1]).toMatchObject({ predicted_trigger: false, pass: true });
});

it('trigger eval refuses a Skill hidden from the model catalog before spending a request', async () => {
  const skillDir = await writeFixtureSkill('disable-model-invocation: true\n');
  await expect(runTriggerEval({ skillPath: skillDir, evalsPath: join(directory, 'trigger-evals.json') }))
    .rejects.toThrow(/disable-model-invocation/);
  expect(roots).toHaveLength(0);
});

it('run-eval executes each config on the product AMA root', async () => {
  const skillDir = await writeFixtureSkill();
  await writeFile(join(directory, 'evals.json'), JSON.stringify({ skill_name: 'fixture-skill', evals: [{ id: 1, prompt: 'Write notes.' }] }));
  await runEvalWorkspace({ skillPath: skillDir, evalsPath: join(directory, 'evals.json'),
    workspaceDir: join(directory, 'run-eval'), runsPerConfig: 1, cwd: directory, provider: 'exec-provider' });
  expect(roots).toHaveLength(2);
  for (const root of roots) expect(root.options).toMatchObject({ provider: 'exec-provider', agentMode: 'ama', context: { gitRoot: directory } });
});
