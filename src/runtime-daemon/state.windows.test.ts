import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, it } from 'vitest';

import {
  readRuntimeDaemonState,
  resolveRuntimeDaemonPaths,
  writeRuntimeDaemonState,
  type RuntimeDaemonState,
} from './state.js';

const readerSource = `
const fs = require('node:fs');
const counts = { reads: 0, invalidJson: 0, readErrors: 0 };
let stopping = false;
let ready = false;
const watchdog = setTimeout(() => { stopping = true; }, 15000);
process.on('message', message => { if (message === 'stop') stopping = true; });
process.on('disconnect', () => { stopping = true; });
function batch() {
  for (let index = 0; index < 100 && !stopping; index++) {
    let contents;
    try { contents = fs.readFileSync(process.argv[1], 'utf8'); }
    catch { counts.readErrors++; continue; }
    counts.reads++;
    try { JSON.parse(contents); } catch { counts.invalidJson++; }
  }
  if (!ready) { ready = true; process.send?.({ type: 'ready' }); }
  if (!stopping) { setImmediate(batch); return; }
  clearTimeout(watchdog);
  if (process.connected) process.send({ type: 'result', ...counts }, () => process.disconnect());
}
batch();
`;

interface ReaderResult {
  readonly reads: number;
  readonly invalidJson: number;
  readonly readErrors: number;
}

function startReader(stateFile: string) {
  const child = spawn(process.execPath, ['-e', readerSource, stateFile], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let result: ReaderResult | undefined;
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('State reader did not become ready')), 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`State reader exited early: ${stderr}`)); });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'ready') { clearTimeout(timer); resolve(); }
      if (message.type === 'result'
        && 'reads' in message && typeof message.reads === 'number'
        && 'invalidJson' in message && typeof message.invalidJson === 'number'
        && 'readErrors' in message && typeof message.readErrors === 'number') {
        result = { reads: message.reads, invalidJson: message.invalidJson, readErrors: message.readErrors };
      }
    });
  });
  return { child, ready, exited, result: () => result, stderr: () => stderr };
}

async function stopReader(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
  const forceStop = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }, 3000);
  try {
    if (child.connected) child.send('stop', (error) => { if (error) child.kill(); });
    await exited;
  } finally {
    clearTimeout(forceStop);
  }
}

it.skipIf(process.platform !== 'win32')('publishes 200 atomic daemon states while another Node process continuously reads JSON', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodax-state-reader-'));
  const paths = resolveRuntimeDaemonPaths(root, 'contention');
  const state = (generation: number): RuntimeDaemonState => ({
    runtimeId: 'state-reader-contention', profile: 'contention', pid: process.pid,
    startedAt: '2026-09-21T00:00:00.000Z', endpoint: 'test-only', version: 'test',
    status: 'ready', lastError: `generation-${generation}`,
  });
  let reader: ReturnType<typeof startReader> | undefined;
  try {
    writeRuntimeDaemonState(paths, state(0));
    reader = startReader(paths.stateFile);
    await reader.ready;
    const deadline = performance.now() + 10_000;
    for (let generation = 1; generation <= 200; generation++) {
      if (performance.now() > deadline) throw new Error('State contention exceeded its test budget');
      writeRuntimeDaemonState(paths, state(generation));
      expect(readRuntimeDaemonState(paths)).toEqual(state(generation));
      await nextTurn();
    }
    await stopReader(reader.child, reader.exited);
    expect(await reader.exited).toBe(0);
    expect(reader.stderr()).toBe('');
    expect(reader.result()?.reads).toBeGreaterThan(100);
    expect(reader.result()?.invalidJson).toBe(0);
    expect(reader.result()?.readErrors).toBe(0);
    expect(readRuntimeDaemonState(paths)).toEqual(state(200));
  } finally {
    if (reader) await stopReader(reader.child, reader.exited);
    const resolved = realpathSync(root);
    const relative = path.relative(realpathSync(tmpdir()), resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing cleanup outside test temp root');
    rmSync(resolved, { recursive: true, force: true });
  }
}, 20_000);
