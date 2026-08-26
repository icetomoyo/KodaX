import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertTrustedTextMutationPolicy,
  toolWrite,
  type KodaXToolExecutionContext,
} from '@kodax-ai/coding';

import {
  runKodaXSandboxed,
  type KodaXSandboxRunResult,
} from '../src/sandbox-runtime.js';
import { createTrustedTextMutationHost } from '../src/windows-text-transaction.js';
import { trustedTextNativeArtifactStateRoots } from '../src/windows-native-artifacts.js';

const realPosixGate = (process.platform === 'linux' || process.platform === 'darwin')
  && process.env.KODAX_REAL_POSIX_SANDBOX === '1';

const barrierScript = String.raw`
const fs = require('node:fs');
const own = process.argv[1];
const peer = process.argv[2];
fs.writeFileSync(own, 'ready');
const deadline = Date.now() + 15000;
while (!fs.existsSync(peer) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
if (!fs.existsSync(peer)) {
  process.stderr.write('KODAX_POSIX_BARRIER_TIMEOUT\n');
  process.exit(7);
}
`;

function requireCompleted(result: KodaXSandboxRunResult): Extract<
  KodaXSandboxRunResult,
  { readonly status: 'completed' }
> {
  if (result.status !== 'completed') {
    throw new Error(`POSIX sandbox unavailable: ${JSON.stringify(result.doctor)}`);
  }
  return result;
}

function requireExit(
  result: KodaXSandboxRunResult,
  exitCode: number,
): Extract<KodaXSandboxRunResult, { readonly status: 'completed' }> {
  const completed = requireCompleted(result);
  if (completed.exitCode !== exitCode) {
    throw new Error(
      `POSIX sandbox exited ${completed.exitCode}, expected ${exitCode}: `
      + JSON.stringify({ stdout: completed.stdout, stderr: completed.stderr }),
    );
  }
  return completed;
}

async function waitForFile(target: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(target);
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${target}`);
}

describe.runIf(realPosixGate)('FEATURE_295 real POSIX shell sandbox', () => {
  const roots: string[] = [];
  const protectedProbes: string[] = [];

  afterEach(async () => {
    await Promise.all([
      ...protectedProbes.splice(0).map((file) => rm(file, { force: true })),
      ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ]);
  });

  it('runs independent policies concurrently and enforces each write root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-posix-policies-'));
    roots.push(root);
    const policyA = path.join(root, 'a');
    const policyB = path.join(root, 'b');
    await Promise.all([mkdir(policyA), mkdir(policyB)]);
    const readyA = path.join(policyA, 'ready');
    const readyB = path.join(policyB, 'ready');

    const run = (writeRoot: string, own: string, peer: string) => runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', barrierScript, own, peer],
      cwd: writeRoot,
      filesystem: {
        allowRead: [root],
        allowWrite: [writeRoot],
      },
      network: { mode: 'deny' },
      inheritEnvironment: true,
      timeoutMs: 25_000,
    });

    const [resultA, resultB] = await Promise.all([
      run(policyA, readyA, readyB),
      run(policyB, readyB, readyA),
    ]);
    expect(requireExit(resultA, 0).sandboxed).toBe(true);
    expect(requireExit(resultB, 0).sandboxed).toBe(true);

    const sentinel = `KODAX_EXPECTED_POSIX_POLICY_DENIAL:${randomUUID()}`;
    const protectedSentinel = `KODAX_EXPECTED_POSIX_PROTECTED_READ_DENIAL:${randomUUID()}`;
    const escaped = path.join(policyA, 'escaped');
    const ownMarker = path.join(policyB, 'own-write');
    const protectedRoot = trustedTextNativeArtifactStateRoots().at(-1);
    if (protectedRoot === undefined) throw new Error('expected a protected native text root');
    await mkdir(protectedRoot, { recursive: true, mode: 0o700 });
    const protectedProbe = path.join(protectedRoot, `policy-probe-${randomUUID()}`);
    protectedProbes.push(protectedProbe);
    await writeFile(protectedProbe, 'protected', { mode: 0o600 });
    const denialScript = String.raw`
const fs = require('node:fs');
const own = process.argv[1];
const escaped = process.argv[2];
const sentinel = process.argv[3];
const protectedProbe = process.argv[4];
const protectedSentinel = process.argv[5];
fs.writeFileSync(own, 'allowed');
try {
  fs.writeFileSync(escaped, 'escape');
  process.stderr.write('KODAX_POSIX_ESCAPE_UNEXPECTEDLY_SUCCEEDED\n');
  process.exit(9);
} catch (error) {
  if (
    error
    && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS')
    && error.path === escaped
  ) {
    process.stderr.write(sentinel + '\n');
  } else {
    throw error;
  }
}
try {
  fs.readFileSync(protectedProbe);
  process.stderr.write('KODAX_POSIX_PROTECTED_READ_UNEXPECTEDLY_SUCCEEDED\n');
  process.exit(10);
} catch (error) {
  if (
    error
    && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOENT')
    && error.path === protectedProbe
  ) {
    process.stderr.write(protectedSentinel + '\n');
    process.exit(1);
  }
  throw error;
}
`;
    const denied = requireCompleted(await runKodaXSandboxed({
      command: process.execPath,
      args: [
        '-e', denialScript, ownMarker, escaped, sentinel, protectedProbe, protectedSentinel,
      ],
      cwd: policyB,
      filesystem: {
        allowRead: [root],
        allowWrite: [policyB],
      },
      network: { mode: 'deny' },
      inheritEnvironment: true,
      timeoutMs: 15_000,
    }));

    expect(denied.exitCode).toBe(1);
    expect(denied.stderr.split(/\r?\n/)).toContain(sentinel);
    expect(denied.stderr.split(/\r?\n/)).toContain(protectedSentinel);
    await expect(readFile(ownMarker, 'utf8')).resolves.toBe('allowed');
    await expect(access(escaped)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 50_000);

  it('keeps trusted text writes independent from a live shell sandbox', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-posix-text-shell-'));
    roots.push(root);
    const shellRoot = path.join(root, 'shell');
    const textRoot = path.join(root, 'text');
    await Promise.all([mkdir(shellRoot), mkdir(textRoot)]);
    const ready = path.join(shellRoot, 'ready');
    const release = path.join(shellRoot, 'release');
    const shellScript = String.raw`
const fs = require('node:fs');
const ready = process.argv[1];
const release = process.argv[2];
fs.writeFileSync(ready, 'ready');
const deadline = Date.now() + 15000;
while (!fs.existsSync(release) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
if (!fs.existsSync(release)) process.exit(7);
`;
    const shell = runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', shellScript, ready, release],
      cwd: shellRoot,
      filesystem: {
        allowRead: [shellRoot],
        allowWrite: [shellRoot],
      },
      network: { mode: 'deny' },
      inheritEnvironment: true,
      timeoutMs: 25_000,
    });
    const shellResult = shell.then(requireCompleted);
    await Promise.race([
      waitForFile(ready),
      shellResult.then((completed) => {
        throw new Error(
          `POSIX sandbox exited ${completed.exitCode} before its ready marker: `
          + JSON.stringify({ stdout: completed.stdout, stderr: completed.stderr }),
        );
      }),
    ]);

    const host = createTrustedTextMutationHost(
      () => [root],
      (canonicalTarget) => assertTrustedTextMutationPolicy(canonicalTarget),
    );
    const context: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: textRoot,
      gitRoot: textRoot,
      trustedTextMutationHost: host,
    };
    const target = path.join(textRoot, 'hello.md');
    await expect(toolWrite({ path: target, content: 'hello' }, context))
      .resolves.toContain('File created');
    await expect(readFile(target, 'utf8')).resolves.toBe('hello');

    const releaseSnapshot = await host.snapshot({
      path: release,
      createParentDirectories: false,
    });
    await host.commit({
      path: release,
      expectedRevision: releaseSnapshot.revision,
      content: 'release',
      createParentDirectories: false,
    });
    expect(requireExit(await shellResult, 0).sandboxed).toBe(true);
  }, 40_000);

  it('does not let the sandbox target forge broker control authority', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-posix-control-authority-'));
    roots.push(root);
    const result = await runKodaXSandboxed({
      command: process.execPath,
      args: [
        '-e',
        "const fs=require('node:fs');try{fs.writeSync(3,Buffer.from('FORGED_CONTROL\\n'))}catch{}process.exit(0)",
      ],
      cwd: root,
      filesystem: {
        allowRead: [root],
        allowWrite: [],
      },
      network: { mode: 'deny' },
      inheritEnvironment: true,
      timeoutMs: 15_000,
    });

    expect(requireExit(result, 0).sandboxed).toBe(true);
  });

  it('rejects protected-state allow carve-backs before POSIX sandbox launch', async () => {
    const protectedRoot = trustedTextNativeArtifactStateRoots().at(-1);
    if (protectedRoot === undefined) throw new Error('expected a protected native text root');
    await mkdir(protectedRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-posix-protected-alias-'));
    roots.push(root);
    const alias = path.join(root, 'alias');
    await symlink(protectedRoot, alias, 'dir');
    const baseInput = {
      command: process.execPath,
      args: ['--version'],
      network: { mode: 'deny' as const },
      inheritEnvironment: true,
      timeoutMs: 15_000,
    };

    for (const filesystem of [
      { allowRead: [protectedRoot], allowWrite: [] },
      { allowRead: [path.parse(protectedRoot).root], allowWrite: [] },
      { allowRead: [], allowWrite: [path.basename(protectedRoot)] },
      { allowRead: [], allowWrite: [path.join('alias', 'missing')] },
    ]) {
      const cwd = filesystem.allowWrite[0] === path.basename(protectedRoot)
        ? path.dirname(protectedRoot)
        : root;
      await expect(runKodaXSandboxed({ ...baseInput, cwd, filesystem }))
        .rejects.toThrow(/protected native text state/i);
    }
  });
});
