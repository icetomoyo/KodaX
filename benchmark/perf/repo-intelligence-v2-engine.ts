/**
 * Drives the RepoIntel v2 engine program over its JSON-RPC protocol for the
 * v2 benches, the way the Host does. The program is the one named by
 * KODAX_REPO_INTELLIGENCE_ENGINE_PATH, or the release build in this checkout.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  connectRepoIntelEngine,
  type RepoIntelEngineConnection,
} from '../../packages/coding/src/repo-intelligence/engine/connection.js';
import type { ReferenceSite, V2Definition } from './repo-intelligence-v2-score.js';

const TIMEOUT_MS = 600_000;
const READY_POLL_MS = 50;

export function benchEngineProgram(): string {
  const program = process.env.KODAX_REPO_INTELLIGENCE_ENGINE_PATH
    ?? path.resolve('native', 'repo-intel', 'target', 'release', `kodax-repo-intel${process.platform === 'win32' ? '.exe' : ''}`);
  if (!existsSync(program)) {
    throw new Error(`No engine program at ${program}. Run \`cargo build --release\` in native/repo-intel, or set KODAX_REPO_INTELLIGENCE_ENGINE_PATH.`);
  }
  return program;
}

export interface WorkspaceStatus {
  readonly state: string;
  readonly error?: string | null;
  readonly indexed: number;
  readonly withSyntaxErrors: number;
  readonly notIndexed: Record<string, number>;
  readonly filesRead: number;
  readonly sweeps: number;
}

export interface BenchEngine {
  readonly connection: RepoIntelEngineConnection;
  readonly initialize: Record<string, unknown>;
  call<T>(method: string, params?: object): Promise<T>;
  /** The engine's resident memory now, in bytes, when the platform reports it. */
  residentBytes(): Promise<number | undefined>;
  stop(): Promise<void>;
}

export async function startBenchEngine(program: string, storageRoot: string): Promise<BenchEngine> {
  const connection = await connectRepoIntelEngine({ command: program }, (line) => process.stderr.write(`[engine] ${line}\n`));
  const call = <T>(method: string, params?: object): Promise<T> => connection.request<T>(method, params, TIMEOUT_MS);
  const initialize = await call<Record<string, unknown>>('initialize', { storageRoot });
  return {
    connection,
    initialize,
    call,
    residentBytes: async () => (await call<{ residentBytes?: number | null }>('engine.status')).residentBytes ?? undefined,
    stop: () => connection.stop(10_000),
  };
}

/** Opens `root` and waits for the first sweep to finish; `onPoll` runs while it waits. */
export async function openAndWait(engine: BenchEngine, root: string, onPoll?: () => Promise<void>): Promise<{ ms: number; status: WorkspaceStatus }> {
  const start = performance.now();
  await engine.call('workspace.open', { root });
  for (;;) {
    const status = await engine.call<WorkspaceStatus>('workspace.status', { root });
    if (status.state === 'degraded') throw new Error(`Indexing ${root} failed: ${status.error ?? 'no reason given'}`);
    if (status.state === 'ready' && status.sweeps > 0) return { ms: Math.round(performance.now() - start), status };
    await onPoll?.();
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

export interface FindPage<T> {
  readonly precision: string;
  readonly hits: T[];
  readonly total: number;
  readonly nextOffset: number | null;
}

export interface FindAll<T> {
  readonly hits: T[];
  readonly total: number;
  readonly pages: number;
  readonly precisions: Set<string>;
}

/** Every hit for `name`, following `nextOffset` to the end. */
export async function findAll<T>(engine: BenchEngine, method: string, root: string, name: string): Promise<FindAll<T>> {
  const hits: T[] = [];
  const precisions = new Set<string>();
  let offset: number | null = 0;
  let total = 0;
  let pages = 0;
  while (offset !== null) {
    const page: FindPage<T> = await engine.call<FindPage<T>>(method, { root, name, limit: 500, offset });
    hits.push(...page.hits);
    precisions.add(page.precision);
    total = page.total;
    pages += 1;
    offset = page.nextOffset;
  }
  return { hits, total, pages, precisions };
}

export type ReferenceHit = ReferenceSite & { readonly name: string };

export interface OutlineAnswer {
  readonly indexed: boolean;
  readonly reason?: string;
  readonly withSyntaxErrors?: boolean;
  readonly definitions?: V2Definition[];
}

export async function outlineOf(engine: BenchEngine, root: string, filePath: string): Promise<OutlineAnswer> {
  return engine.call<OutlineAnswer>('file.outline', { root, path: filePath });
}

export interface ImportsAnswer {
  readonly indexed: boolean;
  readonly reason?: string;
  readonly imports?: readonly {
    readonly module: string;
    readonly name: string;
    readonly local: string;
    readonly target?: string;
    readonly unresolved?: 'external' | 'missing';
  }[];
}

export async function importsOf(engine: BenchEngine, root: string, filePath: string): Promise<ImportsAnswer> {
  return engine.call<ImportsAnswer>('file.imports', { root, path: filePath });
}
