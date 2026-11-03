import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowAgentBackend } from '@kodax-ai/agent';
import { runWorkflowModule } from './workflow-runner.js';
import { completeWorkflowRunCleanup, recoverWorkflowRunCleanups } from './cleanup.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const backend: WorkflowAgentBackend = {
  spawn: async () => { throw new Error('unexpected spawn'); },
  wait: async () => { throw new Error('unexpected wait'); },
  output: async () => { throw new Error('unexpected output'); },
  send: async () => {}, stop: async () => {},
};

describe('Host-owned Workflow cleanup', () => {
  it('retries the exact branch after its worktree disappeared without replaying the Workflow', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'workflow-branch-recovery-')); dirs.push(configHome);
    const runDir = join(configHome, 'workflow-runs', 'project', 'branch-recovery');
    const worktree = join(runDir, 'worktrees', 'scratch');
    mkdirSync(worktree, { recursive: true });
    let executions = 0;
    await runWorkflowModule({ runId: 'branch-recovery', runDir, args: {}, backend,
      processMetadata: { hostMetadata: { ownerSessionId: 'session-a', ownerRunId: 'branch-recovery' } },
      module: { meta: { name: 'branch-recovery', description: 'recover branch cleanup' },
        run: async () => { executions++; return 'done'; } },
    });
    const oid = 'a'.repeat(40);
    let treePresent = true;
    let branchPresent = true;
    let fail = true;
    const runGit = async (args: readonly string[]): Promise<string> => {
      if (args[0] === 'worktree' && args[1] === 'list') return treePresent
        ? `worktree ${worktree}\nHEAD ${oid}\nbranch refs/heads/workflow-scratch\n` : '';
      if (args[0] === 'rev-parse') return branchPresent ? oid : '';
      if (args[0] === 'worktree' && args[1] === 'remove') treePresent = false;
      if (args[0] === 'branch' || args[0] === 'update-ref') {
        if (fail) throw new Error('branch ref lock is busy');
        expect(args).toEqual(['update-ref', '-d', 'refs/heads/workflow-scratch', oid]);
        branchPresent = false;
      }
      return '';
    };
    const first = await completeWorkflowRunCleanup({ runId: 'branch-recovery', runDir,
      ownerSessionId: 'session-a', ownerRunId: 'branch-recovery', gitRoot: configHome,
      resourcesStopped: true, configHome }, { runGit });
    expect(treePresent).toBe(false);
    expect(branchPresent).toBe(true);
    expect(first.warnings.join(' ')).toContain('branch ref lock is busy');
    expect(JSON.parse(readFileSync(join(runDir, 'cleanup.json'), 'utf8')).completed).toBe(false);
    fail = false;
    expect((await recoverWorkflowRunCleanups(configHome, { runGit })).warnings).toEqual([]);
    expect(branchPresent).toBe(false);
    expect(executions).toBe(1);
    expect(JSON.parse(readFileSync(join(runDir, 'cleanup.json'), 'utf8')).completed).toBe(true);
  });

  it('persists a valid void return distinctly and can reclaim its confirmed temporary work', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'workflow-cleanup-void-')); dirs.push(runDir);
    const worktree = join(runDir, 'worktrees', 'scratch');
    mkdirSync(worktree, { recursive: true });
    await runWorkflowModule({ runId: 'void', runDir, args: {}, backend,
      processMetadata: { hostMetadata: { ownerSessionId: 'session-a', ownerRunId: 'void' } },
      module: { meta: { name: 'void', description: 'no return is valid SDK execution' }, run: async () => {} },
    });
    expect(JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'))).toEqual({ version: 1, kind: 'undefined' });
    const result = await completeWorkflowRunCleanup({ runId: 'void', runDir, ownerSessionId: 'session-a',
      ownerRunId: 'void', gitRoot: runDir, resourcesStopped: true }, { runGit: async args =>
      args[0] === 'worktree' && args[1] === 'list' ? `worktree ${worktree}\n` : '' });
    expect(result.removed).toEqual([worktree]);
  });
  it('only reclaims confirmed unreferenced worktrees after complete final evidence is durable', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'workflow-cleanup-')); dirs.push(runDir);
    const retained = join(runDir, 'worktrees', 'report-source');
    const disposable = join(runDir, 'worktrees', 'scratch');
    mkdirSync(disposable, { recursive: true });
    const foreign = join(runDir, '..', 'another-run', 'worktrees', 'scratch');
    await runWorkflowModule({ runId: 'owned-run', runDir, args: {}, backend,
      processMetadata: { hostMetadata: { ownerSessionId: 'session-a', ownerRunId: 'run-a' } },
      module: { meta: { name: 'cleanup-test', description: 'cleanup ownership' }, run: async wf => {
        await wf.artifact('report', { originalPath: join(retained, 'output.txt') });
        return { summary: 'done', complete: 'full original' };
      } },
    });
    mkdirSync(join(runDir, 'results'), { recursive: true });
    writeFileSync(join(runDir, 'results', 'child.json'), JSON.stringify({ finalText:
      `[Workflow worktree: ${disposable}]\nInspected project without retaining files.` }));
    const removed: string[] = [];
    const runGit = async (args: readonly string[]): Promise<string> => {
      if (args[0] === 'worktree' && args[1] === 'list') return [retained, disposable, foreign]
        .filter(p => !removed.includes(p)).map(p => `worktree ${p}\n`).join('\n');
      if (args[0] === 'worktree' && args[1] === 'remove') {
        expect(JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')).value.complete).toBe('full original');
        removed.push(args[2]!);
      }
      return '';
    };
    const input = { runId: 'owned-run', runDir, ownerSessionId: 'session-a', ownerRunId: 'run-a', gitRoot: runDir, resourcesStopped: true as const };
    const foreignResult = await completeWorkflowRunCleanup({ ...input, ownerSessionId: 'session-b' }, { runGit });
    expect(foreignResult.removed).toEqual([]);
    expect(removed).toEqual([]);
    const result = await completeWorkflowRunCleanup(input, { runGit });
    expect(result.removed).toEqual([disposable]);
    expect(removed).toEqual([disposable]);
    expect(result.warnings.join(' ')).toContain('referenced');
    await completeWorkflowRunCleanup(input, { runGit });
    expect(removed).toEqual([disposable]);
  });

  it('does no Git work for a run with no worktrees', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'workflow-cleanup-empty-')); dirs.push(runDir);
    await runWorkflowModule({ runId: 'empty', runDir, args: {}, backend,
      processMetadata: { hostMetadata: { ownerSessionId: 'session-a', ownerRunId: 'run-a' } },
      module: { meta: { name: 'empty', description: 'no temporary work' }, run: async () => 'done' },
    });
    let gitCalls = 0;
    const result = await completeWorkflowRunCleanup({ runId: 'empty', runDir, ownerSessionId: 'session-a',
      ownerRunId: 'run-a', gitRoot: runDir, resourcesStopped: true }, { runGit: async () => { gitCalls++; return ''; } });
    expect(result.warnings).toEqual([]);
    expect(gitCalls).toBe(0);
  });

  it('retains temporary resources when a declared complete original is unreadable', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'workflow-cleanup-incomplete-')); dirs.push(configHome);
    const runDir = join(configHome, 'workflow-runs', 'project', 'incomplete');
    mkdirSync(join(runDir, 'worktrees', 'scratch'), { recursive: true });
    await runWorkflowModule({ runId: 'incomplete', runDir, args: {}, backend,
      processMetadata: { hostMetadata: { ownerSessionId: 'session-a', ownerRunId: 'incomplete' } },
      module: { meta: { name: 'incomplete', description: 'retained original' }, run: async () => 'full original' },
    });
    const original = readFileSync(join(runDir, 'result.json'), 'utf8');
    writeFileSync(join(runDir, 'result.json'), '{');
    let gitCalls = 0;
    const result = await completeWorkflowRunCleanup({ runId: 'incomplete', runDir,
      ownerSessionId: 'session-a', ownerRunId: 'incomplete', gitRoot: runDir, resourcesStopped: true, configHome },
    { runGit: async () => { gitCalls++; return ''; } });
    expect(result.removed).toEqual([]);
    expect(result.warnings.join(' ')).toContain('retained resources');
    expect(gitCalls).toBe(0);
    writeFileSync(join(runDir, 'result.json'), original);
    await recoverWorkflowRunCleanups(configHome, { runGit: async () => { gitCalls++; return ''; } });
    expect(gitCalls).toBeGreaterThan(0);
  });

  it('resumes a partially failed cleanup from its durable eligibility receipt without replaying the workflow', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'workflow-cleanup-recovery-')); dirs.push(configHome);
    const runDir = join(configHome, 'workflow-runs', 'project', 'recoverable');
    const worktree = join(runDir, 'worktrees', 'scratch');
    mkdirSync(worktree, { recursive: true });
    let executions = 0;
    await runWorkflowModule({ runId: 'recoverable', runDir, args: {}, backend,
      processMetadata: { hostMetadata: { ownerSessionId: 'session-a', ownerRunId: 'recoverable' } },
      module: { meta: { name: 'recovery', description: 'cleanup recovery' }, run: async () => { executions++; return 'done'; } },
    });
    let fail = true;
    let removed = false;
    const runGit = async (args: readonly string[]): Promise<string> => {
      if (args[0] === 'worktree' && args[1] === 'list') return removed ? '' : `worktree ${worktree}\n`;
      if (args[0] === 'worktree' && args[1] === 'remove') {
        if (fail) throw new Error('fixture sharing violation');
        removed = true;
      }
      return '';
    };
    const first = await completeWorkflowRunCleanup({ runId: 'recoverable', runDir, ownerSessionId: 'session-a',
      ownerRunId: 'recoverable', gitRoot: configHome, resourcesStopped: true, configHome }, { runGit });
    expect(first.warnings.join(' ')).toContain('fixture sharing violation');
    fail = false;
    const recovered = await recoverWorkflowRunCleanups(configHome, { runGit });
    expect(recovered.removed).toEqual([worktree]);
    expect(executions).toBe(1);
    expect((await recoverWorkflowRunCleanups(configHome, { runGit })).removed).toEqual([]);
  });
});
