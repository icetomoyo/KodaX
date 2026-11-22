/**
 * History-recall description eval: does the restored session_history_* wording make the model search the
 * compacted history for an exact detail, and leave it alone when the answer is still in context?
 *   tsx benchmark/history-recall.eval.ts prepare
 *   tsx benchmark/history-recall.eval.ts run <revision> <alias,alias,...> [samples] [cell,cell,...]
 *   tsx benchmark/history-recall.eval.ts pack <revision>
 * Design, budget and review rubric are pre-registered in docs/research/2026-11-22-history-recall-gaps-grepmem.md.
 * Arm A sends the tool definitions from HEAD 4b688c8b4, arm B the working tree's. Everything else is the same bytes:
 * the production Worker prompt, every builtin tool, and a checkpoint made by the production compactor.
 * Raw output goes to <os.tmpdir()>/kodax-eval-dumps/history-recall/<revision>/.
 */
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KodaXBaseProvider,
  type KodaXMessage,
  type KodaXProviderConfig,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { compact } from '@kodax-ai/agent';
import { applyPostCompactAttachments } from '../packages/coding/src/agent-runtime/middleware/post-compact-attachments.js';
import { KODAX_TOOLS } from '../packages/coding/src/tools/registry.js';
import { buildWorkerSystemPrompt } from './harness/worker-system-prompt.js';
import { runOneShot } from './harness/harness.js';
import type { ModelAlias } from './harness/aliases.js';
import { CELLS, COMPACTED_HISTORY, KEPT_TAIL, SUMMARY, type RecallCell } from './history-recall.cases.js';

const MAX_CALLS_TOTAL = 110;
const MAX_TOKENS_TOTAL = 6_000_000;
const RESERVE_TOKENS_PER_CALL = 60_000;
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'history-recall');
const HISTORY_TOOLS = ['session_history_search', 'session_history_read'];

/** Arm A: the definitions at HEAD 4b688c8b4, byte for byte. */
const BASELINE_TOOLS: Record<string, Pick<KodaXToolDefinition, 'description' | 'input_schema'>> = {
  session_history_search: {
    description: 'Find omitted persisted history only when missing detail is needed; do not guess from checkpoint. '
      + 'Bounded snippets/stable citations; read needed hit with hit.entryRevision as read.revision.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Specific phrase/ID/command/historical fact.' },
        limit: { type: 'number', description: '1–20; default 8.' },
        role: { type: 'string', enum: ['user', 'assistant'] },
        scope: { type: 'string', enum: ['compacted', 'all'], description: 'Default compacted; all only if active-tail search needed.' },
      },
      required: ['query'],
    },
  },
  session_history_read: {
    description: 'Read cited persisted entry in bounded character chunks. '
      + 'Use selected hit.entryRevision as revision; reuse returned entryRevision for nextOffset or stale recovery. '
      + 'It checks this entry across normal message appends. Top-level search revision remains a strict whole-history snapshot.',
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'Exact hit.entryId.' },
        revision: { type: 'string', description: 'Selected hit.entryRevision or read.entryRevision; legacy whole-history revision remains strict.' },
        offset: { type: 'number', description: '0-based characters; default 0.' },
      },
      required: ['entry_id'],
    },
  },
};

/** Returns the fixed summary, so the checkpoint text is the compactor's own framing around a known body. */
class FixedSummaryProvider extends KodaXBaseProvider {
  readonly name = 'history-recall-fixed-summary';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'UNUSED', model: 'fixed-summary', supportsThinking: false, contextWindow: 200_000,
  };
  async stream(): Promise<KodaXStreamResult> {
    return { textBlocks: [{ type: 'text', text: SUMMARY }], toolBlocks: [], thinkingBlocks: [] };
  }
}

const textOf = (messages: readonly KodaXMessage[]) => JSON.stringify(messages);

/** Compacts the session the way a Run does: checkpoint, kept tail, then the post-compact ledger push. */
async function compactedContext(): Promise<KodaXMessage[]> {
  const full = [...COMPACTED_HISTORY, ...KEPT_TAIL];
  const result = await compact(full, { enabled: true, triggerPercent: 75 }, new FixedSummaryProvider(),
    12_000, undefined, undefined, undefined, undefined, undefined, undefined, true);
  if (!result.compacted) throw new Error('The compactor did not compact the session.');
  if (!result.artifactLedger?.length) return result.messages;
  const { compacted } = await applyPostCompactAttachments({ compacted: result.messages,
    artifactLedger: result.artifactLedger, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter });
  return [...compacted];
}

/** Fails if a recall fact survived compaction or a control fact did not: such a cell would not test recall. */
function checkCells(context: readonly KodaXMessage[], cells: readonly RecallCell[]): void {
  const text = textOf(context);
  const problems = cells.flatMap(cell => cell.facts
    .filter(fact => (cell.kind === 'recall') === text.includes(fact.replaceAll('"', '\\"')))
    .map(fact => `${cell.name}: "${fact}" ${cell.kind === 'recall' ? 'is still in context' : 'is missing from context'}`));
  if (problems.length > 0) throw new Error(`Invalid cells:\n${problems.join('\n')}`);
}

function toolsFor(arm: 'A' | 'B'): KodaXToolDefinition[] {
  return KODAX_TOOLS.map(tool => (arm === 'A' && tool.name in BASELINE_TOOLS ? { ...tool, ...BASELINE_TOOLS[tool.name]! } : tool));
}

async function prepare() {
  const context = await compactedContext();
  checkCells(context, CELLS);
  const task = typeof COMPACTED_HISTORY[0]!.content === 'string' ? COMPACTED_HISTORY[0]!.content : '';
  const system = await buildWorkerSystemPrompt({ provider: 'history-recall-eval' }, task, false);
  const [a, b] = [toolsFor('A'), toolsFor('B')];
  const differing = a.filter((tool, i) => JSON.stringify(tool) !== JSON.stringify(b[i])).map(tool => tool.name);
  if (differing.join() !== HISTORY_TOOLS.join()) throw new Error(`Arms differ in ${differing.join() || 'nothing'}.`);
  await mkdir(ROOT, { recursive: true });
  await writeFile(path.join(ROOT, 'fixture.json'), JSON.stringify({ system, context, tools: { A: a, B: b } }, null, 2));
  process.stdout.write(`${path.join(ROOT, 'fixture.json')}\nsystem ${system.length} chars, context ${context.length} messages, `
    + `tools A ${JSON.stringify(a).length} / B ${JSON.stringify(b).length} chars\n`);
}

interface Ledger { calls: number; tokens: number }

async function readLedger(): Promise<Ledger> {
  const file = path.join(ROOT, 'ledger.json');
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as Ledger : { calls: 0, tokens: 0 };
}

const mentions = (text: string, name: string) => [`${name}(`, `"name":"${name}"`, `"name": "${name}"`, `<${name}>`, `name=${name}`, `name: ${name}`]
  .some(pattern => text.includes(pattern));

function observe(raw: { text: string; toolCalls: ReadonlyArray<{ name: string }> }) {
  const names = raw.toolCalls.map(call => call.name);
  return {
    searched: names.includes('session_history_search') || mentions(raw.text, 'session_history_search'),
    firstTool: names[0] ?? null,
    otherTools: names.filter(name => !HISTORY_TOOLS.includes(name)),
  };
}

interface Fixture { system: string; context: KodaXMessage[]; tools: Record<'A' | 'B', KodaXToolDefinition[]> }

/** One alias: cells, samples and both arms in order, one request in flight. Reserves before each call. */
async function runLane(alias: string, cells: readonly RecallCell[], samples: number, fixture: Fixture, dir: string, ledger: Ledger) {
  for (const cell of cells) {
    for (let sample = 0; sample < samples; sample++) {
      const arms: ('A' | 'B')[] = randomInt(2) === 0 ? ['A', 'B'] : ['B', 'A'];
      for (const arm of arms) {
        if (ledger.calls + 1 > MAX_CALLS_TOTAL || ledger.tokens + RESERVE_TOKENS_PER_CALL > MAX_TOKENS_TOTAL) {
          throw new Error(`Budget reached at ${ledger.calls} calls / ${ledger.tokens} tokens; completed raw output is kept.`);
        }
        ledger.calls += 1;
        ledger.tokens += RESERVE_TOKENS_PER_CALL;
        await writeFile(path.join(ROOT, 'ledger.json'), JSON.stringify(ledger));
        const raw = await runOneShot(alias as ModelAlias, { systemPrompt: fixture.system, priorMessages: fixture.context,
          userMessage: cell.question, tools: fixture.tools[arm], timeoutMs: 180_000, maxOutputTokens: 8192 })
          .catch((error: unknown) => ({ error: String(error), text: '', toolCalls: [], usage: undefined }));
        ledger.tokens += (raw.usage?.totalTokens ?? RESERVE_TOKENS_PER_CALL) - RESERVE_TOKENS_PER_CALL;
        await writeFile(path.join(ROOT, 'ledger.json'), JSON.stringify(ledger));
        await writeFile(path.join(dir, `${alias.replace('/', '_')}-${cell.name}-${sample}-${arm}.json`),
          JSON.stringify({ alias, cell: cell.name, kind: cell.kind, sample, arm, observed: observe(raw), ...raw }, null, 2));
      }
    }
  }
}

async function run(revision: string, aliasArg: string, samplesArg?: string, cellArg?: string) {
  const fixture = JSON.parse(await readFile(path.join(ROOT, 'fixture.json'), 'utf8')) as Fixture;
  checkCells(fixture.context, CELLS);
  const aliases = aliasArg.split(',');
  const samples = Number(samplesArg ?? 1);
  const cells = cellArg ? CELLS.filter(cell => cellArg.split(',').includes(cell.name)) : CELLS;
  const ledger = await readLedger();
  const planned = aliases.length * cells.length * samples * 2;
  if (cells.length === 0 || ledger.calls + planned > MAX_CALLS_TOTAL) {
    throw new Error(`${planned} planned calls do not fit: ${ledger.calls} of ${MAX_CALLS_TOTAL} already used.`);
  }
  const dir = path.join(ROOT, revision);
  await mkdir(dir, { recursive: true });
  process.stdout.write(`${dir}\n`);
  await Promise.all(aliases.map(alias => runLane(alias, cells, samples, fixture, dir, ledger)));
  process.stdout.write(`${JSON.stringify(ledger)}\n`);
}

/** Pairs each sample's two arms under random X/Y labels for blind review; the key goes to a separate file. */
async function pack(revision: string) {
  const dir = path.join(ROOT, revision);
  const runs = await Promise.all((await readdir(dir)).filter(name => /-[AB]\.json$/.test(name))
    .map(async name => JSON.parse(await readFile(path.join(dir, name), 'utf8')) as {
      alias: string; cell: string; sample: number; arm: 'A' | 'B'; text: string; toolCalls: unknown[]; error?: string;
    }));
  const pairs = new Map<string, typeof runs>();
  for (const r of runs) pairs.set(`${r.alias}|${r.cell}|${r.sample}`, [...(pairs.get(`${r.alias}|${r.cell}|${r.sample}`) ?? []), r]);
  const key: Record<string, { X: 'A' | 'B'; Y: 'A' | 'B' }> = {};
  const evidence = [...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([id, pair]) => {
    const xArm = randomInt(2) === 0 ? 'A' : 'B';
    key[id] = { X: xArm, Y: xArm === 'A' ? 'B' : 'A' };
    const view = (arm: 'A' | 'B') => {
      const r = pair.find(item => item.arm === arm);
      return r ? { text: r.text, toolCalls: r.toolCalls, error: r.error } : { missing: true };
    };
    const [alias, cell] = id.split('|');
    return { id, alias, cell, question: CELLS.find(c => c.name === cell)?.question, X: view(xArm), Y: view(key[id]!.Y) };
  });
  await writeFile(path.join(dir, 'pack.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(dir, 'pack-key.json'), JSON.stringify(key, null, 2));
  process.stdout.write(`${path.join(dir, 'pack.json')}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'prepare') return prepare();
  if (command === 'run' && rest[0] && rest[1]) return run(rest[0], rest[1], rest[2], rest[3]);
  if (command === 'pack' && rest[0]) return pack(rest[0]);
  throw new Error('Usage: prepare | run <revision> <aliases> [samples] [cells] | pack <revision>');
}
void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
