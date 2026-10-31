import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXStreamResult } from '@kodax-ai/llm';
import { runFinalHistoryRuntime, READ_ROUTE_FAILURE } from './final-contract-history-runtime.js';

it('recovers real compacted evidence and a readonly child read failure through the unchanged SDK and AMA', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-final-history-offline-'));
  vi.stubEnv('KODAX_TOOL_OUTPUT_DIR', path.join(directory, 'workspace/.agent/tmp/tool-results'));
  vi.stubGlobal('fetch', () => { throw new Error('Offline test forbids provider dispatch'); });
  const respond = (name?: string, input: Record<string, unknown> = {}, text = ''): KodaXStreamResult => ({
    toolBlocks: name ? [{ type: 'tool_use', id: `${name}-${++sequence}`, name, input }] : [],
    textBlocks: text ? [{ type: 'text', text }] : [], thinkingBlocks: [], stopReason: name ? 'tool_use' : 'end_turn',
  });
  let sequence = 0, roots = 0, children = 0;
  try {
    const record = await runFinalHistoryRuntime(directory, async (input, _signal, _index, meta) => {
      const history = JSON.stringify(input.messages);
      if (meta.kind === 'auxiliary') throw new Error('Unexpected auxiliary request in fixed offline trajectory');
      if (meta.kind === 'child') {
        if (children++ === 0) return respond('read', { path: 'README.md' });
        if (children === 2) {
          expect(history).toContain(READ_ROUTE_FAILURE);
          return respond('grep', { path: 'README.md', pattern: 'distributed', output_mode: 'content' });
        }
        expect(history).toContain('no distributed persistence');
        return respond(undefined, {}, '已通过允许的grep核对README：未实现分布式存储。read入口不可用；未修改或运行仓库代码。');
      }
      if (roots++ === 0) return respond(undefined, {}, '已记录交接内容。');
      if (roots === 2) return respond('session_history_search', { query: '发布交接记录', scope: 'all', role: 'user' });
      if (roots === 3) {
        const receipts = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(block => block.type === 'tool_result');
        const receipt = receipts.find(block => typeof block.content === 'string' && block.content.includes('"hits"'));
        if (!receipt || typeof receipt.content !== 'string') throw new Error('Missing real search receipt');
        const search = JSON.parse(receipt.content) as { hits: { entryId: string; entryRevision: string; active: boolean }[] };
        const hit = search.hits.find(item => !item.active)!;
        expect(hit.entryRevision).toMatch(/^entry:sha256:/);
        return respond('session_history_read', { entry_id: hit.entryId, revision: hit.entryRevision });
      }
      if (roots === 4) {
        expect(history).toContain('CANONICAL-ENTRY-29');
        expect(history).not.toContain('"status":"stale"');
        return respond('spawn_agent', { task_name: 'static-review', objective: '请只读核对README的部署边界，报告具体依据和未执行项。', read_only: true });
      }
      if (!history.includes('<agent-completed')) return respond('wait_agent', { timeout_ms: 1000 });
      expect(history).toContain('read入口不可用');
      return respond(undefined, {}, '兼容标签CANONICAL-ENTRY-29，跨机器持久存储仍未验证。已整合只读子审查，read入口失败后使用grep核对；没有修改或运行测试。');
    }, { model: 'offline', reasoning: 'off', signal: new AbortController().signal, calls: 16, tools: 80 });
    expect(record.error).toBeNull();
    expect(record.protectedUnchanged).toBe(true);
    expect(record.runs.map(run => run.state)).toEqual(['completed', 'completed']);
    expect(record.counts.child).toBe(3);
    expect(record.events.some(event => event.kind === 'guard' && event.readOnly && event.denied === READ_ROUTE_FAILURE)).toBe(true);
    expect(record.events.some(event => event.kind === 'guard' && event.readOnly && event.name === 'grep' && event.denied === null)).toBe(true);
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-final-history-offline-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}, 120_000);
