import { afterEach, expect, it, vi } from 'vitest';
import { budgetedEditCall } from './first-turn-edit-v2.eval.js';
import { EditRevisionBudget, type EditRoute } from './first-turn-edit-eval-support.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const route: EditRoute = { id: 'zai/glm53flash', provider: 'zai-coding', model: 'glm-5.3-flash', env: 'ZAI_CODING_API_KEY', rate: { inputPer1M: 0.15, outputPer1M: 0.5 }, reasoning: { enabled: false, effort: 'none' }, billing: 'coding-plan-reference-only' };

it('saves reservations before one physical SDK request, then saves actual usage and raw tool calls', async () => {
  vi.stubEnv(route.env, 'local-edit-fixture-key');
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(JSON.parse(await request.text()) as Record<string, unknown>);
    const rows = [
      { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: route.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'edit-fixture', name: 'edit', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"sum.js","edits":[]}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }));
  const budget = new EditRevisionBudget(); const saved: unknown[] = [];
  const evidence = await budgetedEditCall(route, { system: 'production channel fixture', messages: [{ role: 'user', content: 'edit' }], tools: [] }, budget, async () => { saved.push(structuredClone(budget.state)); });
  expect(requests).toHaveLength(1); expect(requests[0]?.max_tokens).toBe(2048);
  expect(saved).toEqual([expect.objectContaining({ calls: 1, chargedTokens: 0, reservedTokens: expect.any(Number) }), expect.objectContaining({ calls: 1, chargedTokens: 101, reservedTokens: 0 })]);
  expect(evidence.physicalAttempts).toBe(1); expect(evidence.error).toBeNull();
  expect(evidence.toolCalls).toEqual([{ name: 'edit', input: { path: 'sum.js', edits: [] } }]);
});

it('retains a failed single attempt, redacts credentials and charges unknown usage without retry', async () => {
  vi.stubEnv(route.env, 'local-edit-secret');
  const fetch = vi.fn(async () => { throw new Error('network failed local-edit-secret'); }); vi.stubGlobal('fetch', fetch);
  const budget = new EditRevisionBudget();
  const evidence = await budgetedEditCall(route, { system: 'fixture', messages: [{ role: 'user', content: 'edit' }], tools: [] }, budget, async () => undefined);
  expect(fetch).toHaveBeenCalledTimes(1); expect(evidence.error).toBeTruthy();
  expect(evidence.error).not.toContain('local-edit-secret');
  expect(budget.state.calls).toBe(1); expect(budget.state.unknownUsageCalls).toBe(1);
  expect(budget.state.chargedTokens).toBeGreaterThan(4096); expect(budget.state.reservedTokens).toBe(0);
});

it('does not dispatch after another lane stops while its reservation is being persisted', async () => {
  vi.stubEnv(route.env, 'local-edit-fixture-key');
  const fetch = vi.fn(async () => { throw new Error('Unexpected dispatch after lane stop'); }); vi.stubGlobal('fetch', fetch);
  let reserved!: () => void; const reservationSaved = new Promise<void>(resolve => { reserved = resolve; });
  let resumePersistence!: () => void; const pendingSave = new Promise<void>(resolve => { resumePersistence = resolve; });
  let stopped = false; let saveCount = 0;
  const budget = new EditRevisionBudget();
  const request = budgetedEditCall(route, { system: 'fixture', messages: [{ role: 'user', content: 'edit' }], tools: [] }, budget,
    async () => { if (saveCount++ === 0) { reserved(); await pendingSave; } }, undefined, undefined,
    () => { if (stopped) throw new Error('Other lane stopped before dispatch'); });
  await reservationSaved; stopped = true; resumePersistence();
  const evidence = await request;
  expect(fetch).not.toHaveBeenCalled(); expect(evidence.physicalAttempts).toBe(0);
  expect(evidence.error).toContain('Other lane stopped before dispatch');
  expect(budget.state.reservedTokens).toBe(0);
});
