import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { connectKodaXRuntime, createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

/**
 * FEATURE_298 T37 slice 4 — daemon-connected clients (interactive REPLs in
 * daemon mode included) prepare Skills, commands, /review, and /agents lean
 * through the invocations RPC: the same trusted Host service the embedded
 * runtime exposes in-process, reached over the daemon face.
 */
async function seedProject(): Promise<string> {
  const run = promisify(execFile);
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-t37-daemon-'));
  const git = (args: string[]) => run('git', args, { cwd: projectRoot, windowsHide: true });
  await git(['init', '-q']);
  await git(['config', 'user.email', 't37@test.local']);
  await git(['config', 'user.name', 't37']);
  await writeFile(path.join(projectRoot, 'a.txt'), 'one\n', 'utf8');
  await git(['add', 'a.txt']);
  await git(['commit', '-qm', 'base']);
  await writeFile(path.join(projectRoot, 'a.txt'), 'one\ntwo\n', 'utf8');

  const skillDir = path.join(projectRoot, '.kodax', 'skills', 'audit-helper');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: audit-helper',
      'description: Audit the current diff with arguments',
      '---',
      '',
      'Audit request: $ARGUMENTS',
    ].join('\n'),
    'utf8',
  );
  return projectRoot;
}

it('prepares invocations over the daemon face against a real Host', async () => {
  const projectRoot = await seedProject();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(projectRoot);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId,
    pid: process.pid,
    createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire the invocations Host.');
  const endpointPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\kodax-invocations-${randomUUID()}`
    : path.join(projectRoot, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXRuntime({ homeDir: projectRoot, endpoint: endpointPath });
  try {
    await client.sessions.create({ sessionId: 'session-t37-daemon', projectPath: projectRoot });
    // Skill preparation crosses the RPC boundary with the Host-minted policy.
    const prepared = await client.invocations.prepareSkill({
      projectRoot,
      name: 'audit-helper',
      argumentsText: 'focus on auth',
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind === 'prepared') {
      expect(prepared.invocation.prompt).toContain('Audit request: focus on auth');
      expect(prepared.invocation.skillInvocation.runtimePolicy).toEqual({ enforceAtRuntime: true });
    }

    const unknownSkill = await client.invocations.prepareSkill({
      projectRoot,
      name: 'definitely-not-a-skill',
    });
    expect(unknownSkill).toEqual({ kind: 'unknown' });

    // Review preparation captures the diff Host-side and returns the prompt.
    const review = await client.invocations.prepareReview({
      projectRoot,
      sessionId: 'session-t37-daemon',
      args: [],
    });
    expect(review.kind).toBe('prepared');
    if (review.kind === 'prepared') {
      expect(review.invocation.prompt).toContain('+two');
    }
    await expect(client.invocations.prepareReview({
      projectRoot, sessionId: 'missing-session', args: ['--workflow'],
    })).rejects.toThrow();
    await expect(client.invocations.prepareReview({
      projectRoot: path.dirname(projectRoot), sessionId: 'session-t37-daemon', args: ['--workflow'],
    })).rejects.toThrow(/workspace|project/i);
    const workflowReview = await client.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37-daemon', args: ['--workflow'],
    });
    expect(workflowReview.kind).toBe('workflow');

    // Builtin command names stay client-side execution without expansion.
    const command = await client.invocations.prepareCommand({
      projectRoot,
      name: 'help',
    });
    expect(command).toEqual({ kind: 'local' });

    // /agents lean reports the missing file until one exists.
    const leanMissing = await client.invocations.prepareAgentsLean({ projectRoot });
    expect(leanMissing).toEqual({ kind: 'missing' });
    await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Agents\n', 'utf8');
    const leanPrepared = await client.invocations.prepareAgentsLean({ projectRoot });
    expect(leanPrepared.kind).toBe('prepared');
    if (leanPrepared.kind === 'prepared') {
      expect(leanPrepared.invocation.displayName).toBe('/agents lean');
    }
    await client.sessions.archive('session-t37-daemon');
    await expect(client.invocations.prepareReview({
      projectRoot, sessionId: 'session-t37-daemon', args: ['--workflow'],
    })).rejects.toThrow(/archived/i);
  } finally {
    await client.close();
    await host.close();
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
