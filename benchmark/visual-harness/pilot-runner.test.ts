import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { freezeKimiPilot, freezeKimiCodePilot, runVisualPilot } from './pilot-runner.js';

async function fixture(reply: (body: Record<string, unknown>, index: number, response: ServerResponse) => object | undefined, coding = false,
  quota = (_read: number): object => ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: '0' } } })) {
  const calls: Record<string, unknown>[] = [];
  let quotaReads = 0;
  const server: Server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      quotaReads++; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(quota(quotaReads))); return;
    }
    let body = ''; for await (const chunk of req) body += String(chunk);
    calls.push(JSON.parse(body) as Record<string, unknown>);
    res.setHeader('content-type', 'application/json');
    const response = reply(calls.at(-1)!, calls.length, res);
    if (response !== undefined) res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-pilot-test-'));
  const capture = { model: 'fixture-model', messages: [
    { role: 'system', content: 'Provider: wire-openai\nModel: fixture-model\nProduction instructions.' },
    { role: 'user', content: 'previous task' }],
    tools: [{ type: 'function', function: { name: 'visual_inspect', description: 'Unabridged production description.', parameters: { type: 'object' } } }], stream: true };
  const baselineFile = path.join(root, 'baseline.json'); const candidateFile = path.join(root, 'candidate.json');
  await writeFile(baselineFile, JSON.stringify(capture)); await writeFile(candidateFile, JSON.stringify(capture));
  const directory = await (coding ? freezeKimiCodePilot : freezeKimiPilot)({ baselineFile, candidateFile, candidateRevision: '3'.repeat(40),
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, authorization: 'User approved four calls under the frozen caps.' });
  return { calls, directory, quotaReads: () => quotaReads, async close() {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await rm(root, { recursive: true, force: true });
    expect(path.dirname(directory)).toBe(path.join(os.tmpdir(), 'kodax-eval-dumps', 'visual-harness'));
    await rm(directory, { recursive: true, force: true });
  } };
}
const answer = { model: 'kimi-k2.6', choices: [{ message: { content: '42', tool_calls: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 2, total_tokens: 1002, prompt_tokens_details: { cached_tokens: 200 } } };

it('rejects repository destinations before reading or writing an experiment', async () => {
  await expect(runVisualPilot({ directory: process.cwd(), apiKey: 'local-fixture-only' })).rejects.toThrow('OS Temp outside the worktree');
});

it.each([
  ['visible spend reaches limit', (read: number) => ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: read === 1 ? '0' : '100' } } }), 1, 'Token/spend stop limit', 1],
  ['exact integer cents reach limit', (read: number) => ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: read === 1 ? '101' : '201' } } }), 1, 'Token/spend stop limit', 1],
  ['missing expense meter', () => ({}), 0, 'Missing subscription expense', null],
  ['expense meter resets', (read: number) => ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: read === 1 ? '200' : '100' } } }), 1, 'counter reset', null],
  ['expense decreases above initial baseline', (read: number) => ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: ['1000', '1050', '1020'][read - 1] } } }), 2, 'counter reset', null],
  ['expense is missing after an earlier success', (read: number) => read === 3 ? {} : ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: read === 1 ? '1000' : '1050' } } }), 2, 'Missing subscription expense', null],
  ['expense is an empty string', () => ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: '' } } }), 0, 'Missing subscription expense', null],
  ['expense is null', () => ({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: null } } }), 0, 'Missing subscription expense', null],
] as const)('stops subscription execution when %s', async (_name, quota, calls, reason, observed) => {
  const f = await fixture(() => ({ ...answer, model: 'kimi-for-coding' }), true, quota);
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(f.calls).toHaveLength(calls); expect(result.status).toBe('stopped'); expect(result.stopReason).toContain(reason);
    expect(result.observedExtraUsageCny).toBe(observed); expect(result.costCny).toBeNull();
  } finally { await f.close(); }
});

it('uses the authorized Kimi Code route, measures tokens and records wallet snapshots without pretending subscription fees are token prices', async () => {
  const f = await fixture(() => ({ ...answer, model: 'kimi-for-coding', usage: { ...answer.usage,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } } }), true);
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(f.calls).toHaveLength(4); expect(f.quotaReads()).toBe(5);
    expect(result).toMatchObject({ status: 'completed', providerCalls: 4, totalTokens: 4008,
      costCny: null, actualInvoiceUsd: null, observedExtraUsageCny: 0, metadataHttpRequests: 5 });
    expect(f.calls.every(call => call.model === 'kimi-for-coding' && call.max_tokens === 512)).toBe(true);
    expect((f.calls[0]!.messages as { content: string }[])[0]!.content).toContain('Provider: kimi-code\nModel: kimi-for-coding');
    expect(JSON.parse(await readFile(path.join(f.directory, 'plan.json'), 'utf8'))).toMatchObject({ revision: 3, provider: 'kimi-code' });
  } finally { await f.close(); }
});

it('sends exactly the four frozen bodies, accounts actual usage and preserves raw before paired blind review', async () => {
  const f = await fixture(() => answer);
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(f.calls).toHaveLength(4); expect(result).toMatchObject({ status: 'completed', providerCalls: 4, totalTokens: 4008 });
    expect(result.costCny).toBeCloseTo(0.021896, 8);
    const plan = JSON.parse(await readFile(path.join(f.directory, 'plan.json'), 'utf8')) as { revision: number; cells: { caseId: string; arm: string }[] };
    expect(plan.revision).toBe(2);
    expect((f.calls[0]!.messages as { content: string }[])[0]!.content).toBe('Provider: kimi\nModel: kimi-k2.6\nProduction instructions.');
    for (const [index, cell] of plan.cells.entries()) {
      const frozen = await readFile(path.join(f.directory, `${cell.caseId}-${cell.arm}.json`), 'utf8');
      expect(f.calls[index]).toEqual(JSON.parse(frozen));
      expect(f.calls[index]).toMatchObject({ model: 'kimi-k2.6', max_tokens: 512, stream: false, thinking: { type: 'disabled' } });
      expect(f.calls[index]).not.toHaveProperty('max_completion_tokens');
      expect(JSON.parse(await readFile(path.join(f.directory, `${cell.caseId}-${cell.arm}.response.txt`), 'utf8'))).toEqual(answer);
    }
    const blind = await readFile(path.join(f.directory, 'blinded.json'), 'utf8');
    expect(blind).toContain('42'); expect(blind).not.toMatch(/baseline|candidate|prompt_tokens/);
    await expect(runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' })).rejects.toThrow();
    expect(f.calls).toHaveLength(4);
  } finally { await f.close(); }
});

it('refuses a changed output cap before any dispatch even if someone rehashes the request', async () => {
  const f = await fixture(() => answer);
  try {
    const file = path.join(f.directory, 'exact-rgba-baseline.json');
    const body = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; body.max_tokens = 5000;
    const changed = JSON.stringify(body); await writeFile(file, changed);
    const planFile = path.join(f.directory, 'plan.json');
    const plan = JSON.parse(await readFile(planFile, 'utf8')) as { cells: { requestSha256: string }[] };
    plan.cells[0]!.requestSha256 = createHash('sha256').update(changed).digest('hex'); await writeFile(planFile, JSON.stringify(plan));
    await expect(runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' })).rejects.toThrow('Frozen request cap/model/transport mismatch');
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

it('stops on missing usage after preserving the response, without reporting zero as a complete cost', async () => {
  const f = await fixture(() => ({ choices: answer.choices, model: answer.model }));
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(f.calls).toHaveLength(1);
    expect(result).toMatchObject({ status: 'stopped', providerCalls: 1, usageComplete: false, totalTokens: null, costCny: null,
      stopReason: 'Missing or inconsistent usage; stop.' });
    expect(await readFile(path.join(f.directory, 'exact-rgba-baseline.response.txt'), 'utf8')).toContain('42');
  } finally { await f.close(); }
});

it.each([
  ['token limit', { ...answer, usage: { prompt_tokens: 100_000, completion_tokens: 2, total_tokens: 100_002 } }, 'Token/spend stop limit'],
  ['output cap', { ...answer, usage: { prompt_tokens: 1000, completion_tokens: 513, total_tokens: 1513 } }, 'Output cap exceeded'],
  ['invalid usage', { ...answer, usage: { prompt_tokens: 1000, completion_tokens: 2, total_tokens: 1 } }, 'inconsistent usage'],
  ['cache accounting', { ...answer, usage: { ...answer.usage, prompt_tokens_details: { cache_write_tokens: 200 } } }, 'Unsupported cache'],
  ['model mismatch', { ...answer, model: 'unexpected-fallback-model' }, 'Unexpected model'],
] as const)('stops without retries on %s and retains completed raw', async (_name, response, reason) => {
  const f = await fixture(() => response);
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(result.status).toBe('stopped'); expect(result.stopReason).toContain(reason); expect(f.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(f.directory, 'exact-rgba-baseline.response.txt'), 'utf8'))).toEqual(response);
  } finally { await f.close(); }
});

it('keeps HTTP failure raw and never retries a rate limit', async () => {
  const f = await fixture((_body, _index, res) => { res.statusCode = 429; return { error: 'rate limited' }; });
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(result).toMatchObject({ status: 'stopped', providerCalls: 1, usageComplete: false });
    expect(result.stopReason).toContain('HTTP 429'); expect(f.calls).toHaveLength(1);
    expect(await readFile(path.join(f.directory, 'exact-rgba-baseline.response.txt'), 'utf8')).toBe('{"error":"rate limited"}');
  } finally { await f.close(); }
});

it('aborts a stalled body at the frozen deadline and keeps the received prefix', async () => {
  const f = await fixture((_body, _index, res) => { res.write('{"partial":'); return undefined; });
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(150));
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(deadline).toHaveBeenCalledWith(60_000);
    expect(result).toMatchObject({ status: 'stopped', providerCalls: 1, usageComplete: false });
    expect(f.calls).toHaveLength(1);
    expect(await readFile(path.join(f.directory, 'exact-rgba-baseline.response.txt'), 'utf8')).toBe('{"partial":');
  } finally { deadline.mockRestore(); await f.close(); }
});

it('rejects unauthorized plans and damaged later-cell inputs before spending the first call', async () => {
  const f = await fixture(() => answer);
  try {
    const planFile = path.join(f.directory, 'plan.json'); const original = await readFile(planFile, 'utf8');
    const plan = JSON.parse(original) as { authorizedBudget: { maxProviderCalls: number } };
    plan.authorizedBudget.maxProviderCalls = 0; await writeFile(planFile, JSON.stringify(plan));
    await expect(runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' })).rejects.toThrow('authorized four-call');
    await writeFile(planFile, original);
    await writeFile(path.join(f.directory, 'irrelevant-image-candidate.json'), '{}');
    await expect(runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' })).rejects.toThrow('hash mismatch');
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

it('captures proposed tool calls without following them or adding model rounds', async () => {
  const response = { ...answer, choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [
    { id: 'call-1', type: 'function', function: { name: 'visual_inspect', arguments: '{"observation_id":"old"}' } },
  ] } }] };
  const f = await fixture(() => response);
  try {
    const result = await runVisualPilot({ directory: f.directory, apiKey: 'local-fixture-only' });
    expect(result.status).toBe('completed'); expect(f.calls).toHaveLength(4);
    const blind = await readFile(path.join(f.directory, 'blinded.json'), 'utf8'); expect(blind).toContain('visual_inspect');
  } finally { await f.close(); }
});
