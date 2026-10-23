import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { inputHash } from './first-turn-eval-support.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([6, 20])('distinguishes child QA messages from completed repair and AMA closure under a %i-response cap', async cap => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPLEX_CLOSURE_KEY', 'offline-only');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-qa-closure-'));
  const report = 'QA: the unused counter assertion cannot verify a repeated false cache hit.';
  const childFinal = 'Inspected closure.test.js; reported the ineffective assertion. Parent owns the repair and rerun.';
  const finalText = 'Applied the QA correction, ran the real test successfully, and received child completion.';
  const oldAssertion = '  let n = 0;\n  const client = createClient({ cache: createCache({}), load: async () => false });\n  assert.equal(await client.get("t", "k"), false);\n  assert.equal(n, 0);';
  const newAssertion = '  let loads = 0;\n  const client = createClient({ cache: createCache({}), load: async () => { loads++; return false; } });\n  assert.equal(await client.get("t", "k"), false);\n  assert.equal(await client.get("t", "k"), false);\n  assert.equal(loads, 1);';
  const initialTest = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { createCache } from "../src/cache.js";\nimport { createClient } from "../src/client.js";\ntest("repeated false cache hit", async () => {\n' + oldAssertion + '\n});\n';
  const tool = (name: string, input: Record<string, unknown>, id: string) => ({ type: 'tool_use' as const, name, input, id });
  let rootCalls = 0;
  let childCalls = 0;
  let proposedRepair = false;
  let proposedTest = false;
  let sawQaRead = false;
  let receivedQa = false;
  let receivedCompletion = false;
  let sawRepairReceipt = false;
  let sawTestReceipt = false;
  try {
    const record = await runComplexRuntime({ id: 'qa-closure', provider: 'offline', model: 'offline', env: 'COMPLEX_CLOSURE_KEY' }, directory, async input => {
      const child = input.system.includes('focused sub-agent');
      const round = child ? childCalls++ : rootCalls++;
      let tools: ReturnType<typeof tool>[];
      let text = '';
      if (child) {
        if (round === 0) tools = [tool('read', { path: 'tests/closure.test.js' }, 'qa-read')];
        else if (round === 1) {
          sawQaRead = input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
            block.type === 'tool_result' && block.tool_use_id === 'qa-read' && !block.is_error
            && String(block.content).includes('assert.equal(n, 0)')));
          expect(sawQaRead).toBe(true);
          tools = [tool('send_message', { to: 'parent', content: report }, 'qa-message')];
        }
        else { tools = []; text = childFinal; }
      } else if (round === 0) tools = [tool('write', { path: 'tests/closure.test.js', content: initialTest }, 'initial-test')];
      else if (round === 1) tools = [tool('spawn_agent', { task_name: 'qa', objective: 'Read closure.test.js, report the ineffective assertion to parent, then finish.', read_only: true, fork_turns: 'none' }, 'spawn-qa')];
      else {
        receivedQa ||= input.messages.some(message => typeof message.content === 'string' && message.content.includes(report));
        receivedCompletion ||= input.messages.some(message => message._taskResult?.summary === childFinal
          || message._taskResults?.some(result => result.summary === childFinal));
        const receipts = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        sawRepairReceipt ||= receipts.some(block => block.type === 'tool_result' && block.tool_use_id === 'qa-repair' && !block.is_error);
        sawTestReceipt ||= receipts.some(block => block.type === 'tool_result' && block.tool_use_id === 'qa-test' && !block.is_error
          && String(block.content).includes('Exit: 0') && String(block.content).includes('# pass 1'));
        if (receivedQa && !proposedRepair) {
          proposedRepair = true;
          tools = [tool('edit', { path: 'tests/closure.test.js', edits: [{ old_string: oldAssertion, new_string: newAssertion }] }, 'qa-repair')];
        } else if (sawRepairReceipt && !proposedTest) {
          proposedTest = true;
          tools = [tool('bash', { command: 'node --test tests/closure.test.js' }, 'qa-test')];
        } else if (sawTestReceipt && receivedCompletion) { tools = []; text = finalText; }
        else tools = [tool('wait_agent', { timeout_ms: 10000 }, 'wait-qa-' + round)];
      }
      const result: KodaXStreamResult = { textBlocks: text ? [{ type: 'text', text }] : [], thinkingBlocks: [], toolBlocks: tools,
        stopReason: tools.length ? 'tool_use' : 'end_turn' };
      return { inputHash: inputHash(input), result, text, toolCalls: tools, usage: null, estimatedUsd: null, error: null,
        physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, { calls: cap, tools: 24, timeoutMs: 30000 }, true);
    if (cap === 6) {
      expect(record.calls).toHaveLength(cap);
      expect(record.error).toBe('budget-censored: shared root/child response cap');
      expect(record.phase).not.toBe('completed');
      expect(record.success).toBe(false);
      expect(record.finalText).not.toBe(finalText);
    } else {
      expect(record.error).toBeNull();
      expect(record.phase).toBe('completed');
      expect(record.success).toBe(true);
      expect(record.finalText).toBe(finalText);
      expect(sawQaRead).toBe(true);
      expect(receivedQa).toBe(true);
      expect(receivedCompletion).toBe(true);
      expect(sawRepairReceipt).toBe(true);
      expect(sawTestReceipt).toBe(true);
      expect(childCalls).toBe(3);
      expect(await fs.readFile(path.join(directory, 'workspace/tests/closure.test.js'), 'utf8')).toContain(newAssertion);
    }
    expect(record.groundtruth.protectedUnchanged).toBe(true);
    expect(record.counts.maxActual).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected cleanup target');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 40000);
