import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { inputHash } from './first-turn-eval-support.js';

it('sends one current repository overview and change scope in the first managed Runtime request', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-first-repo-context-'));
  vi.stubEnv('KODAX_FIRST_REPO_CONTEXT_KEY', 'offline-only');
  const fetcher = vi.fn(() => { throw new Error('Repository context regression must stay offline'); });
  vi.stubGlobal('fetch', fetcher);
  let context: string | undefined;
  try {
    const result = await runComplexRuntime({ id: 'repo-context', provider: 'zhipu-coding', model: 'fixture', env: 'KODAX_FIRST_REPO_CONTEXT_KEY' },
      directory, async input => {
        const carriers = input.messages.filter(message => message._source === 'managed-run-context');
        expect(carriers).toHaveLength(1);
        context = String(carriers[0]!.content);
        const response: KodaXStreamResult = { textBlocks: [{ type: 'text', text: '只读检查结束；未修改文件，未执行修复测试。' }],
          thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
        return { inputHash: inputHash(input), result: response, text: response.textBlocks[0]!.text, toolCalls: [],
          usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 1, tools: 0, timeoutMs: 45_000 }, false, '检查 packages/cache 的当前模块、影响范围及仓库状态；只读回答。');
    expect(result.phase, result.error ?? '').toBe('completed');
    expect(result.error).toBeNull();
    expect(context).toBeDefined();
    expect(context!.match(/^## Repository Intelligence$/gm)).toHaveLength(1);
    expect(context!.match(/^## Repository Change Scope$/gm)).toHaveLength(1);
    expect(context).toContain('## Active Module Intelligence');
    expect(context).toContain('## Active Impact Intelligence');
    expect(context).toContain('packages/cache');
    expect(result.groundtruth.protectedUnchanged).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-first-repo-context-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
