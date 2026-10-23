import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { inputHash } from './first-turn-eval-support.js';
import { DEFERRED_REPO_LSP_NAMES, projectDeferredRepoLspInput } from './deferred-repo-lsp-support.js';

it.each(['all', 'repo'] as const)('keeps the %s root menu stable across discovery, SDK refusal, real module execution and AMA closure', async family => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-deferred-runtime-'));
  vi.stubEnv('KODAX_DEFERRED_RUNTIME_TEST_KEY', 'offline-only');
  const fetcher = vi.fn(() => { throw new Error('Offline Runtime must not call a model endpoint'); });
  vi.stubGlobal('fetch', fetcher);
  let menu: string[] | undefined;
  try {
    const result = await runComplexRuntime({ id: 'offline-deferred', provider: 'zhipu-coding', model: 'fixture', env: 'KODAX_DEFERRED_RUNTIME_TEST_KEY' },
      directory, async (input, _signal, round) => {
        const view = projectDeferredRepoLspInput(input, true, family);
        const names = view.tools.map(tool => tool.name);
        const hidden = family === 'all' ? DEFERRED_REPO_LSP_NAMES : DEFERRED_REPO_LSP_NAMES.filter(name => !name.startsWith('lsp_'));
        for (const name of hidden) expect(names).not.toContain(name);
        if (family === 'repo') expect(names).toContain('lsp_references');
        if (menu) expect(names).toEqual(menu); else menu = names;
        const results = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(block => block.type === 'tool_result');
        if (round === 1) expect(results.some(block => String(block.content).includes('"name":"module_context"'))).toBe(true);
        if (round === 2) expect(results.some(block => block.tool_use_id === 'refused' && block.is_error
          && String(block.content).includes('Path leaves the fixture workspace.'))).toBe(true);
        if (round === 3) expect(results.some(block => block.tool_use_id === 'recovered' && !block.is_error
          && String(block.content).includes('Module context for'))).toBe(true);
        const call = [
          { id: 'discover', name: 'tool_search', input: { query: 'select:module_context' } },
          { id: 'refused', name: 'tool_call', input: { name: 'module_context', input: { target_path: '../outside' } } },
          { id: 'recovered', name: 'tool_call', input: { name: 'module_context', input: { target_path: 'packages/cache' } } },
        ][round];
        const response: KodaXStreamResult = { textBlocks: call ? [] : [{ type: 'text', text: '已恢复路径并取得模块证据；本次只读，没有修改代码或运行修复测试。' }],
          toolBlocks: call ? [{ type: 'tool_use', ...call }] : [], thinkingBlocks: [], stopReason: call ? 'tool_use' : 'end_turn' };
        return { inputHash: inputHash(view), result: response, text: response.textBlocks.map(block => block.text).join(''), toolCalls: response.toolBlocks,
          usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 4, tools: 8, timeoutMs: 45_000 }, false, '只读取得 packages/cache 的完整模块证据；拒绝错误路径后恢复。');
    expect(result.phase, result.error ?? '').toBe('completed');
    expect(result.error).toBeNull();
    expect(result.calls).toHaveLength(4);
    expect(result.finalText).toContain('本次只读');
    expect(result.groundtruth.protectedUnchanged).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-deferred-runtime-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
