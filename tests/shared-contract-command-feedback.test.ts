import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXStreamResult, KodaXToolUseBlock } from '@kodax-ai/llm';
import { checkNaturalTool, runNaturalRuntime } from './shared-contract-natural-runtime.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-command-feedback-')) throw Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('identifies the rejected test command shape while preserving admission and read-only scope', () => {
  const workspace = 'C:\\fixture';
  expect(checkNaturalTool(workspace, 'bash', { command: 'npm test 2>&1' }, false)).toContain('redirection');
  expect(checkNaturalTool(workspace, 'bash', { command: 'node --test tests' }, false)).toContain('Directory');
  const commands = ['npm test', 'node --test', 'node --test tests/basic.test.js', 'node --test test/example.mjs',
    'npm test 2>&1', 'node --test tests', 'node --test --watch', 'npm test > .agent/tmp/output.txt',
    'node --test ../outside.test.js', 'npm test && git status', 'git status', 'rm tests/basic.test.js'];
  for (const command of commands) for (const readOnly of [false, true]) {
    for (const cwd of [undefined, workspace, 'C:\\outside']) for (const background of [false, true]) {
      const input = { command, cwd, run_in_background: background };
      const reason = checkNaturalTool(workspace, 'bash', input, readOnly);
      expect(reason === null).toBe(checkNaturalTool(workspace, 'bash', input, readOnly, 'legacy') === null);
      if (readOnly && reason) expect(reason).toContain("child's read-only scope");
    }
  }
  expect(checkNaturalTool(workspace, 'bash', { command: 'node --test tests/basic.test.js' }, false)).toBeNull();
  expect(checkNaturalTool(workspace, 'bash', { command: 'node --test tests/basic.test.js' }, true)).not.toBeNull();
});

it('delivers both original refusals then executes a separately proposed valid test without relaxing isolation', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw Error('No external network'); }); vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-command-feedback-')); directories.push(directory);
  const shell = (id: string, command: string): KodaXToolUseBlock => ({ type: 'tool_use', id, name: 'bash', input: { command } });
  const reply = (toolBlocks: KodaXToolUseBlock[], text = ''): KodaXStreamResult => ({
    toolBlocks, textBlocks: text ? [{ type: 'text', text }] : [], thinkingBlocks: [], stopReason: toolBlocks.length ? 'tool_use' : 'end_turn',
  });
  const record = await runNaturalRuntime(directory, 'tenant-cache', async (input, _signal, index) => {
    const receipt = (id: string) => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === id);
    if (index === 0) return reply([shell('redirect', 'npm test 2>&1'), shell('directory', 'node --test tests')]);
    if (index === 1) {
      expect(receipt('redirect')).toMatchObject({ is_error: true, content: expect.stringContaining('redirection') });
      expect(receipt('directory')).toMatchObject({ is_error: true, content: expect.stringContaining('Directory') });
      return reply([shell('permitted-test', 'node --test tests/basic.test.js')]);
    }
    expect(index).toBe(2);
    expect(receipt('permitted-test')).toMatchObject({ is_error: false, content: expect.stringContaining('# pass 1') });
    return reply([], 'One public test ran and passed; no code was changed.');
  }, { limits: { calls: 3, tools: 3, timeoutMs: 45000 } });
  expect(record.error).toBeNull(); expect(record.counts.requests).toBe(3);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied)).toHaveLength(2);
  expect(record.protectedUnchanged).toBe(true); expect(fetcher).not.toHaveBeenCalled();
}, 60000);
