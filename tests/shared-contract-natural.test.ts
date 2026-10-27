import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NATURAL_CASES } from '../benchmark/datasets/shared-contract-natural/cases.js';
import { prepareNaturalCase, RECOVERY_GOLDEN } from '../benchmark/datasets/shared-contract-natural/fixture.js';
import { RECOVERY_ORACLE } from '../benchmark/datasets/shared-contract-natural/oracle.js';

const roots: string[] = [];
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-natural-fixture-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-natural-fixture-')) {
      throw new Error('Refusing unbounded fixture cleanup');
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

function runNode(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

describe('log-inspired natural task fixtures (offline only)', () => {
  it('provides four natural requests without private paths, gold answers, or tool choreography', () => {
    expect(NATURAL_CASES.map(item => item.id)).toEqual(['review', 'incremental-review', 'symptom-repair', 'verification-followup']);
    expect(NATURAL_CASES.every(item => item.provenance === 'log-inspired-isolated-recreation')).toBe(true);
    const prompts = NATURAL_CASES.map(item => item.prompt).join('\n');
    for (const hidden of ['startedAt', 'src/recovery.js', 'RECOVERY_GOLDEN', 'spawn_agent', 'todo_create', '.codex', '.kodax']) {
      expect(prompts).not.toContain(hidden);
    }
    expect(NATURAL_CASES.find(item => item.id === 'incremental-review')?.requiresPriorContext).toBe(true);
    expect(NATURAL_CASES.find(item => item.id === 'verification-followup')?.requiresPriorContext).toBe(true);
  });

  it('keeps public tests passing but independently kills the original defect and verifies the gold repair', async () => {
    const directory = await root();
    const prepared = await prepareNaturalCase(directory, 'symptom-repair');
    const oracle = path.join(directory, 'oracle.mjs');
    await fs.writeFile(oracle, RECOVERY_ORACLE);
    expect(runNode(prepared.workspace, ['--test']).status).toBe(0);
    const broken = runNode(directory, ['--test', oracle], { NATURAL_ORACLE_WORKSPACE: prepared.workspace });
    expect(broken.status).toBe(1);
    expect(broken.stdout).toMatch(/not ok \d+ - verified exit permits restart without rewriting unknown history/);
    expect(broken.stdout).toMatch(/ok \d+ - running, uncertain and unrelated processes remain blocked/);
    await fs.writeFile(path.join(prepared.workspace, 'src/recovery.js'), RECOVERY_GOLDEN);
    const fixed = runNode(directory, ['--test', oracle], { NATURAL_ORACLE_WORKSPACE: prepared.workspace });
    expect(fixed.status).toBe(0);
    expect(fixed.stdout).toContain('# pass 5');
    const files = await fs.readdir(prepared.workspace, { recursive: true });
    expect(files.some(file => /oracle|golden|references\.json/.test(file))).toBe(false);
  });

  it('makes the incremental fix reproduce a real new identity bug, with earlier receipts predating the delta', async () => {
    const directory = await root();
    const prepared = await prepareNaturalCase(directory, 'incremental-review');
    expect(prepared.priorContext).toContain('fixture 执行');
    expect(JSON.parse(prepared.receipts[1]?.stdout ?? '{}')).toMatchObject({ readyToStart: false });
    expect(prepared.priorContext).toContain('# pass 2');
    expect(prepared.receipts.length).toBe(2);
    expect(prepared.receipts.every(receipt => receipt.exitCode === 0 && receipt.revision === prepared.reviewedRevision)).toBe(true);
    expect(prepared.reviewedRevision).not.toBe(prepared.head);
    expect(prepared.delta).toContain('cleanup.state');
    expect(prepared.status).toBe('');
    const oracle = path.join(directory, 'oracle.mjs');
    await fs.writeFile(oracle, RECOVERY_ORACLE);
    const result = runNode(directory, ['--test', oracle], { NATURAL_ORACLE_WORKSPACE: prepared.workspace });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/ok \d+ - verified exit permits restart without rewriting unknown history/);
    expect(result.stdout).toMatch(/not ok \d+ - running, uncertain and unrelated processes remain blocked/);
  });

  it('supplies verification follow-up with current actual test output, hashes and explicit verification limits', async () => {
    const prepared = await prepareNaturalCase(await root(), 'verification-followup');
    expect(prepared.receipts.length).toBe(2);
    expect(prepared.receipts.every(receipt => receipt.revision === prepared.head && receipt.exitCode === 0)).toBe(true);
    expect(prepared.priorContext).toContain('# pass 2');
    expect(JSON.parse(prepared.receipts[1]?.stdout ?? '{}')).toMatchObject({ readyToStart: true });
    expect(prepared.priorContext).toContain('没有实测操作系统进程');
    expect(prepared.priorContext).not.toContain('# pass 5');
    expect(prepared.receipts[0]?.files['src/recovery.js']).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.status).toBe('');
  });

  it('reconstructs identical Git state and reviews both the commit delta and a benign working tree change', async () => {
    const first = await prepareNaturalCase(await root(), 'review');
    const second = await prepareNaturalCase(await root(), 'review');
    expect(first.base).toBe(second.base);
    expect(first.head).toBe(second.head);
    expect(first.delta).toBe(second.delta);
    expect(first.status).toContain('M README.md');
    expect(first.delta).toContain('cleanup.state');
    expect(first.priorContext).toBe('');
    expect(first.receipts).toHaveLength(0);
  });
});
