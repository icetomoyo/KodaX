/** Offline write-growth/reopen benchmark. Raw output belongs in OS temporary storage.
 * Usage: npx tsx benchmark/perf/execution-facts.bench.ts [baseline-module.ts]
 */
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createExecutionFactsStore } from '../../src/execution-facts.js';

const imported = process.argv[2] ? await import(pathToFileURL(path.resolve(process.argv[2])).href) as
  { createExecutionFactsStore: typeof createExecutionFactsStore } : { createExecutionFactsStore };
const factory = imported.createExecutionFactsStore;
const owner = { ownerId: 'bench-owner', runtimeId: 'bench-runtime', pid: process.pid, startedAt: new Date().toISOString() };
const target = { kind: 'run' as const, runId: 'bench-run' };
const samples: { requests: number; repeat: number; elapsedMs: number; reopenMs: number; writtenBytes: number }[] = [];
for (const requests of process.argv[2] ? [50, 250, 1000] : [50, 250, 1000, 5000]) {
  for (let repeat = 0; repeat < 3; repeat++) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-facts-bench-'));
    const write = fs.writeFileSync, append = fs.appendFileSync;
    let writtenBytes = 0;
    fs.writeFileSync = (file, data, options) => { writtenBytes += Buffer.byteLength(data.toString()); write(file, data, options); };
    fs.appendFileSync = (file, data, options) => { writtenBytes += Buffer.byteLength(data.toString()); append(file, data, options); };
    try {
      const store = factory(directory, owner); store.created('session');
      const started = performance.now();
      for (let index = 0; index < requests; index++) {
        const request = { requestId: `request-${index}`, logicalRequestId: `logical-${index}`, provider: 'fixture',
          purpose: 'primary' as const, attempt: 1, boundary: 'physical_attempt' as const, dispatch: 'dispatched' as const,
          startedAt: '2026-11-01T00:00:00.000Z' };
        store.provider('session', target, { ...request, state: 'started' });
        store.provider('session', target, { ...request, state: 'succeeded', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
      }
      const elapsedMs = performance.now() - started;
      const reopening = performance.now();
      const restored = await factory(directory, owner).service.read('session');
      const reopenMs = performance.now() - reopening;
      if (restored.requestCount !== requests || restored.usage?.totalTokens !== requests * 3) throw new Error('Benchmark lost observations.');
      samples.push({ requests, repeat, elapsedMs, reopenMs, writtenBytes });
    } finally {
      fs.writeFileSync = write; fs.appendFileSync = append;
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('kodax-facts-bench-')) throw new Error('Unsafe benchmark cleanup target.');
      await rm(resolved, { recursive: true, force: true });
    }
  }
}
process.stdout.write(`${JSON.stringify({ node: process.version, platform: `${os.platform()} ${os.release()}`, module: process.argv[2] ?? 'candidate', samples }, null, 2)}\n`);
