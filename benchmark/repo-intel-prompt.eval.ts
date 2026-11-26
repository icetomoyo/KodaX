/**
 * Repo-intelligence prompt eval (Layer 2, one response per cell, model-selected tools never run).
 *   node --import tsx benchmark/repo-intel-prompt.eval.ts capture
 *   node --import tsx benchmark/repo-intel-prompt.eval.ts prepare
 *   node --import tsx benchmark/repo-intel-prompt.eval.ts run <revision> <alias,alias,...> [samples] [C1,C2,...]
 *   node --import tsx benchmark/repo-intel-prompt.eval.ts pack <revision>
 * capture freezes real first requests from tests/managed-first-turn.capture.ts (zero network). The candidate
 * arm is that request as captured from the working tree. The baseline arm is the same request with exactly the
 * changed prompt texts put back to their BASELINE_REF bytes: static-text keys from the .md sources and the two
 * worker-role-prompt.ts lines. Cases, questions and rubric: benchmark/repo-intel-prompt.cases.ts.
 * Raw output goes to <os.tmpdir()>/kodax-eval-dumps/repointel-p0-prompt/.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KodaXMessage, KodaXTokenUsage, KodaXToolDefinition } from '@kodax-ai/llm';
import { runOneShot } from './harness/harness.js';
import { resolveAlias, type ModelAlias } from './harness/aliases.js';
import {
  C4_CHILD_OBJECTIVE, CAPTURE_CHILD_OBJECTIVE, CAPTURES, CASES, type RepoIntelCase,
} from './repo-intel-prompt.cases.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'repointel-p0-prompt');
const BASELINE_REF = 'd4220a204';
const LIMITS = { calls: 100, perCell: 1, rounds: 1, outputTokens: 8192, totalTokens: 4_000_000, reservePerCall: 60_000, timeoutMs: 120_000 };
const TEXT_DIR = 'packages/coding/src/prompts/text';
const TEXT_SOURCES = ['agents/worker-role-prompt.md', 'construction/builtin-agents.md', 'prompts/child-system-contract.md',
  'reasoning.md', 'tools/tool-definitions.md'];
const CHANGED_KEYS = ['child.system.intro', 'repo-explorer.instructions', 'repo-intelligence.low-confidence-note',
  'tool.changed_scope.description', 'tool.semantic_lookup.description', 'worker.repo-tools.changed-scope'];
const WORKER_TS = 'packages/coding/src/agents/worker-role-prompt.ts';

interface Swap { readonly id: string; readonly baseline: string; readonly candidate: string }
interface FrozenInput { readonly system: string; readonly messages: readonly KodaXMessage[]; readonly tools: readonly KodaXToolDefinition[] }
interface CaptureFile { cases: Array<{ id: string; input: FrozenInput; child?: FrozenInput }> }
type Arm = 'baseline' | 'candidate';
interface CaseFixture { arms: Record<Arm, FrozenInput>; hashes: Record<Arm, string>; swapHits: Record<string, number> }
interface Fixture { baselineRef: string; swaps: Swap[]; cases: Record<string, CaseFixture> }

/** The two edited worker-role-prompt.ts lines, as rendered text. */
const TS_SWAPS: readonly Swap[] = [
  { id: 'worker-role-prompt.ts:symbol_context',
    baseline: '- Use `symbol_context` before grepping for one symbol and its probable callers/callees.',
    candidate: '- Use `symbol_context` for one named symbol\'s definition and probable callers/callees.' },
  { id: 'worker-role-prompt.ts:semantic_lookup',
    baseline: '- Use `semantic_lookup` for concepts rather than exact strings.',
    candidate: '- `semantic_lookup` matches indexed names, so query it with likely identifiers rather than descriptions of behavior.' },
];

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const count = (text: string, part: string) => text.split(part).length - 1;
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

/** Same entry format as scripts/prompt-text.mjs: `<!-- @key name -->` then a body trimmed of trailing newlines. */
function parseKeys(content: string): Map<string, string> {
  const entries = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lf(content).split('\n')) {
    const marker = /^<!-- @key ([A-Za-z0-9._/-]+) -->$/.exec(line);
    if (marker) entries.set(marker[1]!, current = []);
    else current?.push(line);
  }
  return new Map([...entries].map(([key, lines]) => [key, lines.join('\n').replace(/\n+$/, '')]));
}

/** Changed texts between BASELINE_REF and the working tree; fails if anything else in those sources changed. */
function buildSwaps(): Swap[] {
  const store = JSON.parse(readFileSync(path.join(REPO, 'packages/coding/src/prompts/static-text.json'), 'utf8')) as Record<string, unknown>;
  const swaps: Swap[] = [];
  for (const file of TEXT_SOURCES) {
    const base = parseKeys(git('show', `${BASELINE_REF}:${TEXT_DIR}/${file}`));
    const cand = parseKeys(readFileSync(path.join(REPO, TEXT_DIR, file), 'utf8'));
    if ([...base.keys()].sort().join() !== [...cand.keys()].sort().join()) throw new Error(`${file}: key set changed`);
    for (const [key, value] of cand) {
      if (base.get(key) === value) continue;
      if (store[key] !== value) throw new Error(`${key}: static-text.json is stale; run node scripts/prompt-text.mjs`);
      swaps.push({ id: key, baseline: base.get(key)!, candidate: value });
    }
  }
  if (swaps.map(swap => swap.id).sort().join() !== CHANGED_KEYS.join()) throw new Error(`Changed keys: ${swaps.map(s => s.id).join()}`);
  const escape = (text: string) => text.replaceAll('\'', '\\\'');
  let rebuilt = lf(git('show', `${BASELINE_REF}:${WORKER_TS}`));
  for (const swap of TS_SWAPS) {
    if (count(rebuilt, escape(swap.baseline)) !== 1) throw new Error(`${swap.id}: baseline line not found once`);
    rebuilt = rebuilt.split(escape(swap.baseline)).join(escape(swap.candidate));
  }
  if (rebuilt !== lf(readFileSync(path.join(REPO, WORKER_TS), 'utf8'))) throw new Error(`${WORKER_TS} changed beyond the two swapped lines`);
  return [...swaps, ...TS_SWAPS];
}

function swapText(text: string, swaps: readonly Swap[], hits: Record<string, number>): string {
  let out = text;
  for (const swap of swaps) {
    const found = count(out, swap.candidate);
    if (found === 0) continue;
    hits[swap.id] = (hits[swap.id] ?? 0) + found;
    out = out.split(swap.candidate).join(swap.baseline);
  }
  return out;
}

/** The candidate request with every changed text put back to its baseline bytes. */
function toBaseline(input: FrozenInput, swaps: readonly Swap[]): { input: FrozenInput; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  const messages = input.messages.map((message): KodaXMessage => (typeof message.content === 'string'
    ? { ...message, content: swapText(message.content, swaps, hits) }
    : { ...message, content: message.content.map(block => (block.type === 'text' ? { ...block, text: swapText(block.text, swaps, hits) } : block)) }));
  const tools = input.tools.map(tool => ({ ...tool, description: swapText(tool.description, swaps, hits) }));
  return { input: { system: swapText(input.system, swaps, hits), messages, tools }, hits };
}

const firstText = (input: FrozenInput) => {
  const content = input.messages[0]?.content;
  if (typeof content !== 'string') throw new Error('Expected a string first message');
  return content;
};
const replaceFirst = (input: FrozenInput, content: string): FrozenInput => ({ ...input, messages: [{ ...input.messages[0]!, content }, ...input.messages.slice(1)] });

/** C2: the run context the 2s repository-intelligence budget leaves when the change scope misses it. */
function stripChangeScope(input: FrozenInput): FrozenInput {
  const text = firstText(input);
  const start = text.indexOf('\n\n## Repository Change Scope\n');
  const end = text.indexOf('\n=== End Managed Run Context ===', start);
  if (start < 0 || end < 0) throw new Error('No Repository Change Scope to strip');
  const stripped = text.slice(0, start) + text.slice(end);
  if (stripped.includes('Repository Change Scope') || JSON.stringify(input.messages.slice(1)).includes('Repository Change Scope')) {
    throw new Error('Scope survived stripping');
  }
  return replaceFirst(input, stripped);
}

function swapChildObjective(input: FrozenInput): FrozenInput {
  const text = firstText(input);
  if (input.messages.length !== 1 || count(text, CAPTURE_CHILD_OBJECTIVE) !== 1 || input.system.includes(CAPTURE_CHILD_OBJECTIVE)) {
    throw new Error('Child capture does not carry the objective exactly once');
  }
  return replaceFirst(input, text.replace(CAPTURE_CHILD_OBJECTIVE, C4_CHILD_OBJECTIVE));
}

async function capture() {
  const dir = path.join(ROOT, 'captures');
  await mkdir(dir, { recursive: true });
  for (const spec of CAPTURES) {
    const out = path.join(dir, `${spec.id}.json`);
    if (existsSync(out)) { process.stdout.write(`kept ${out}\n`); continue; }
    const casesFile = path.join(dir, `${spec.id}.cases.json`);
    await writeFile(casesFile, JSON.stringify(spec.tasks.map(task => ({ ...task, workMode: 'coding' }))));
    const env: NodeJS.ProcessEnv = { ...process.env, KODAX_HOME: path.join(ROOT, 'capture-home'), KODAX_MANAGED_CAPTURE_OUT: out,
      KODAX_MANAGED_CAPTURE_CASES: casesFile, KODAX_MANAGED_CAPTURE_REPO_MODE: spec.repoMode, KODAX_MANAGED_CAPTURE_STAGE: `repointel-p0-${spec.id}` };
    delete env.KODAX_MANAGED_CAPTURE_CHILD;
    delete env.KODAX_MANAGED_CAPTURE_CATALOG;
    if (spec.childLane) env.KODAX_MANAGED_CAPTURE_CHILD = spec.childLane;
    // vite-node with the vitest config resolves @kodax-ai/* to source, so the capture renders the working tree.
    const script = spec.workspace === 'cache' ? 'tests/managed-first-turn.capture.ts' : 'benchmark/repo-intel-prompt.eval.ts';
    if (spec.workspace === 'llm') env.REPOINTEL_P0_CAPTURE = spec.id;
    execFileSync(process.execPath, [path.join(REPO, 'node_modules/vite-node/vite-node.mjs'), '-c', 'vitest.config.ts', script],
      { cwd: REPO, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  }
}

/** packages/llm at the baseline ref as a committed Git repository: real code whose file names do not answer C3. */
async function writeLlmWorkspace(workspace: string): Promise<void> {
  for (const file of git('ls-tree', '-r', '--name-only', BASELINE_REF, 'packages/llm').split('\n').filter(Boolean)) {
    const target = path.join(workspace, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, execFileSync('git', ['show', `${BASELINE_REF}:${file}`], { cwd: REPO, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }), { flag: 'wx' });
  }
  const run = (...args: string[]) => execFileSync('git', args, { cwd: workspace, windowsHide: true });
  run('init', '-q');
  run('config', 'core.autocrlf', 'false');
  run('add', '--all');
  run('-c', 'user.name=Eval Fixture', '-c', 'user.email=eval-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline');
}

/**
 * Runs under vite-node (REPOINTEL_P0_CAPTURE set by capture()). Mirrors the Runtime path of
 * tests/managed-first-turn.capture.ts on the llm workspace and keeps the most complete of three attempts,
 * because repository intelligence races a 2s budget on a cold index.
 */
async function captureLlm(specId: string): Promise<void> {
  const spec = CAPTURES.find(item => item.id === specId);
  const out = process.env.KODAX_MANAGED_CAPTURE_OUT;
  if (!spec || !out) throw new Error(`Unknown capture ${specId}`);
  const { KodaXBaseProvider, registerModelProvider } = await import('@kodax-ai/llm');
  const { createKodaXRuntime } = await import('../tests/runtime-fixture.js');
  const rows: CaptureFile['cases'] = [];
  for (const task of spec.tasks) {
    let best: FrozenInput | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const dir = path.join(ROOT, 'captures', `${spec.id}-${task.id}-${attempt}`);
      if (existsSync(dir)) throw new Error(`${dir} exists; captures are frozen`);
      const workspace = path.join(dir, 'workspace');
      await writeLlmWorkspace(workspace);
      let captured: FrozenInput | undefined;
      class CaptureProvider extends KodaXBaseProvider {
        readonly name = 'repointel-capture';
        readonly supportsThinking = false;
        protected readonly config = { apiKeyEnv: 'REPOINTEL_CAPTURE_KEY', model: 'capture-model', contextWindow: 128000, supportsThinking: false };
        override isConfigured(): boolean { return true; }
        async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string) {
          if (tools.length > 1 && !captured) captured = JSON.parse(JSON.stringify({ messages, tools, system })) as FrozenInput;
          return { textBlocks: [{ type: 'text' as const, text: 'capture only' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' as const };
        }
      }
      const unregister = registerModelProvider('repointel-capture', () => new CaptureProvider());
      const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(dir, 'home'), defaultProvider: 'repointel-capture', defaultModel: 'capture-model' });
      try {
        const session = await runtime.sessions.create({ projectPath: workspace });
        await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
        const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: task.task, options: {
          provider: 'repointel-capture', model: 'capture-model', reasoningMode: 'off', lsp: false, maxIter: 2, disablePromptCache: true,
          learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] } }),
          agentMode: 'ama', workMode: 'coding',
          context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: spec.repoMode, resolveShellPermissionMode: () => 'full-access' },
        } });
        const result = await handle.result;
        if (result.error) throw new Error(`${task.id}: ${result.error.name}: ${result.error.message}`);
      } finally {
        await runtime.close();
        unregister();
      }
      if (!captured) throw new Error(`${task.id}: no root request captured`);
      if (!best || JSON.stringify(captured).length > JSON.stringify(best).length) best = captured;
    }
    rows.push({ id: task.id, input: best! });
  }
  await writeFile(out, JSON.stringify({ stage: `repointel-p0-${spec.id}`, cases: rows }, null, 2), { flag: 'wx' });
  process.stdout.write(`captured ${spec.id}\n`);
}

async function prepare() {
  const swaps = buildSwaps();
  const captures = new Map<string, CaptureFile>();
  for (const spec of CAPTURES) captures.set(spec.id, await readJson<CaptureFile>(path.join(ROOT, 'captures', `${spec.id}.json`)));
  const cases: Record<string, CaseFixture> = {};
  for (const c of CASES) {
    const row = captures.get(c.capture)?.cases.find(item => item.id === c.task);
    let candidate = c.use === 'child' ? row?.child : row?.input;
    if (!candidate) throw new Error(`${c.id}: capture ${c.capture}/${c.task} has no ${c.use} request`);
    if (c.transform === 'strip-change-scope') candidate = stripChangeScope(candidate);
    if (c.transform === 'child-objective') candidate = swapChildObjective(candidate);
    const last = candidate.messages.at(-1);
    if (last?.role !== 'user' || typeof last.content !== 'string') throw new Error(`${c.id}: request must end with a user text message`);
    const { input: baseline, hits } = toBaseline(candidate, swaps);
    const [b, k] = [JSON.stringify(baseline), JSON.stringify(candidate)];
    const problems = [
      b === k ? 'arms are identical' : '',
      ...c.requiredSwaps.filter(id => !hits[id]).map(id => `required swap ${id} did not reach the request`),
      k.includes(JSON.stringify(c.candidateSentence).slice(1, -1)) ? '' : 'candidate lacks its sentence',
      b.includes(JSON.stringify(c.candidateSentence).slice(1, -1)) ? 'baseline carries the candidate sentence' : '',
      b.includes(JSON.stringify(c.baselineSentence).slice(1, -1)) ? '' : 'baseline lacks its sentence',
      k.includes(JSON.stringify(c.baselineSentence).slice(1, -1)) ? 'candidate carries the baseline sentence' : '',
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(`${c.id}: ${problems.join('; ')}`);
    cases[c.id] = { arms: { baseline, candidate }, hashes: { baseline: hash(baseline), candidate: hash(candidate) }, swapHits: hits };
    process.stdout.write(`${c.id}: tools ${candidate.tools.length}, swaps ${JSON.stringify(hits)}\n`);
  }
  const fixture: Fixture = { baselineRef: BASELINE_REF, swaps, cases };
  await writeFile(path.join(ROOT, 'fixture.json'), JSON.stringify(fixture, null, 2));
  await writeFile(path.join(ROOT, 'manifest.json'), JSON.stringify({ limits: LIMITS, baselineRef: BASELINE_REF,
    fixtureHash: hash(fixture), cases: CASES.map(({ id, question, rubric }) => ({ id, question, rubric })),
    sources: Object.fromEntries(['benchmark/repo-intel-prompt.eval.ts', 'benchmark/repo-intel-prompt.cases.ts', 'tests/managed-first-turn.capture.ts']
      .map(file => [file, createHash('sha256').update(readFileSync(path.join(REPO, file))).digest('hex')])) }, null, 2));
  process.stdout.write(`${path.join(ROOT, 'fixture.json')}\n`);
}

interface ToolCall { name: string; input: unknown }
interface RawResult { text: string; toolCalls: readonly ToolCall[]; usage?: KodaXTokenUsage; durationMs?: number; error?: string }

const mentions = (text: string, name: string) => [`${name}(`, `"name":"${name}"`, `"name": "${name}"`, `<${name}>`, `name=${name}`, `name: ${name}`]
  .some(pattern => text.includes(pattern));
const queryOf = (call: ToolCall) => {
  const input = call.input as { query?: unknown } | null;
  return typeof input?.query === 'string' ? input.query : '';
};

/** Mechanical observations; the blind semantic review decides the comparison. */
function observe(caseId: RepoIntelCase['id'], raw: RawResult, available: ReadonlySet<string>) {
  const names = raw.toolCalls.map(call => call.name);
  const base = { firstTool: names[0] ?? null, tools: names, textOnly: names.length === 0,
    unavailableTools: names.filter(name => !available.has(name)), censored: (raw.usage?.outputTokens ?? 0) >= LIMITS.outputTokens };
  if (caseId === 'C1' || caseId === 'C2') {
    const delegated = raw.toolCalls.filter(call => call.name === 'spawn_agent').some(call => JSON.stringify(call.input).includes('changed_scope'));
    return { ...base, changedScopeCalled: names.includes('changed_scope'), firstIsChangedScope: names[0] === 'changed_scope',
      changedScopeTextSyntax: mentions(raw.text, 'changed_scope'), changedScopeDelegated: delegated,
      actedWithoutScopeCall: !names.includes('changed_scope') && names.length > 0 };
  }
  if (caseId === 'C3') {
    const queries = raw.toolCalls.filter(call => call.name === 'semantic_lookup').map(queryOf);
    return { ...base, semanticLookupQueries: queries, descriptiveSemanticQuery: queries.some(q => q.trim().split(/\s+/).length >= 3),
      semanticLookupTextSyntax: mentions(raw.text, 'semantic_lookup'), grepUsed: names.includes('grep') };
  }
  const local = (name: string) => ['glob', 'grep', 'read', 'code_search'].includes(name) || name.startsWith('lsp_');
  return { ...base, moduleContextCalled: names.includes('module_context'), moduleContextMentioned: raw.text.includes('module_context'),
    firstToolLocal: names.length > 0 && local(names[0]!), allToolsLocal: names.length > 0 && names.every(local) };
}

interface Ledger { calls: number; tokens: number; unknownUsage: number; stopped?: string }

async function readLedger(): Promise<Ledger> {
  const file = path.join(ROOT, 'ledger.json');
  return existsSync(file) ? readJson<Ledger>(file) : { calls: 0, tokens: 0, unknownUsage: 0 };
}
const saveLedger = (ledger: Ledger) => writeFile(path.join(ROOT, 'ledger.json'), JSON.stringify(ledger, null, 2));
const cellFile = (dir: string, alias: string, caseId: string, sample: number, arm: Arm) => path.join(dir, `${alias.replace('/', '_')}-${caseId}-${sample}-${arm}.json`);

/** One alias: cases, samples and both arms in random order, one request in flight; reserves before each call. */
async function runLane(alias: ModelAlias, cases: readonly RepoIntelCase[], samples: number, fixture: Fixture, dir: string, ledger: Ledger) {
  for (const c of cases) {
    const fx = fixture.cases[c.id]!;
    const available = new Set(fx.arms.candidate.tools.map(tool => tool.name));
    for (let sample = 0; sample < samples; sample++) {
      const arms: Arm[] = randomInt(2) === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const arm of arms) {
        const file = cellFile(dir, alias, c.id, sample, arm);
        if (existsSync(file)) continue;
        if (ledger.stopped) return;
        if (ledger.calls + 1 > LIMITS.calls || ledger.tokens + LIMITS.reservePerCall > LIMITS.totalTokens) {
          ledger.stopped = `budget cap at ${ledger.calls} calls / ${ledger.tokens} tokens`;
          await saveLedger(ledger);
          return;
        }
        ledger.calls += 1;
        ledger.tokens += LIMITS.reservePerCall;
        await saveLedger(ledger);
        const input = fx.arms[arm];
        const last = input.messages.at(-1)!;
        const raw: RawResult = await runOneShot(alias, { systemPrompt: input.system, priorMessages: input.messages.slice(0, -1),
          userMessage: last.content as string, tools: input.tools, timeoutMs: LIMITS.timeoutMs, maxOutputTokens: LIMITS.outputTokens })
          .catch((error: unknown) => ({ error: String(error), text: '', toolCalls: [] }));
        if (raw.usage) ledger.tokens += raw.usage.totalTokens - LIMITS.reservePerCall;
        else ledger.unknownUsage += 1;
        await saveLedger(ledger);
        const target = resolveAlias(alias);
        await writeFile(file, JSON.stringify({ alias, provider: target.provider, model: target.model, case: c.id, sample, arm,
          inputHash: fx.hashes[arm], userMessage: last.content, observed: observe(c.id, raw, available), ...raw }, null, 2));
        process.stdout.write(`${alias} ${c.id} #${sample} ${arm}: ${raw.error ? `ERROR ${raw.error}` : raw.toolCalls.map(t => t.name).join(',') || 'text'}\n`);
      }
    }
  }
}

async function run(revision: string, aliasArg: string, samplesArg?: string, caseArg?: string) {
  const fixture = await readJson<Fixture>(path.join(ROOT, 'fixture.json'));
  for (const [id, fx] of Object.entries(fixture.cases)) {
    if (hash(fx.arms.baseline) !== fx.hashes.baseline || hash(fx.arms.candidate) !== fx.hashes.candidate) throw new Error(`${id}: fixture hash mismatch`);
  }
  const aliases = aliasArg.split(',') as ModelAlias[];
  const missing = aliases.filter(alias => !process.env[resolveAlias(alias).apiKeyEnv]);
  if (missing.length > 0) process.stdout.write(`Skipping aliases without API keys: ${missing.join(', ')}\n`);
  const runnable = aliases.filter(alias => !missing.includes(alias));
  const samples = Number(samplesArg ?? 1);
  const cases = caseArg ? CASES.filter(c => caseArg.split(',').includes(c.id)) : CASES;
  const dir = path.join(ROOT, revision);
  await mkdir(dir, { recursive: true });
  const ledger = await readLedger();
  if (ledger.stopped) throw new Error(`Ledger stopped: ${ledger.stopped}`);
  const planned = runnable.flatMap(alias => cases.flatMap(c => Array.from({ length: samples }, (_, s) => (['baseline', 'candidate'] as const)
    .filter(arm => !existsSync(cellFile(dir, alias, c.id, s, arm)))).flat())).length;
  if (cases.length === 0 || ledger.calls + planned > LIMITS.calls) {
    throw new Error(`${planned} planned calls do not fit: ${ledger.calls} of ${LIMITS.calls} already used.`);
  }
  process.stdout.write(`${dir}\n${planned} calls planned\n`);
  await Promise.all(runnable.map(alias => runLane(alias, cases, samples, fixture, dir, ledger)));
  process.stdout.write(`${JSON.stringify(ledger)}\n`);
}

interface Dump { alias: string; case: RepoIntelCase['id']; sample: number; arm: Arm; text: string; toolCalls: ToolCall[];
  error?: string; observed: Record<string, unknown> }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} …[${text.length - max} more chars]` : text);

/** One blinded packet per case: A/B labels drawn at random per case, the key in a separate file. */
async function pack(revision: string) {
  const dir = path.join(ROOT, revision);
  const dumps = await Promise.all((await readdir(dir)).filter(name => /-(baseline|candidate)\.json$/.test(name))
    .map(name => readJson<Dump>(path.join(dir, name))));
  const key: Record<string, Record<'A' | 'B', Arm>> = {};
  for (const c of CASES) {
    const rows = dumps.filter(d => d.case === c.id);
    if (rows.length === 0) continue;
    const aArm: Arm = randomInt(2) === 0 ? 'baseline' : 'candidate';
    const labelOf = (arm: Arm) => (arm === aArm ? 'A' : 'B');
    key[c.id] = { A: aArm, B: aArm === 'baseline' ? 'candidate' : 'baseline' };
    const view = (d: Dump | undefined) => (d ? { firstToolCalls: d.toolCalls.map(call => ({ name: call.name, input: clip(JSON.stringify(call.input), 400) })),
      textExcerpt: clip(d.text, 700), error: d.error, observed: d.observed } : { missing: true });
    const samples = [...new Set(rows.map(d => `${d.alias}|${d.sample}`))].sort().map(id => {
      const [alias, sample] = id.split('|');
      const find = (label: 'A' | 'B') => rows.find(d => d.alias === alias && String(d.sample) === sample && labelOf(d.arm) === label);
      return { alias, sample: Number(sample), A: view(find('A')), B: view(find('B')) };
    });
    const tally: Record<string, Record<string, Record<string, number>>> = {};
    for (const d of rows) {
      const bucket = (tally[`${d.alias} ${labelOf(d.arm)}`] ??= {});
      for (const [metric, value] of Object.entries(d.observed)) {
        if (typeof value !== 'boolean' && metric !== 'firstTool') continue;
        const slot = (bucket[metric] ??= {});
        const label = String(value);
        slot[label] = (slot[label] ?? 0) + 1;
      }
      if (d.error) (bucket.error ??= {}).true = ((bucket.error ??= {}).true ?? 0) + 1;
    }
    const packet = { revision, case: c.id, question: c.question, rubric: c.rubric, counts: tally, samples };
    await writeFile(path.join(dir, `packet-${c.id}.json`), JSON.stringify(packet, null, 2));
    const lines = [`# ${c.id} (${revision})`, `Question: ${c.question}`, `Rubric: ${c.rubric}`, '', 'Mechanical counts per alias and blinded arm:',
      ...Object.entries(tally).sort().map(([who, metrics]) => `  ${who}: ${Object.entries(metrics).map(([m, v]) => `${m} ${JSON.stringify(v)}`).join('; ')}`), ''];
    for (const s of samples) {
      lines.push(`## ${s.alias} sample ${s.sample}`);
      for (const label of ['A', 'B'] as const) {
        const v = s[label];
        if ('missing' in v) { lines.push(`[${label}] missing`); continue; }
        lines.push(`[${label}] tools: ${v.firstToolCalls.map(t => `${t.name} ${t.input}`).join('\n          ') || '(none)'}${v.error ? `\n    error: ${v.error}` : ''}`);
        lines.push(`    text: ${v.textExcerpt.replace(/\n/g, '\n          ') || '(empty)'}`);
      }
      lines.push('');
    }
    await writeFile(path.join(dir, `packet-${c.id}.txt`), lines.join('\n'));
  }
  await writeFile(path.join(dir, 'unblinding-key.json'), JSON.stringify(key, null, 2));
  process.stdout.write(`${dir}\n`);
}

async function main() {
  if (process.env.REPOINTEL_P0_CAPTURE) return captureLlm(process.env.REPOINTEL_P0_CAPTURE);
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'capture') return capture();
  if (command === 'prepare') return prepare();
  if (command === 'run' && rest[0] && rest[1]) return run(rest[0], rest[1], rest[2], rest[3]);
  if (command === 'pack' && rest[0]) return pack(rest[0]);
  throw new Error('Usage: capture | prepare | run <revision> <aliases> [samples] [cases] | pack <revision>');
}
void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
