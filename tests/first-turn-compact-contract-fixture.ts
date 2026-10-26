import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toolRead } from '../packages/coding/src/tools/read.js';
import { toolEdit } from '../packages/coding/src/tools/edit.js';
import { toolSkill } from '../packages/coding/src/tools/skill.js';
import { SkillRegistry } from '../packages/agent/src/capabilities/skills/skill-registry.js';
import { createTodoStore } from '../packages/coding/src/task-engine/todo-store.js';
import { toolTodoUpdate } from '../packages/coding/src/tools/todo-update.js';
import { toolTodoList } from '../packages/coding/src/tools/todo-list.js';
import { cacheSource, equalityTest, contractCases, priorCall, priorResult } from './first-turn-compact-contract-cases.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import { createAgentActorController } from '../packages/agent/src/actors/index.js';
import { toolSpawnAgent } from '../packages/coding/src/tools/agent-collaboration.js';
import { createTrustedTextMutationHost } from '../src/windows-text-transaction.js';
import { assertTrustedTextMutationPolicy } from '../packages/coding/src/trusted-text-mutation.js';

/** Preparation executes only these bounded local fixture operations, never model-chosen tools. */
export async function prepareContractFixture(directory: string) {
  const workspace = path.join(directory, 'controlled-workspace');
  await fs.mkdir(path.join(workspace, 'packages/cache'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'tests'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
  await fs.writeFile(path.join(workspace, 'packages/cache/store.js'), cacheSource, { flag: 'wx' });
  await fs.writeFile(path.join(workspace, 'tests/equality.test.mjs'), equalityTest, { flag: 'wx' });
  const context: KodaXToolExecutionContext = { backups: new Map(), executionCwd: workspace,
    trustedTextMutationHost: createTrustedTextMutationHost(() => [workspace], target => assertTrustedTextMutationPolicy(target, workspace)) };
  const read = await toolRead({ path: 'packages/cache/store.js' }, context);
  if (typeof read !== 'string') throw new Error('Expected real text read');
  const refusedEdit = await toolEdit({ path: 'packages/cache/store.js', edits: [{ old_string: 'clock() > deadline', new_string: 'clock() >= deadline' }] }, context);
  if (!refusedEdit.includes('[Tool Error]')) throw new Error('Expected real stale-anchor refusal');
  const before = await fs.readFile(path.join(workspace, 'packages/cache/store.js'), 'utf8');
  if (before !== cacheSource) throw new Error('Refused edit mutated fixture');
  const originalTest = spawnSync(process.execPath, ['--test', 'tests/equality.test.mjs'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  if (originalTest.error || originalTest.status !== 1) throw new Error('Equality test must catch original defect');
  const edit = await toolEdit({ path: 'packages/cache/store.js', edits: [{ old_string: 'clock() > entry.expiresAt', new_string: 'clock() >= entry.expiresAt' }] }, context);
  if (edit.includes('[Tool Error]')) throw new Error('Prepared legal edit failed');
  const tested = spawnSync(process.execPath, ['--test', 'tests/equality.test.mjs'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  if (tested.error || tested.status !== 0) throw new Error('Prepared fixed equality test failed');
  const test = `${tested.stdout}${tested.stderr}\nExit code: ${tested.status}`;
  const store = createTodoStore();
  store.init([{ id: 'todo_1', subject: '修复' }, { id: 'todo_2', subject: '验证并交付' }]);
  const todoContext: KodaXToolExecutionContext = { backups: new Map(), todoStore: store };
  await toolTodoUpdate({ id: 'todo_1', status: 'completed' }, todoContext);
  await toolTodoUpdate({ id: 'todo_2', status: 'in_progress', activeForm: '验证并交付' }, todoContext);
  const listBefore = { all: await toolTodoList({}, todoContext), item: await toolTodoList({ id: 'todo_2' }, todoContext) };
  const complete = await toolTodoUpdate({ id: 'todo_2', status: 'completed' }, todoContext);
  const listAfter = { all: await toolTodoList({}, todoContext), item: await toolTodoList({ id: 'todo_2' }, todoContext) };
  const skillRegistry = new SkillRegistry(workspace, { projectPaths: [], userPaths: [], pluginPaths: [], builtinPath: path.resolve('packages/agent/src/capabilities/skills/builtin') });
  const reviewSkill = await toolSkill({ skill: 'code-review', args: 'packages/identity packages/cache' },
    { ...context, skillRegistry, skillDynamicContext: { disable: true } });
  if (reviewSkill.startsWith('[Tool Error]')) throw new Error('Builtin review skill failed to expand');
  const controller = await createAgentActorController({ executor: { execute: input => new Promise(resolve => {
    const finish = () => resolve({ output: 'Offline fixture cleanup' });
    if (input.signal.aborted) finish(); else input.signal.addEventListener('abort', finish, { once: true });
  }) } });
  let capacity: string;
  try {
    const actorContext: KodaXToolExecutionContext = { backups: new Map(), actorControl: controller.bind('/root'), actorTurnRef: { actorPath: '/root', turnId: 'root-fixture' } };
    for (const name of ['inspect-child', 'second', 'third']) {
      const admitted = JSON.parse(await toolSpawnAgent({ task_name: name, objective: 'Bounded offline fixture', read_only: true }, actorContext)) as { ok?: boolean };
      if (!admitted.ok) throw new Error('Offline child admission failed');
    }
    capacity = await toolSpawnAgent({ task_name: 'extra', objective: 'Investigate TTL', read_only: true }, actorContext);
    const refused = JSON.parse(capacity) as { ok: boolean; error: { code: string; activeNonRootTurns: number } };
    if (refused.ok || refused.error.code !== 'agent_limit_reached' || refused.error.activeNonRootTurns !== 3) throw new Error('Expected real capacity refusal');
  } finally { await controller.shutdown('Offline fixture finished'); }
  const cases = contractCases({ read, refusedEdit, capacity });
  const reviewCase = cases.find(item => item.id === 'P03')!;
  reviewCase.history.unshift(priorCall('loaded-review', 'skill', { skill: 'code-review', args: 'packages/identity packages/cache' }), priorResult('loaded-review', reviewSkill));
  reviewCase.state += ' The code-review Skill was already invoked; its complete expanded result is in the history. Do not load it again.';
  return { workspace, cases, receipts: { read, refusedEdit, capacity, edit, test, complete, listBefore, listAfter },
    originalTest: { exitCode: originalTest.status, stdout: originalTest.stdout, stderr: originalTest.stderr } };
}
