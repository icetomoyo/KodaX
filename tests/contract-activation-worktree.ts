/** Capture-derived worktree first use; actual local Git facts, no model-chosen command execution. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { KodaXMessage } from '@kodax-ai/llm';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

export const WORKTREE_FIRST_USE_TASK = '请为这项独立工作准备一个隔离工作区，分支 codex/cache-ttl-review，说明“核对缓存 TTL 边界”。暂不修改代码，完成后告诉我位置。';

export async function prepareActivationWorktreePair(directory: string, baseline: FrozenInput, candidate: FrozenInput) {
  const workspace = path.join(directory, 'worktree-workspace'), hooks = path.join(directory, 'empty-git-hooks');
  await fs.mkdir(workspace); await fs.mkdir(hooks);
  await fs.writeFile(path.join(workspace, 'value.mjs'), 'export const value = 1;\n');
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Local Git fixture failed: ${result.error?.message ?? result.stderr}`);
    return { executable: 'git', args, cwd: workspace, status: result.status, stdout: result.stdout.replaceAll('\r\n', '\n'), stderr: result.stderr };
  };
  const setup = [git(['init', '-b', 'main']), git(['add', '--', 'value.mjs']),
    git(['-c', 'user.name=Offline Evaluation', '-c', 'user.email=offline@example.invalid', 'commit', '-m', 'Seed offline worktree fixture'])];
  const preflight = git(['status', '--short', '--branch']), top = git(['rev-parse', '--show-toplevel']);
  const newBranch = git(['branch', '--list', 'codex/cache-ttl-review']);
  if (preflight.stdout !== '## main\n' || newBranch.stdout !== '' || path.resolve(top.stdout.trim()) !== path.resolve(workspace)) throw new Error('Worktree fixture must be a clean actual main checkout with an unused target branch');
  const messages = structuredClone(baseline.messages) as KodaXMessage[];
  const envelope = messages.find(message => message.role === 'user' && message._synthetic === true && message._source === 'managed-run-context');
  if (!envelope || typeof envelope.content !== 'string' || !envelope.content.includes('Project: workspace\n')) throw new Error('Expected retained canonical cold Runtime envelope');
  envelope.content = envelope.content.replace(/Session Scratch Directory: [^\n]+/, () => `Session Scratch Directory: ${path.join(workspace, '.agent/tmp/sessions/activation-worktree')}`)
    .replace(/Project: workspace\n(?: +[^\n]*\n)*/u, () => `Project: ${workspace}\n  value.mjs\n`);
  const task = [...messages].reverse().find(message => message.role === 'user' && message._synthetic !== true && typeof message.content === 'string');
  if (!task) throw new Error('Missing original real user task');
  task.content = WORKTREE_FIRST_USE_TASK;
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'git-preflight', name: 'bash', input: { command: 'git status --short --branch' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'git-preflight', content: `${preflight.stdout}\nExit code: ${preflight.status}`, is_error: false }] });
  const facts = { workspace, setup, preflight, top, newBranch };
  const align = (input: FrozenInput) => {
    if ([...input.system.matchAll(/^Working Directory: [^\r\n]+/gm)].length !== 1) throw new Error('Expected one captured Environment working directory');
    return { ...input, system: input.system.replace(/^Working Directory: [^\r\n]+/m, () => `Working Directory: ${workspace}`) };
  };
  const alignedBaseline = align(baseline), alignedCandidate = align(candidate);
  const fullFacts = { ...facts, environmentProjection: { baselineBefore: inputHash(baseline.system), baselineAfter: inputHash(alignedBaseline.system),
    candidateBefore: inputHash(candidate.system), candidateAfter: inputHash(alignedCandidate.system), rule: 'Replace exactly one captured Working Directory line with actual common fixture cwd; all other system text stays captured.' } };
  return { baseline: { ...alignedBaseline, messages }, candidate: { ...alignedCandidate, messages: structuredClone(messages) }, facts: fullFacts,
    factHash: inputHash(fullFacts), canonicalMessagesHash: inputHash(messages), externalModelCalls: 0,
    scope: 'capture-derived controlled root checkpoint: retained/candidate cold system/tools, common canonical messages with truthful new local Git fixture environment and real preflight. Original captured raw is unchanged. No model-selected tool executes; no worktree is created by the evaluation.' };
}
