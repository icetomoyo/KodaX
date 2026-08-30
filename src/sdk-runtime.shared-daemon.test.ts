import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSessionStorage } from '@kodax-ai/repl';

import {
  acquireKodaXInlineOwner,
  createKodaXRuntime,
  enableKodaXDaemonOwner,
  getKodaXRuntimeOwnerState,
  setKodaXRuntimeOwnerMode,
} from './sdk-runtime.js';
import { acquireRuntimeDaemonProcessLease } from './runtime-daemon/process.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

describe('F269 shared Runtime contracts', () => {
  it('recovers a public inline owner left by a crashed process', () => {
    const homeDir = makeHome();
    const profile = 'coder';
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        import {
          acquireKodaXInlineOwner,
          setKodaXRuntimeOwnerMode,
        } from './src/sdk-runtime.ts';
        const homeDir = process.argv[1];
        const profile = process.argv[2];
        setKodaXRuntimeOwnerMode({
          homeDir,
          profile,
          mode: 'inline',
          expectedRevision: 0,
        });
        acquireKodaXInlineOwner({ homeDir, profile });
      `,
      homeDir,
      profile,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(0);
    const abandoned = getKodaXRuntimeOwnerState({ homeDir, profile });
    expect(abandoned).toMatchObject({
      policy: { mode: 'inline', revision: 1 },
      ownerStatus: 'owned',
      owner: { kind: 'inline' },
    });
    expect(abandoned.owner?.processStartIdentity).toMatch(/^(?:linux:)?\d+$/);

    expect(enableKodaXDaemonOwner({ homeDir, profile })).toMatchObject({
      mode: 'daemon',
      revision: 2,
    });
    expect(getKodaXRuntimeOwnerState({ homeDir, profile })).toMatchObject({
      policy: { mode: 'daemon', revision: 2 },
      ownerStatus: 'unowned',
      owner: null,
    });
  });

  it('keeps an inline owner close retryable when policy coordination is busy', () => {
    const homeDir = makeHome();
    const profile = 'coder';
    setKodaXRuntimeOwnerMode({
      homeDir,
      profile,
      mode: 'inline',
      expectedRevision: 0,
    });
    const inline = acquireKodaXInlineOwner({ homeDir, profile });
    expect(() => enableKodaXDaemonOwner({ homeDir, profile }))
      .toThrow(/inline owner.*active/i);
    const ownerRoot = path.join(homeDir, '.kodax', 'runtime', 'daemon', profile);
    const coordinationFile = path.join(ownerRoot, 'owner-policy.lock');
    const ownerFile = path.join(ownerRoot, 'daemon.lock');
    fs.writeFileSync(coordinationFile, JSON.stringify({
      runtimeId: 'owner-transition-live',
      pid: process.pid,
      createdAt: new Date().toISOString(),
      nonce: 'live-transition',
    }), 'utf8');

    expect(() => inline.close()).toThrow(/release.*inline owner/i);
    expect(fs.existsSync(ownerFile)).toBe(true);
    fs.rmSync(coordinationFile);
    expect(() => inline.close()).not.toThrow();
    expect(fs.existsSync(ownerFile)).toBe(false);
  });

  it('uses revision CAS for session settings and never silently overwrites', async () => {
    const runtime = await createKodaXRuntime({ homeDir: makeHome() });
    const session = await runtime.sessions.create({ title: 'CAS' });
    const initial = await runtime.sessions.getSettingsVersioned(session.id);

    const applied = await runtime.sessions.updateSettingsVersioned(
      session.id,
      { model: 'model-a', agentMode: 'ama', autoModeEngine: 'rules' },
      { expectedRevision: initial.revision },
    );

    expect(applied).toEqual({
      revision: 1,
      value: { model: 'model-a', agentMode: 'ama' },
    });
    await expect(runtime.sessions.updateSettingsVersioned(
      session.id,
      { model: 'model-b' },
      { expectedRevision: initial.revision },
    )).rejects.toMatchObject({ code: 'conflict' });
    await expect(runtime.sessions.getSettingsVersioned(session.id)).resolves.toEqual(applied);
    await runtime.close();
  });

  it('rejects Partner sessions at the shared daemon service boundary without mutating them', async () => {
    const homeDir = makeHome();
    const sessionsDir = path.join(homeDir, 'sessions');
    const partner = await createKodaXRuntime({ homeDir, sessionsDir });
    const session = await partner.sessions.create({
      sessionId: 'partner-session',
      title: 'Partner',
      surface: 'partner',
      profileId: 'kodax-space.partner',
    });
    const unknownSurface = await partner.sessions.create({
      sessionId: 'unknown-surface-existing',
      title: 'Unknown surface',
      surface: 'custom-product',
    });
    await partner.close();
    const sessionFile = fs.readdirSync(sessionsDir, { recursive: true })
      .map((entry) => path.join(sessionsDir, entry.toString()))
      .find((entry) => path.basename(entry) === `${session.id}.jsonl`);
    if (!sessionFile) throw new Error(`Missing persisted Partner session: ${session.id}`);
    const before = fs.readFileSync(sessionFile, 'utf8');

    const daemon = await createKodaXRuntime({
      homeDir,
      sessionsDir,
      profile: 'coder',
      sharedDaemonHost: true,
    });

    await expect(daemon.sessions.create({
      sessionId: 'cli-coder-session',
      title: 'Coder session',
      surface: 'cli',
    })).resolves.toMatchObject({ id: 'cli-coder-session', surface: 'cli' });
    await expect(daemon.sessions.create({
      sessionId: 'cli-coder-session',
      title: 'Must not overwrite',
      surface: 'cli',
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(daemon.sessions.load('cli-coder-session')).resolves.toMatchObject({
      title: 'Coder session',
    });
    await expect(daemon.sessions.create({
      sessionId: 'unknown-surface-session',
      surface: 'custom-product',
    })).rejects.toMatchObject({ code: 'session_not_admitted' });

    await expect(daemon.sessions.load(session.id)).rejects.toMatchObject({
      code: 'session_not_admitted',
    });
    await expect(daemon.sessions.getSettingsVersioned(session.id)).rejects.toMatchObject({
      code: 'session_not_admitted',
    });
    await expect(daemon.sessions.transcript(session.id)).rejects.toMatchObject({
      code: 'session_not_admitted',
    });
    const peek = vi.spyOn(FileSessionStorage.prototype, 'peek');
    const fullCapture = vi.spyOn(FileSessionStorage.prototype, 'readFullSnapshot');
    const stalePageCursor = Buffer.from(JSON.stringify({
      kind: 'conversation_cache_page',
      view: 'conversation',
      revision: 'sha256:stale',
      end: 0,
    }), 'utf8').toString('base64url');
    for (const deniedSessionId of [session.id, unknownSurface.id]) {
      peek.mockClear();
      fullCapture.mockClear();
      await expect(daemon.sessions.conversationPage({
        sessionId: deniedSessionId,
        limit: 1,
      })).rejects.toMatchObject({ code: 'session_not_admitted' });
      await expect(daemon.sessions.conversationPage({
        sessionId: deniedSessionId,
        cursor: stalePageCursor,
        limit: 1,
      })).rejects.toMatchObject({ code: 'session_not_admitted' });
      await expect(daemon.sessions.conversationEntryChunk({
        sessionId: deniedSessionId,
        revision: 'sha256:stale',
        entryIndex: 0,
      })).rejects.toMatchObject({ code: 'session_not_admitted' });
      expect(peek).not.toHaveBeenCalled();
      expect(fullCapture).not.toHaveBeenCalled();
    }
    peek.mockRestore();
    fullCapture.mockRestore();
    await expect(daemon.sessions.fork({ sessionId: session.id })).rejects.toMatchObject({
      code: 'session_not_admitted',
    });
    await expect(daemon.sessions.rewind({ sessionId: session.id })).rejects.toMatchObject({
      code: 'session_not_admitted',
    });
    await expect(daemon.sessions.compact({ sessionId: session.id })).rejects.toMatchObject({
      code: 'session_not_admitted',
    });
    await expect(daemon.sessions.delete(session.id)).rejects.toMatchObject({
      code: 'session_not_admitted',
    });
    await expect(daemon.runs.start({ sessionId: session.id, prompt: 'must not run' }))
      .rejects.toMatchObject({ code: 'session_not_admitted' });
    await expect(daemon.runs.list({ sessionId: session.id }))
      .rejects.toMatchObject({ code: 'session_not_admitted' });
    await expect(daemon.sessions.create({
      sessionId: 'partner-via-daemon',
      surface: 'partner',
    })).rejects.toMatchObject({ code: 'session_not_admitted' });
    await expect(daemon.sessions.create({
      sessionId: 'partner-profile-via-daemon',
      surface: 'code',
      profileId: 'kodax-space.partner',
    })).rejects.toMatchObject({ code: 'session_not_admitted' });
    await expect(daemon.sessions.create({
      sessionId: 'partner-hyphen-profile-via-daemon',
      surface: 'code',
      profileId: 'kodax-space-partner',
    })).rejects.toMatchObject({ code: 'session_not_admitted' });
    await expect(daemon.sessions.list()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: session.id })]),
    );
    await expect(daemon.status.snapshot()).resolves.toMatchObject({
      sessions: expect.not.arrayContaining([expect.objectContaining({ id: session.id })]),
    });
    expect(fs.readFileSync(sessionFile, 'utf8')).toBe(before);
    await daemon.close();
  });

  it('joins with an atomic snapshot cursor and emits each later event once', async () => {
    const runtime = await createKodaXRuntime({ homeDir: makeHome() });
    const session = await runtime.sessions.create({ title: 'Observe' });
    const received: string[] = [];

    const observation = await runtime.sessions.observe(session.id, (event) => {
      received.push(event.id);
    });
    await runtime.sessions.updateSettingsVersioned(
      session.id,
      { model: 'model-a' },
      { expectedRevision: observation.snapshot.settings.revision },
    );

    expect(observation.snapshot.runtimeId).toBe(runtime.identity.runtimeId);
    expect(observation.snapshot.transcriptRevision).toMatch(/^sha256:/);
    expect(observation.snapshot.session.id).toBe(session.id);
    expect(observation.snapshot.runs).toEqual([]);
    expect(observation.snapshot.pendingPermissions).toEqual([]);
    expect(received).toHaveLength(1);
    expect(new Set(received).size).toBe(received.length);
    expect((await runtime.events.replay({
      sessionId: session.id,
      after: observation.snapshot.cursor,
    })).map((event) => event.id)).toEqual(received);

    observation.close();
    await runtime.close();
  });

  it('takes a session snapshot while unrelated sessions keep emitting events', async () => {
    const runtime = await createKodaXRuntime({ homeDir: makeHome() });
    const target = await runtime.sessions.create({ title: 'Target' });
    const noisy = await runtime.sessions.create({ title: 'Noisy' });
    let churning = true;
    const churn = (async () => {
      while (churning) await runtime.sessions.load(noisy.id);
    })();

    try {
      const observation = await runtime.sessions.observe(target.id, () => undefined);
      expect(observation.snapshot.session.id).toBe(target.id);
      observation.close();
    } finally {
      churning = false;
      await churn;
      await runtime.close();
    }
  });

  it('fences daemon auto-start while explicit inline rollback owns the profile', async () => {
    const homeDir = makeHome();
    const policy = setKodaXRuntimeOwnerMode({
      homeDir,
      profile: 'coder',
      mode: 'inline',
      expectedRevision: 0,
    });
    const inline = acquireKodaXInlineOwner({ homeDir, profile: 'coder' });

    expect(policy.revision).toBe(1);
    expect(() => acquireKodaXInlineOwner({ homeDir, profile: 'coder' })).toThrow(/already has an owner/i);
    await expect(acquireRuntimeDaemonProcessLease({ homeDir, profile: 'coder' }))
      .rejects.toThrow(/inline rollback policy/i);

    inline.close();
    expect(setKodaXRuntimeOwnerMode({
      homeDir,
      profile: 'coder',
      mode: 'daemon',
      expectedRevision: 1,
    })).toMatchObject({ mode: 'daemon', revision: 2 });
  });

  it('keeps persistent permission grants under the single Runtime owner', async () => {
    const homeDir = makeHome();
    const runtime = await createKodaXRuntime({
      homeDir,
      profile: 'coder',
      sharedDaemonHost: true,
    });
    const decision = runtime.permissions.request({
      sessionId: 'session-grant',
      runId: 'run-grant',
      toolName: 'write',
      toolInput: { path: 'notes.md', content: 'hello' },
      executionCwd: homeDir,
    });
    const [pending] = await runtime.permissions.listPending({ runId: 'run-grant' });
    if (!pending) throw new Error('expected permission request');
    const persistent = pending.grantSuggestions
      ?.find((suggestion) => suggestion.kind === 'persistent');
    if (!persistent) throw new Error('expected Runtime-issued persistent suggestion');
    expect(await runtime.permissions.respond(pending.id, {
      type: 'allow_always',
      suggestionId: persistent.id,
    })).toBe(true);
    await expect(decision).resolves.toMatchObject({ type: 'allow_always' });
    await runtime.close();

    const reopened = await createKodaXRuntime({
      homeDir,
      profile: 'coder',
      sharedDaemonHost: true,
    });
    await expect(reopened.permissions.listGrants()).resolves.toMatchObject({
      revision: 1,
      value: [expect.objectContaining({
        scope: expect.objectContaining({
          toolName: 'write',
          matcher: expect.objectContaining({ kind: 'exact-path' }),
        }),
      })],
    });
    await reopened.close();
  });
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-f269-runtime-'));
  homes.push(home);
  return home;
}
