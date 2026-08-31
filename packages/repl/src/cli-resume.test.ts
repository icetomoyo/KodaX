import os from 'node:os';
import path from 'node:path';
import fs, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listCliResumeSessions } from './cli-resume.js';
import { deriveProjectKeyFromRoot } from './interactive/project-key.js';
import { LAYOUT_VERSION } from './interactive/session-migration.js';
import { FileSessionStorage } from './interactive/storage.js';

describe('listCliResumeSessions', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('matches the existing bare-resume filters without loading empty, worker, or other-project sessions', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const otherProjectRoot = path.join(tempHome, 'other');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(otherProjectRoot, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });

    const writeSession = async (id: string, overrides: Record<string, unknown>): Promise<void> => {
      const meta = {
        _type: 'meta',
        id,
        title: id,
        gitRoot: projectRoot,
        createdAt: '2026-07-18T00:00:00.000Z',
        scope: 'user',
        activeMessageCount: 2,
        runtimeInfo: { canonicalRepoRoot: projectRoot, surface: 'repl' },
        ...overrides,
      };
      await writeFile(path.join(sessionsDir, `${id}.jsonl`), `${JSON.stringify(meta)}\n`, 'utf8');
    };

    await writeSession('included', { title: 'Included session' });
    await writeSession('empty', { activeMessageCount: 0 });
    await writeSession('presentation-only', {
      activeMessageCount: 0,
      uiHistory: [
        { type: 'assistant', text: '完整实验汇总', presentationOnly: true },
        { type: 'sidecar', text: 'Sidecar Verifier blocked', presentationOnly: true },
        { type: 'error', text: 'terminal failure', presentationOnly: true },
      ],
    });
    await writeSession('worker', { scope: 'managed-task-worker' });
    await writeSession('other-project', {
      gitRoot: otherProjectRoot,
      runtimeInfo: { canonicalRepoRoot: otherProjectRoot, surface: 'repl' },
    });

    const sessions = await listCliResumeSessions({
      projectRoot,
      sessionsDir,
      limit: 1000,
    });

    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'included',
        title: 'Included session',
        msgCount: 2,
        surface: 'repl',
      }),
      expect.objectContaining({
        id: 'presentation-only',
        msgCount: 3,
      }),
    ]));
    expect(sessions.map((session) => session.id)).not.toContain('empty');
  });

  it('sorts newest first, honors the limit, and counts legacy message lines', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });

    const olderMeta = {
      _type: 'meta',
      title: 'Older',
      gitRoot: projectRoot,
      createdAt: '2026-07-17T00:00:00.000Z',
      scope: 'user',
    };
    await writeFile(
      path.join(sessionsDir, 'older.jsonl'),
      `${JSON.stringify(olderMeta)}\n${JSON.stringify({ role: 'user', content: 'one' })}\n${JSON.stringify({ role: 'assistant', content: 'two' })}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sessionsDir, 'newer.jsonl'),
      `${JSON.stringify({ ...olderMeta, title: 'Newer', createdAt: '2026-07-18T00:00:00.000Z', activeMessageCount: 1 })}\n`,
      'utf8',
    );

    const all = await listCliResumeSessions({ projectRoot, sessionsDir, limit: 10 });
    const limited = await listCliResumeSessions({ projectRoot, sessionsDir, limit: 1 });

    expect(all.map((item) => [item.id, item.msgCount])).toEqual([
      ['newer', 1],
      ['older', 2],
    ]);
    expect(limited.map((item) => item.id)).toEqual(['newer']);
  });

  it('keeps legacy archived files out of the active resume picker', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    await mkdir(projectRoot, { recursive: true });

    // Stamp the current layout first so this specifically exercises the
    // dual-layout reader rather than migration of the legacy fixture.
    await listCliResumeSessions({ projectRoot, sessionsDir });
    const meta = {
      _type: 'meta',
      title: 'Archived legacy session',
      gitRoot: projectRoot,
      scope: 'user',
      activeMessageCount: 2,
    };
    await writeFile(
      path.join(sessionsDir, 'archived-legacy.jsonl'),
      `${JSON.stringify(meta)}\n`,
      'utf8',
    );

    await expect(listCliResumeSessions({ projectRoot, sessionsDir }))
      .resolves.toEqual([]);
  });

  it('indexes a metadata line larger than the bounded head read', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    const meta = {
      _type: 'meta',
      id: 'large-meta',
      title: 'Large metadata session',
      gitRoot: projectRoot,
      createdAt: '2026-08-16T00:00:00.000Z',
      scope: 'user',
      activeMessageCount: 1,
      runtimeInfo: { canonicalRepoRoot: projectRoot, surface: 'repl' },
      uiHistory: ['x'.repeat(70_000)],
    };
    await writeFile(
      path.join(projectDir, 'large-meta.jsonl'),
      `${JSON.stringify(meta)}\n`,
      'utf8',
    );

    await expect(listCliResumeSessions({ projectRoot, sessionsDir }))
      .resolves.toEqual([expect.objectContaining({
        id: 'large-meta',
        title: 'Large metadata session',
      })]);
  });

  it('uses the latest append-only metadata when rebuilding the resume index', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(projectDir, { recursive: true })]);
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ canonicalRoot: projectRoot }),
      'utf8',
    );
    const baseMeta = (id: string) => ({
      _type: 'meta',
      id,
      title: 'Initial title',
      gitRoot: projectRoot,
      createdAt: '2026-08-16T00:00:00.000Z',
      scope: 'user',
      activeMessageCount: 1,
      runtimeInfo: { canonicalRepoRoot: projectRoot, surface: 'repl' },
    });
    await Promise.all([
      writeFile(
        path.join(projectDir, 'renamed.jsonl'),
        `${JSON.stringify(baseMeta('renamed'))}\n${JSON.stringify({ _type: 'meta_update', title: 'Latest title', activeMessageCount: 2 })}`,
        'utf8',
      ),
      writeFile(
        path.join(projectDir, 'became-worker.jsonl'),
        `${JSON.stringify(baseMeta('became-worker'))}\n${JSON.stringify({ _type: 'meta_update', scope: 'managed-task-worker', activeMessageCount: 2 })}`,
        'utf8',
      ),
      writeFile(
        path.join(projectDir, 'crash-renamed.jsonl'),
        `${JSON.stringify(baseMeta('crash-renamed'))}\n${JSON.stringify({ _type: 'meta_update', title: 'Recovered title', activeMessageCount: 2 })}\n{"_type":`,
        'utf8',
      ),
      writeFile(
        path.join(projectDir, 'crash-worker.jsonl'),
        `${JSON.stringify(baseMeta('crash-worker'))}\n${JSON.stringify({ _type: 'meta_update', scope: 'managed-task-worker', activeMessageCount: 2 })}\n{"_type":`,
        'utf8',
      ),
    ]);

    const sessions = await listCliResumeSessions({ projectRoot, sessionsDir });
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'renamed', title: 'Latest title', msgCount: 2 }),
      expect.objectContaining({ id: 'crash-renamed', title: 'Recovered title', msgCount: 2 }),
    ]));
    expect(sessions.map((session) => session.id).sort()).toEqual(['crash-renamed', 'renamed']);
  });

  it('does not trust a project bucket whose identity manifest belongs to another root', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const foreignRoot = path.join(tempHome, 'foreign');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(projectDir, { recursive: true })]);
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ canonicalRoot: foreignRoot }),
      'utf8',
    );
    const meta = (id: string, root: string) => JSON.stringify({
      _type: 'meta', id, title: id, gitRoot: root, scope: 'user', activeMessageCount: 1,
      runtimeInfo: { canonicalRepoRoot: root },
    }) + '\n';
    await Promise.all([
      writeFile(path.join(projectDir, 'current.jsonl'), meta('current', projectRoot), 'utf8'),
      writeFile(path.join(projectDir, 'foreign.jsonl'), meta('foreign', foreignRoot), 'utf8'),
    ]);

    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([
      expect.objectContaining({ id: 'current' }),
    ]);
    await expect(fs.access(path.join(projectDir, '.resume-index', 'complete.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns canonical sessions when rebuilding the derived index fails', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(projectDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ canonicalRoot: projectRoot }), 'utf8'),
      writeFile(path.join(projectDir, '.resume-index'), 'blocked', 'utf8'),
      writeFile(path.join(projectDir, 'session.jsonl'), `${JSON.stringify({
        _type: 'meta', id: 'session', title: 'Canonical session', gitRoot: projectRoot,
        scope: 'user', activeMessageCount: 1,
        runtimeInfo: { canonicalRepoRoot: projectRoot },
      })}\n`, 'utf8'),
    ]);
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([
        expect.objectContaining({ id: 'session' }),
      ]);
      expect(emitWarning).toHaveBeenCalledWith(
        expect.stringContaining('using canonical sessions instead'),
        expect.objectContaining({ code: 'KODAX_RESUME_INDEX' }),
      );
    } finally {
      emitWarning.mockRestore();
    }
  });

  it('never opens another project session while listing the current project', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'current-repo');
    const foreignRoot = path.join(tempHome, 'foreign-repo');
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(foreignRoot, { recursive: true }),
      mkdir(sessionsDir, { recursive: true }),
    ]);
    const currentDir = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(projectRoot).key,
    );
    const foreignDir = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(foreignRoot).key,
    );
    await Promise.all([
      mkdir(currentDir, { recursive: true }),
      mkdir(foreignDir, { recursive: true }),
    ]);
    const meta = (id: string, root: string) => JSON.stringify({
      _type: 'meta',
      id,
      title: id,
      gitRoot: root,
      createdAt: '2026-08-15T00:00:00.000Z',
      scope: 'user',
      activeMessageCount: 1,
      runtimeInfo: { canonicalRepoRoot: root, workspaceRoot: root, surface: 'repl' },
    }) + '\n';
    const currentPath = path.join(currentDir, 'current.jsonl');
    const foreignPath = path.join(foreignDir, 'foreign.jsonl');
    await Promise.all([
      writeFile(currentPath, meta('current', projectRoot), 'utf8'),
      writeFile(foreignPath, meta('foreign', foreignRoot), 'utf8'),
      writeFile(
        path.join(sessionsDir, '.layout.json'),
        JSON.stringify({ version: LAYOUT_VERSION }),
        'utf8',
      ),
    ]);
    const open = vi.spyOn(fs, 'open');

    try {
      await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([
        expect.objectContaining({ id: 'current' }),
      ]);
      expect(open.mock.calls.some(([candidate]) => path.resolve(String(candidate)) === foreignPath))
        .toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  it('finds an old worktree-keyed bucket without scanning unrelated projects', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const repository = path.join(tempHome, 'main');
    const worktree = path.join(tempHome, 'worktree');
    const nested = path.join(worktree, 'src');
    const gitDir = path.join(repository, '.git', 'worktrees', 'worktree');
    const oldProjectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(worktree).key);
    const foreignDir = path.join(sessionsDir, deriveProjectKeyFromRoot(path.join(tempHome, 'foreign')).key);
    await Promise.all([
      mkdir(gitDir, { recursive: true }),
      mkdir(nested, { recursive: true }),
      mkdir(oldProjectDir, { recursive: true }),
      mkdir(foreignDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`, 'utf8'),
      writeFile(path.join(gitDir, 'commondir'), '../..\n', 'utf8'),
      writeFile(path.join(gitDir, 'gitdir'), path.join(worktree, '.git') + '\n', 'utf8'),
      writeFile(path.join(sessionsDir, '.layout.json'), JSON.stringify({ version: LAYOUT_VERSION }), 'utf8'),
      writeFile(path.join(oldProjectDir, 'worktree-session.jsonl'), JSON.stringify({
        _type: 'meta', id: 'worktree-session', title: 'Worktree session', gitRoot: worktree,
        scope: 'user', activeMessageCount: 1,
        runtimeInfo: { canonicalRepoRoot: worktree, workspaceRoot: worktree, surface: 'repl' },
      }) + '\n', 'utf8'),
      writeFile(path.join(foreignDir, 'foreign.jsonl'), JSON.stringify({
        _type: 'meta', id: 'foreign', title: 'Foreign', gitRoot: path.join(tempHome, 'foreign'),
        scope: 'user', activeMessageCount: 1,
      }) + '\n', 'utf8'),
    ]);
    const open = vi.spyOn(fs, 'open');

    try {
      await expect(listCliResumeSessions({ projectRoot: nested, sessionsDir })).resolves.toEqual([
        expect.objectContaining({ id: 'worktree-session' }),
      ]);
      await expect(listCliResumeSessions({ projectRoot: repository, sessionsDir })).resolves.toEqual([
        expect.objectContaining({ id: 'worktree-session' }),
      ]);
      expect(open.mock.calls.some(([candidate]) =>
        path.resolve(String(candidate)) === path.join(foreignDir, 'foreign.jsonl'))).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  it('certifies only the current legacy bucket and reuses its index on the next resume', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([
      mkdir(path.join(projectRoot, '.git'), { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(sessionsDir, '.layout.json'), JSON.stringify({ version: LAYOUT_VERSION }), 'utf8'),
      writeFile(path.join(projectDir, 'current.jsonl'), JSON.stringify({
        _type: 'meta', id: 'current', title: 'Current', gitRoot: projectRoot,
        scope: 'user', activeMessageCount: 1,
        runtimeInfo: { canonicalRepoRoot: projectRoot, workspaceRoot: projectRoot },
      }) + '\n', 'utf8'),
      writeFile(path.join(projectDir, 'empty.jsonl'), JSON.stringify({
        _type: 'meta', id: 'empty', title: 'Empty', gitRoot: projectRoot,
        scope: 'user', activeMessageCount: 0,
        runtimeInfo: { canonicalRepoRoot: projectRoot, workspaceRoot: projectRoot },
      }) + '\n', 'utf8'),
    ]);

    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([
      expect.objectContaining({ id: 'current' }),
    ]);
    await expect(fs.readFile(path.join(projectDir, 'project.json'), 'utf8'))
      .resolves.toContain('canonicalRoot');

    const open = vi.spyOn(fs, 'open');
    try {
      await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toHaveLength(1);
      expect(open.mock.calls.filter(([candidate]) => String(candidate).endsWith('.jsonl')))
        .toHaveLength(0);
    } finally {
      open.mockRestore();
    }
  });

  it('does not trust a stale git root over the canonical runtime identity', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'current');
    const foreignRoot = path.join(tempHome, 'foreign');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(sessionsDir, '.layout.json'), JSON.stringify({ version: LAYOUT_VERSION }), 'utf8'),
      writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ canonicalRoot: projectRoot }), 'utf8'),
      writeFile(path.join(projectDir, 'conflicting-identity.jsonl'), `${JSON.stringify({
        _type: 'meta',
        id: 'conflicting-identity',
        title: 'Conflicting identity',
        gitRoot: projectRoot,
        scope: 'user',
        activeMessageCount: 1,
        runtimeInfo: { canonicalRepoRoot: foreignRoot, workspaceRoot: foreignRoot },
      })}\n`, 'utf8'),
    ]);

    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([]);
    await expect(fs.readFile(path.join(projectDir, 'project.json'), 'utf8').then(JSON.parse))
      .resolves.toMatchObject({ canonicalRoot: projectRoot });
  });

  it('does not certify a missing manifest when the current bucket contains a foreign session', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const foreignRoot = path.join(tempHome, 'foreign');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([
      mkdir(path.join(projectRoot, '.git'), { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(sessionsDir, '.layout.json'), JSON.stringify({ version: LAYOUT_VERSION }), 'utf8'),
      writeFile(path.join(projectDir, 'current.jsonl'), JSON.stringify({
        _type: 'meta', id: 'current', title: 'Current', gitRoot: projectRoot,
        scope: 'user', activeMessageCount: 1,
      }) + '\n', 'utf8'),
      writeFile(path.join(projectDir, 'foreign.jsonl'), JSON.stringify({
        _type: 'meta', id: 'foreign', title: 'Foreign', gitRoot: foreignRoot,
        scope: 'user', activeMessageCount: 1,
      }) + '\n', 'utf8'),
    ]);

    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([
      expect.objectContaining({ id: 'current' }),
    ]);
    await expect(fs.access(path.join(projectDir, 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns current sessions when optional linked-worktree discovery is unavailable', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([
      mkdir(path.join(projectRoot, '.git'), { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(projectRoot, '.git', 'worktrees'), 'not a directory', 'utf8'),
      writeFile(path.join(sessionsDir, '.layout.json'), JSON.stringify({ version: LAYOUT_VERSION }), 'utf8'),
      writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ canonicalRoot: projectRoot }), 'utf8'),
      writeFile(path.join(projectDir, 'current.jsonl'), JSON.stringify({
        _type: 'meta', id: 'current', title: 'Current', gitRoot: projectRoot,
        scope: 'user', activeMessageCount: 1,
      }) + '\n', 'utf8'),
    ]);
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([
      expect.objectContaining({ id: 'current' }),
    ]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('linked-worktree discovery'),
      expect.objectContaining({ code: 'KODAX_RESUME_COMPATIBILITY' }),
    );
  });

  it('returns active sessions but does not certify when legacy archive inspection is unavailable', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([
      mkdir(path.join(projectRoot, '.git'), { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(sessionsDir, '.layout.json'), JSON.stringify({ version: LAYOUT_VERSION }), 'utf8'),
      writeFile(path.join(projectDir, 'archived'), 'not a directory', 'utf8'),
      writeFile(path.join(projectDir, 'current.jsonl'), JSON.stringify({
        _type: 'meta', id: 'current', title: 'Current', gitRoot: projectRoot,
        scope: 'user', activeMessageCount: 1,
      }) + '\n', 'utf8'),
    ]);
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([
      expect.objectContaining({ id: 'current' }),
    ]);
    await expect(fs.access(path.join(projectDir, 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('legacy archived-session certification'),
      expect.objectContaining({ code: 'KODAX_RESUME_COMPATIBILITY' }),
    );
  });

  it('reuses a resumable membership index instead of reopening empty and worker sessions', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(sessionsDir, { recursive: true }),
    ]);
    const projectDir = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(projectRoot).key,
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ canonicalRoot: projectRoot }),
      'utf8',
    );
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 200; index += 1) {
      const resumable = index < 5;
      const worker = index >= 100;
      writes.push(writeFile(
        path.join(projectDir, `session-${index}.jsonl`),
        JSON.stringify({
          _type: 'meta',
          id: `session-${index}`,
          title: `Session ${index}`,
          gitRoot: projectRoot,
          createdAt: `2026-08-15T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
          scope: worker ? 'managed-task-worker' : 'user',
          activeMessageCount: resumable ? 1 : 0,
          runtimeInfo: {
            canonicalRepoRoot: projectRoot,
            workspaceRoot: projectRoot,
            surface: worker ? 'managed-task' : 'acp',
          },
        }) + '\n',
        'utf8',
      ));
    }
    await Promise.all(writes);

    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toHaveLength(5);
    const open = vi.spyOn(fs, 'open');
    try {
      await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toHaveLength(5);
      const openedSessionFiles = open.mock.calls.filter(([candidate]) =>
        String(candidate).endsWith('.jsonl'));
      expect(openedSessionFiles).toHaveLength(0);
    } finally {
      open.mockRestore();
    }

    await new FileSessionStorage({ sessionsDir, cwd: projectRoot }).save('new-worker', {
      messages: [{ role: 'user', content: 'worker bookkeeping' }],
      title: 'New worker',
      gitRoot: projectRoot,
      runtimeInfo: { canonicalRepoRoot: projectRoot, workspaceRoot: projectRoot },
      scope: 'managed-task-worker',
    });
    const postWriteOpen = vi.spyOn(fs, 'open');
    try {
      await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toHaveLength(5);
      expect(postWriteOpen.mock.calls.filter(([candidate]) =>
        String(candidate).endsWith('.jsonl'))).toHaveLength(0);
    } finally {
      postWriteOpen.mockRestore();
    }
  });

  it('does not let a writer certify an index before existing canonical sessions were scanned', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await writeFile(path.join(projectDir, 'existing.jsonl'), `${JSON.stringify({
      _type: 'meta',
      id: 'existing',
      title: 'Existing session',
      gitRoot: projectRoot,
      createdAt: '2026-08-15T00:00:00.000Z',
      scope: 'user',
      activeMessageCount: 1,
      runtimeInfo: { canonicalRepoRoot: projectRoot, surface: 'repl' },
    })}\n`, 'utf8');
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ canonicalRoot: projectRoot }),
      'utf8',
    );
    const storage = new FileSessionStorage({ sessionsDir, cwd: projectRoot });

    await storage.save('new-empty', {
      messages: [],
      title: 'Empty',
      gitRoot: projectRoot,
      runtimeInfo: { canonicalRepoRoot: projectRoot, executionCwd: projectRoot },
    });

    await expect(listCliResumeSessions({ projectRoot, sessionsDir }))
      .resolves.toEqual([expect.objectContaining({ id: 'existing' })]);
  });

  it('keeps resumable membership synchronized across save, archive, and delete', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-resume-'));
    tempDirs.push(tempHome);
    const sessionsDir = path.join(tempHome, 'sessions');
    const projectRoot = path.join(tempHome, 'repo');
    await mkdir(projectRoot, { recursive: true });
    await listCliResumeSessions({ projectRoot, sessionsDir });
    const storage = new FileSessionStorage({ sessionsDir, cwd: projectRoot });
    const data = {
      messages: [{ role: 'user' as const, content: 'remember me' }],
      title: 'Indexed session',
      gitRoot: projectRoot,
      runtimeInfo: {
        canonicalRepoRoot: projectRoot,
        workspaceRoot: projectRoot,
        executionCwd: projectRoot,
        surface: 'repl',
      },
    };

    await storage.save('indexed-session', data);
    await expect(listCliResumeSessions({ projectRoot, sessionsDir }))
      .resolves.toEqual([expect.objectContaining({ id: 'indexed-session' })]);

    await storage.save('indexed-session', { ...data, title: 'Renamed session' });
    await expect(listCliResumeSessions({ projectRoot, sessionsDir }))
      .resolves.toEqual([expect.objectContaining({
        id: 'indexed-session',
        title: 'Renamed session',
        surface: 'repl',
      })]);

    await storage.save('worker-session', {
      ...data,
      title: 'Worker',
      scope: 'managed-task-worker',
    });
    await expect(listCliResumeSessions({ projectRoot, sessionsDir }))
      .resolves.toEqual([expect.objectContaining({ id: 'indexed-session' })]);

    await expect(storage.archive('indexed-session')).resolves.toBe(true);
    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([]);

    await storage.save('indexed-session', { ...data, title: 'Archived mutation' });
    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([]);

    await expect(storage.unarchive('indexed-session')).resolves.toBe(true);
    await expect(listCliResumeSessions({ projectRoot, sessionsDir }))
      .resolves.toEqual([expect.objectContaining({ id: 'indexed-session' })]);

    await storage.delete('indexed-session');
    await expect(listCliResumeSessions({ projectRoot, sessionsDir })).resolves.toEqual([]);
  });
});
