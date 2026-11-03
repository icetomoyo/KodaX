import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { protectWorkflowProject, withWorkflowWorktreeProtection, isWorkflowProjectProtected } from './project-protection.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('workflow-project-')) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-project-')); directories.push(directory);
  const runDir = join(directory, 'workflow-runs', 'project', 'run-one');
  const worktree = join(runDir, 'worktrees', 'scratch');
  const nested = join(worktree, 'packages', 'adopted');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: 'run-one', status: 'completed',
    hostMetadata: { ownerSessionId: 'workflow-session', ownerRunId: 'host-run' } }));
  return { directory, runDir, worktree, nested, marker: `${worktree}.project-reference.json` };
}

it('durably pins the owning temporary worktree when its nested directory becomes a project', async () => {
  const state = fixture();
  await protectWorkflowProject(state.nested);
  expect(isWorkflowProjectProtected(state.worktree)).toBe(true);
  const original = readFileSync(state.marker, 'utf8');
  expect(JSON.parse(original)).toMatchObject({ version: 1, runId: 'run-one', ownerSessionId: 'workflow-session', ownerRunId: 'host-run' });
  await protectWorkflowProject(state.worktree);
  expect(readFileSync(state.marker, 'utf8')).toBe(original);
  // Corrupt/old markers remain protection evidence, never an automatic GC reason.
  writeFileSync(state.marker, 'unknown old marker');
  expect(isWorkflowProjectProtected(state.worktree)).toBe(true);
});

it('pins an active Host Workflow before a terminal run.json exists', async () => {
  const state = fixture();
  rmSync(join(state.runDir, 'run.json'));
  writeFileSync(join(state.runDir, 'host-owner.json'), JSON.stringify({ version: 1, runId: 'run-one',
    hostMetadata: { ownerSessionId: 'active-session', ownerRunId: 'active-run' } }));
  await protectWorkflowProject(state.nested);
  expect(JSON.parse(readFileSync(state.marker, 'utf8'))).toMatchObject({ ownerSessionId: 'active-session', ownerRunId: 'active-run' });
});

it.each([undefined, { runId: 'ordinary-project', status: 'completed' }])('leaves an ordinary same-shaped project without Host ownership untouched (%j)', async manifest => {
  const state = fixture();
  rmSync(join(state.runDir, 'run.json'));
  if (manifest) writeFileSync(join(state.runDir, 'run.json'), JSON.stringify(manifest));
  await protectWorkflowProject(state.nested);
  expect(existsSync(state.marker)).toBe(false);
  expect(existsSync(`${state.worktree}.cleanup.lock`)).toBe(false);
  expect(existsSync(state.nested)).toBe(true);
});

it('does nothing for an unrelated missing project and refuses a missing owned directory or invalid owner', async () => {
  const state = fixture();
  const unrelated = join(state.directory, 'unrelated', 'missing');
  await protectWorkflowProject(unrelated);
  expect(existsSync(dirname(unrelated))).toBe(false);
  await expect(protectWorkflowProject(join(state.worktree, 'missing'))).rejects.toThrow();
  expect(existsSync(state.marker)).toBe(false);
  writeFileSync(join(state.runDir, 'run.json'), JSON.stringify({ runId: 'foreign-run', hostMetadata: { ownerSessionId: 's', ownerRunId: 'r' } }));
  await expect(protectWorkflowProject(state.worktree)).rejects.toThrow('matching Host owner');
  expect(existsSync(state.marker)).toBe(false);
});

it.each([false, true])('fails adoption after cleanup wins the same lock (replacement: %s)', async replace => {
  const state = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolveStarted => { entered = resolveStarted; });
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const cleanup = withWorkflowWorktreeProtection(state.worktree, async () => {
    entered(); await gate;
    if (!state.worktree.startsWith(state.directory + '\\') && !state.worktree.startsWith(state.directory + '/')) throw new Error('Unsafe cleanup target');
    rmSync(state.worktree, { recursive: true, force: true });
    if (replace) mkdirSync(state.nested, { recursive: true });
  });
  await started;
  const adoption = protectWorkflowProject(state.nested);
  const rejected = expect(adoption).rejects.toThrow();
  await vi.waitFor(() => expect(readdirSync(`${state.worktree}.cleanup.lock.queue`).some(name => name.startsWith('ticket-'))).toBe(true));
  release(); await cleanup; await rejected;
  expect(existsSync(state.marker)).toBe(false);
  if (!replace) expect(existsSync(`${state.worktree}.cleanup.lock.queue`)).toBe(false);
});

it('lets a cleanup contender see the durable pin under the shared lock', async () => {
  const state = fixture();
  await protectWorkflowProject(state.nested);
  const retained = await withWorkflowWorktreeProtection(state.worktree, async () => isWorkflowProjectProtected(state.worktree));
  expect(retained).toBe(true);
  expect(existsSync(state.nested)).toBe(true);
});

it('leaves no empty coordination queues after repeated temporary worktree cleanup', async () => {
  const state = fixture();
  for (let index = 0; index < 3; index++) {
    const tree = join(dirname(state.worktree), `temporary-${index}`);
    mkdirSync(tree);
    await withWorkflowWorktreeProtection(tree, async () => { rmdirSync(tree); });
    expect(existsSync(`${tree}.cleanup.lock.queue`)).toBe(false);
  }
});

it('retains unknown queue contents and a protected missing project', async () => {
  const state = fixture();
  const queue = `${state.worktree}.cleanup.lock.queue`;
  await withWorkflowWorktreeProtection(state.worktree, async () => {
    writeFileSync(join(queue, 'unknown'), 'retain');
    rmSync(state.worktree, { recursive: true });
  });
  expect(readdirSync(queue)).toEqual(['unknown']);
  rmSync(join(queue, 'unknown'));
  writeFileSync(state.marker, 'retain');
  await withWorkflowWorktreeProtection(state.worktree, async () => undefined);
  expect(existsSync(queue)).toBe(true);
});

it.runIf(process.platform === 'win32')('recognizes a Windows case alias of the same owned worktree', async () => {
  const state = fixture();
  await protectWorkflowProject(state.nested.toUpperCase());
  expect(isWorkflowProjectProtected(state.worktree)).toBe(true);
});
