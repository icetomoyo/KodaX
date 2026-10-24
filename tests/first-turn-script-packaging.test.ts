import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

// Isolated source-build fixture; tests/script-release.test.mjs additionally checks the actual npm tarball.
it('runs minified Script bundles outside the checkout without node_modules and fails clearly if its sidecar is missing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-package-'));
  const source = fileURLToPath(new URL('../packages/coding/src/agent-runtime/script/', import.meta.url));
  const workerPath = path.join(directory, 'script-worker.cjs');
  const outputs = ['script-cell.mjs', 'chunks/script-cell.mjs'];
  try {
    await mkdir(path.join(directory, 'chunks'));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module","private":true}');
    for (const output of outputs) await build({ entryPoints: [path.join(source, 'cell.ts')], outfile: path.join(directory, output),
      bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: true, keepNames: true });
    const workerBuild = await build({ entryPoints: [path.join(source, 'worker.ts')], outfile: workerPath,
      bundle: true, platform: 'node', format: 'cjs', target: 'node20', minify: true, keepNames: true, metafile: true });
    const run = async (output: string) => {
      const code = `import {runScriptCell} from ${JSON.stringify(pathToFileURL(path.join(directory, output)).href)};
        const result=await runScriptCell({code:'const r=await tools.read({}); return Number(r.content)+1;',toolNames:['read'],
          limits:{timeoutMs:5000,memoryBytes:16777216,maxCalls:4,maxTransferBytes:131072},invoke:async()=>({content:'41'})});
        process.stdout.write(JSON.stringify(result));`;
      const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', code], {
        cwd: directory, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, windowsHide: true, timeout: 15_000,
      });
      return JSON.parse(stdout) as { status: string; value?: number; error?: string; receipts: unknown[] };
    };
    for (const output of outputs) {
      const result = await run(output);
      expect(result.status, result.error).toBe('completed');
      expect(result.value).toBe(42);
      expect(result.receipts).toHaveLength(1);
    }
    expect(Object.keys(workerBuild.metafile!.inputs).some(name => name.includes('quickjs-singlefile'))).toBe(true);
    expect(await readFile(workerPath, 'utf8')).not.toContain(source);
    const size = await stat(workerPath);
    process.stdout.write(`Script sidecar bytes: ${size.size}\n`);
    // Explicit build-tool opt-in: ordinary offline tests never download a compiler.
    const bun = process.env.KODAX_SCRIPT_TEST_BUN;
    if (bun) {
      const executable = path.join(directory, process.platform === 'win32' ? 'script-probe.exe' : 'script-probe');
      const entry = path.join(directory, 'binary-entry.mjs');
      await writeFile(entry, `import {runScriptCell} from './script-cell.mjs';
        const timeout = process.argv.includes('--timeout');
        const result = await runScriptCell({code: timeout ? 'while(true){}' : 'const r=await tools.read({});return [Number(r.content)+1,typeof process,typeof fetch];',
          toolNames:['read'],limits:{timeoutMs:timeout?1000:5000,memoryBytes:16777216,maxCalls:4,maxTransferBytes:131072},invoke:async()=>({content:'41'})});
        process.stdout.write(JSON.stringify(result));`);
      await exec(bun, ['build', entry, '--compile', '--minify', '--define', "process.env.KODAX_BUNDLED='true'", '--outfile', executable],
        { cwd: directory, windowsHide: true, timeout: 60_000 });
      const binaryEnv = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', PATH: process.env.SystemRoot ?? '/usr/bin' };
      const binary = await exec(executable, [], { cwd: directory, env: binaryEnv, windowsHide: true, timeout: 15_000 });
      const result = JSON.parse(binary.stdout) as { status: string; value?: unknown; error?: string };
      expect(result.status, result.error).toBe('completed');
      expect(result.value).toEqual([42, 'undefined', 'undefined']);
      const timed = await exec(executable, ['--timeout'], { cwd: directory, env: binaryEnv, windowsHide: true, timeout: 15_000 });
      const stopped = JSON.parse(timed.stdout) as { status: string; error?: string };
      expect(['failed', 'timed_out']).toContain(stopped.status);
      if (stopped.status === 'failed') expect(stopped.error).toMatch(/interrupted|deadline|timed out/i);
      process.stdout.write('Node-free compiled Script probe: completed; CPU loop bounded\n');
    }
    await rename(workerPath, `${workerPath}.absent`);
    const missing = await run(outputs[0]!);
    expect(missing.status).toBe('failed');
    expect(missing.error).toContain('script-worker.cjs');
    expect(missing.receipts).toEqual([]);
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-script-package-')) throw new Error('Unsafe package cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 90_000);
