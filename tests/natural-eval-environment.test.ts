import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXStreamResult, KodaXToolUseBlock } from '@kodax-ai/llm';
import { runNaturalRuntime } from './shared-contract-natural-runtime.js';

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
