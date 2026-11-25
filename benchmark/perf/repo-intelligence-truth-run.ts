/**
 * Shared by the truth benches: the seeded symbol sample, and a full build of
 * the old in-process engine. Loading this module loads the old engine's code.
 */
import { performance } from 'node:perf_hooks';

import { getRepoIntelligenceIndex } from '../../packages/coding/src/repo-intelligence/runtime.js';
import * as workerClient from '../../packages/coding/src/repo-intelligence/semantic-worker-client.js';
import type { RepoSymbolRecord } from '../../packages/coding/src/repo-intelligence/semantic-types.js';
import { isTestFile, isTypeScriptSource, type TruthIndex } from './repo-intelligence-truth-oracle.js';
import { buildEngineView, type EngineIndexLike, type EngineView } from './repo-intelligence-truth-score.js';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

/** A seeded sample of exported functions and methods in non-test TypeScript files. */
export function sampleKeys(truth: TruthIndex, size: number, seed: number): string[] {
  const pool = Array.from(truth.units.values())
    .filter((unit) => (unit.kind === 'function' || unit.kind === 'method') && unit.exported)
    .filter((unit) => isTypeScriptSource(unit.filePath) && !isTestFile(unit.filePath))
    .map((unit) => unit.key)
    .sort();
  return seededShuffle(pool, seed).slice(0, size);
}

/** Engine env: full mode, temp storage, and enough worker heap to finish (2 GB runs out on KodaX). */
export function configureEngineEnv(storageRoot: string): Record<string, string> {
  process.env.KODAX_REPO_INTELLIGENCE_STORAGE_DIR = storageRoot;
  process.env.KODAX_REPO_INTELLIGENCE = 'full';
  process.env.KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB ??= '6144';
  process.env.KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS ??= '600000';
  return {
    KODAX_REPO_INTELLIGENCE: 'full',
    KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB: process.env.KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB,
    KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS: process.env.KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS,
  };
}

// Looked up by name so the bench keeps running if these internal helpers move.
export async function shutdownWorker(): Promise<void> {
  const shutdown: unknown = Reflect.get(workerClient, 'shutdownRepoIntelligenceWorkerForTest');
  if (typeof shutdown === 'function') await shutdown();
}

export function workerPath(): string | undefined {
  const read: unknown = Reflect.get(workerClient, 'getRepoIntelligenceWorkerPathForDiagnostics');
  return typeof read === 'function' ? String(read()) : undefined;
}

export interface OldEngineBuild {
  readonly view: EngineView;
  readonly symbols: readonly RepoSymbolRecord[];
  readonly ms: number;
  readonly status: string;
}

export async function buildEngine(repoRoot: string): Promise<OldEngineBuild> {
  const start = performance.now();
  const options = { refresh: true, mode: 'full' as const };
  const index = await getRepoIntelligenceIndex({ executionCwd: repoRoot, gitRoot: repoRoot }, options);
  const ms = Math.round(performance.now() - start);
  const status = index.capability?.status ?? 'unknown';
  if (index.symbols.length === 0) {
    throw new Error(`Engine returned an empty index (capability status: ${status}). Check worker heap / timeout.`);
  }
  const view = buildEngineView(index as EngineIndexLike);
  await shutdownWorker();
  return { view, symbols: index.symbols, ms, status };
}
