import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureTaskChanges, evaluateConfigTask } from './task-workspace.js';
import { createTaskFixtures } from './task-fixtures.js';

it('preserves additions, deletions and unrequested test edits for the paired review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-diff-test-'));
  const original = path.join(root, 'original'); const final = path.join(root, 'final');
  try {
    await mkdir(original); await mkdir(final);
    await writeFile(path.join(original, 'config.mjs'), 'bug');
    await writeFile(path.join(original, 'config.test.mjs'), 'original checks');
    await writeFile(path.join(original, 'package.json'), 'original package');
    await writeFile(path.join(final, 'config.mjs'), 'fix');
    await writeFile(path.join(final, 'config.test.mjs'), 'weakened checks');
    await writeFile(path.join(final, 'unrequested.txt'), 'unexpected');
    const result = await captureTaskChanges(original, final);
    expect(result.changes).toEqual([
      { path: 'config.mjs', before: 'bug', after: 'fix' },
      { path: 'config.test.mjs', before: 'original checks', after: 'weakened checks' },
      { path: 'package.json', before: 'original package', after: null },
      { path: 'unrequested.txt', before: null, after: 'unexpected' },
    ]);
    expect(result.finalFiles.map(file => file.path)).toEqual(['config.mjs', 'config.test.mjs', 'unrequested.txt']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('verifies with the original tests and preserves an authored test edit for review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-pristine-tests-'));
  const original = path.join(root, 'original'); const final = path.join(root, 'final');
  try {
    await mkdir(original); await mkdir(final);
    const { D } = await createTaskFixtures(Buffer.from([2, 0, 1, 3]));
    for (const [file, bytes] of Object.entries(D.files)) {
      await writeFile(path.join(original, file), bytes); await writeFile(path.join(final, file), bytes);
    }
    const weakened = "import { test } from 'node:test'; test('no checks', () => {});\n";
    await writeFile(path.join(final, 'config.test.mjs'), weakened);
    const broken = await evaluateConfigTask(original, final);
    expect(broken.codeValidation.passed).toBe(false);
    expect(broken.workspaceEvidence.changes.some(change => change.path === 'config.test.mjs')).toBe(true);
    expect(await readFile(path.join(final, 'config.test.mjs'), 'utf8')).toBe(weakened);
    await writeFile(path.join(final, 'config.mjs'), D.files['config.mjs']!.toString().replace('JSON.parse(text)', "JSON.parse(text.trim() || '{}')"));
    const repaired = await evaluateConfigTask(original, final);
    expect(repaired.codeValidation.passed).toBe(true);
    expect(await readFile(path.join(final, 'config.test.mjs'), 'utf8')).toBe(weakened);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps deleted source/test files as a reviewable bad patch rather than losing the outcome', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-deleted-patch-test-'));
  const original = path.join(root, 'original'); const final = path.join(root, 'final');
  try {
    await mkdir(original); await mkdir(final);
    await writeFile(path.join(original, 'config.mjs'), 'bug');
    await writeFile(path.join(original, 'config.test.mjs'), 'original checks');
    const result = await evaluateConfigTask(original, final);
    expect(result.codeValidation.passed).toBe(false);
    expect(result.workspaceEvidence.changes).toHaveLength(2);
    expect(result.workspaceEvidence.finalFiles).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('retains invalid source bytes losslessly without treating them as an executable patch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-binary-patch-test-'));
  const original = path.join(root, 'original'); const final = path.join(root, 'final');
  try {
    await mkdir(original); await mkdir(final);
    await writeFile(path.join(original, 'config.mjs'), 'original source');
    await writeFile(path.join(original, 'config.test.mjs'), 'original tests');
    await writeFile(path.join(final, 'config.mjs'), Buffer.from([255, 0]));
    await writeFile(path.join(final, 'config.test.mjs'), 'original tests');
    const result = await evaluateConfigTask(original, final);
    expect(result.codeValidation.passed).toBe(false);
    const source = result.workspaceEvidence.finalFiles.find(file => file.path === 'config.mjs')!;
    expect(source.encoding).toBe('base64');
    expect(Buffer.from(source.content, 'base64')).toEqual(Buffer.from([255, 0]));
    expect(result.workspaceEvidence.changes[0]!.after).toBe('[base64] /wA=');
  } finally { await rm(root, { recursive: true, force: true }); }
});
