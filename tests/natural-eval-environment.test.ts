import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXStreamResult, KodaXToolUseBlock } from '@kodax-ai/llm';
import { runNaturalRuntime } from './shared-contract-natural-runtime.js';
import { checkUnmarkedTemporaryRoot, prepareNaturalExecutionEnvironment } from '../benchmark/harness/natural-execution-environment.js';

it('reports unreadable ancestors as an invalid environment without granting host reads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-eval-environment-'));
  try {
    const workspace = path.join(directory, 'workspace');
    const execution = await prepareNaturalExecutionEnvironment(workspace);
    const environment = execution.environment();
    const options = environment.NODE_OPTIONS;
    expect(checkUnmarkedTemporaryRoot(environment)).toEqual({ status: 'eval-invalid', reason: 'ancestor-probe-ERR_ACCESS_DENIED' });
    expect(environment.NODE_OPTIONS).toBe(options);
    expect(await fs.readdir(environment.TEMP!)).toEqual([]);
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-eval-environment-')) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('rejects a gitless-root evaluation before provider dispatch when temporary directories inherit the fixture repository', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-eval-environment-'));
  const invoke = vi.fn(async (): Promise<KodaXStreamResult> => ({
    toolBlocks: [], textBlocks: [{ type: 'text', text: 'done' }], thinkingBlocks: [], stopReason: 'end_turn',
  }));
  try {
    await expect(runNaturalRuntime(directory, 'skill-discovery', invoke))
      .rejects.toThrow('eval-invalid: temporary-root topology');
    expect(invoke).not.toHaveBeenCalled();
    const preflight = JSON.parse(await fs.readFile(path.join(directory, 'environment-preflight.json'), 'utf8')) as { status: string; reason: string };
    expect(preflight.status).toBe('eval-invalid');
    expect(preflight.reason).toContain('git-ancestor');
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-eval-environment-')) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 90000);

it('keeps node and npm test descendants inside the fixture environment without changing their commands', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-eval-environment-'));
  const workspace = path.join(directory, 'workspace');
  const outside = path.join(directory, 'private.txt');
  await fs.writeFile(outside, 'OUTSIDE_SENTINEL');
  vi.stubEnv('KODAX_EVAL_PRIVATE_SENTINEL', 'PARENT_ONLY');
  vi.stubEnv('NODE_ENV', 'production');
  const answer = (tool?: KodaXToolUseBlock): KodaXStreamResult => ({
    toolBlocks: tool ? [tool] : [], textBlocks: tool ? [] : [{ type: 'text', text: 'Both test commands completed.' }],
    thinkingBlocks: [], stopReason: tool ? 'tool_use' : 'end_turn',
  });
  const source = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('controlled execution environment', () => {
  assert.throws(() => fs.readFileSync(${JSON.stringify(outside)}), {code:'ERR_ACCESS_DENIED'});
  assert.throws(() => fs.writeFileSync(${JSON.stringify(outside)}, 'modified'), {code:'ERR_ACCESS_DENIED'});
  assert.equal(process.env.KODAX_EVAL_PRIVATE_SENTINEL, undefined);
  assert.ok(os.homedir().startsWith(${JSON.stringify(workspace)}));
  assert.ok(os.tmpdir().startsWith(${JSON.stringify(workspace)}));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'child-'));
  fs.writeFileSync(path.join(temp,'result.txt'),'ok');
  assert.equal(fs.readFileSync(path.join(temp,'result.txt'),'utf8'),'ok');
  fs.rmSync(temp,{recursive:true});
});
`;
  try {
    const receipts: string[] = [];
    const record = await runNaturalRuntime(directory, 'output-retention', async (input, _signal, index) => {
      if (index === 0) return answer({ type: 'tool_use', id: 'write-test', name: 'write', input: { path: 'tests/environment.test.js', content: source } });
      if (index >= 2) {
        const receipt = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(block => block.type === 'tool_result' && block.tool_use_id === `test-${index - 1}`);
        receipts.push(JSON.stringify(receipt));
      }
      if (index === 1 || index === 2) return answer({ type: 'tool_use', id: `test-${index}`, name: 'bash', input: { command: index === 1 ? 'node --test' : 'npm test' } });
      return answer();
    }, { limits: { calls: 4, tools: 3, timeoutMs: 60000 } });
    expect(record.error).toBeNull();
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) expect(receipt).toContain('Exit: 0');
    expect(record.counts.requests).toBe(4);
    expect(record.verification.public.status).toBe(0);
    expect(await fs.readFile(outside, 'utf8')).toBe('OUTSIDE_SENTINEL');
  } finally {
    vi.unstubAllEnvs();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-eval-environment-')) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 90000);
