import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KodaXBaseProvider } from '../packages/llm/src/index.js';
import type { KodaXMessage, KodaXProviderStreamOptions, KodaXReasoningRequest, KodaXStreamResult, KodaXToolDefinition } from '../packages/llm/src/types.js';
import { CODING_SUMMARY_PROMPT, CODING_UPDATE_SUMMARY_PROMPT } from '../packages/coding/src/agent-runtime/coding-compaction-prompts.js';
import { COMPACTION_SUMMARY_PREFIX, COMPACTED_HISTORY_RECOVERY_GUIDANCE } from '../packages/agent/src/session-lineage/compaction/compaction.js';
import { prepareDocumentPilot, runDocumentPilotPair, DOCUMENT_PILOT_ROUTES } from './small-context-document-pilot.eval.js';
import { createBudgetedProvider, createPilotBudget, PILOT_LIMITS, pilotHash, type PilotLedger } from './small-context-document-pilot-support.js';

const roots: string[] = [];
async function temporaryRoot() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-document-pilot-offline-')); roots.push(root); return root; }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe pilot fixture cleanup.');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

class FakeApiProvider extends KodaXBaseProvider {
  readonly name = 'offline-pilot-api'; readonly supportsThinking = false;
  protected readonly config = { model: 'fixture', apiKeyEnv: 'UNUSED', supportsThinking: false, contextWindow: 128_000, maxOutputTokens: 4096 };
  constructor(private readonly fault?: 'wire' | 'retry' | 'output') { super(); }
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
    expect(options?.singleAttempt).toBe(true);
    expect(options?.maxOutputTokensOverride).toBe(2048);
    if (!options?.fetch) throw new Error('Test requires guarded actual fetch.');
    const body = JSON.stringify({ model: options.modelOverride, max_tokens: this.fault === 'output' ? 4096 : options.maxOutputTokensOverride,
      system, messages, tools, ...(this.fault === 'wire' ? { nativeAdapterPadding: 'x'.repeat(65_536) } : {}) });
    const result = await options.fetch('https://offline.invalid/generation', { method: 'POST', body });
    if (this.fault === 'retry') await options.fetch('https://offline.invalid/generation', { method: 'POST', body });
    return await result.json() as KodaXStreamResult;
  }
}
const route = DOCUMENT_PILOT_ROUTES[0]!;
const usage = { inputTokens: 200, outputTokens: 40, totalTokens: 240 };
function response(text = 'offline response', stopReason: KodaXStreamResult['stopReason'] = 'end_turn'): KodaXStreamResult {
  return { textBlocks: [{ type: 'text', text }], toolBlocks: [], thinkingBlocks: [], stopReason, usage };
}
const summary = (round: number) => `<summary>## Goal\nAnswer the bounded document task with precise citations and honest unread scope.\n## Progress\nEDIT019 is complete and must never be replayed. Preserve RUNBOOK_A:L0012 and the inspected source cursor.\n## Critical Context\nRound ${round}: retain the chapter-9 exception RUNBOOK_A:L0908 and latest correction RUNBOOK_A:L1508. Only supplied ranges were inspected; all remaining ranges stay unread.\n## Next Steps\nProduce the requested final JSON from retained evidence without tool side effects.</summary>`;

it('uses production prompts, real read bytes and canonical compact reinsertion in exactly six calls', async () => {
  const root = await temporaryRoot();
  const capture = await prepareDocumentPilot(root, { providerForRoute: () => new FakeApiProvider() });
  expect(capture.wirePreflight).toHaveLength(4);
  expect(capture.wirePreflight.every(value => value.reservedTokens <= PILOT_LIMITS.applicationWindow)).toBe(true);
  expect((await fs.stat(capture.fixtures[0]!.file)).size).toBeGreaterThan(PILOT_LIMITS.applicationWindow);
  const bodies: Array<{ system: string; tools: KodaXToolDefinition[]; messages: KodaXMessage[] }> = [];
  const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
    const call = bodies.length;
    return Response.json(response(call === 3 ? summary(1) : call === 5 ? summary(2) : '{"readScope":"only supplied pages","citations":["RUNBOOK_A:L1508"]}'));
  });
  const budget = await createPilotBudget(root, { offline: true, fetch: fakeFetch });
  const result = await runDocumentPilotPair(capture, capture.fixtures[0]!, route, budget, { provider: new FakeApiProvider() });
  expect(result.calls).toBe(6);
  expect(fakeFetch).toHaveBeenCalledTimes(6);
  expect((await budget.snapshot())).toMatchObject({ calls: 6, chargedTokens: 1440, reservedTokens: 0, unknownUsageCalls: 0 });
  for (const index of [0, 1, 3, 5]) {
    expect(pilotHash(bodies[index]!.system)).toBe(capture.systemHash);
    expect(pilotHash(bodies[index]!.tools)).toBe(capture.toolsHash);
  }
  const promptText = (index: number) => bodies[index]!.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  expect(promptText(2)).toContain(CODING_SUMMARY_PROMPT.trim());
  expect(promptText(4)).toContain(CODING_UPDATE_SUMMARY_PROMPT.trim());
  for (const index of [3, 5]) {
    const checkpoint = bodies[index]!.messages.find(message => message._source === 'compaction-checkpoint');
    expect(checkpoint?.role).toBe('user');
    expect(String(checkpoint?.content).startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(String(checkpoint?.content).endsWith(COMPACTED_HISTORY_RECOVERY_GUIDANCE)).toBe(true);
  }
  const journal = await fs.readFile(path.join(root, 'journal.jsonl'), 'utf8');
  expect(journal.split('\n').filter(line => line && JSON.parse(line).event === 'request')).toHaveLength(6);
  const files = await fs.readdir(root);
  expect(files.filter(file => file.endsWith('.request.json'))).toHaveLength(6);
  expect(files.filter(file => file.endsWith('.response.txt'))).toHaveLength(6);
  const blind = JSON.parse(await fs.readFile(path.join(root, `${result.pairId}.blind.json`), 'utf8')) as Record<string, unknown>;
  expect(blind).not.toHaveProperty('decisionPassed');
  expect(blind).not.toHaveProperty('recommendation');
  expect(JSON.stringify(blind)).not.toContain('chargedTokens');
});

for (const fault of ['wire', 'output'] as const) {
  it(`refuses invalid actual ${fault} bytes before HTTP transport`, async () => {
    const root = await temporaryRoot();
    const transport = vi.fn<typeof fetch>(async () => Response.json(response()));
    const budget = await createPilotBudget(root, { offline: true, fetch: transport });
    const provider = createBudgetedProvider(new FakeApiProvider(fault), route, budget, { callId: `invalid-${fault}` });
    await expect(provider.stream([{ role: 'user', content: 'bounded input' }], [], 'bounded system')).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect((await budget.snapshot()).calls).toBe(0);
  });
}

it('refuses the separately labelled estimated-input budget before serialization or transport', async () => {
  const root = await temporaryRoot();
  const transport = vi.fn<typeof fetch>(async () => Response.json(response()));
  const budget = await createPilotBudget(root, { offline: true, fetch: transport });
  const provider = createBudgetedProvider(new FakeApiProvider(), route, budget, { callId: 'estimated-input' });
  await expect(provider.stream([{ role: 'user', content: '中文超出预算。'.repeat(30_000) }], [], 'system')).rejects.toThrow('Estimated input');
  expect(transport).not.toHaveBeenCalled();
});

for (const field of ['calls', 'tokens', 'usd'] as const) {
  it(`refuses an exhausted shared ${field} budget before transport`, async () => {
    const root = await temporaryRoot();
    const transport = vi.fn<typeof fetch>(async () => Response.json(response()));
    const budget = await createPilotBudget(root, { offline: true, fetch: transport });
    const ledger = await budget.snapshot();
    if (field === 'calls') ledger.calls = PILOT_LIMITS.maxProviderCalls;
    if (field === 'tokens') ledger.chargedTokens = PILOT_LIMITS.maxTotalTokens;
    if (field === 'usd') ledger.chargedUsd = PILOT_LIMITS.maxExternalSpendUsd;
    await fs.writeFile(path.join(root, 'global-budget.json'), JSON.stringify(ledger));
    const provider = createBudgetedProvider(new FakeApiProvider(), route, budget, { callId: `exhausted-${field}` });
    await expect(provider.stream([{ role: 'user', content: 'input' }], [], 'system')).rejects.toThrow('Global pilot budget');
    expect(transport).not.toHaveBeenCalled();
  });
}

it('blocks a hidden retry and retains the unknown-usage reservation', async () => {
  const root = await temporaryRoot();
  const transport = vi.fn<typeof fetch>(async () => Response.json(response()));
  const budget = await createPilotBudget(root, { offline: true, fetch: transport });
  const provider = createBudgetedProvider(new FakeApiProvider('retry'), route, budget, { callId: 'hidden-retry' });
  await expect(provider.stream([{ role: 'user', content: 'input' }], [], 'system')).rejects.toThrow('Automatic retry blocked');
  expect(transport).toHaveBeenCalledTimes(1);
  const ledger = await budget.snapshot();
  expect(ledger.calls).toBe(1);
  expect(ledger.reservedTokens).toBeGreaterThan(2048);
  expect(ledger.unknownUsageCalls).toBe(1);
  expect(ledger.stopped).toContain('Usage unavailable');
});

for (const fault of ['truncated', 'wrapper'] as const) {
  it(`never injects a ${fault} summary or dispatches its later rounds`, async () => {
    const root = await temporaryRoot();
    const capture = await prepareDocumentPilot(root, { providerForRoute: () => new FakeApiProvider() });
    let calls = 0;
    const transport = vi.fn<typeof fetch>(async () => {
      calls++;
      return Response.json(calls === 3 ? response(fault === 'wrapper' ? summary(1).replace('</summary>', '') : summary(1),
        fault === 'truncated' ? 'max_tokens' : 'end_turn') : response('Interim notes.'));
    });
    const budget = await createPilotBudget(root, { offline: true, fetch: transport });
    await expect(runDocumentPilotPair(capture, capture.fixtures[0]!, route, budget, { provider: new FakeApiProvider() })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(3);
    const files = await fs.readdir(root);
    expect(files.some(file => file.endsWith('s1.compacted.json'))).toBe(false);
    expect(files.some(file => file.endsWith('-g2.request.json'))).toBe(false);
    expect(files.filter(file => file.endsWith('.response.txt'))).toHaveLength(3);
  });
}

it('shares concurrent reservations and settlements across two independent budget instances', async () => {
  const root = await temporaryRoot();
  const first = await createPilotBudget(root, { offline: true });
  const second = await createPilotBudget(root, { offline: true });
  await Promise.all([first.reserve('sc-call', 'deepseek/deepseek-flash', 4000, 0.01),
    second.reserve('docx-call', 'zhipu-coding/glm-5.3-flash', 5000, 0)]);
  await Promise.all([first.settle('sc-call', usage, route), second.settle('docx-call', usage, DOCUMENT_PILOT_ROUTES[1]!)]);
  const ledger: PilotLedger = await first.snapshot();
  expect(ledger).toMatchObject({ calls: 2, chargedTokens: 480, reservedTokens: 0, reservedUsd: 0, reservations: [] });
});

it('retains the worst reservation when provider usage is internally inconsistent', async () => {
  const root = await temporaryRoot();
  const budget = await createPilotBudget(root, { offline: true });
  await budget.reserve('inconsistent-usage', 'deepseek/deepseek-flash', 4000, 0.01);
  await budget.settle('inconsistent-usage', { inputTokens: 200, outputTokens: 40, totalTokens: 1 }, route);
  expect(await budget.snapshot()).toMatchObject({ reservedTokens: 4000, reservedUsd: 0.01, chargedTokens: 0, unknownUsageCalls: 1 });
  await expect(budget.reserve('later', 'zhipu-coding/glm-5.3-flash', 4000, 0)).rejects.toThrow('fenced');
});
