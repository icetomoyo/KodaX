#!/usr/bin/env tsx
/**
 * Bare CLI cold-start smoke: process spawn to the first accepted REPL input.
 *
 * A fresh process and isolated KODAX_HOME are used for every sample. Classic
 * REPL is forced because redirected stdio has no portable cross-platform PTY;
 * the timer still includes the production bootstrap, ESM evaluation, Runtime
 * recovery, managed-child cleanup, workspace Git probes, and REPL preparation.
 * The harness waits for readline's prompt before sending `/exit`, so process
 * exit time and cleanup are outside the measured first-ready latency.
 *
 * Smoke run:
 *   npm run bench:cli-first-ready -- --samples=3
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { connectKodaXRuntime } from '../../src/sdk-runtime.js';
import { waitForRuntimeDaemonOwnerExit } from '../../src/runtime-daemon/process.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  resolveRuntimeDaemonPathsFromConfigHome,
} from '../../src/runtime-daemon/state.js';

const DEFAULT_SAMPLES = 5;
const WARMUPS = 1;
const TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

function sampleCount(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--samples='))
    ?.slice('--samples='.length);
  if (raw === undefined) return DEFAULT_SAMPLES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 30) {
    throw new Error('--samples must be an integer between 1 and 30');
  }
  return parsed;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function summarize(values: readonly number[]): Record<string, number> {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number): number => sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ] ?? 0;
  return {
    meanMs: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

async function measureFirstReady(
  benchmarkRoot: string,
  sample: number,
): Promise<number> {
  const sampleRoot = path.join(benchmarkRoot, `sample-${sample}`);
  const configHome = path.join(sampleRoot, 'kodax-home');
  const integrationsDir = path.join(configHome, 'integrations');
  await fs.mkdir(integrationsDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(configHome, 'config.json'), '{}\n', 'utf8'),
    fs.writeFile(path.join(configHome, 'config.example.jsonc'), '', 'utf8'),
    ...['mcp', 'a2a', 'extensions'].map((name) =>
      fs.writeFile(path.join(integrationsDir, `${name}.example.jsonc`), '', 'utf8')),
  ]);
  const bootstrap = path.resolve('dist', 'kodax_bootstrap.js');
  const productionEnv = path.resolve('scripts', 'production-env.cjs');
  const startedAt = performance.now();
  const child = spawn(process.execPath, [
    '--require',
    productionEnv,
    bootstrap,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KODAX_HOME: configHome,
      KODAX_FORCE_CLASSIC_REPL: '1',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const readyMs = await new Promise<number>((resolve, reject) => {
    let captured = '';
    let readyMs: number | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (error) reject(error);
      else resolve(readyMs ?? 0);
    };
    const observe = (chunk: Buffer): void => {
      if (Buffer.byteLength(captured, 'utf8') < MAX_CAPTURE_BYTES) {
        captured += chunk.toString('utf8');
      }
      if (readyMs !== undefined) return;
      const visible = stripAnsi(captured);
      if (!/(?:^|\n)kodax:[^\n]*> $/.test(visible)) return;
      readyMs = round(performance.now() - startedAt);
      child.stdin.end('/exit\n');
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (readyMs === undefined || code !== 0) {
        const tail = stripAnsi(captured).slice(-2_000);
        finish(new Error(
          `bare CLI exited before a clean ready sample (code=${code}, signal=${signal})\n${tail}`,
        ));
        return;
      }
      finish();
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(
        `bare CLI did not reach its first prompt within ${TIMEOUT_MS}ms\n${stripAnsi(captured).slice(-2_000)}`,
      ));
    }, TIMEOUT_MS);
  });
  // The CLI disconnects on /exit; its persistent Host needs its own shutdown.
  // Reclaim it outside the measured boundary, before deleting its config home.
  const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  const state = readRuntimeDaemonState(paths);
  if (!owner || !state || state.runtimeId !== owner.runtimeId || state.pid !== owner.pid) {
    throw new Error('Cannot confirm the benchmark Host owner; retain its fixture for diagnosis.');
  }
  const runtime = await connectKodaXRuntime({
    homeDir: sampleRoot, endpoint: state.endpoint, daemonToken: readRuntimeDaemonToken(paths),
  });
  try {
    if (runtime.identity.runtimeId !== owner.runtimeId) throw new Error('Benchmark Host owner changed before shutdown.');
    await runtime.daemon.shutdown();
  } finally { await runtime.close(); }
  await waitForRuntimeDaemonOwnerExit(owner, TIMEOUT_MS);
  return readyMs;
}

const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-cli-first-ready-'));
const samples = sampleCount();
const timings: number[] = [];
let completed = false;
try {
  for (let sample = -WARMUPS; sample < samples; sample += 1) {
    const wallMs = await measureFirstReady(benchmarkRoot, sample);
    if (sample >= 0) timings.push(wallMs);
  }
  completed = true;
  process.stdout.write(`${JSON.stringify({
    benchmark: 'bare-cli-first-ready',
    surface: 'classic-repl-with-redirected-stdio',
    fixture: 'isolated-existing-config-home',
    boundary: 'fresh-process-spawn-to-first-readline-prompt',
    includes: [
      'production-bootstrap',
      'esm-evaluation',
      'runtime-recovery',
      'managed-child-cleanup',
      'workspace-git-probes',
      'repl-preparation',
    ],
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    warmups: WARMUPS,
    samples,
    timingsMs: timings,
    summary: summarize(timings),
  }, null, 2)}\n`);
} finally {
  if (completed) await fs.rm(benchmarkRoot, { recursive: true, force: true });
  else process.stderr.write(`Retained incomplete benchmark fixtures: ${benchmarkRoot}\n`);
}
