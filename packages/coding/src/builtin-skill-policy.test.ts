import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { SkillRegistry } from '@kodax-ai/agent';
import { applyRuntimeSkillInvocationPolicy } from './skill-invocation-policy.js';

it.each([
  ['git-workflow', 'git status --short', 'curl https://example.invalid'],
  ['git-workflow', 'node git-hosting-request.cjs', 'curl https://example.invalid'],
  ['tdd', 'npm test -- --run', 'git push'],
  ['code-review', 'git diff --stat', 'git commit -m unrequested'],
  ['skill-creator', 'node scripts/run-eval.js --help', 'git push'],
] as const)('enforces shipped %s commands through the real registry and Host callback', async (name, command, denied) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-builtin-policy-'));
  try {
    const registry = new SkillRegistry(root, { projectPaths: [], userPaths: [], pluginPaths: [],
      builtinPath: path.resolve('packages/agent/src/capabilities/skills/builtin') });
    await registry.discover();
    const skill = await registry.loadFull(name);
    const authorize = vi.fn(async () => true as boolean | string);
    const options = await applyRuntimeSkillInvocationPolicy({ provider: 'unused',
      events: { beforeToolExecute: authorize }, context: { executionCwd: root, skillRegistry: registry,
        skillInvocation: { name, path: skill.skillFilePath, expandedContent: skill.content,
          runtimePolicy: { enforceAtRuntime: true } } } });
    expect(await options.events!.beforeToolExecute!('bash', { command })).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
    expect(await options.events!.beforeToolExecute!('bash', { command: denied })).toContain('[Blocked]');
    expect(authorize).toHaveBeenCalledOnce();
    authorize.mockResolvedValueOnce('[Blocked] Host authorization denied.');
    expect(await options.events!.beforeToolExecute!('bash', { command })).toBe('[Blocked] Host authorization denied.');
  } finally { await rm(root, { recursive: true, force: true }); }
});
