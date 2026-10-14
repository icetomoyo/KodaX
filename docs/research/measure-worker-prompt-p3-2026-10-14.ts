// Offline pure-builder comparison against the frozen pre-edit commit. No provider calls.
// node node_modules/vite-node/vite-node.mjs --config vitest.config.ts docs/research/measure-worker-prompt-p3-2026-10-14.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { countTokens } from '../../packages/agent/src/tokenizer.ts';
import * as worker from '../../packages/coding/src/agents/worker-role-prompt.ts';
import * as role from '../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts';
import * as formatting from '../../packages/coding/src/task-engine/_internal/managed-task/formatting.ts';
import { EXECUTION_GUIDANCE } from '../../packages/coding/src/prompts/execution-guidance.ts';
import { buildFallbackRoutingDecision } from '../../packages/coding/src/reasoning.ts';

const baselineCommit = 'bd4479d59cab3d082f07c2d34681fff198d82fa0';

function baselineModule(file: string, dependencies: Readonly<Record<string, unknown>>): unknown {
  const source = execFileSync('git', ['show', `${baselineCommit}:${file}`], { encoding: 'utf8', windowsHide: true });
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(result.outputText, { exports, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected builder dependency: ${name}`);
    return dependencies[name];
  } }, { timeout: 1000 });
  return exports;
}

const beforeWorker = baselineModule('packages/coding/src/agents/worker-role-prompt.ts', {
  '../prompts/execution-guidance.js': { EXECUTION_GUIDANCE },
}) as typeof worker;
const beforeRole = baselineModule('packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts', {
  '../../../agents/worker-role-prompt.js': beforeWorker,
  './formatting.js': formatting,
}) as typeof role;
const task = 'Explain where configuration is loaded.';
const decision = buildFallbackRoutingDecision(task);
const context = { originalTask: task, workspace: {
  executionCwd: 'C:\\fixture\\workspace', gitRoot: 'C:\\fixture\\workspace', platform: 'win32' as const,
} };
const size = (text: string) => ({ chars: text.length, bytes: Buffer.byteLength(text), estimatedTokens: countTokens(text) });
const render = (builder: typeof role, mode: 'stable' | 'context') => builder.createRolePrompt(
  'worker', task, decision, undefined, undefined, 'kodax/role/worker', undefined, context, undefined, false, mode,
);
const report = {
  baselineCommit,
  methodology: 'Pure production builders with one fixed Windows context; baseline source compiled from the pinned baselineCommit, unchanged formatting/execution-guidance dependencies shared. No tools JSON or external context included. countTokens is the project heuristic, not provider usage. Candidate uses the current worktree builders. Undefined capabilities preserve standalone full guidance on both sides.',
  workerStable: { before: size(beforeWorker.buildWorkerStableInstructions()), after: size(worker.buildWorkerStableInstructions()) },
  roleStable: { before: size(render(beforeRole, 'stable')), after: size(render(role, 'stable')) },
  roleContext: { before: size(render(beforeRole, 'context')), after: size(render(role, 'context')) },
  restrictedRepoGuidance: size(worker.buildWorkerStableInstructions(['read', 'grep', 'module_context'])),
};
await fs.writeFile('docs/research/worker-prompt-p3-measurement-2026-10-14.json', JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
