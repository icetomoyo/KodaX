import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { resolveHandlerWorkerUrl } from './handler-worker-client.js';

const executablePath = path.resolve('fixtures', 'kodax');

function resolveFrom(modulePath: string): string {
  return fileURLToPath(resolveHandlerWorkerUrl({
    moduleUrl: pathToFileURL(modulePath).href,
    bundled: false,
    executablePath,
  }));
}

describe('resolveHandlerWorkerUrl', () => {
  it('uses the published sidecar beside a root distribution bundle', () => {
    const distDir = path.resolve('fixtures', 'dist');

    expect(resolveFrom(path.join(distDir, 'root-bundle.js')))
      .toBe(path.join(distDir, 'constructed-handler-worker.js'));
  });

  it('uses the published sidecar above a split SDK chunk', () => {
    const distDir = path.resolve('fixtures', 'dist');

    expect(resolveFrom(path.join(distDir, 'chunks', 'chunk-ABC.js')))
      .toBe(path.join(distDir, 'constructed-handler-worker.js'));
  });

  it('keeps the package-local worker beside an unbundled construction module', () => {
    const constructionDir = path.resolve(
      'fixtures',
      'packages',
      'coding',
      'dist',
      'construction',
    );

    expect(resolveFrom(path.join(constructionDir, 'handler-worker-client.js')))
      .toBe(path.join(constructionDir, 'handler-worker.js'));
  });

  it('uses the sidecar beside the standalone executable in bundled mode', () => {
    const modulePath = path.resolve('fixtures', 'embedded', 'kodax_cli.js');

    const resolved = fileURLToPath(resolveHandlerWorkerUrl({
      moduleUrl: pathToFileURL(modulePath).href,
      bundled: true,
      executablePath,
    }));

    expect(resolved).toBe(path.join(path.dirname(executablePath), 'constructed-handler-worker.js'));
  });

  it('spawns the sidecar selected for a root distribution bundle', async () => {
    const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-handler-sidecar-'));
    const workerPath = path.join(distDir, 'constructed-handler-worker.js');
    await fs.writeFile(
      path.join(distDir, 'package.json'),
      JSON.stringify({ type: 'module' }),
      'utf8',
    );
    await fs.writeFile(
      workerPath,
      [
        "import { parentPort, workerData } from 'node:worker_threads';",
        'parentPort?.postMessage(workerData);',
      ].join('\n'),
      'utf8',
    );
    const workerUrl = resolveHandlerWorkerUrl({
      moduleUrl: pathToFileURL(path.join(distDir, 'root-bundle.js')).href,
      bundled: false,
      executablePath,
    });
    const worker = new Worker(workerUrl, { workerData: 'root-sidecar-ready' });

    try {
      const [message] = await once(worker, 'message');
      expect(message).toBe('root-sidecar-ready');
    } finally {
      await worker.terminate();
      await fs.rm(distDir, { recursive: true, force: true });
    }
  });
});
