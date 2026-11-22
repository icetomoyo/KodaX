/**
 * The one directory tree in which a Host lets a client that is not on its own
 * machine name a project. Such a client never sends or sees a Host path: it
 * names a directory by its path inside the workspace, with `/` between names
 * and `.` for the workspace itself.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { HostProtocolError } from '../host-protocol/codec.js';

export interface HostWorkspace {
  /** The directory a workspace path names. Fails unless it exists inside the workspace. */
  resolve(project: string): Promise<string>;
  /** The workspace path of a Host directory, or undefined when it lies outside the workspace. */
  relative(directory: string): Promise<string | undefined>;
  /** The workspace directory with links followed, for `within`. */
  root(): Promise<string>;
}

export function createHostWorkspace(root: string): HostWorkspace {
  let resolved: Promise<string> | undefined;
  // Links are followed once, here, so every later comparison is between real paths.
  const realRoot = (): Promise<string> => (resolved ??= fs.realpath(root).catch((error: unknown) => {
    resolved = undefined;
    throw new HostProtocolError('unavailable', 'The Host workspace directory cannot be read.', {
      reason: 'workspace_unavailable', cause: error,
    });
  }));
  const outside = (): HostProtocolError => new HostProtocolError(
    'invalid_params', 'The project must be a path inside the Host workspace.', { reason: 'project_outside_workspace' });

  return {
    async resolve(project) {
      const base = await realRoot();
      // The name itself must stay inside before the file system is asked anything.
      if (project.includes('\\') || path.isAbsolute(project) || within(base, path.resolve(base, project)) === undefined) {
        throw outside();
      }
      let directory: string;
      try {
        directory = await fs.realpath(path.resolve(base, project));
        if (!(await fs.stat(directory)).isDirectory()) throw new Error('Not a directory.');
      } catch (error: unknown) {
        throw new HostProtocolError('not_found', 'The project is not a directory in the Host workspace.', {
          reason: 'project_not_found', cause: error,
        });
      }
      // A link inside the workspace may lead out of it.
      if (within(base, directory) === undefined) throw outside();
      return directory;
    },
    async relative(directory) {
      return within(await realRoot(), directory);
    },
    root: realRoot,
  };
}

/** The path of `target` inside `base` with `/` between names, or undefined when it is not inside. */
export function within(base: string, target: string): string | undefined {
  const relative = path.relative(base, target);
  if (relative === '') return '.';
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
  return relative.split(path.sep).join('/');
}
