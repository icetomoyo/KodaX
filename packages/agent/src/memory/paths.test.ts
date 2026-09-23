/**
 * FEATURE_124 (v0.7.43) — paths.ts unit tests.
 *
 * Covers sanitize collision-safety, no-remote fallback, NFC / lowercase
 * normalization, and isAutoManagedMemoryFile prefix matching.
 *
 * The `git config` call is mocked so option propagation and no-remote
 * fallback remain hermetic. Sanitization cases inject their inputs directly.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock, gitPreflight } = vi.hoisted(() => ({
  execSyncMock: vi.fn(() => ''),
  gitPreflight: vi.fn(),
}));

vi.mock('../runtime/macos-git.js', () => ({
  assertNoGitInstallPromptSync: gitPreflight,
}));

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

import { setAgentConfigHome } from '../runtime/agent-home.js';
import {
  hashCwd,
  hashMemoryIdentityComponent,
  isAutoManagedMemoryFile,
  matchesMemoryApplicability,
  parseMemoryTypeFromFilename,
  resolveMemoryEntrypoint,
  resolveMemoryRoot,
  resolveScopedMemoryRoot,
  sanitizeProjectKey,
} from './paths.js';

describe('sanitizeProjectKey', () => {
  it('strips https:// + .git → host-user-repo', () => {
    expect(sanitizeProjectKey('https://github.com/user/repo.git')).toBe(
      'github.com-user-repo',
    );
  });

  it('strips ssh:// + git@ + .git → same key as HTTPS', () => {
    const httpsKey = sanitizeProjectKey('https://github.com/user/repo.git');
    const sshKey = sanitizeProjectKey('git@github.com:user/repo.git');
    expect(sshKey).toBe(httpsKey);
  });

  it('strips ssh:// protocol prefix', () => {
    expect(sanitizeProjectKey('ssh://git@gitlab.example.com/team/repo')).toBe(
      'gitlab.example.com-team-repo',
    );
  });

  it('lowercases host part', () => {
    expect(sanitizeProjectKey('https://GitHub.com/User/Repo.git')).toBe(
      'github.com-user-repo',
    );
  });

  it('handles missing .git suffix', () => {
    expect(sanitizeProjectKey('https://github.com/user/repo')).toBe(
      'github.com-user-repo',
    );
  });

  it('removes HTTPS credentials and query secrets before creating a path key', () => {
    expect(sanitizeProjectKey(
      'https://oauth2:ghp_super_secret@github.com/user/repo.git?token=also-secret',
    )).toBe('github.com-user-repo');
  });

  it('does not produce leading/trailing dashes', () => {
    const key = sanitizeProjectKey('git@github.com:user/repo.git');
    expect(key.startsWith('-')).toBe(false);
    expect(key.endsWith('-')).toBe(false);
  });
});

describe('hashCwd', () => {
  it('returns 16 hex chars', () => {
    const hash = hashCwd('/Users/foo/repo');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is case-insensitive (Windows + macOS default FS)', () => {
    // Compare cwd absolute paths to avoid divergence on Windows where
    // `path.resolve('/users/foo/repo')` may prepend the drive letter.
    const lower = hashCwd(path.resolve('/users/foo/repo'));
    const upper = hashCwd(path.resolve('/Users/Foo/Repo'));
    expect(lower).toBe(upper);
  });

  it('differs for different cwds', () => {
    const a = hashCwd('/Users/foo/repo-a');
    const b = hashCwd('/Users/foo/repo-b');
    expect(a).not.toBe(b);
  });
});

describe('resolveMemoryRoot / resolveMemoryEntrypoint', () => {
  let tempHome: string;

  beforeEach(() => {
    execSyncMock.mockClear();
    gitPreflight.mockReset();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-memory-paths-'));
    setAgentConfigHome(tempHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('uses agent config home from setAgentConfigHome override', () => {
    // cwd has no remote → fallback to local-<hash>
    const root = resolveMemoryRoot(tempHome);
    expect(root.startsWith(tempHome)).toBe(true);
    expect(root.includes('projects')).toBe(true);
    expect(root.endsWith('memory')).toBe(true);
  });

  it('hides the background Git remote probe in Windows GUI hosts', () => {
    resolveMemoryRoot(tempHome);

    expect(execSyncMock).toHaveBeenCalledWith(
      'git config --get remote.origin.url',
      expect.objectContaining({
        cwd: tempHome,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1_000,
        windowsHide: true,
      }),
    );
  });

  it('keeps the local memory fallback without launching blocked Git and recovers the remote identity', () => {
    gitPreflight.mockImplementation(() => { throw new Error('macOS developer tools unavailable'); });
    execSyncMock.mockReturnValue('https://github.com/user/repo.git');
    try {
      expect(resolveMemoryRoot(tempHome)).toBe(
        path.join(tempHome, 'projects', `local-${hashCwd(tempHome)}`, 'memory'),
      );
      expect(execSyncMock).not.toHaveBeenCalled();
      gitPreflight.mockReset();
      expect(resolveMemoryRoot(tempHome)).toBe(
        path.join(tempHome, 'projects', 'github.com-user-repo', 'memory'),
      );
      expect(execSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      execSyncMock.mockReturnValue('');
    }
  });

  it('fallback key for no-remote cwd starts with local-', () => {
    const root = resolveMemoryRoot(tempHome);
    const segments = root.split(path.sep);
    const keyIdx = segments.indexOf('projects') + 1;
    expect(segments[keyIdx]).toMatch(/^local-[0-9a-f]{16}$/);
  });

  it('resolveMemoryEntrypoint returns <root>/MEMORY.md', () => {
    const entrypoint = resolveMemoryEntrypoint(tempHome);
    expect(entrypoint.endsWith(path.join('memory', 'MEMORY.md'))).toBe(true);
  });
});

describe('FEATURE_260 scoped memory identity', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-memory-scopes-'));
    setAgentConfigHome(tempHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const identity = {
    tenantId: 'tenant-acme',
    workspaceId: 'workspace-platform',
    userId: 'user-123',
    agentId: 'coding-agent',
    projectId: 'project-kodax',
    sessionId: 'session-1',
  } as const;

  it('requires every selector field to match exactly', () => {
    expect(matchesMemoryApplicability(identity, {
      tenantId: identity.tenantId,
      projectId: identity.projectId,
      userId: identity.userId,
    })).toBe(true);

    for (const [field, replacement] of [
      ['tenantId', 'other-tenant'],
      ['workspaceId', 'other-workspace'],
      ['userId', 'other-user'],
      ['agentId', 'other-agent'],
      ['projectId', 'other-project'],
      ['sessionId', 'other-session'],
    ] as const) {
      expect(matchesMemoryApplicability(identity, {
        tenantId: identity.tenantId,
        [field]: replacement,
      })).toBe(false);
    }
  });

  it('uses full lowercase SHA-256 components and never leaks raw identity', () => {
    const hash = hashMemoryIdentityComponent('tenant', identity.tenantId);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashMemoryIdentityComponent('tenant', identity.tenantId));
    expect(hash).not.toBe(hashMemoryIdentityComponent('project', identity.tenantId));

    const root = resolveScopedMemoryRoot(identity, 'project');
    expect(root).toBe(path.join(
      tempHome,
      'memory-scopes',
      hash,
      'project',
      hashMemoryIdentityComponent('project', identity.projectId),
    ));
    expect(root).not.toContain(identity.tenantId);
    expect(root).not.toContain(identity.projectId);
    expect(isAutoManagedMemoryFile(path.join(root, 'project_stack.md'))).toBe(true);
  });

  it('honors an explicit identity config home without changing global runtime state', () => {
    const explicitHome = path.join(tempHome, 'explicit-owner');
    const root = resolveScopedMemoryRoot({
      ...identity,
      configHome: explicitHome,
    }, 'user');

    expect(root).toBe(path.join(
      explicitHome,
      'memory-scopes',
      hashMemoryIdentityComponent('tenant', identity.tenantId),
      'user',
      hashMemoryIdentityComponent('user', identity.userId),
    ));
  });

  it('fails closed when a scoped root lacks the required identity field', () => {
    expect(() => resolveScopedMemoryRoot(identity, 'workspace')).not.toThrow();
    expect(() => resolveScopedMemoryRoot({
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
    }, 'project')).toThrow(/projectId/);
  });
});

describe('isAutoManagedMemoryFile', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-memory-isfile-'));
    setAgentConfigHome(tempHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns true for memory/*.md under projects/<key>/', () => {
    const memoryFile = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'memory',
      'feedback_no_mock.md',
    );
    expect(isAutoManagedMemoryFile(memoryFile)).toBe(true);
  });

  it('protects non-Markdown governance files inside managed memory roots', () => {
    const governance = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'memory',
      '.governance',
      'lifecycle.json',
    );
    expect(isAutoManagedMemoryFile(governance)).toBe(true);
  });

  it('returns false for files in projects/<key>/ but not under memory/', () => {
    const sessions = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'sessions',
      'foo.md',
    );
    expect(isAutoManagedMemoryFile(sessions)).toBe(false);
  });

  it('returns false for paths outside agent config home', () => {
    const outside = path.join(os.homedir(), 'unrelated', 'memory', 'x.md');
    expect(isAutoManagedMemoryFile(outside)).toBe(false);
  });

  it('handles path traversal (.. segments) via path.resolve', () => {
    // path.resolve('<home>/projects/<key>/memory/../sessions/x.md')
    // normalizes to '<home>/projects/<key>/sessions/x.md' which is NOT
    // memory.
    const traversal = path.join(
      tempHome,
      'projects',
      'github.com-user-repo',
      'memory',
      '..',
      'sessions',
      'x.md',
    );
    expect(isAutoManagedMemoryFile(traversal)).toBe(false);
  });
});

describe('parseMemoryTypeFromFilename', () => {
  it('recognizes the 4 type prefixes', () => {
    expect(parseMemoryTypeFromFilename('user_role.md')).toBe('user');
    expect(parseMemoryTypeFromFilename('feedback_no_mock.md')).toBe('feedback');
    expect(parseMemoryTypeFromFilename('project_q2.md')).toBe('project');
    expect(parseMemoryTypeFromFilename('reference_grafana.md')).toBe(
      'reference',
    );
  });

  it('is case-insensitive', () => {
    expect(parseMemoryTypeFromFilename('Feedback_No_Mock.md')).toBe('feedback');
  });

  it('returns undefined for files not matching the convention', () => {
    expect(parseMemoryTypeFromFilename('random.md')).toBeUndefined();
    expect(parseMemoryTypeFromFilename('MEMORY.md')).toBeUndefined();
    expect(parseMemoryTypeFromFilename('my-feedback.md')).toBeUndefined();
  });

  it('accepts bare type-name files (no underscore suffix)', () => {
    expect(parseMemoryTypeFromFilename('user.md')).toBe('user');
  });
});
