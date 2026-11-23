/**
 * The Host workspace, read-only: what a directory holds, the bytes of a file,
 * and what git sees changed in a project. Paths are workspace paths, with `/`
 * between names and `.` for the workspace itself. A path that leads out of the
 * workspace through a link fails with `invalid_params`
 * (`path_outside_workspace`); one that names a secret, such as `.env` or a
 * directory like `.ssh`, fails with `forbidden` (`path_refused`) and is left
 * out of listings and diffs. A Host with no workspace refuses all of them
 * (`forbidden`, `workspace_not_configured`).
 */
import { z } from 'zod/v4';

import { hostParams, hostResult, WorkspacePath, type HostMethodRegistry } from './schema.js';

const Entry = z.object({
  name: z.string(),
  /** A link is not followed: list or read through it to see where it leads. */
  kind: z.enum(['file', 'directory', 'link', 'other']),
  /** Bytes, for a file. */
  size: z.int().optional(),
  /** UTC milliseconds. Absent for a link. */
  modifiedAt: z.int().optional(),
});

export const WORKSPACE_METHODS = {
  /** What a directory holds, ordered by name, a page at a time. */
  'workspace.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      /** The workspace itself when absent. */
      path: WorkspacePath.optional(),
      limit: z.int().min(1).max(1000).optional(),
      cursor: z.string().min(1).max(1024).optional(),
    }),
    result: hostResult({ entries: z.array(Entry), nextCursor: z.string().optional() }),
  },
  /**
   * A chunk of a file, at most `limits.blobChunkBytes`, in base64. Every chunk
   * says the whole file's length. A cursor whose file changed since fails with
   * `resync_required` (`file_changed`), and the client reads again from the start.
   */
  'workspace.read': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ path: WorkspacePath, cursor: z.string().min(1).max(256).optional() }),
    result: hostResult({
      data: z.string(),
      byteLength: z.int(),
      modifiedAt: z.int(),
      nextCursor: z.string().optional(),
    }),
  },
  /**
   * What git sees changed under a directory, as a unified diff with paths
   * relative to it: the working tree against the index, or with `staged` the
   * index against `HEAD`. Files git does not track yet are not in it. A diff
   * longer than 256 KiB is cut at a line and says `truncated`. A directory
   * outside any git work tree fails with `invalid_state` (`not_a_git_repository`).
   * A repository whose own config names a filter, a command git would run as
   * it reads, fails with `forbidden` (`repository_filters`).
   */
  'workspace.gitDiff': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ path: WorkspacePath.optional(), staged: z.boolean().optional() }),
    result: hostResult({ diff: z.string(), truncated: z.boolean().optional() }),
  },
} as const satisfies HostMethodRegistry;
