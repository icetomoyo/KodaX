import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTrustedTextMutationPolicy, toolWrite, type KodaXEvents, type KodaXToolExecutionContext } from '@kodax-ai/coding';
import { executeToolCall } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { createTrustedTextMutationHost } from './windows-text-transaction.js';
import { trustedTextNativeArtifactStateRoots } from './windows-native-artifacts.js';
import { createPermissionContext, executeWithPermission } from '../packages/repl/src/permission/executor.js';

describe('approved text targets outside workspace roots', () => {
  let root: string;
  let workspace: string;
  let ctx: KodaXToolExecutionContext;
  const state = () => buildRuntimeSessionState({ activeTools: [], modelSelection: {} });
  const dispatch = (name: string, input: Record<string, unknown>, events: KodaXEvents = {
    beforeToolExecute: async () => true,
  }) => executeToolCall(events, { id: `call-${name}`, name, input }, ctx, state());

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-text-permission-'));
    workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    ctx = {
      backups: new Map(), executionCwd: workspace, gitRoot: workspace,
      trustedTextMutationHost: createTrustedTextMutationHost(() => [workspace], (target) => {
        assertTrustedTextMutationPolicy(target, workspace, [path.join(workspace, '.kodax', 'exec-policy.jsonc')]);
      }),
      shellSandbox: { prepare: vi.fn(async () => { throw new Error('shell unavailable'); }) },
    };
  });

  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('runs all five text tools through an exact permission gate while the shell is unavailable', async () => {
    const target = path.join(root, 'user', '.kodax', 'skills', 'sample', 'SKILL.md');
    await expect(dispatch('write', { path: target, content: 'before' })).resolves.toContain('File created');
    await expect(dispatch('edit', { path: target, old_string: 'before', new_string: 'edited' })).resolves.toContain('File edited');
    await expect(dispatch('multi_edit', { path: target, edits: [{ old_string: 'edited', new_string: 'anchor' }] })).resolves.toContain('File edited');
    await expect(dispatch('insert_after_anchor', { path: target, anchor: 'anchor', content: 'extra' })).resolves.toContain('Content inserted');
    await expect(dispatch('undo', {})).resolves.toContain('Restored');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('anchor');
    expect(ctx.shellSandbox?.prepare).not.toHaveBeenCalled();
    expect(ctx.approvedTextMutationPath).toBeUndefined();
    await expect(toolWrite({ path: target, content: 'unapproved' }, ctx)).rejects.toMatchObject({ code: 'text_mutation_policy_denied' });
  });

  it('authorizes the concrete bridge target exactly once', async () => {
    const target = path.join(root, 'user', '.kodax', 'integrations', 'a2a.json');
    const gate = vi.fn(async () => true);
    await expect(dispatch('tool_call', { name: 'write', arguments: { path: target, content: '{}' } }, {
      beforeToolExecute: gate,
    })).resolves.toContain('File created');
    expect(gate).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenCalledWith('write', { path: target, content: '{}' }, { toolId: 'call-tool_call:write' });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('{}');
  });

  it.each(['unreviewed', 'rejected'] as const)('does not grant external access through the legacy Auto helper: %s', async (review) => {
    const target = path.join(root, 'auto.txt');
    const permission = createPermissionContext({
      permissionMode: 'auto', gitRoot: workspace,
      ...(review === 'rejected' ? { beforeToolExecute: async () => false } : {}),
    });
    await expect(executeWithPermission('write', { path: target, content: 'denied' }, ctx, permission))
      .resolves.toContain('outside the Runtime write roots');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([true, false])('grants legacy Edits external access only after confirmation: %s', async (confirmed) => {
    const target = path.join(root, 'confirmed.txt');
    const permission = createPermissionContext({
      permissionMode: 'accept-edits', gitRoot: workspace,
      onConfirm: async () => ({ confirmed }),
    });
    permission.confirmTools.add('write');
    const result = await executeWithPermission('write', { path: target, content: 'approved' }, ctx, permission);
    if (confirmed) {
      expect(result).toContain('File created');
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('approved');
    } else {
      expect(result).toContain('[Cancelled]');
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each([false, '[Blocked] Plan mode'])('does not write after a permission rejection: %s', async (decision) => {
    const target = path.join(root, 'rejected.txt');
    await dispatch('write', { path: target, content: 'denied', approvedPath: target, approvedTextMutationPath: target }, {
      beforeToolExecute: async () => decision,
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not treat a tool argument or a missing permission hook as authorization', async () => {
    const target = path.join(root, 'unapproved.txt');
    await expect(dispatch('write', { path: target, content: 'denied', approvedPath: target }, {}))
      .resolves.toContain('outside the Runtime write roots');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reuse an exact approval for a sibling file, including one inside the workspace', async () => {
    const approvedPath = path.join(root, 'approved.txt');
    for (const target of [path.join(root, 'sibling.txt'), path.join(workspace, 'other.txt')]) {
      await expect(ctx.trustedTextMutationHost!.snapshot({ path: target, approvedPath, createParentDirectories: true }))
        .rejects.toMatchObject({ code: 'text_mutation_policy_denied' });
    }
  });

  it('keeps independent parallel calls isolated', async () => {
    const targets = [path.join(root, 'one', 'note.txt'), path.join(root, 'two', 'note.txt')];
    const results = await Promise.all(targets.map((target, index) => dispatch('write', { path: target, content: String(index) })));
    expect(results.every((result) => result.includes('File created'))).toBe(true);
    expect(await Promise.all(targets.map((target) => fs.readFile(target, 'utf8')))).toEqual(['0', '1']);
    expect(ctx.approvedTextMutationPath).toBeUndefined();
  });

  it('preserves CAS when a missing parent is created between snapshot and parallel commits', async () => {
    const target = path.join(root, 'new', 'subdir', 'shared.txt');
    const first = ctx.trustedTextMutationHost!;
    const second = createTrustedTextMutationHost(() => [workspace], assertTrustedTextMutationPolicy);
    const snapshot = await first.snapshot({ path: target, approvedPath: target, createParentDirectories: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    const input = { path: target, approvedPath: target, expectedCanonicalPath: snapshot.canonicalPath,
      expectedRevision: snapshot.revision, createParentDirectories: true };
    const outcomes = await Promise.all([
      first.commit({ ...input, content: 'one' }), second.commit({ ...input, content: 'two' }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['stale', 'written']);
  });

  it('keeps Git, project Exec Policy, and native state protected after approval', async () => {
    for (const target of [path.join(root, '.git', 'config'), path.join(workspace, '.kodax', 'exec-policy.jsonc')]) {
      await expect(dispatch('write', { path: target, content: 'denied' })).resolves.toContain('protected KodaX state');
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const target = path.join(trustedTextNativeArtifactStateRoots()[0]!, 'never-written.txt');
    await expect(dispatch('write', { path: target, content: 'denied' })).resolves.toContain('protected native text state');
  });

  it('rejects a retargeted ancestor before committing to its new location', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const alias = path.join(root, 'alias');
    await fs.mkdir(path.join(first, 'nested'), { recursive: true });
    await fs.mkdir(path.join(second, 'nested'), { recursive: true });
    await fs.symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(alias, 'nested', 'note.txt');
    const host = ctx.trustedTextMutationHost!;
    const snapshot = await host.snapshot({ path: target, approvedPath: target, createParentDirectories: true });
    await fs.unlink(alias);
    await fs.symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(host.commit({ path: target, approvedPath: target,
      expectedCanonicalPath: snapshot.canonicalPath, expectedRevision: snapshot.revision,
      content: 'denied', createParentDirectories: true })).rejects.toMatchObject({ code: 'text_mutation_identity_changed' });
    await expect(fs.stat(path.join(second, 'nested', 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
