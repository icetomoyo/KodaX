/**
 * The Host's RepoIntel v2 engine, behind KODAX_REPO_INTELLIGENCE_ENGINE=v2.
 * It finds the native program, keeps one supervised engine for every session
 * on this Host, opens each Run's repository and passes on the files its edits
 * changed. Edits made through the shell reach the index by the engine's own
 * periodic sweep. Without the program, the Host runs as before.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectRepoIntelEngine, createRepoIntelSupervisor, type RepoIntelEngineConnection, type RepoIntelSupervisor,
} from '@kodax-ai/coding';
import type { KodaXToolResultBlock } from '@kodax-ai/agent';
import { toolResultFileChange } from './client-canonical-tools.js';

export const REPO_INTEL_ENGINE_SWITCH = 'KODAX_REPO_INTELLIGENCE_ENGINE';
export const REPO_INTEL_ENGINE_PATH = 'KODAX_REPO_INTELLIGENCE_ENGINE_PATH';

export interface RepoIntelEngineLocation {
  /** The program, when one was found. */
  readonly path?: string;
  /** Every place looked, in order, for reporting a missing program. */
  readonly searched: readonly string[];
}

export function repoIntelEngineEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[REPO_INTEL_ENGINE_SWITCH] === 'v2';
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    // Missing or unreadable alike: the Host cannot run a program from there.
    return false;
  }
}

/** Looks where native programs ship, then in a source checkout built with `cargo build --release`. */
export function locateRepoIntelEngine(env: NodeJS.ProcessEnv, moduleUrl: string = import.meta.url): RepoIntelEngineLocation {
  const named = env[REPO_INTEL_ENGINE_PATH];
  if (named) return { ...(isFile(named) ? { path: named } : {}), searched: [named] };
  const program = `kodax-repo-intel${process.platform === 'win32' ? '.exe' : ''}`;
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const platform = `${process.platform}-${process.arch}`;
  const searched = [...new Set([
    path.join(moduleDirectory, 'native', platform, program),
    path.join(moduleDirectory, '..', 'native', platform, program),
    path.join(moduleDirectory, '..', 'dist', 'native', platform, program),
    path.join(path.dirname(process.execPath), 'vendor', 'kodax-native', platform, program),
    path.join(moduleDirectory, '..', 'native', 'repo-intel', 'target', 'release', program),
  ].map(candidate => path.resolve(candidate)))];
  const found = searched.find(isFile);
  return { ...(found ? { path: found } : {}), searched };
}

export function createRepoIntelEngineHost(input: {
  readonly configHome: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onLog: (level: 'info' | 'warn', message: string) => void;
}): RepoIntelSupervisor | undefined {
  if (!repoIntelEngineEnabled(input.env)) return undefined;
  const location = locateRepoIntelEngine(input.env);
  if (location.path === undefined) {
    input.onLog('warn', `${REPO_INTEL_ENGINE_SWITCH}=v2 is set, but the RepoIntel engine program was not found in `
      + `${location.searched.join(', ')}. Put the program from the GitHub Release in one of those places, or set `
      + `${REPO_INTEL_ENGINE_PATH} to it. RepoIntel keeps working without it.`);
    return undefined;
  }
  return createRepoIntelSupervisor({
    launch: { command: location.path },
    storageRoot: path.join(input.configHome, 'repo-intelligence-v2'),
    onLog: (line: string) => input.onLog('info', line),
  });
}

export interface RepoIntelEngineInspection {
  readonly enabled: boolean;
  readonly program?: string;
  /** Present when the program was not found. */
  readonly searched?: readonly string[];
  /** What the program said when started once, or why it could not answer. */
  readonly engine?:
    | { readonly version: string; readonly languages: readonly string[]; readonly background: { readonly active: boolean; readonly reason?: string } }
    | { readonly error: string };
}

const INSPECT_TIMEOUT_MS = 5_000;

/** For `kodax doctor`: starts the program once and stops it. Its `initialize` writes nothing. */
export async function inspectRepoIntelEngine(configHome: string, env: NodeJS.ProcessEnv): Promise<RepoIntelEngineInspection> {
  if (!repoIntelEngineEnabled(env)) return { enabled: false };
  const location = locateRepoIntelEngine(env);
  if (location.path === undefined) return { enabled: true, searched: location.searched };
  let connection: RepoIntelEngineConnection | undefined;
  try {
    // A program the system cannot run may throw here rather than report through `exited`.
    connection = await connectRepoIntelEngine({ command: location.path });
    const answer = await connection.request<Exclude<RepoIntelEngineInspection['engine'], { error: string } | undefined>>('initialize',
      { storageRoot: path.join(configHome, 'repo-intelligence-v2') }, INSPECT_TIMEOUT_MS);
    const { version, languages, background } = answer;
    return { enabled: true, program: location.path, engine: { version, languages, background } };
  } catch (error: unknown) {
    return { enabled: true, program: location.path, engine: { error: error instanceof Error ? error.message : String(error) } };
  } finally {
    await connection?.stop(INSPECT_TIMEOUT_MS);
  }
}

/** The repository-relative path an edit changed, written with `/` as git lists it. */
function changedPath(payload: unknown, root: string): string | undefined {
  const result = (payload as { result?: { toolResult?: KodaXToolResultBlock } } | undefined)?.result;
  const change = toolResultFileChange(result?.toolResult);
  if (change === undefined) return undefined;
  const relative = path.relative(root, path.resolve(root, change.path));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

/** Feeds one Runtime event of a Run working in `root` to the engine. */
export function relayRunEventToRepoIntel(engine: RepoIntelSupervisor, type: string, payload: unknown, root: string): void {
  if (type === 'run.started') {
    engine.open(root);
    return;
  }
  if (type !== 'tool.finished') return;
  const changed = changedPath(payload, root);
  if (changed !== undefined) engine.changed(root, [changed]);
}
