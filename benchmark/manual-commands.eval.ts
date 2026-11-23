/**
 * Manual commands eval: after the model reads the rewritten manual topics, does it give the user commands that
 * exist today (`kodax host …`, `kodax sessions …`, `/reasoning off`) without losing anything the old text taught?
 *   tsx benchmark/manual-commands.eval.ts prepare
 *   tsx benchmark/manual-commands.eval.ts run <revision> <alias,alias,...> [samples] [case,case,...]
 *   tsx benchmark/manual-commands.eval.ts pack <revision>
 * Questions, rubric and budget are pre-registered in docs/research/2026-11-24-manual-commands-eval.md.
 * Arm A reads the manual as of BASELINE_COMMIT, arm B the manual in this tree; both through the production
 * kodax_manual tool. Everything else is the same bytes: the production Worker prompt, every builtin tool, the
 * question and the first manual call. Fixed call graph (r2 onward): while the model only calls kodax_manual, the
 * harness answers from the same arm's manual and asks again, up to MAX_ROUNDS calls per cell. Any other tool call
 * ends the cell unrun. Raw output goes to <os.tmpdir()>/kodax-eval-dumps/manual-commands/<revision>/.
 */
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { createToolResultBlock } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { toolKodaxManual } from '../packages/coding/src/tools/manual.js';
import { KODAX_TOOLS } from '../packages/coding/src/tools/registry.js';
import type { KodaXManualTopicInput } from '../packages/coding/src/self-knowledge/types.js';
import { buildWorkerSystemPrompt } from './harness/worker-system-prompt.js';
import { runOneShot } from './harness/harness.js';
import type { ModelAlias } from './harness/aliases.js';
import { CASES, type ManualCase } from './manual-commands.cases.js';

/** The last commit before the manual rewrite. */
const BASELINE_COMMIT = '1d802763a';
const MANUAL_PATH = 'packages/coding/src/self-knowledge/manual-topics.json';
const REPO = fileURLToPath(new URL('..', import.meta.url));
const MAX_ROUNDS = 3;
const MAX_CALLS_TOTAL = 80;
const MAX_TOKENS_TOTAL = 4_800_000;
const RESERVE_TOKENS_PER_CALL = 60_000;
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'manual-commands');
type Arm = 'A' | 'B';
type StoredTopic = KodaXManualTopicInput & { body: readonly string[] };

/** Arm A replaces every topic the rewrite changed with its baseline text; arm B is the shipped manual. */
export function injectedTopics(baseline: readonly StoredTopic[], candidate: readonly StoredTopic[]): KodaXManualTopicInput[] {
  return baseline
    .filter(topic => JSON.stringify(topic) !== JSON.stringify(candidate.find(item => item.id === topic.id)))
    .map(topic => ({ ...topic, body: topic.body.join('\n') }));
}

function armTopics(): Record<Arm, KodaXManualTopicInput[]> {
  const baseline = JSON.parse(execFileSync('git', ['show', `${BASELINE_COMMIT}:${MANUAL_PATH}`], { cwd: REPO, encoding: 'utf8' })) as StoredTopic[];
  const candidate = JSON.parse(readFileSync(path.join(REPO, MANUAL_PATH), 'utf8')) as StoredTopic[];
  return { A: injectedTopics(baseline, candidate), B: [] };
}

/** What kodax_manual returns for this input when the given topics replace the shipped ones. */
export function answerManual(input: Record<string, unknown>, topics: readonly KodaXManualTopicInput[]): Promise<string> {
  return toolKodaxManual(input, { backups: new Map(), ...(topics.length ? { selfManual: { topics } } : {}) });
}

/** The first request: the question, the model's manual call, then the topic as the tool result. */
export function messagesFor(evalCase: ManualCase, result: string): KodaXMessage[] {
  return [
    { role: 'user', content: evalCase.question },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'manual-1', name: 'kodax_manual', input: { topic: evalCase.topic } }] },
    { role: 'user', content: [createToolResultBlock('manual-1', result)] },
  ];
}

interface Fixture {
  tools: KodaXToolDefinition[];
  topics: Record<Arm, KodaXManualTopicInput[]>;
  cases: Record<string, { system: string; messages: Record<Arm, KodaXMessage[]> }>;
}

async function prepare() {
  // An empty workspace and KodaX home, so the prompt carries no project rules or saved notes from this machine.
  const workspace = path.join(ROOT, 'workspace');
  const home = path.join(ROOT, 'home');
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env.KODAX_HOME = home;
  const topics = armTopics();
  const fixture: Fixture = { tools: [...KODAX_TOOLS], topics, cases: {} };
  for (const evalCase of CASES) {
    const system = await buildWorkerSystemPrompt({ provider: 'manual-commands-eval',
      context: { executionCwd: workspace, gitRoot: workspace, configHome: home, repoIntelligenceMode: 'off' } }, evalCase.question);
    const input = { topic: evalCase.topic };
    const results = { A: await answerManual(input, topics.A), B: await answerManual(input, topics.B) };
    if (results.A === results.B) throw new Error(`${evalCase.name}: both arms read the same topic.`);
    fixture.cases[evalCase.name] = { system, messages: { A: messagesFor(evalCase, results.A), B: messagesFor(evalCase, results.B) } };
  }
  await writeFile(path.join(ROOT, 'fixture.json'), JSON.stringify(fixture, null, 2));
  process.stdout.write(`${path.join(ROOT, 'fixture.json')}\n${CASES.length} cases, arm A replaces `
    + `${topics.A.map(topic => topic.id).join(', ')}; system ${Object.values(fixture.cases)[0]!.system.length} chars\n`);
}

/** Structural facts about the answer. The reviewer reads the raw output to judge it. */
export function observe(raw: { text: string; toolCalls: ReadonlyArray<{ name: string }> }) {
  const unique = (values: string[]) => [...new Set(values)];
  return {
    tools: raw.toolCalls.map(call => call.name),
    cliCommands: unique([...raw.text.matchAll(/kodax\s+(?:host|daemon|sessions)(?:\s+[a-z-]+)?/g)].map(match => match[0].replace(/\s+/g, ' '))),
    namesDaemonCommand: /kodax\s+daemon\b/.test(raw.text),
    reasoningOff: unique([...raw.text.matchAll(/\/(?:reasoning|effort|thinking|think|reason|t)\s+(?:off|none)\b/g)].map(match => match[0])),
  };
}

interface Ledger { calls: number; tokens: number }

async function readLedger(): Promise<Ledger> {
  const file = path.join(ROOT, 'ledger.json');
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as Ledger : { calls: 0, tokens: 0 };
}

async function reserve(ledger: Ledger): Promise<void> {
  if (ledger.calls + 1 > MAX_CALLS_TOTAL || ledger.tokens + RESERVE_TOKENS_PER_CALL > MAX_TOKENS_TOTAL) {
    throw new Error(`Budget reached at ${ledger.calls} calls / ${ledger.tokens} tokens; completed raw output is kept.`);
  }
  ledger.calls += 1;
  ledger.tokens += RESERVE_TOKENS_PER_CALL;
  await writeFile(path.join(ROOT, 'ledger.json'), JSON.stringify(ledger));
}

/** One cell: ask, answer manual calls from the arm's manual, ask again; stop on an answer, another tool or MAX_ROUNDS. */
async function runCell(alias: string, system: string, start: KodaXMessage[], fixture: Fixture, arm: Arm, ledger: Ledger) {
  const messages = [...start];
  const rounds: Array<{ text: string; toolCalls: unknown[]; usage?: unknown; error?: string }> = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await reserve(ledger);
    const raw = await runOneShot(alias as ModelAlias, { systemPrompt: system, priorMessages: messages,
      tools: fixture.tools, timeoutMs: 180_000, maxOutputTokens: 8192 })
      .catch((error: unknown) => ({ error: String(error), text: '', toolCalls: [], usage: undefined, assistantContent: [] }));
    ledger.tokens += (raw.usage?.totalTokens ?? RESERVE_TOKENS_PER_CALL) - RESERVE_TOKENS_PER_CALL;
    await writeFile(path.join(ROOT, 'ledger.json'), JSON.stringify(ledger));
    rounds.push({ text: raw.text, toolCalls: [...raw.toolCalls], usage: raw.usage, ...('error' in raw ? { error: raw.error } : {}) });
    const calls = raw.assistantContent.filter(block => block.type === 'tool_use');
    if (calls.length === 0 || calls.some(call => call.name !== 'kodax_manual')) break;
    messages.push({ role: 'assistant', content: [...raw.assistantContent] });
    messages.push({ role: 'user', content: await Promise.all(calls.map(async call =>
      createToolResultBlock(call.id, await answerManual(call.input as Record<string, unknown>, fixture.topics[arm])))) });
  }
  const last = rounds.at(-1)!;
  return { rounds, censored: last.toolCalls.length > 0, finalText: last.text };
}

/** One alias: cases, samples and both arms in order, one request in flight. */
async function runLane(alias: string, cases: readonly ManualCase[], samples: number, fixture: Fixture, dir: string, ledger: Ledger) {
  for (const evalCase of cases) {
    const { system, messages } = fixture.cases[evalCase.name]!;
    for (let sample = 0; sample < samples; sample++) {
      const arms: Arm[] = randomInt(2) === 0 ? ['A', 'B'] : ['B', 'A'];
      for (const arm of arms) {
        const cell = await runCell(alias, system, messages[arm], fixture, arm, ledger);
        const allText = cell.rounds.map(round => round.text).join('\n');
        await writeFile(path.join(dir, `${alias.replace('/', '_')}-${evalCase.name}-${sample}-${arm}.json`),
          JSON.stringify({ alias, case: evalCase.name, sample, arm,
            observed: observe({ text: allText, toolCalls: cell.rounds.flatMap(round => round.toolCalls as { name: string }[]) }),
            ...cell }, null, 2));
      }
    }
  }
}

async function run(revision: string, aliasArg: string, samplesArg?: string, caseArg?: string) {
  const fixture = JSON.parse(await readFile(path.join(ROOT, 'fixture.json'), 'utf8')) as Fixture;
  const aliases = aliasArg.split(',');
  const samples = Number(samplesArg ?? 1);
  const cases = caseArg ? CASES.filter(evalCase => caseArg.split(',').includes(evalCase.name)) : CASES;
  const ledger = await readLedger();
  const planned = aliases.length * cases.length * samples * 2 * MAX_ROUNDS;
  if (cases.length === 0 || ledger.calls + planned > MAX_CALLS_TOTAL) {
    throw new Error(`Up to ${planned} calls do not fit: ${ledger.calls} of ${MAX_CALLS_TOTAL} already used.`);
  }
  const dir = path.join(ROOT, revision);
  await mkdir(dir, { recursive: true });
  process.stdout.write(`${dir}\n`);
  await Promise.all(aliases.map(alias => runLane(alias, cases, samples, fixture, dir, ledger)));
  process.stdout.write(`${JSON.stringify(ledger)}\n`);
}

/** Pairs each sample's two arms under random X/Y labels for blind review; the key goes to a separate file. */
async function pack(revision: string) {
  const dir = path.join(ROOT, revision);
  const runs = await Promise.all((await readdir(dir)).filter(name => /-[AB]\.json$/.test(name))
    .map(async name => JSON.parse(await readFile(path.join(dir, name), 'utf8')) as {
      alias: string; case: string; sample: number; arm: Arm; rounds: Array<{ text: string; toolCalls: unknown[]; error?: string }>;
      censored: boolean;
    }));
  const pairs = new Map<string, typeof runs>();
  for (const r of runs) pairs.set(`${r.alias}|${r.case}|${r.sample}`, [...(pairs.get(`${r.alias}|${r.case}|${r.sample}`) ?? []), r]);
  const key: Record<string, { X: Arm; Y: Arm }> = {};
  const evidence = [...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([id, pair]) => {
    const xArm: Arm = randomInt(2) === 0 ? 'A' : 'B';
    key[id] = { X: xArm, Y: xArm === 'A' ? 'B' : 'A' };
    const view = (arm: Arm) => {
      const r = pair.find(item => item.arm === arm);
      return r ? { rounds: r.rounds.map(({ text, toolCalls, error }) => ({ text, toolCalls, error })), censored: r.censored } : { missing: true };
    };
    const evalCase = CASES.find(c => c.name === id.split('|')[1]);
    return { id, question: evalCase?.question, useful: evalCase?.useful, X: view(xArm), Y: view(key[id]!.Y) };
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
  throw new Error('Usage: prepare | run <revision> <aliases> [samples] [cases] | pack <revision>');
}

// Run only from the command line, so the cases test can import the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
