import { describe, expect, it, vi } from 'vitest';
import {
  resolveSkillCreatorToolPath,
  runSkillCreatorTool,
  toFileUrl,
} from './skill_cli.js';

describe('skill CLI helpers', () => {
  it('resolves builtin skill-creator tool paths', () => {
    const toolPath = resolveSkillCreatorToolPath('package', 'C:/tmp/builtin');

    expect(toolPath.replace(/\\/g, '/')).toBe('C:/tmp/builtin/skill-creator/scripts/package-skill.js');
    expect(toFileUrl(toolPath)).toContain('package-skill.js');
  });

  it('delegates to the builtin script runner with the expected arguments', async () => {
    const runner = vi.fn<(scriptPath: string, args: string[]) => Promise<number>>(async () => 0);

    await runSkillCreatorTool('install', ['example.skill', '--dest', 'C:/skills'], runner);

    expect(runner).toHaveBeenCalledTimes(1);
    const firstCall = runner.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [scriptPath, args] = firstCall!;
    expect(String(scriptPath).replace(/\\/g, '/')).toContain('/skill-creator/scripts/install-skill.js');
    expect(args).toEqual(['example.skill', '--dest', 'C:/skills']);
  });

  it('supports init and eval tool paths as thin wrappers', () => {
    expect(resolveSkillCreatorToolPath('init', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/init-skill.js');
    expect(resolveSkillCreatorToolPath('eval', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/run-eval.js');
  });

  it('supports phase 3 evaluator tool paths as thin wrappers', () => {
    expect(resolveSkillCreatorToolPath('grade', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/grade-evals.js');
    expect(resolveSkillCreatorToolPath('analyze', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/analyze-benchmark.js');
    expect(resolveSkillCreatorToolPath('compare', 'C:/tmp/builtin').replace(/\\/g, '/'))
      .toBe('C:/tmp/builtin/skill-creator/scripts/compare-runs.js');
  });
});
