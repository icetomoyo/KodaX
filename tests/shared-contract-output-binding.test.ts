import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const preload = pathToFileURL(path.resolve('benchmark/harness/isolated-output-binding.mjs')).href;
const root = path.join(os.tmpdir(), 'kodax-output-binding-offline');

it('binds concurrent cell processes separately without changing their parent environment', async () => {
  const parent = process.env.KODAX_TOOL_OUTPUT_DIR;
  const replies = await Promise.all(['cell-01', 'cell-02'].map(async cell => {
    const { stdout } = await execute(process.execPath, ['--import', preload, '-e',
      'process.stdout.write(JSON.stringify({output:process.env.KODAX_TOOL_OUTPUT_DIR,marker:process.env.EVAL_TEST_MARKER}))'], {
      windowsHide: true, timeout: 15000,
      env: { ...process.env, KODAX_ORIGINAL_SMOKE_ROOT: root, KODAX_ORIGINAL_SMOKE_CELL: cell,
        KODAX_TOOL_OUTPUT_DIR: path.join(os.tmpdir(), 'unrelated-host-output'), EVAL_TEST_MARKER: 'preserved' },
    });
    return JSON.parse(stdout) as { output: string; marker: string };
  }));
  expect(replies).toEqual(['cell-01', 'cell-02'].map(cell => ({
    output: path.join(root, cell, 'workspace', '.agent', 'tmp', 'tool-results'), marker: 'preserved',
  })));
  expect(process.env.KODAX_TOOL_OUTPUT_DIR).toBe(parent);
});

it.each([
  [os.tmpdir(), 'cell-01'], [path.resolve(os.tmpdir(), '..'), 'cell-01'],
  ['relative-root', 'cell-01'], [root, '../outside'],
])('rejects invalid cell binding before starting the evaluator (%s, %s)', async (directory, cell) => {
  await expect(execute(process.execPath, ['--import', preload, '-e', 'process.stdout.write("EVALUATOR_STARTED")'], {
    windowsHide: true, timeout: 15000,
    env: { ...process.env, KODAX_ORIGINAL_SMOKE_ROOT: directory, KODAX_ORIGINAL_SMOKE_CELL: cell },
  })).rejects.toMatchObject({ stdout: '', stderr: expect.stringMatching(/opaque cell id|child of OS temporary storage/) });
});
