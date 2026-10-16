/**
 * Shard 6d-j — tool-policy path / shell boundary tests.
 *
 * Covers the pure helpers restored from the legacy
 * `createToolPolicyHook` branch that Shard 6d-b deleted.
 */

import { describe, expect, it } from 'vitest';
import {
  SHELL_WRITE_PATTERNS,
  collectToolInputPaths,
  enforceShellWriteBoundary,
  enforceWritePathBoundary,
  matchesShellPattern,
  matchesWritePathPattern,
} from './tool-policy.js';

// A caller-supplied boundary for the shared guards; no role installs it by default.
const DOCS_ONLY_WRITE_PATH_PATTERNS: readonly string[] = [
  '\\.(?:md|mdx|txt|rst|adoc)$',
  '(?:^|/)(?:docs?|documentation|design|requirements?|specs?|plans?|notes?|reports?)(?:/|$)',
  '(?:^|/)(?:README|CHANGELOG|FEATURE_LIST|KNOWN_ISSUES|PRD|ADR|HLD|DD)(?:\\.[^/]+)?$',
];

describe('matchesWritePathPattern', () => {
  it('matches docs-only path patterns (docs/foo.md, CHANGELOG, README)', () => {
    expect(matchesWritePathPattern('docs/feature.md', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(true);
    expect(matchesWritePathPattern('CHANGELOG.md', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(true);
    expect(matchesWritePathPattern('README', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(true);
    expect(matchesWritePathPattern('FEATURE_LIST.md', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(true);
    expect(matchesWritePathPattern('docs/plans/design.rst', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(true);
  });

  it('rejects code paths under docs-only pattern list', () => {
    expect(matchesWritePathPattern('src/runner.ts', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(false);
    expect(matchesWritePathPattern('packages/coding/src/foo.ts', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(false);
    expect(matchesWritePathPattern('scripts/release.sh', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(false);
  });

  it('normalizes Windows backslashes before testing', () => {
    expect(matchesWritePathPattern('docs\\plans\\x.md', DOCS_ONLY_WRITE_PATH_PATTERNS)).toBe(true);
  });

  it('returns true when the pattern list is empty / undefined (no boundary)', () => {
    expect(matchesWritePathPattern('anything', [])).toBe(true);
    expect(matchesWritePathPattern('anything', undefined)).toBe(true);
  });
});

describe('matchesShellPattern', () => {
  it('matches destructive shell commands from SHELL_WRITE_PATTERNS', () => {
    expect(matchesShellPattern('rm -rf /tmp/foo', SHELL_WRITE_PATTERNS)).toBe(true);
    expect(matchesShellPattern('mv foo bar', SHELL_WRITE_PATTERNS)).toBe(true);
    expect(matchesShellPattern('cp -r a b', SHELL_WRITE_PATTERNS)).toBe(true);
    expect(matchesShellPattern('sed -i s/x/y/ file', SHELL_WRITE_PATTERNS)).toBe(true);
    expect(matchesShellPattern('echo foo > bar.txt', SHELL_WRITE_PATTERNS)).toBe(true);
    expect(matchesShellPattern('Remove-Item C:\\foo', SHELL_WRITE_PATTERNS)).toBe(true);
  });

  it('does not match read-only commands', () => {
    expect(matchesShellPattern('ls -la', SHELL_WRITE_PATTERNS)).toBe(false);
    expect(matchesShellPattern('cat file.txt', SHELL_WRITE_PATTERNS)).toBe(false);
    expect(matchesShellPattern('git diff HEAD~1', SHELL_WRITE_PATTERNS)).toBe(false);
    expect(matchesShellPattern('node foo.js 2>&1', SHELL_WRITE_PATTERNS)).toBe(false);
  });
});

describe('collectToolInputPaths', () => {
  it('extracts file_path from top-level input', () => {
    expect(collectToolInputPaths({ file_path: 'docs/x.md' })).toEqual(['docs/x.md']);
  });

  it('extracts paths from nested + array shapes', () => {
    const input = {
      files: [{ path: 'a.md' }, { path: 'b.md' }],
      target_path: 'c.md',
    };
    expect(collectToolInputPaths(input).sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('ignores string values under non-path keys', () => {
    expect(collectToolInputPaths({ content: 'hello', language: 'ts' })).toEqual([]);
  });

  it('handles cycles without blowing up', () => {
    const obj: Record<string, unknown> = { file_path: 'x.md' };
    obj.self = obj;
    expect(collectToolInputPaths(obj)).toEqual(['x.md']);
  });
});

describe('enforceWritePathBoundary', () => {
  it('returns undefined for non-write tools (no-op)', () => {
    expect(enforceWritePathBoundary('read', { path: 'any.ts' }, DOCS_ONLY_WRITE_PATH_PATTERNS)).toBeUndefined();
    expect(enforceWritePathBoundary('grep', { pattern: 'x' }, DOCS_ONLY_WRITE_PATH_PATTERNS)).toBeUndefined();
  });

  it('returns undefined when docs-only allows the path', () => {
    expect(enforceWritePathBoundary('write', { file_path: 'docs/a.md' }, DOCS_ONLY_WRITE_PATH_PATTERNS)).toBeUndefined();
    expect(enforceWritePathBoundary('edit', { file_path: 'CHANGELOG.md' }, DOCS_ONLY_WRITE_PATH_PATTERNS)).toBeUndefined();
  });

  it('returns an error message when a code path is written under docs-only', () => {
    const msg = enforceWritePathBoundary(
      'write',
      { file_path: 'src/runner.ts' },
      DOCS_ONLY_WRITE_PATH_PATTERNS,
    );
    expect(msg).toMatch(/blocked/);
    expect(msg).toMatch(/src\/runner\.ts/);
  });

  it('rejects when no path can be extracted (conservative)', () => {
    const msg = enforceWritePathBoundary('write', { content: 'hi' }, DOCS_ONLY_WRITE_PATH_PATTERNS);
    expect(msg).toMatch(/could not be verified/);
  });

  it('returns undefined when no pattern list is given (no boundary)', () => {
    expect(enforceWritePathBoundary('write', { file_path: 'anywhere.ts' }, undefined)).toBeUndefined();
    expect(enforceWritePathBoundary('write', { file_path: 'anywhere.ts' }, [])).toBeUndefined();
  });
});

describe('enforceShellWriteBoundary', () => {
  it('blocks destructive commands', () => {
    expect(enforceShellWriteBoundary('rm -rf /tmp/foo')).toMatch(/blocked/);
    expect(enforceShellWriteBoundary('echo hi > file.txt')).toMatch(/blocked/);
  });

  it('allows read-only commands', () => {
    expect(enforceShellWriteBoundary('ls -la')).toBeUndefined();
    expect(enforceShellWriteBoundary('git diff')).toBeUndefined();
    expect(enforceShellWriteBoundary('cat x.md')).toBeUndefined();
  });
});

// FEATURE_193 (v0.7.43): `'role allow-lists expose repo-intelligence
// deep-capsule tools (v0.7.27)'` describe block removed — the
// `PLANNER_ALLOWED_TOOLS` and `H1_READONLY_GENERATOR_ALLOWED_TOOLS`
// constants it covered were dropped with the V1 chain retirement.

