import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { PRODUCT_CASES, prepareProductCase } from '../benchmark/datasets/product-multiturn/fixture.js';

it.each(['tenant-cache', 'config-precedence', 'output-retention', 'skill-discovery', 'history-replay'] as const)('distinguishes the reported defect, incomplete fixes and complete repair in %s', async id => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-product-fixture-'));
  try {
    const definition = PRODUCT_CASES[id];
    const prepared = await prepareProductCase(directory, id);
    const oracle = path.join(directory, 'oracle.mjs');
    await fs.writeFile(oracle, definition.oracle);
    const run = () => spawnSync(process.execPath, ['--test', oracle], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, NATURAL_ORACLE_WORKSPACE: prepared.workspace },
    });
    expect(run().status).toBe(1);
    for (const [file, content] of Object.entries(definition.partial)) await fs.writeFile(path.join(prepared.workspace, file), content);
    expect(run().status).toBe(1);
    for (const [file, content] of Object.entries(definition.golden)) await fs.writeFile(path.join(prepared.workspace, file), content);
    const repaired = run();
    expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
    if (id === 'tenant-cache') {
      const file = path.join(prepared.workspace, 'src/client.js');
      await fs.writeFile(file, definition.golden['src/client.js']!.replace('JSON.stringify([tenant, key])', '`${tenant} ${key}`'));
      expect(run().status, 'A delimiter-based key must not satisfy arbitrary-string pair isolation').toBe(1);
      await fs.writeFile(file, definition.golden['src/client.js']!);
    }
    if (id === 'config-precedence') {
      const file = path.join(prepared.workspace, 'src/config.js');
      const golden = definition.golden['src/config.js']!;
      await fs.writeFile(file, golden.replace('result[key] = source[key]',
        "result[key] = typeof source[key] === 'number' ? Math.trunc(source[key]) : source[key]"));
      expect(run().status, 'Valid finite settings must not be silently rounded').toBe(1);
      await fs.writeFile(file, golden);
    }
    if (id === 'history-replay') {
      const file = path.join(prepared.workspace, 'src/history.js');
      const golden = definition.golden['src/history.js']!;
      for (const mutation of [
        golden.replace('JSON.stringify(parts)', "parts.join('|')"),
        golden.replace('JSON.stringify(parts)', "parts.join('\\0')"),
        golden.replace("parts.every(part => typeof part === 'string' && part.length > 0)", 'true'),
      ]) {
        await fs.writeFile(file, mutation);
        expect(run().status, 'Identity collisions and incomplete identity merging must fail acceptance').toBe(1);
      }
      await fs.writeFile(file, golden);
      const view = path.join(prepared.workspace, 'src/view.js');
      await fs.writeFile(view, definition.golden['src/view.js']!.replace(
        "['running', 'completed', 'failed', 'cancelled'].includes(record.status) ? record.status : 'unknown'",
        "({running:'running',completed:'completed',failed:'failed',cancelled:'cancelled'})[record.status] ?? 'unknown'",
      ));
      expect(run().status, 'Inherited object properties are not valid task statuses').toBe(1);
      await fs.writeFile(view, definition.golden['src/view.js']!);
    }
    if (id === 'skill-discovery') {
      const file = path.join(prepared.workspace, 'src/root.js');
      const golden = definition.golden['src/root.js']!;
      for (const mutation of [
        golden.replace("path.join(current, '.git')", "path.join(current, '.kodax')"),
        golden.replace("if (error.code !== 'ENOENT') throw error;", ''),
      ]) {
        await fs.writeFile(file, mutation);
        expect(run().status, 'Wrong root markers and swallowed I/O failures must fail acceptance').toBe(1);
      }
      await fs.writeFile(file, golden);
      const registry = path.join(prepared.workspace, 'src/registry.js');
      const content = definition.golden['src/registry.js']!;
      await fs.writeFile(registry, content.replace('  async function list(cwd) {',
        '  const cache = new Map();\n  async function list(cwd) {')
        .replace("const description = /^description: (.*)$/m.exec(content)?.[1] ?? '';",
          "const stamp = (await fs.stat(file)).mtimeMs; const previous = cache.get(file);\n      const description = previous?.stamp === stamp ? previous.description : /^description: (.*)$/m.exec(content)?.[1] ?? '';\n      cache.set(file, { stamp, description });"));
      expect(run().status, 'A timestamp-only metadata cache misses completed same-size edits').toBe(1);
      await fs.writeFile(registry, content);
    }
    const publicTests = spawnSync(process.execPath, ['--test'], { cwd: prepared.workspace, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(publicTests.status, publicTests.stdout + publicTests.stderr).toBe(0);
    expect(prepared.priorContext).toBe('');
    expect(await fs.readdir(prepared.workspace)).not.toContain('oracle.mjs');
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-product-fixture-')) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
