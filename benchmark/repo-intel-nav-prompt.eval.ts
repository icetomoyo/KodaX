/**
 * RepoIntel v2 navigation prompt eval (Layer 2, one response per cell, model-selected tools never run).
 *   node --import tsx benchmark/repo-intel-nav-prompt.eval.ts capture
 *   node --import tsx benchmark/repo-intel-nav-prompt.eval.ts prepare
 *   node --import tsx benchmark/repo-intel-nav-prompt.eval.ts run <revision> <alias,alias,...> [samples] [N1,N2,...]
 *   node --import tsx benchmark/repo-intel-nav-prompt.eval.ts pack <revision>
 * capture runs the real managed Runtime with the Host's v2 engine (KODAX_REPO_INTELLIGENCE_ENGINE=v2) on a
 * committed snapshot of packages/agent, zero network, and freezes each task's first root request. The candidate
 * arm is that request; the baseline arm drops find_symbol, file_outline and the Repository Map section.
 * Cases, questions and rubric: benchmark/repo-intel-nav-prompt.cases.ts.
 * Raw output goes to <os.tmpdir()>/kodax-eval-dumps/repointel-p2-prompt/.
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
import { CASES, TASKS, type NavCase } from './repo-intel-nav-prompt.cases.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'repointel-p2-prompt');
const SNAPSHOT_REF = '6dbe531c1';
const ENGINE = path.join(REPO, 'native/repo-intel/target/release', `kodax-repo-intel${process.platform === 'win32' ? '.exe' : ''}`);
const LIMITS = { calls: 120, perCell: 1, rounds: 1, outputTokens: 8192, totalTokens: 6_000_000, reservePerCall: 60_000, timeoutMs: 120_000 };
const INDEX_TOOLS = ['find_symbol', 'file_outline'];
const MAP_HEADING = '\n\n## Repository Map\n';
const CONTEXT_END = '\n=== End Managed Run Context ===';

interface FrozenInput { readonly system: string; readonly messages: readonly KodaXMessage[]; readonly tools: readonly KodaXToolDefinition[] }
interface CaptureFile { tasks: Record<string, FrozenInput>; toolResults: Record<string, string> }
type Arm = 'baseline' | 'candidate';
interface CaseFixture { arms: Partial<Record<Arm, FrozenInput>>; hashes: Partial<Record<Arm, string>> }
interface Fixture { snapshotRef: string; cases: Record<string, CaseFixture> }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const workspaceDir = () => path.join(ROOT, 'captures', 'workspace');
const captureFile = () => path.join(ROOT, 'captures', 'capture.json');

/** packages/agent at SNAPSHOT_REF as a committed Git repository, which the engine needs to list files. */
function writeWorkspace(workspace: string): void {
  execFileSync('git', ['init', '-q', workspace], { windowsHide: true });
  const archive = execFileSync('git', ['archive', SNAPSHOT_REF, 'packages/agent'], { cwd: REPO, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-f', '-'], { cwd: workspace, input: archive, windowsHide: true });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: workspace, windowsHide: true });
  run('config', 'core.autocrlf', 'false');
  run('add', '--all');
  run('-c', 'user.name=Eval Fixture', '-c', 'user.email=eval-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline');
}

async function capture() {
  if (existsSync(captureFile())) { process.stdout.write(`kept ${captureFile()}\n`); return; }
  if (!existsSync(ENGINE)) throw new Error(`Build the engine first: ${ENGINE}`);
  if (existsSync(workspaceDir())) throw new Error(`${workspaceDir()} exists without a capture; remove the captures folder by hand`);
  await mkdir(workspaceDir(), { recursive: true });
  writeWorkspace(workspaceDir());
  const env: NodeJS.ProcessEnv = { ...process.env, REPOINTEL_NAV_CAPTURE: '1', KODAX_REPO_INTELLIGENCE_ENGINE: 'v2', KODAX_REPO_INTELLIGENCE_ENGINE_PATH: ENGINE };
  // vite-node with the vitest config resolves @kodax-ai/* to source, so the capture renders the working tree.
  execFileSync(process.execPath, [path.join(REPO, 'node_modules/vite-node/vite-node.mjs'), '-c', 'vitest.config.ts', 'benchmark/repo-intel-nav-prompt.eval.ts'],
    { cwd: REPO, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
}

const hasIndex = (input: FrozenInput) => INDEX_TOOLS.every(name => input.tools.some(tool => tool.name === name))
  && JSON.stringify(input.messages).includes(JSON.stringify(MAP_HEADING).slice(1, -1));

/**
 * Runs under vite-node (REPOINTEL_NAV_CAPTURE set by capture()). A first Run opens the repository in the
 * Host's engine; each task then gets a new session, retried until the index was ready for its first request.
 */
async function captureUnderRuntime(): Promise<void> {
  const workspace = workspaceDir();
  const { KodaXBaseProvider, registerModelProvider } = await import('@kodax-ai/llm');
  const { createKodaXRuntime } = await import('../tests/runtime-fixture.js');
  let captured: FrozenInput | undefined;
  class CaptureProvider extends KodaXBaseProvider {
    readonly name = 'repointel-nav-capture';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'REPOINTEL_CAPTURE_KEY', model: 'capture-model', contextWindow: 128000, supportsThinking: false };
    override isConfigured(): boolean { return true; }
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string) {
      if (tools.length > 1 && !captured) captured = JSON.parse(JSON.stringify({ messages, tools, system })) as FrozenInput;
      return { textBlocks: [{ type: 'text' as const, text: 'capture only' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' as const };
    }
  }
  const unregister = registerModelProvider('repointel-nav-capture', () => new CaptureProvider());
  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(ROOT, 'captures', 'home'), defaultProvider: 'repointel-nav-capture', defaultModel: 'capture-model' });
  const runTask = async (prompt: string): Promise<FrozenInput> => {
    captured = undefined;
    const session = await runtime.sessions.create({ projectPath: workspace });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
    const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt, options: {
      provider: 'repointel-nav-capture', model: 'capture-model', reasoningMode: 'off', lsp: false, maxIter: 2, disablePromptCache: true,
      learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' as const, reasonCodes: ['eval-isolated'] } }),
      agentMode: 'ama', workMode: 'coding',
      context: { executionCwd: workspace, gitRoot: workspace, resolveShellPermissionMode: () => 'full-access' },
    } });
    const result = await handle.result;
    if (result.error) throw new Error(`${result.error.name}: ${result.error.message}`);
    if (!captured) throw new Error('no root request captured');
    return captured;
  };
  const tasks: CaptureFile['tasks'] = {};
  try {
    await runTask('Say hello.');
    for (const task of TASKS) {
      for (let attempt = 0; attempt < 5 && !tasks[task.id]; attempt++) {
        if (attempt > 0) await delay(3_000);
        const input = await runTask(task.task);
        if (hasIndex(input)) tasks[task.id] = input;
      }
      if (!tasks[task.id]) throw new Error(`${task.id}: the index never reached the first request`);
      process.stdout.write(`captured ${task.id}\n`);
    }
  } finally {
    await runtime.close();
    unregister();
  }
  await writeFile(captureFile(), JSON.stringify({ snapshotRef: SNAPSHOT_REF, tasks, toolResults: await continuationResults(workspace) }, null, 2), { flag: 'wx' });
  process.stdout.write(`${captureFile()}\n`);
}

/** What find_symbol returns for each continuation: from a real engine, or the tool's own not-ready answer. */
async function continuationResults(workspace: string): Promise<Record<string, string>> {
  const { createRepoIntelSupervisor } = await import('@kodax-ai/coding');
  const { toolFindSymbol } = await import('../packages/coding/src/tools/repo-intel-navigation.js');
  type Ctx = Parameters<typeof toolFindSymbol>[1];
  const engine = createRepoIntelSupervisor({ launch: { command: ENGINE }, storageRoot: path.join(ROOT, 'captures', 'engine-store'), onLog: () => undefined });
  const real = { root: workspace, request: <T>(method: string, params: Readonly<Record<string, unknown>>) => engine.query<T>(workspace, method, params) };
  const indexing = { root: workspace, request: async <T>(): Promise<T> => ({ hits: [], total: 0, nextOffset: null,
    coverage: { state: 'indexing', indexed: 120, notIndexed: {} } }) as T };
  const ctx = (repoIntel: Ctx['repoIntel']) => ({ backups: new Map(), executionCwd: workspace, gitRoot: workspace, repoIntel }) as Ctx;
  const results: Record<string, string> = {};
  try {
    engine.open(workspace);
    for (let tries = 0; ; tries++) {
      const status = await real.request<{ state: string }>('workspace.status', {}).catch(() => undefined);
      if (status?.state === 'ready') break;
      if (tries > 120) throw new Error('The engine did not finish indexing the snapshot');
      await delay(1_000);
    }
    for (const c of CASES) {
      if (!c.continuation) continue;
      results[c.id] = await toolFindSymbol({ ...c.continuation.input }, ctx(c.continuation.result === 'engine' ? real : indexing));
    }
  } finally {
    await engine.close();
  }
  return results;
}

/** The request a Run gets with no engine: no index tools and no Repository Map section. */
function withoutIndex(input: FrozenInput): FrozenInput {
  const first = input.messages[0]?.content;
  if (typeof first !== 'string') throw new Error('Expected a string first message');
  const start = first.indexOf(MAP_HEADING);
  const next = first.indexOf('\n\n## ', start + MAP_HEADING.length);
  const end = first.indexOf(CONTEXT_END, start);
  if (start < 0 || end < 0) throw new Error('No Repository Map to strip');
  const stripped = first.slice(0, start) + first.slice(next >= 0 && next < end ? next : end);
  const out = { ...input, messages: [{ ...input.messages[0]!, content: stripped }, ...input.messages.slice(1)],
    tools: input.tools.filter(tool => !INDEX_TOOLS.includes(tool.name)) };
  const text = JSON.stringify(out);
  if (text.includes('Repository Map') || INDEX_TOOLS.some(name => text.includes(name))) throw new Error('Index traces survived stripping');
  return out;
}

/** The candidate request followed by the model's find_symbol call and its result. */
function continued(input: FrozenInput, c: NavCase, result: string): FrozenInput {
  const id = `toolu_nav_${c.id}`;
  return { ...input, messages: [...input.messages,
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'find_symbol', input: { ...c.continuation!.input } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] }] };
}

async function prepare() {
  const captured = await readJson<CaptureFile>(captureFile());
  const cases: Record<string, CaseFixture> = {};
  for (const c of CASES) {
    const input = captured.tasks[c.task];
    if (!input || !hasIndex(input)) throw new Error(`${c.id}: capture ${c.task} is missing or has no index`);
    if (input.messages.at(-1)?.role !== 'user') throw new Error(`${c.id}: request must end with a user message`);
    const result = captured.toolResults[c.id];
    if (c.continuation && !result) throw new Error(`${c.id}: no find_symbol result captured`);
    const arms: CaseFixture['arms'] = c.continuation ? { candidate: continued(input, c, result!) } : { baseline: withoutIndex(input), candidate: input };
    cases[c.id] = { arms, hashes: Object.fromEntries(Object.entries(arms).map(([arm, value]) => [arm, hash(value)])) };
    process.stdout.write(`${c.id}: ${Object.keys(arms).join('+')}, tools ${input.tools.length}${result ? `, result: ${result.split('\n')[0]}` : ''}\n`);
  }
  const fixture: Fixture = { snapshotRef: SNAPSHOT_REF, cases };
  await writeFile(path.join(ROOT, 'fixture.json'), JSON.stringify(fixture, null, 2));
  await writeFile(path.join(ROOT, 'manifest.json'), JSON.stringify({ limits: LIMITS, snapshotRef: SNAPSHOT_REF,
    fixtureHash: hash(fixture), cases: CASES.map(({ id, question, rubric }) => ({ id, question, rubric })),
    sources: Object.fromEntries(['benchmark/repo-intel-nav-prompt.eval.ts', 'benchmark/repo-intel-nav-prompt.cases.ts']
      .map(file => [file, createHash('sha256').update(readFileSync(path.join(REPO, file))).digest('hex')])) }, null, 2));
  process.stdout.write(`${path.join(ROOT, 'fixture.json')}\n`);
}

interface ToolCall { name: string; input: unknown }
interface RawResult { text: string; toolCalls: readonly ToolCall[]; usage?: KodaXTokenUsage; durationMs?: number; error?: string }

const callText = (call: ToolCall) => JSON.stringify(call.input);

/** Mechanical observations; the blind semantic review decides the comparison. */
function observe(c: NavCase, raw: RawResult, available: ReadonlySet<string>) {
  const names = raw.toolCalls.map(call => call.name);
  const calls = (name: string) => raw.toolCalls.filter(call => call.name === name);
  return {
    firstTool: names[0] ?? null, tools: names, textOnly: names.length === 0,
    unavailableTools: names.filter(name => !available.has(name)),
    censored: (raw.usage?.outputTokens ?? 0) >= LIMITS.outputTokens,
    findSymbolUsed: names.includes('find_symbol'), fileOutlineUsed: names.includes('file_outline'), grepUsed: names.includes('grep'),
    findSymbolWithPath: calls('find_symbol').some(call => callText(call).includes('"path"')),
    wholeOrSliceRead: c.id === 'N3' && calls('read').some(call => callText(call).includes('actors/controller.ts')),
  };
}

interface Ledger { calls: number; tokens: number; unknownUsage: number; stopped?: string }

async function readLedger(): Promise<Ledger> {
  const file = path.join(ROOT, 'ledger.json');
  return existsSync(file) ? readJson<Ledger>(file) : { calls: 0, tokens: 0, unknownUsage: 0 };
}
const saveLedger = (ledger: Ledger) => writeFile(path.join(ROOT, 'ledger.json'), JSON.stringify(ledger, null, 2));
const cellFile = (dir: string, alias: string, caseId: string, sample: number, arm: Arm) => path.join(dir, `${alias.replace('/', '_')}-${caseId}-${sample}-${arm}.json`);
const armsOf = (fx: CaseFixture) => (Object.keys(fx.arms) as Arm[]);

/** One alias: cases, samples and arms in random order, one request in flight; reserves before each call. */
async function runLane(alias: ModelAlias, cases: readonly NavCase[], samples: number, fixture: Fixture, dir: string, ledger: Ledger) {
  for (const c of cases) {
    const fx = fixture.cases[c.id]!;
    const available = new Set(fx.arms.candidate!.tools.map(tool => tool.name));
    for (let sample = 0; sample < samples; sample++) {
      const arms = armsOf(fx).sort(() => randomInt(2) - 0.5);
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
        const input = fx.arms[arm]!;
        const raw: RawResult = await runOneShot(alias, { systemPrompt: input.system, priorMessages: [...input.messages],
          tools: input.tools, timeoutMs: LIMITS.timeoutMs, maxOutputTokens: LIMITS.outputTokens })
          .catch((error: unknown) => ({ error: String(error), text: '', toolCalls: [] }));
        if (raw.usage) ledger.tokens += raw.usage.totalTokens - LIMITS.reservePerCall;
        else ledger.unknownUsage += 1;
        await saveLedger(ledger);
        const target = resolveAlias(alias);
        await writeFile(file, JSON.stringify({ alias, provider: target.provider, model: target.model, case: c.id, sample, arm,
          inputHash: fx.hashes[arm], observed: observe(c, raw, available), ...raw }, null, 2));
        process.stdout.write(`${alias} ${c.id} #${sample} ${arm}: ${raw.error ? `ERROR ${raw.error}` : raw.toolCalls.map(t => t.name).join(',') || 'text'}\n`);
      }
    }
  }
}

async function run(revision: string, aliasArg: string, samplesArg?: string, caseArg?: string) {
  const fixture = await readJson<Fixture>(path.join(ROOT, 'fixture.json'));
  for (const [id, fx] of Object.entries(fixture.cases)) {
    if (armsOf(fx).some(arm => hash(fx.arms[arm]) !== fx.hashes[arm])) throw new Error(`${id}: fixture hash mismatch`);
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
  const planned = runnable.flatMap(alias => cases.flatMap(c => Array.from({ length: samples }, (_, s) => armsOf(fixture.cases[c.id]!)
    .filter(arm => !existsSync(cellFile(dir, alias, c.id, s, arm)))).flat())).length;
  if (cases.length === 0 || ledger.calls + planned > LIMITS.calls) {
    throw new Error(`${planned} planned calls do not fit: ${ledger.calls} of ${LIMITS.calls} already used.`);
  }
  process.stdout.write(`${dir}\n${planned} calls planned\n`);
  await Promise.all(runnable.map(alias => runLane(alias, cases, samples, fixture, dir, ledger)));
  process.stdout.write(`${JSON.stringify(ledger)}\n`);
}

interface Dump { alias: string; case: NavCase['id']; sample: number; arm: Arm; text: string; toolCalls: ToolCall[];
  error?: string; observed: Record<string, unknown> }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} …[${text.length - max} more chars]` : text);

/** One blinded packet per case: A/B labels drawn at random per two-arm case, the key in a separate file. */
async function pack(revision: string) {
  const dir = path.join(ROOT, revision);
  const dumps = await Promise.all((await readdir(dir)).filter(name => /-(baseline|candidate)\.json$/.test(name))
    .map(name => readJson<Dump>(path.join(dir, name))));
  const key: Record<string, Record<'A' | 'B', Arm>> = {};
  for (const c of CASES) {
    const rows = dumps.filter(d => d.case === c.id);
    if (rows.length === 0) continue;
    const aArm: Arm = c.continuation || randomInt(2) === 0 ? 'candidate' : 'baseline';
    const labelOf = (arm: Arm) => (arm === aArm ? 'A' : 'B');
    key[c.id] = { A: aArm, B: aArm === 'baseline' ? 'candidate' : 'baseline' };
    const lines = [`# ${c.id} (${revision})`, `Question: ${c.question}`, `Rubric: ${c.rubric}`, ''];
    const tally: Record<string, Record<string, number>> = {};
    for (const d of rows) {
      for (const [metric, value] of Object.entries(d.observed)) {
        if (typeof value !== 'boolean' || !value) continue;
        const who = `${d.alias} ${labelOf(d.arm)}`;
        (tally[who] ??= {})[metric] = ((tally[who] ??= {})[metric] ?? 0) + 1;
      }
    }
    lines.push('True-flag counts per alias and blinded arm:', ...Object.entries(tally).sort().map(([who, m]) => `  ${who}: ${JSON.stringify(m)}`), '');
    for (const id of [...new Set(rows.map(d => `${d.alias}|${d.sample}`))].sort()) {
      const [alias, sample] = id.split('|');
      lines.push(`## ${alias} sample ${sample}`);
      for (const label of ['A', 'B'] as const) {
        const d = rows.find(row => row.alias === alias && String(row.sample) === sample && labelOf(row.arm) === label);
        if (!d) continue;
        lines.push(`[${label}] tools: ${d.toolCalls.map(t => `${t.name} ${clip(JSON.stringify(t.input), 400)}`).join('\n          ') || '(none)'}${d.error ? `\n    error: ${d.error}` : ''}`);
        lines.push(`    text: ${clip(d.text, 700).replace(/\n/g, '\n          ') || '(empty)'}`);
      }
      lines.push('');
    }
    await writeFile(path.join(dir, `packet-${c.id}.txt`), lines.join('\n'));
  }
  await writeFile(path.join(dir, 'unblinding-key.json'), JSON.stringify(key, null, 2));
  process.stdout.write(`${dir}\n`);
}

async function main() {
  if (process.env.REPOINTEL_NAV_CAPTURE) return captureUnderRuntime();
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'capture') return capture();
  if (command === 'prepare') return prepare();
  if (command === 'run' && rest[0] && rest[1]) return run(rest[0], rest[1], rest[2], rest[3]);
  if (command === 'pack' && rest[0]) return pack(rest[0]);
  throw new Error('Usage: capture | prepare | run <revision> <aliases> [samples] [cases] | pack <revision>');
}
void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
