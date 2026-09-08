import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveScopedMemoryRoot } from '@kodax-ai/agent';
import { deriveCodingMemoryIdentityFromRoot } from '@kodax-ai/coding';
import { randomUUID } from 'node:crypto';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

describe('runtime.memory Host service (FEATURE_298 T36)', () => {
  let homeDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-memory-home-'));
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-memory-proj-'));
  });

  afterEach(async () => {
    fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('does not let a cached Memory plane write after the Host closes', async () => {
    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const runtime = await createKodaXRuntime({ homeDir });
    const plane = await runtime.memory.forProject(projectRoot);
    await runtime.close();
    await expect(plane.controller.remember({ statement: 'This must not be stored.' })).rejects.toThrow(/closed/i);
    await expect(plane.rebuild()).rejects.toThrow(/closed/i);
  }, 60_000);

  it.each(['embedded', 'daemon'] as const)('serves remember, view, exact forget, honest rebuild, and trusted open targets via %s', async (mode) => {
    const { createKodaXRuntime, connectKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const owner = await createKodaXRuntime({ homeDir, defaultProvider: 'anthropic', sharedDaemonHost: true });
    const paths = resolveRuntimeDaemonPaths(homeDir);
    const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: owner.identity.runtimeId, pid: process.pid, createdAt: owner.identity.startedAt });
    if (!lock) throw new Error('Could not acquire Memory Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-memory-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime: owner, paths, lock, endpoint });
    const runtime = mode === 'daemon' ? await connectKodaXRuntime({ homeDir, endpoint: endpoint.path }) : owner;
    try {
      const plane = await runtime.memory.forProject(projectRoot);

      // The Host derives the identity itself: the plane's root is the scoped
      // root for (configHome, projectRoot), never a caller-supplied root.
      const identity = deriveCodingMemoryIdentityFromRoot(
        path.join(homeDir, '.kodax'),
        projectRoot,
      );
      expect(plane.memoryRoot).toBe(resolveScopedMemoryRoot(identity, 'project'));

      // US32 — remember → view → exact forget.
      const remembered = await plane.controller.remember({
        statement: 'The release gate requires a green eval suite.',
        claimKind: 'policy',
        claimKey: 'release.gate',
        evidenceRef: 'user-command:s1',
      });
      expect(remembered.status).not.toBe('error');
      const refs = await plane.controller.listRefs({
        kinds: ['memdir'],
        lifecycles: ['active', 'trusted'],
      });
      expect(refs.length).toBe(1);
      const snapshot = await plane.controller.readRef(refs[0]!);
      expect(snapshot.body).toContain('green eval suite');
      if (mode === 'daemon') {
        const forgedPath = { ...refs[0]!, storageUri: path.join(projectRoot, 'unrelated.txt') };
        expect((await plane.controller.readRef(forgedPath)).body).toBe(snapshot.body);
      }
      const forgotten = await plane.controller.forgetRef(
        refs[0]!.id,
        (await plane.controller.readRef(refs[0]!)).bodyFingerprint,
      );
      expect('status' in forgotten ? forgotten.status : forgotten).not.toBe('error');
      expect((await plane.controller.listRefs({
        kinds: ['memdir'],
        lifecycles: ['active', 'trusted'],
      })).length).toBe(0);

      // US32 — rebuild preserves topic file rules: frontmatter files are
      // untouched, only MEMORY.md is (re)written, malformed files fall back.
      const topicA = path.join(plane.memoryRoot, 'gate_a.md');
      const topicB = path.join(plane.memoryRoot, 'gate_b.md');
      const malformed = path.join(plane.memoryRoot, 'no_frontmatter.md');
      fs.mkdirSync(plane.memoryRoot, { recursive: true });
      const contentA = '---\nname: gate_a\ndescription: Gate A\ntype: policy\n---\nBody A.';
      const contentB = '---\nname: gate_b\ndescription: Gate B\ntype: policy\n---\nBody B.';
      fs.writeFileSync(topicA, contentA, 'utf-8');
      fs.writeFileSync(topicB, contentB, 'utf-8');
      const baseTime = new Date('2026-05-01T00:00:00Z');
      fs.utimesSync(topicA, baseTime, new Date('2026-05-01T00:00:00Z'));
      fs.utimesSync(topicB, baseTime, new Date('2026-05-02T00:00:00Z'));
      fs.writeFileSync(malformed, 'just body', 'utf-8');
      const rebuild = await plane.rebuild();
      expect(rebuild.status).toBe('rebuilt');
      expect(rebuild.entryCount).toBe(3);
      expect(rebuild.malformedFiles).toEqual(['no_frontmatter.md']);
      expect(fs.readFileSync(topicA, 'utf-8')).toBe(contentA);
      expect(fs.readFileSync(topicB, 'utf-8')).toBe(contentB);
      const index = fs.readFileSync(plane.entrypointPath, 'utf-8');
      expect(index.indexOf('gate_b')).toBeLessThan(index.indexOf('gate_a'));

      // US32 — open returns a trusted path inside the Host memory root, and
      // rejects targets that escape it.
      const opened = await plane.ensureOpenTarget(plane.memoryRoot);
      expect(path.resolve(opened)).toBe(path.resolve(plane.memoryRoot));
      await expect(plane.ensureOpenTarget(plane.entrypointPath)).resolves.toBe(plane.entrypointPath);
      const escape = path.join(path.dirname(plane.memoryRoot), 'outside.md');
      fs.writeFileSync(escape, 'x', 'utf-8');
      await expect(plane.ensureOpenTarget(escape)).rejects.toThrow(/escapes the project memory root/);
    } finally {
      await runtime.close();
      await host.close();
      await owner.close();
    }
  }, 60_000);

  it('rejects stale approvals after the inspected content changed over the daemon face', async () => {
    const { createKodaXRuntime, connectKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const owner = await createKodaXRuntime({ homeDir, defaultProvider: 'anthropic', sharedDaemonHost: true });
    const paths = resolveRuntimeDaemonPaths(homeDir);
    const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: owner.identity.runtimeId, pid: process.pid, createdAt: owner.identity.startedAt });
    if (!lock) throw new Error('Could not acquire Memory Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-memory-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime: owner, paths, lock, endpoint });
    const runtime = await connectKodaXRuntime({ homeDir, endpoint: endpoint.path });
    try {
      const plane = await runtime.memory.forProject(projectRoot);
      // Seed a pending correction proposal the way the plane itself does:
      // remember a claim, then re-remember a conflicting statement for the
      // same key — the correction lands in the decision inbox.
      await plane.controller.remember({
        statement: 'Deploy on Fridays.',
        claimKind: 'policy',
        claimKey: 'deploy.window',
        evidenceRef: 'user-command:s2a',
      });
      await plane.controller.remember({
        statement: 'Never deploy on Fridays.',
        claimKind: 'policy',
        claimKey: 'deploy.window',
        evidenceRef: 'user-command:s2b',
      });
      const inbox = await plane.controller.listInbox();
      expect(inbox.length).toBeGreaterThan(0);
      const proposal = inbox[0]!;
      const shown = await plane.controller.showProposal(proposal.id);
      if (shown === undefined) throw new Error('test setup expected a shown proposal');
      // Change the underlying topic file after the preview was captured.
      const storageUri = shown.targetRefs.find((ref) => ref.storageUri !== undefined)?.storageUri;
      expect(storageUri).toBeDefined();
      fs.appendFileSync(storageUri!, String.fromCharCode(10) + 'edited after preview', 'utf-8');
      const approved = await plane.controller.approveProposal(
        proposal.id,
        shown.expectedFingerprints,
      );
      expect(approved.applied).not.toBe(true);
    } finally {
      await runtime.close();
      await host.close();
      await owner.close();
    }
  }, 60_000);
});
