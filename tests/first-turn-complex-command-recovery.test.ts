import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareWindowsManagedProcess } from '../packages/agent/src/runtime/windows-managed-process.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { inputHash } from './first-turn-eval-support.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';

vi.mock('node:child_process', { spy: true });
vi.mock('../packages/agent/src/runtime/windows-managed-process.js', { spy: true });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['bash', 'tool_call'].flatMap(entry => ['diagnostic', 'readonly-write'].map(scenario => ({ entry, scenario }))))(
  'returns a denied $entry $scenario to a real readonly child without executing it, then completes AMA', async ({ entry, scenario }) => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPLEX_OFFLINE_KEY', 'offline-only');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-child-command-recovery-'));
  const actualProcesses = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const actualManaged = await vi.importActual<typeof import('../packages/agent/src/runtime/windows-managed-process.js')>(
    '../packages/agent/src/runtime/windows-managed-process.js');
  let forbiddenExecutions = 0;
  // A regression must fail before a forbidden command can reach the OS.
  const inspectLaunch = (executable: string, args: readonly string[]): void => {
    if (JSON.stringify([executable, args]).includes('MUST_NOT_EXECUTE')) {
      forbiddenExecutions++;
      throw new Error('Forbidden diagnostic reached the process boundary');
    }
  };
  // A Job gate transports its target privately; inspect that admission as well
  // as direct spawns so forbidden commands remain observable on both paths.
  vi.mocked(prepareWindowsManagedProcess).mockImplementation(input => {
    inspectLaunch(input.executable, input.args);
    return actualManaged.prepareWindowsManagedProcess(input);
  });
  vi.mocked(spawn).mockImplementation((...args) => {
    inspectLaunch(args[0], Array.isArray(args[1]) ? args[1] : []);
    return actualProcesses.spawn(...args);
  });
  const tool = (name: string, input: Record<string, unknown>, id: string) => ({ type: 'tool_use' as const, name, input, id });
  const args = { command: scenario === 'diagnostic' ? 'node --input-type=module -e "throw new Error(\'MUST_NOT_EXECUTE\')"'
    : 'echo --- > .agent/tmp/MUST_NOT_EXECUTE.txt' };
  const denial = scenario === 'diagnostic' ? 'Only local test execution is in scope.' : 'Redirection leaves the permitted fixture scope.';
  const deniedCall = entry === 'bash' ? tool(entry, args, 'denied-diagnostic')
    : tool(entry, { name: ' bash ', input: args }, 'denied-diagnostic');
  const original = structuredClone(deniedCall);
  const childReport = 'Readonly inspection and basic test completed after the refused diagnostic.';
  let rootCalls = 0;
  let childCalls = 0;
  let sawError = false;
  let sawAllowedResults = false;
  let integratedChild = false;
  try {
    const record = await runComplexRuntime({ id: 'command-recovery', provider: 'offline', model: 'offline', env: 'COMPLEX_OFFLINE_KEY' }, directory, async input => {
      const child = input.system.includes('focused sub-agent');
      const round = child ? childCalls++ : rootCalls++;
      let tools: ReturnType<typeof tool>[];
      if (child) {
        if (round === 0) tools = [deniedCall, tool('read', { path: 'README.md' }, 'allowed-sibling')];
        else if (round === 1) {
          sawError = input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
            block.type === 'tool_result' && block.tool_use_id === deniedCall.id && block.is_error === true
            && String(block.content).includes('before execution: ' + denial)));
          expect(input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
            block.type === 'tool_use' && block.id === deniedCall.id && JSON.stringify(block.input) === JSON.stringify(original.input)))).toBe(true);
          expect(input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
            block.type === 'tool_result' && block.tool_use_id === 'allowed-sibling' && !block.is_error && String(block.content).includes('Tenant cache client')))).toBe(true);
          tools = [tool('bash', { command: 'node --test tests/basic.test.js' }, 'allowed-test')];
        } else {
          sawAllowedResults = input.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
            block.type === 'tool_result' && block.tool_use_id === 'allowed-test' && !block.is_error
            && String(block.content).includes('Exit: 0') && String(block.content).includes('# pass 1')));
          tools = [];
        }
      } else if (round === 0) tools = [tool('spawn_agent', {
        task_name: 'readonly-check', objective: 'Inspect README and run the existing local test, then report.', read_only: true, fork_turns: 'none',
      }, 'spawn-readonly')];
      else {
        integratedChild = input.messages.some(message => message._taskResult?.source === 'child_task' && message._taskResult.summary === childReport);
        tools = integratedChild ? [] : [tool('wait_agent', { timeout_ms: 10000 }, 'wait-readonly-' + round)];
      }
      const text = child ? childReport : 'Integrated actual readonly child report.';
      const result: KodaXStreamResult = { textBlocks: tools.length ? [] : [{ type: 'text', text }], thinkingBlocks: [], toolBlocks: tools,
        stopReason: tools.length ? 'tool_use' : 'end_turn' };
      return { inputHash: inputHash(input), result, text, toolCalls: tools, usage: null, estimatedUsd: null, error: null,
        physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, { calls: 10, tools: 12, timeoutMs: 30000 }, true);
    expect(record.error).toBeNull();
    expect(record.phase).toBe('completed');
    expect(record.success).toBe(true);
    expect(sawError).toBe(true);
    expect(sawAllowedResults).toBe(true);
    expect(integratedChild).toBe(true);
    expect(childCalls).toBe(3);
    expect(record.counts.allowedSpawns).toBe(1);
    expect(record.counts.maxActual).toBe(1);
    expect(record.groundtruth.protectedUnchanged).toBe(true);
    expect(deniedCall).toEqual(original);
    expect(forbiddenExecutions).toBe(0);
    await expect(fs.stat(path.join(directory, 'workspace/.agent/tmp/MUST_NOT_EXECUTE.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
