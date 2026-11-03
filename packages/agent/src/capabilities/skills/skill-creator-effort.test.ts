import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyzeBenchmark, main as analyzeMain } from './builtin/skill-creator/scripts/analyze-benchmark.js';
import { compareWorkspace, main as compareMain } from './builtin/skill-creator/scripts/compare-runs.js';
import { gradeWorkspace, main as gradeMain } from './builtin/skill-creator/scripts/grade-evals.js';
import { setKodaXSDKForSkillCreator } from './builtin/skill-creator/scripts/utils.js';

let directory: string;
const requests: { effort?: string; reasoningMode?: string; thinking?: boolean }[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kodax-skill-effort-'));
  requests.length = 0;
  setKodaXSDKForSkillCreator({ runKodaX: async (options: typeof requests[number]) => {
    requests.push(options);
    return { lastText: '{}' };
  } });
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

for (const [name, execute, main] of [
  ['analyze', analyzeBenchmark, analyzeMain],
  ['compare', compareWorkspace, compareMain],
  ['grade', gradeWorkspace, gradeMain],
] as const) {
  it(`${name} uses native medium for its independent assessment request`, async () => {
    await execute({ workspaceDir: directory });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request).toMatchObject({ effort: 'medium', reasoningMode: undefined });
  });
  it(`${name} preserves an explicit native effort over a legacy input`, async () => {
    await execute({ workspaceDir: directory, effort: 'xhigh', reasoningMode: 'quick' });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.effort).toBe('xhigh');
  });
  it(`${name} retains explicitly supplied legacy SDK options`, async () => {
    await execute({ workspaceDir: directory, reasoningMode: 'deep' });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request).toMatchObject({ effort: undefined, reasoningMode: 'deep' });
  });
  it.each([
    ['--effort', 'max', { effort: 'max', reasoningMode: undefined }],
    ['--reasoning', 'deep', { effort: undefined, reasoningMode: 'deep' }],
  ] as const)(`${name} parses %s at its actual script entry`, async (flag, value, expected) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await main(['node', `${name}.js`, directory, flag, value]);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request).toMatchObject(expected);
  });
}
