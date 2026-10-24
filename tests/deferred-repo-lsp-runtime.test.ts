import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { inputHash } from './first-turn-eval-support.js';
import { DEFERRED_REPO_LSP_NAMES, projectDeferredRepoLspInput } from './deferred-repo-lsp-support.js';

it('uses the production local-search menu through direct lookup, refusal recovery and AMA closure without discovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-local-search-runtime-'));
  vi.stubEnv('KODAX_LOCAL_SEARCH_RUNTIME_TEST_KEY', 'offline-only');
  const fetcher = vi.fn(() => { throw new Error('Offline Runtime must not call a model endpoint'); });
  vi.stubGlobal('fetch', fetcher);
  const observedMenus: string[][] = [];
  try {
    const result = await runComplexRuntime({ id: 'offline-local-search', provider: 'zhipu-coding', model: 'fixture', env: 'KODAX_LOCAL_SEARCH_RUNTIME_TEST_KEY' },
      directory, async (input, _signal, round) => {
        const names = input.tools.map(tool => tool.name);
        observedMenus.push(names);
        expect(names).not.toContain('code_search');
        expect(names).toEqual(expect.arrayContaining(['grep', 'glob', 'read', 'spawn_agent', 'todo_create']));
        const receipts = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(block => block.type === 'tool_result');
        if (round === 1) {
          expect(receipts.find(block => block.tool_use_id === 'content')?.content).toContain('packages/cache/store.js');
          expect(receipts.find(block => block.tool_use_id === 'paths')?.content).toMatch(/src[\\/]cache\.js/);
        }
        if (round === 2) expect(receipts.some(block => block.tool_use_id === 'refused' && block.is_error
          && String(block.content).includes('Path leaves the fixture workspace.'))).toBe(true);
        if (round === 3) expect(receipts.some(block => block.tool_use_id === 'recovered' && !block.is_error
          && String(block.content).includes('createCache'))).toBe(true);
        const calls = [
          [{ id: 'content', name: 'grep', input: { pattern: 'createCache', literal: true, path: 'src' } },
            { id: 'paths', name: 'glob', input: { pattern: 'src/*cache*' } }],
          [{ id: 'refused', name: 'read', input: { path: '../outside' } }],
          [{ id: 'recovered', name: 'read', input: { path: 'packages/cache/store.js' } }],
        ][round];
        const response: KodaXStreamResult = {
          textBlocks: calls ? [] : [{ type: 'text', text: '已定位 src/cache.js 的公开导出及 packages/cache/store.js 的实现；只读检查，未修改或运行修复测试。' }],
          toolBlocks: calls?.map(call => ({ type: 'tool_use' as const, ...call })) ?? [],
          thinkingBlocks: [], stopReason: calls ? 'tool_use' : 'end_turn',
        };
        return { inputHash: inputHash(input), result: response, text: response.textBlocks.map(block => block.text).join(''),
          toolCalls: response.toolBlocks, usage: null, estimatedUsd: null, error: null,
          physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 4, tools: 12, timeoutMs: 45_000 }, false, '只读定位公开缓存入口和实际实现，报告证据。');
    expect(result.phase, JSON.stringify({ error: result.error, finalText: result.finalText, observedMenus, events: result.events.slice(-4) })).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.calls).toHaveLength(4);
    expect(result.groundtruth.protectedUnchanged).toBe(true);
    expect(result.finalText).toContain('未修改');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-local-search-runtime-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);

it.each(['all', 'repo', 'manual', 'manual-tail'] as const)('keeps the %s root menu stable across discovery, SDK refusal, real evidence execution and AMA closure', async variant => {
  const family = variant === 'manual-tail' ? 'manual' : variant;
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
        expect(view.system).toBe(input.system);
        expect(view.messages).toBe(input.messages);
        if (family === 'manual') {
          for (const capability of ['spawn_agent', 'todo_create', 'wait_agent', 'agent_output']) {
            expect(names).toContain(capability);
            expect(view.system + JSON.stringify(view.messages)).toContain(capability);
          }
        }
        const hidden = family === 'manual' ? ['kodax_manual'] : family === 'all' ? DEFERRED_REPO_LSP_NAMES : DEFERRED_REPO_LSP_NAMES.filter(name => !name.startsWith('lsp_'));
        for (const name of hidden) expect(names).not.toContain(name);
        if (family === 'repo') expect(names).toContain('lsp_references');
        if (menu) expect(names).toEqual(menu); else menu = names;
        const results = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(block => block.type === 'tool_result');
        if (round === 1) expect(results.some(block => String(block.content).includes(family === 'manual' ? '"name":"kodax_manual"' : '"name":"module_context"'))).toBe(true);
        if (round === 2) expect(results.some(block => block.tool_use_id === 'refused' && block.is_error
          && String(block.content).includes(variant === 'manual-tail' ? 'tail output filtering is outside this fixture scope.' : 'Path leaves the fixture workspace.'))).toBe(true);
        if (round === 3) expect(results.some(block => block.tool_use_id === 'recovered' && !block.is_error
          && String(block.content).includes(family === 'manual' ? '~/.kodax/extensions' : 'Module context for'))).toBe(true);
        const call = (family === 'manual' ? [
          { id: 'discover', name: 'tool_search', input: { query: 'select:kodax_manual' } },
          variant === 'manual-tail' ? { id: 'refused', name: 'bash', input: { command: 'npm test | tail -n 12' } }
            : { id: 'refused', name: 'read', input: { path: '../outside' } },
          { id: 'recovered', name: 'tool_call', input: { name: 'kodax_manual', input: { topic: 'extensions' } } },
        ] : [
          { id: 'discover', name: 'tool_search', input: { query: 'select:module_context' } },
          { id: 'refused', name: 'tool_call', input: { name: 'module_context', input: { target_path: '../outside' } } },
          { id: 'recovered', name: 'tool_call', input: { name: 'module_context', input: { target_path: 'packages/cache' } } },
        ])[round];
        const response: KodaXStreamResult = { textBlocks: call ? [] : [{ type: 'text', text: '已取得实际证据；本次只读，没有修改代码或运行修复测试。' }],
          toolBlocks: call ? [{ type: 'tool_use', ...call }] : [], thinkingBlocks: [], stopReason: call ? 'tool_use' : 'end_turn' };
        return { inputHash: inputHash(view), result: response, text: response.textBlocks.map(block => block.text).join(''), toolCalls: response.toolBlocks,
          usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 4, tools: 8, timeoutMs: 45_000 }, false, family === 'manual' ? '只读查询当前 KodaX 扩展手册，文件路径不可用时使用内置知识。' : '只读取得 packages/cache 的完整模块证据；拒绝错误路径后恢复。');
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
