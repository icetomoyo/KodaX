import { CACHE_TASK } from '../benchmark/datasets/search-entry-complex/fixture.js';
import type { KodaXStreamResult, KodaXToolUseBlock } from '../packages/llm/src/types.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

export interface RestructuredCheckpoint {
  id: 'initial' | 'known-plan-and-content' | 'stale-anchor';
  input: FrozenInput;
}

/** Zero-network scripted preparation, not a completed repair or model-quality result. */
export async function captureRestructuredCheckpoints(directory: string): Promise<{
  kind: 'offline-checkpoints-not-full-e2e';
  checkpoints: RestructuredCheckpoint[];
  counts: { responses: number; toolCount: number };
  fullTaskCompleted: false; oraclePass: boolean; paidProviderCalls: 0;
}> {
  const env = 'KODAX_RESTRUCTURED_CHECKPOINT_KEY';
  const previousKey = process.env[env];
  const previousMode = process.env.NODE_ENV;
  process.env[env] = 'offline-only';
  process.env.NODE_ENV = 'production';
  const checkpoints: RestructuredCheckpoint[] = [];
  let todoId: string | undefined;
  const tool = (id: string, name: string, input: Record<string, unknown>): KodaXToolUseBlock =>
    ({ type: 'tool_use', id, name, input });
  function receipt(input: FrozenInput, id: string) {
    const result = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === id);
    if (!result || result.type !== 'tool_result') throw new Error(`Missing actual Runtime receipt: ${id}`);
    return result;
  }
  function successfulTodoReceipt(input: FrozenInput, id: string): Record<string, unknown> {
    const result = receipt(input, id);
    const payload: unknown = JSON.parse(String(result.content));
    if (result.is_error || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || !('ok' in payload) || payload.ok !== true) throw new Error(`Todo operation did not succeed: ${id}`);
    return payload as Record<string, unknown>;
  }
  try {
    const record = await runComplexRuntime(
      { id: 'restructured-checkpoints', provider: 'offline', model: 'fixture', env }, directory,
      async (input, _signal, round) => {
        if (round > 4 || input.tools.some(item => item.name === 'report_stall_judgment')) {
          throw new Error('Unexpected provider branch in scripted checkpoint preparation');
        }
        const calls: KodaXToolUseBlock[] = [];
        if (round === 0) {
          checkpoints.push({ id: 'initial', input: structuredClone(input) });
          calls.push(tool('create-plan', 'todo_create', {
            subject: '修复并验证跨包缓存边界', activeForm: '修复并验证跨包缓存边界',
          }));
        } else if (round === 1) {
          const created = successfulTodoReceipt(input, 'create-plan');
          if (typeof created.id !== 'string') throw new Error('Runtime did not create a stable Todo id');
          todoId = created.id;
          calls.push(tool('start-plan', 'todo_update', { id: todoId, status: 'in_progress', activeForm: '修复缓存到期边界' }),
            tool('read-cache', 'read', { path: 'packages/cache/store.js' }));
        } else if (round === 2) {
          successfulTodoReceipt(input, 'start-plan');
          if (receipt(input, 'read-cache').is_error) throw new Error('Checkpoint preparation failed before the edit');
          checkpoints.push({ id: 'known-plan-and-content', input: structuredClone(input) });
          calls.push(tool('stale-edit', 'edit', { path: 'packages/cache/store.js',
            edits: [{ old_string: 'clock() > staleDeadline', new_string: 'clock() >= staleDeadline' }],
          }));
        } else if (round === 3) {
          const refused = receipt(input, 'stale-edit');
          if (refused.is_error !== true) throw new Error('Expected an actual stale-anchor error without mutation');
          checkpoints.push({ id: 'stale-anchor', input: structuredClone(input) });
          // Stop the preparation trace after capture; this cleanup is not part of
          // either model input and does not pretend the requested repair was done.
          calls.push(tool('cancel-preparation', 'todo_update', { id: todoId, status: 'cancelled',
            note: '离线检查点准备在此停止；尚未实施修复或完成任务验证。' }));
        } else {
          successfulTodoReceipt(input, 'cancel-preparation');
        }
        const text = calls.length ? '' : '离线检查点已采集；未实施修复，未完成原任务。';
        const result: KodaXStreamResult = { textBlocks: text ? [{ type: 'text', text }] : [],
          thinkingBlocks: [], toolBlocks: calls, stopReason: calls.length ? 'tool_use' : 'end_turn' };
        return { inputHash: inputHash(input), result, text, toolCalls: calls, usage: null,
          estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 5, tools: 5, timeoutMs: 30000 }, false, CACHE_TASK, [], 'agent',
    );
    if (record.error || checkpoints.length !== 3 || record.counts.responses !== 5) {
      throw new Error(`Incomplete offline checkpoint trace: ${record.error ?? 'unexpected checkpoint/request count'}`);
    }
    return { kind: 'offline-checkpoints-not-full-e2e', checkpoints, counts: record.counts,
      fullTaskCompleted: false, oraclePass: record.groundtruth.oraclePass, paidProviderCalls: 0 };
  } finally {
    if (previousKey === undefined) delete process.env[env]; else process.env[env] = previousKey;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
  }
}
