/**
 * Contract test for CAP-033: tool target path resolution
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-033-tool-target-path-resolution
 *
 * Test obligations:
 * - CAP-PATH-RESOLVE-001: relative + absolute forms canonicalize to the
 *   same absolute path when the relative path is resolved against the
 *   execution cwd
 * - CAP-PATH-RESOLVE-002: returns undefined for tool calls with no
 *   path / empty path / non-string path
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/edit-recovery.ts:54
 * (extracted from agent.ts:902-912 during FEATURE_100 P2). The actual
 * canonicalization helper is `resolveExecutionPath` in runtime-paths.ts.
 *
 * Time-ordering constraint: used by edit recovery (CAP-015) write-block
 * lookup and mutation tracker.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6j.
 */

import path from 'path';
import { describe, expect, it } from 'vitest';

import { resolveToolTargetPath } from '../middleware/edit-recovery.js';
import type { KodaXToolExecutionContext } from '../../types.js';

function makeCtx(executionCwd: string): KodaXToolExecutionContext {
  return {
    executionCwd,
    gitRoot: executionCwd,
    abortSignal: undefined,
    backups: new Map(),
  } as unknown as KodaXToolExecutionContext;
}

describe('CAP-033: tool target path resolution contract', () => {
  it('CAP-PATH-RESOLVE-001: relative and absolute path forms of the same file canonicalize to the same absolute string', () => {
    const cwd = path.resolve('/tmp/repo');
    const ctx = makeCtx(cwd);

    const fromRelative = resolveToolTargetPath(
      { id: 'tc-1', name: 'read_file', input: { path: 'src/index.ts' } },
      ctx,
    );
    const fromAbsolute = resolveToolTargetPath(
      { id: 'tc-1', name: 'read_file', input: { path: path.join(cwd, 'src/index.ts') } },
      ctx,
    );

    expect(fromRelative).toBeDefined();
    expect(fromAbsolute).toBeDefined();
    expect(fromRelative).toBe(fromAbsolute);
    expect(fromRelative).toBe(path.resolve(cwd, 'src/index.ts'));
  });

  it('CAP-PATH-RESOLVE-002a: returns undefined when tool call has no input.path field', () => {
    const ctx = makeCtx(path.resolve('/tmp/repo'));
    expect(
      resolveToolTargetPath({ id: 'tc-bash', name: 'bash', input: { command: 'ls' } }, ctx),
    ).toBeUndefined();
  });

  it('CAP-PATH-RESOLVE-002b: returns undefined when input.path is an empty / whitespace-only string', () => {
    const ctx = makeCtx(path.resolve('/tmp/repo'));
    expect(resolveToolTargetPath({ id: 'tc-1', name: 'read_file', input: { path: '' } }, ctx)).toBeUndefined();
    expect(resolveToolTargetPath({ id: 'tc-1', name: 'read_file', input: { path: '   ' } }, ctx)).toBeUndefined();
  });

  it('CAP-PATH-RESOLVE-002c: returns undefined when input is undefined', () => {
    const ctx = makeCtx(path.resolve('/tmp/repo'));
    expect(resolveToolTargetPath({ id: 'tc-1', name: 'read_file', input: undefined }, ctx)).toBeUndefined();
  });

  it('CAP-PATH-RESOLVE-002d: returns undefined when input.path is a non-string value', () => {
    const ctx = makeCtx(path.resolve('/tmp/repo'));
    expect(
      resolveToolTargetPath(
        { id: 'tc-1', name: 'read_file', input: { path: 42 as unknown as string } },
        ctx,
      ),
    ).toBeUndefined();
  });
});
