/** Bounded Layer-2 Kimi pilot. No tool execution, fallback, repair or retries. */
import { createHash, randomInt } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeVisualPilot } from './pilot-plan.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2);
const PRICES = { currency: 'CNY', inputPerMillion: 6.5, cachedInputPerMillion: 1.1, outputPerMillion: 27,
  source: 'https://platform.kimi.com/docs/pricing/chat', checked: '2026-10-29',
  usdBudgetAccounting: 'Conservative 1 CNY counts as 1 USD; this is a budget upper bound, not an FX quote or invoice.' };

async function assertDumpDirectory(directory: string) {
  const target = await realpath(directory);
  const inside = (root: string) => { const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
  if (!inside(await realpath(os.tmpdir())) || inside(await realpath(process.cwd()))) throw new Error('Raw output requires OS Temp outside the worktree.');
}
type Draft = Awaited<ReturnType<typeof import('./pilot-plan.js').freezeVisualPilot>>;
interface Plan extends Omit<Draft, 'cells'> {
  endpoint: string;
  authorization: string;
  cells: Omit<Draft['cells'][number], 'request'>[];
}
interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } }
interface ResponseBody { model?: string; choices?: { message: { content?: string; tool_calls?: unknown[] }; finish_reason: string }[]; usage?: Usage }
interface Outcome { caseId: string; arm: string; status: number | undefined; durationMs: number;
  responseSha256: string; response: ResponseBody | undefined; error?: string }

interface FreezeInput { baselineFile: string; candidateFile: string; candidateRevision: string; endpoint: string; authorization: string }
export const freezeKimiPilot = (input: FreezeInput) => freezePilot(input, false);
export const freezeKimiCodePilot = (input: FreezeInput) => freezePilot(input, true);

async function freezePilot(input: FreezeInput, coding: boolean): Promise<string> {
  if (!input.authorization.trim()) throw new Error('Positive human authorization is required.');
  const provider = coding ? 'kimi-code' : 'kimi'; const model = coding ? 'kimi-for-coding' : 'kimi-k2.6';
  const revision = coding ? 3 : 2;
  const draft = await writeVisualPilot({ ...input, provider, model });
  const parent = path.join(os.tmpdir(), 'kodax-eval-dumps', 'visual-harness'); await mkdir(parent, { recursive: true });
  await assertDumpDirectory(parent);
  const directory = await mkdtemp(path.join(parent, `pilot-r${revision}-`));
  const plan = JSON.parse(await readFile(path.join(draft, 'plan.json'), 'utf8')) as Plan;
  for (const cell of plan.cells) {
    const source = JSON.parse(await readFile(path.join(draft, `${cell.caseId}-${cell.arm}.json`), 'utf8')) as Record<string, unknown>;
    // Equal route/transport overrides, documented separately from production tool/message bytes.
    delete source.max_completion_tokens; delete source.stream_options;
    const messages = source.messages as { role: string; content: unknown }[];
    for (const message of messages) {
      if (message.role === 'system' && typeof message.content === 'string') {
        message.content = message.content.replace('Provider: wire-openai\nModel: fixture-model\n', `Provider: ${provider}\nModel: ${model}\n`);
      }
    }
    cell.historySha256 = hash(JSON.stringify(messages.slice(0, -1)));
    const body = JSON.stringify({ ...source, max_tokens: 512, stream: false, thinking: { type: 'disabled' } });
    cell.requestSha256 = hash(body);
    await writeFile(path.join(directory, `${cell.caseId}-${cell.arm}.json`), body, { flag: 'wx' });
  }
  await writeFile(path.join(directory, 'reference.png'), await readFile(path.join(draft, 'reference.png')), { flag: 'wx' });
  await writeFile(path.join(directory, 'plan.json'), json({ ...plan, revision, endpoint: input.endpoint,
    authorization: input.authorization, authorizedBudget: plan.proposedBudget,
    draftDirectory: draft, transportOverrides: { stream: false, max_tokens: 512, thinking: { type: 'disabled' } },
    environmentOverride: `Only the captured Provider: wire-openai / Model: fixture-model header becomes ${provider} / ${model}. Production tools remain verbatim; supplied normalized fixture paths/times remain controlled history, not a live workspace.`,
    pricing: coding ? { kind: 'subscription', source: 'https://www.kimi.com/code/docs/kimi-code/membership.html',
      accounting: 'Observe monthlyUsed CNY delta before/after each generation; no nominal per-token prices, no attributed subscription invoice.' } : PRICES,
  }), { flag: 'wx' });
  return directory;
}

export async function runVisualPilot(input: { directory: string; apiKey: string }) {
  await assertDumpDirectory(input.directory);
  const planText = await readFile(path.join(input.directory, 'plan.json'), 'utf8');
  const plan = JSON.parse(planText) as Plan;
  const coding = plan.revision === 3 && plan.provider === 'kimi-code' && plan.model === 'kimi-for-coding';
  if (!input.apiKey || !plan.authorization || (!coding && (plan.revision !== 2 || plan.model !== 'kimi-k2.6'))
    || plan.cells.length !== 4 || plan.authorizedBudget.maxProviderCalls !== 4
    || plan.authorizedBudget.maxTotalTokens !== 100_000 || plan.authorizedBudget.maxExternalSpendUsd !== 1) {
    throw new Error('Expected the authorized four-call Kimi revision and frozen caps.');
  }
  const bodies = [];
  for (const cell of plan.cells) {
    const body = await readFile(path.join(input.directory, `${cell.caseId}-${cell.arm}.json`), 'utf8');
    if (hash(body) !== cell.requestSha256) throw new Error('Frozen request hash mismatch.');
    const request = JSON.parse(body) as Record<string, unknown>;
    if (request.model !== plan.model || request.max_tokens !== 512 || request.stream !== false
      || request.max_completion_tokens !== undefined || JSON.stringify(request.thinking) !== '{"type":"disabled"}') {
      throw new Error('Frozen request cap/model/transport mismatch.');
    }
    bodies.push(body);
  }
  // Exclusive marker forbids re-execution/resume from silently spending another four calls.
  await writeFile(path.join(input.directory, 'started.json'), json({ at: new Date().toISOString(), planSha256: hash(planText) }), { flag: 'wx' });
  let providerCalls = 0; let totalTokens = 0; let costCny = 0; let stopReason: string | undefined; let accountedCalls = 0;
  let metadataHttpRequests = 0; let walletBeforeCents = 0; let walletPreviousCents = 0;
  let observedExtraUsageCny: number | null = null; let lastKnownExtraUsageCny: number | null = null;
  async function readWalletCents(name: string): Promise<number> {
    metadataHttpRequests++;
    const reply = await fetch(new URL('../usages', plan.endpoint), { redirect: 'error',
      headers: { authorization: `Bearer ${input.apiKey}`, 'user-agent': 'KodaX' }, signal: AbortSignal.timeout(15_000) });
    const raw = await reply.text(); await writeFile(path.join(input.directory, `${name}.quota.json`), raw, { flag: 'wx' });
    if (!reply.ok) throw new Error(`Quota HTTP ${reply.status}; no retry.`);
    const wallet = (JSON.parse(raw) as { booster_wallet?: { monthlyUsed?: { currency?: string; priceInCents?: string } } }).booster_wallet?.monthlyUsed;
    if (typeof wallet?.priceInCents !== 'string' || !/^\d+$/.test(wallet.priceInCents)) throw new Error('Missing subscription expense observation; stop.');
    const cents = Number(wallet?.priceInCents);
    if (wallet?.currency !== 'CNY' || !Number.isSafeInteger(cents) || cents < 0) throw new Error('Missing subscription expense observation; stop.');
    return cents;
  }
  if (coding) {
    try { walletBeforeCents = await readWalletCents('before'); walletPreviousCents = walletBeforeCents; }
    catch (error) { stopReason = error instanceof Error ? error.message : String(error); }
  }
  const outcomes: Outcome[] = [];
  for (const [index, cell] of plan.cells.entries()) {
    if (stopReason) break;
    const stem = path.join(input.directory, `${cell.caseId}-${cell.arm}`);
    const started = Date.now(); let status: number | undefined; let response = ''; let outcome: ResponseBody | undefined;
    await writeFile(`${stem}.response.txt`, '', { flag: 'wx' });
    try {
      if (coding) observedExtraUsageCny = null;
      providerCalls++;
      const reply = await fetch(plan.endpoint, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json', 'user-agent': 'KodaX' },
        body: bodies[index], signal: AbortSignal.timeout(60_000) });
      status = reply.status;
      if (!reply.body) throw new Error('Missing response body.');
      for await (const chunk of reply.body) await appendFile(`${stem}.response.txt`, chunk);
      response = await readFile(`${stem}.response.txt`, 'utf8');
      if (!reply.ok) throw new Error(`Provider HTTP ${status}; no retry.`);
      outcome = JSON.parse(response) as ResponseBody;
      const usage = outcome.usage;
      if (!usage || ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0)
        || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) throw new Error('Missing or inconsistent usage; stop.');
      totalTokens += usage.total_tokens;
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const written = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
      if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.prompt_tokens
        || !Number.isSafeInteger(written) || written < 0 || written + cached > usage.prompt_tokens
        || (!coding && written > 0)) throw new Error('Unsupported cache accounting; stop.');
      if (!coding) costCny += ((usage.prompt_tokens - cached) * PRICES.inputPerMillion + cached * PRICES.cachedInputPerMillion
        + usage.completion_tokens * PRICES.outputPerMillion) / 1_000_000;
      accountedCalls++;
      if (coding) {
        const currentCents = await readWalletCents(`${cell.caseId}-${cell.arm}`);
        if (currentCents < walletPreviousCents) throw new Error('Subscription expense counter reset; stop.');
        walletPreviousCents = currentCents;
        observedExtraUsageCny = (currentCents - walletBeforeCents) / 100;
        lastKnownExtraUsageCny = observedExtraUsageCny;
      }
      if (outcome.model !== plan.model || outcome.choices?.length !== 1) throw new Error('Unexpected model/response shape; stop.');
      if (usage.completion_tokens > 512) throw new Error('Output cap exceeded; stop.');
      if (totalTokens >= 100_000 || (coding ? walletPreviousCents - walletBeforeCents >= 100 : costCny >= 1)) throw new Error('Token/spend stop limit reached.');
    } catch (error) { stopReason = error instanceof Error ? error.message : String(error); }
    const result = { caseId: cell.caseId, arm: cell.arm, status, durationMs: Date.now() - started,
      responseSha256: hash(await readFile(`${stem}.response.txt`, 'utf8')), response: outcome,
      ...(stopReason ? { error: stopReason } : {}) };
    outcomes.push(result);
    await writeFile(`${stem}.result.json`, json(result), { flag: 'wx' });
    if (stopReason) break;
  }
  const usageComplete = accountedCalls === providerCalls;
  const summary = { status: stopReason ? 'stopped' : 'completed', providerCalls,
    totalTokens: usageComplete ? totalTokens : null, costCny: usageComplete && !coding ? costCny : null,
    usageComplete, accountedSubtotal: { calls: accountedCalls, tokens: totalTokens, costCny: coding ? null : costCny,
      ...(coding ? { observedExtraUsageCny: lastKnownExtraUsageCny } : {}) },
    usdBudgetUpperBound: usageComplete && !coding ? costCny : null, actualInvoiceUsd: null,
    ...(coding ? { observedExtraUsageCny, metadataHttpRequests } : {}),
    ...(stopReason ? { stopReason } : {}), outcomes };
  await writeFile(path.join(input.directory, 'results.json'), json(summary), { flag: 'wx' });
  const reveal: Record<string, unknown> = {};
  const blinded = ['exact-rgba', 'irrelevant-image'].map(caseId => {
    const pair = outcomes.filter(outcome => outcome.caseId === caseId);
    if (randomInt(2)) pair.reverse();
    return { caseId, responses: pair.map((outcome, index) => {
      const label = index ? 'Y' : 'X'; reveal[`${caseId}/${label}`] = outcome.arm;
      return { label, rawSha256: outcome.responseSha256, choices: outcome.response?.choices, error: outcome.error };
    }) };
  });
  await writeFile(path.join(input.directory, 'blinded.json'), json(blinded), { flag: 'wx' });
  await writeFile(path.join(input.directory, 'reveal.json'), json(reveal), { flag: 'wx' });
  return summary;
}
