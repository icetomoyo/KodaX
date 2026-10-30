/** Physical request accounting shared across the six serial historical cells. Raw stays in OS Temp. */
import { createHash } from 'node:crypto';
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProposedMessage } from './task-cell.js';

export type ActualUsage = NonNullable<ProposedMessage['usage']>;
interface Ledger {
  calls: number; accountedCalls: number; tokens: number; metadata: number; stopped: boolean;
  firstWalletCents?: number; lastWalletCents?: number; stopReason?: string;
  cells: Record<string, { calls: number; tokens: number }>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ENDPOINT = 'https://api.kimi.com/coding/v1/chat/completions';

export async function assertTaskDumpDirectory(value: string): Promise<string> {
  const directory = await realpath(value);
  const inside = (root: string) => { const relative = path.relative(root, directory);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
  const temporary = await realpath(os.tmpdir());
  if (directory === temporary || !inside(temporary) || inside(await realpath(process.cwd()))) throw new Error('Raw requires dedicated OS Temp outside the worktree.');
  return directory;
}

export async function createTaskTransport(input: { directory: string; cell: string; caseId: 'A' | 'B' | 'D';
  authorization: string; apiKey: string; fetcher?: typeof fetch; maxCellCalls?: number }) {
  const directory = await assertTaskDumpDirectory(input.directory);
  const identity = /^(?:[EGT]-)?([ABD])-[XY]$/.exec(input.cell);
  const maxCellCalls = input.maxCellCalls ?? (input.caseId === 'B' ? 5 : 4);
  if (!input.authorization.trim() || !input.apiKey || identity?.[1] !== input.caseId
    || !Number.isInteger(maxCellCalls) || maxCellCalls < 1 || maxCellCalls > 5) throw new Error('Authorized frozen cell and credential required.');
  await writeFile(path.join(directory, `${input.cell}.started.json`), JSON.stringify({ at: new Date().toISOString() }), { flag: 'wx' });
  const fetcher = input.fetcher ?? globalThis.fetch;
  const ledgerPath = path.join(directory, 'ledger.json');
  let ledger: Ledger;
  try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Ledger; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ledger = { calls: 0, accountedCalls: 0, tokens: 0, metadata: 0, stopped: false, cells: {} };
  }
  const cell = ledger.cells[input.cell] ??= { calls: 0, tokens: 0 };
  const save = () => writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
  async function wallet(name: string) {
    if (ledger.metadata >= 64) throw new Error('Metadata HTTP budget exhausted.');
    ledger.metadata++; await save();
    const response = await fetcher(new URL('../usages', ENDPOINT).href, { redirect: 'error',
      headers: { authorization: `Bearer ${input.apiKey}`, 'user-agent': 'KodaX' }, signal: AbortSignal.timeout(15_000) });
    const raw = await response.text();
    await writeFile(path.join(directory, `${name}.quota.json`), raw, { flag: 'wx' });
    if (!response.ok) throw new Error(`Quota HTTP ${response.status}; no retry.`);
    const value = (JSON.parse(raw) as { booster_wallet?: { monthlyUsed?: { currency?: string; priceInCents?: string } } }).booster_wallet?.monthlyUsed;
    if (value?.currency !== 'CNY' || !/^\d+$/.test(value.priceInCents ?? '')) throw new Error('Subscription spend observation unavailable.');
    const cents = Number(value.priceInCents);
    if (!Number.isSafeInteger(cents) || cents < (ledger.lastWalletCents ?? 0)) throw new Error('Wallet counter invalid/reset.');
    ledger.firstWalletCents ??= cents; ledger.lastWalletCents = cents;
    await save();
    if (cents - ledger.firstWalletCents >= 200) throw new Error('Conservative spend stop reached (2 CNY counted as USD2).');
  }
  return { get stopped() { return ledger.stopped; }, respond: async (request: Record<string, unknown>, signal?: AbortSignal): Promise<ProposedMessage & { usage: ActualUsage; finishReason: string }> => {
    if (ledger.stopped) throw new Error(ledger.stopReason ?? 'Batch already stopped.');
    try {
      if (ledger.calls >= 26 || cell.calls >= maxCellCalls
        || ledger.tokens >= 550_000 || cell.tokens >= (input.caseId === 'B' ? 100_000 : 80_000)) throw new Error('Call/token budget exhausted.');
      if (request.model !== 'kimi-for-coding' || !Array.isArray(request.messages)) throw new Error('Frozen model/messages mismatch.');
      if (ledger.firstWalletCents === undefined) await wallet('initial');
      const { max_completion_tokens: _oldCap, stream_options: _streamOptions, ...production } = request;
      const body = JSON.stringify({ ...production, max_tokens: 2048, stream: false, thinking: { type: 'disabled' } });
      const stem = `${input.cell}-${cell.calls + 1}`;
      await writeFile(path.join(directory, `${stem}.production.json`), JSON.stringify(request), { flag: 'wx' });
      await writeFile(path.join(directory, `${stem}.request.json`), body, { flag: 'wx' });
      ledger.calls++; cell.calls++; await save();
      const started = Date.now();
      const responseFile = path.join(directory, `${stem}.response.txt`);
      await writeFile(responseFile, '', { flag: 'wx' });
      const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json', 'user-agent': 'KodaX' },
        body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
      if (!response.body) throw new Error('Provider response has no body.');
      for await (const chunk of response.body) await appendFile(responseFile, chunk);
      const raw = await readFile(responseFile, 'utf8');
      await writeFile(path.join(directory, `${stem}.http.json`), JSON.stringify({ status: response.status, durationMs: Date.now() - started,
        requestSha256: hash(body), responseSha256: hash(raw) }), { flag: 'wx' });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}; no retry.`);
      const data = JSON.parse(raw) as { model?: string; choices?: { message: ProposedMessage; finish_reason: string }[]; usage?: ActualUsage };
      const usage = data.usage;
      if (!usage || ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(value => Number.isSafeInteger(value) && value >= 0)
        || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) throw new Error('Actual usage missing/inconsistent; no estimate substituted.');
      ledger.tokens += usage.total_tokens; cell.tokens += usage.total_tokens; ledger.accountedCalls++; await save();
      await wallet(stem);
      if (ledger.tokens >= 550_000 || cell.tokens >= (input.caseId === 'B' ? 100_000 : 80_000)) throw new Error('Token stop reached after actual usage settlement.');
      if (data.model !== 'kimi-for-coding' || data.choices?.length !== 1 || usage.completion_tokens > 2048) throw new Error('Model/shape/output cap mismatch.');
      return { ...data.choices[0]!.message, usage, finishReason: data.choices[0]!.finish_reason };
    } catch (error) {
      ledger.stopped = true; ledger.stopReason = error instanceof Error ? error.message : String(error);
      try { await save(); }
      catch (settlementError) { throw new AggregateError([error, settlementError], 'Request failed and ledger settlement also failed.'); }
      throw error;
    }
  } };
}
