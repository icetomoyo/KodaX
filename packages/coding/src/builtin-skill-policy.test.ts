import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { SkillRegistry } from '@kodax-ai/agent';
import { applyRuntimeSkillInvocationPolicy } from './skill-invocation-policy.js';

// Shipped Skills are instructions, not tool sandboxes: activating one never narrows the
// agent's tools. Every call still goes through Host authorization and sandbox checks.
it.each([
  ['git-workflow', 'git status --short', 'Get-ChildItem .'],
  ['tdd', 'npm test -- --run', 'web_fetch'],
  ['code-review', 'git diff --stat', 'spawn_agent'],
  ['skill-creator', 'node scripts/run-eval.js --help', 'todo_create'],
] as const)('shipped %s leaves every tool to Host authorization', async (name, command, other) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-builtin-policy-'));
  try {
    const registry = new SkillRegistry(root, { projectPaths: [], userPaths: [], pluginPaths: [],
      builtinPath: path.resolve('packages/agent/src/capabilities/skills/builtin') });
    await registry.discover();
    const skill = await registry.loadFull(name);
    expect(skill.allowedTools).toBeUndefined();
    const authorize = vi.fn(async () => true as boolean | string);
    const options = await applyRuntimeSkillInvocationPolicy({ provider: 'unused',
      events: { beforeToolExecute: authorize }, context: { executionCwd: root, skillRegistry: registry,
        skillInvocation: { name, path: skill.skillFilePath, expandedContent: skill.content,
          runtimePolicy: { enforceAtRuntime: true } } } });
    const before = options.events!.beforeToolExecute!;
    expect(await before('bash', { command })).toBe(true);
    expect(await before('bash', { command: other })).toBe(true);
    expect(await before(other, {})).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(3);
    authorize.mockResolvedValueOnce('[Blocked] Host authorization denied.');
    expect(await before('bash', { command })).toBe('[Blocked] Host authorization denied.');
  } finally { await rm(root, { recursive: true, force: true }); }
});
