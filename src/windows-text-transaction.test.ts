import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertTrustedTextMutationPolicy,
  toolEdit,
  toolInsertAfterAnchor,
  toolUndo,
  toolWrite,
  type KodaXToolExecutionContext,
} from '@kodax-ai/coding';
import { toolMultiEdit } from '../packages/coding/src/tools/multi-edit.js';

import {
  _internalWindowsTextTransaction,
  createWindowsTrustedTextMutationHost,
} from './windows-text-transaction.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const posixIt = process.platform === 'win32' ? it.skip : it;
const portableIt = ['win32', 'linux', 'darwin'].includes(process.platform) ? it : it.skip;
const execFile = promisify(execFileCallback);
const authorizeOrdinaryCanonicalTarget = (canonicalTarget: string): void => {
  assertTrustedTextMutationPolicy(canonicalTarget);
};

async function createIntegrationTestRoot(): Promise<string> {
  const base = process.env.KODAX_NATIVE_TEST_TEMP
    ?? process.env.RUNNER_TEMP
    ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'kodax-windows-text-host-'));
}

async function writeFromExternalProcess(target: string, content: string): Promise<void> {
  await execFile(process.execPath, [
    '-e',
    'require("node:fs").writeFileSync(process.argv[1],process.argv[2])',
    target,
    content,
  ]);
}

describe('Windows trusted text transaction integration', () => {
  let root = '';

  beforeEach(async () => {
    root = await createIntegrationTestRoot();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  portableIt('keeps every controlled text tool usable without consulting a failed shell provider', async () => {
    const failedShellPreparation = Promise.reject(new Error('injected shell setup failure'));
    await expect(failedShellPreparation).rejects.toThrow('injected shell setup failure');

    const target = path.join(root, 'hello.md');
    const host = createWindowsTrustedTextMutationHost(
      () => [root],
      authorizeOrdinaryCanonicalTarget,
    );
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      gitRoot: root,
      trustedTextMutationHost: host,
    };

    await expect(toolWrite({ path: target, content: 'hello' }, ctx))
      .resolves.toContain('File created');
    await expect(toolEdit({
      path: target,
      old_string: 'hello',
      new_string: 'after',
    }, ctx)).resolves.toContain('File edited');
    await expect(toolMultiEdit({
      path: target,
      edits: [{ old_string: 'after', new_string: 'anchor' }],
    }, ctx)).resolves.toContain('File edited');
    await expect(toolInsertAfterAnchor({
      path: target,
      anchor: 'anchor',
      content: 'inserted',
    }, ctx)).resolves.toContain('Content inserted');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('anchor\ninserted');
    await expect(toolUndo({}, ctx)).resolves.toContain('Restored');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('anchor');
  });

  portableIt('lets only one Runtime commit the same observed revision', async () => {
    const target = path.join(root, 'same.txt');
    await fs.writeFile(target, 'before', 'utf8');
    const first = createWindowsTrustedTextMutationHost(
      () => [root],
      authorizeOrdinaryCanonicalTarget,
    );
    const second = createWindowsTrustedTextMutationHost(
      () => [root],
      authorizeOrdinaryCanonicalTarget,
    );
    const observed = await first.snapshot({ path: target, createParentDirectories: false });

    const outcomes = await Promise.all([
      first.commit({
        path: target,
        expectedRevision: observed.revision,
        content: 'first',
        createParentDirectories: false,
      }),
      second.commit({
        path: target,
        expectedRevision: observed.revision,
        content: 'second',
        createParentDirectories: false,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'written')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'stale')).toHaveLength(1);
  });

  portableIt('returns stale instead of overwriting a shell-side change before CAS', async () => {
    const target = path.join(root, 'shell-race.txt');
    await fs.writeFile(target, 'before', 'utf8');
    const host = createWindowsTrustedTextMutationHost(
      () => [root],
      authorizeOrdinaryCanonicalTarget,
    );
    const observed = await host.snapshot({ path: target, createParentDirectories: false });
    await writeFromExternalProcess(target, 'shell-change');

    await expect(host.commit({
      path: target,
      expectedRevision: observed.revision,
      content: 'must-not-overwrite',
      createParentDirectories: false,
    })).resolves.toMatchObject({ status: 'stale' });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('shell-change');
  });

  it('preserves a complete receipt when native durability is uncertain', () => {
    expect(_internalWindowsTextTransaction.requireWrittenOutcome(
      path.join(root, 'uncertain.txt'),
      'after',
      {
        status: 'committed_uncertain',
        slotId: 'slot:uncertain',
        preContent: 'before',
        preRevision: 'present:r1',
        postRevision: 'present:r2',
        abandonedLock: false,
        message: 'parent-directory durability could not be proven',
      },
    )).toEqual({
      status: 'committed_uncertain',
      before: {
        state: 'present',
        content: 'before',
        revision: 'present:r1',
        slot: 'slot:uncertain',
        canonicalPath: path.join(root, 'uncertain.txt'),
      },
      after: {
        state: 'present',
        content: 'after',
        revision: 'present:r2',
        slot: 'slot:uncertain',
        canonicalPath: path.join(root, 'uncertain.txt'),
      },
      recoveredAbandonedLock: false,
      reason: 'parent-directory durability could not be proven',
    });
  });

  it('rejects the pre-receipt native text protocol', () => {
    expect(() => _internalWindowsTextTransaction.validateNativeBinding({
      textTransactionProtocol: () => 3,
      TrustedTextTransactionRoot: class {
        constructor(_rootPath: string, _stateRoot?: string) {}
        async snapshot() { throw new Error('not used'); }
        async commit() { throw new Error('not used'); }
      },
    })).toThrow(/protocol 4/i);
  });

  portableIt('keeps the native undo receipt when an intervening shell write makes it stale', async () => {
    const target = path.join(root, 'undo-shell-race.txt');
    await fs.writeFile(target, 'before', 'utf8');
    const host = createWindowsTrustedTextMutationHost(
      () => [root],
      authorizeOrdinaryCanonicalTarget,
    );
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      gitRoot: root,
      trustedTextMutationHost: host,
    };

    await expect(toolEdit({
      path: target,
      old_string: 'before',
      new_string: 'kodax-edit',
    }, ctx)).resolves.toContain('File edited');
    await writeFromExternalProcess(target, 'shell-change');

    await expect(toolUndo({}, ctx)).rejects.toMatchObject({
      name: 'KodaXTrustedTextMutationError',
      code: 'text_mutation_stale',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('shell-change');
    expect(ctx.backups.size).toBe(1);

    await fs.writeFile(target, 'kodax-edit', 'utf8');
    await expect(toolUndo({}, ctx)).resolves.toContain('Restored');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('before');
  });

  portableIt('rejects targets outside the Runtime roots before native I/O', async () => {
    const host = createWindowsTrustedTextMutationHost(
      () => [root],
      authorizeOrdinaryCanonicalTarget,
    );
    const outside = path.join(path.dirname(root), 'outside.txt');
    await expect(host.snapshot({
      path: outside,
      createParentDirectories: false,
    })).rejects.toMatchObject({
      name: 'KodaXTrustedTextMutationError',
      code: 'text_mutation_policy_denied',
    });
  });

  posixIt('reauthorizes a canonical receipt path below an aliased write root', async () => {
    const actualParent = path.join(root, 'actual-parent');
    const actualRoot = path.join(actualParent, 'work');
    const aliasParent = path.join(root, 'alias-parent');
    const aliasedRoot = path.join(aliasParent, 'work');
    await fs.mkdir(actualRoot, { recursive: true });
    await fs.symlink(actualParent, aliasParent, 'dir');
    const canonicalRoot = await fs.realpath(actualRoot);
    const canonicalTarget = path.join(canonicalRoot, 'receipt.txt');

    expect(_internalWindowsTextTransaction.authorizeTarget(canonicalTarget, [aliasedRoot])).toEqual({
      canonicalRoot,
      canonicalTarget,
    });
  });

  windowsIt('rejects UNC and device namespaces before any filesystem call', () => {
    const lstat = vi.spyOn(fsSync, 'lstatSync');
    const realpath = vi.spyOn(fsSync.realpathSync, 'native');

    expect(() => _internalWindowsTextTransaction.authorizeTarget(
      String.raw`\\server\share\hello.md`,
      [String.raw`\\server\share`],
    )).toThrow(/UNC|device/i);
    expect(() => _internalWindowsTextTransaction.authorizeTarget(
      String.raw`\\?\C:\work\hello.md`,
      [String.raw`C:\work`],
    )).toThrow(/UNC|device/i);
    expect(() => _internalWindowsTextTransaction.authorizeTarget(
      String.raw`C:\work\hello.md`,
      [String.raw`\\.\C:\work`],
    )).toThrow(/UNC|device/i);

    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  windowsIt('rechecks canonical policy when an authorized root moves under a sensitive directory', async () => {
    const initialContainer = path.join(root, 'initial');
    const sensitiveContainer = path.join(root, 'protected', '.git');
    const authorizedDirectory = path.join(initialContainer, 'authorized');
    const movedDirectory = path.join(sensitiveContainer, 'authorized');
    const alias = path.join(root, 'alias');
    await fs.mkdir(authorizedDirectory, { recursive: true });
    await fs.mkdir(sensitiveContainer, { recursive: true });
    await fs.symlink(initialContainer, alias, 'junction');

    const lexicalRoot = path.join(alias, 'authorized');
    const target = path.join(lexicalRoot, 'policy.txt');
    await fs.writeFile(target, 'before', 'utf8');
    const authorizedTargets: string[] = [];
    const host = createWindowsTrustedTextMutationHost(() => [lexicalRoot], (canonicalTarget) => {
      authorizedTargets.push(canonicalTarget);
      assertTrustedTextMutationPolicy(canonicalTarget, root);
    });
    const observed = await host.snapshot({ path: target, createParentDirectories: false });

    await fs.rename(authorizedDirectory, movedDirectory);
    await fs.unlink(alias);
    await fs.symlink(sensitiveContainer, alias, 'junction');

    await expect(host.commit({
      path: target,
      expectedRevision: observed.revision,
      content: 'must-not-write',
      createParentDirectories: false,
    })).rejects.toMatchObject({
      code: 'text_mutation_policy_denied',
    });
    await expect(fs.readFile(path.join(movedDirectory, 'policy.txt'), 'utf8')).resolves.toBe('before');
    expect(authorizedTargets.some((candidate) => (
      candidate.split(/[\\/]+/).some((component) => component.toLowerCase() === '.git')
    ))).toBe(true);
  });

  it('leaves approvable Agent Home files to the outer permission policy', () => {
    const agentHome = path.join(root, 'agent-home');
    vi.stubEnv('KODAX_HOME', agentHome);

    expect(() => assertTrustedTextMutationPolicy(path.join(agentHome, 'config.json')))
      .not.toThrow();
    expect(() => assertTrustedTextMutationPolicy(path.join(agentHome, 'runtime', 'daemon.json')))
      .toThrow(/protected KodaX state/i);
  });
});
