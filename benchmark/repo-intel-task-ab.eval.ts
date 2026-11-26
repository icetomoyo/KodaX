/**
 * RepoIntel v2 task A/B: whole tasks through the managed Runtime, with the Host's v2 engine on and off.
 *   node --import tsx benchmark/repo-intel-task-ab.eval.ts prepare
 *   node --import tsx benchmark/repo-intel-task-ab.eval.ts run <revision> <alias,alias,...> [reps] [T1,T2,...]
 *   node --import tsx benchmark/repo-intel-task-ab.eval.ts rejudge <revision>
 *   node --import tsx benchmark/repo-intel-task-ab.eval.ts report <revision>
 * End to end, so Layer 3.5 under benchmark/EVAL_GUIDELINES.md; the owner approved this plan (design doc §11).
 * Each (alias, arm) has its own committed snapshot of this repository and its own in-process Runtime, kept for
 * the whole run so the on arm's index stays warm as on a long-lived Host. The arms differ only in
 * KODAX_REPO_INTELLIGENCE_ENGINE=v2 when their Runtime is created. Provider calls are metered at the provider
 * class, children included, and a Run is stopped at its call, tool-call, token or time cap.
 * Cells are resumable: a cell with a result file is not run again.
 * Tasks, hidden checks and truth: benchmark/repo-intel-task-ab.cases.ts.
 * Raw output goes to <os.tmpdir()>/kodax-eval-dumps/repointel-p2-ab/; the lanes live in <LOCALAPPDATA>/kodax-eval-lanes/repointel-p2-ab/.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KodaXBaseProvider, KodaXMessage, KodaXStreamResult, KodaXToolDefinition } from '@kodax-ai/llm';
import { resolveAlias, type ModelAlias } from './harness/aliases.js';
import { TASKS, type AbTask, type AbTaskId } from './repo-intel-task-ab.cases.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'repointel-p2-ab');
// Outside the system temp folder: permission code treats temp as writable, which flips plan-mode tests.
const LANES = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'kodax-eval-lanes', 'repointel-p2-ab');
const SNAPSHOT_REF = '9679a424d';
const POOL: readonly ModelAlias[] = ['ds/v4flash', 'kimi'];
const ENGINE = path.join(REPO, 'native/repo-intel/target/release', `kodax-repo-intel${process.platform === 'win32' ? '.exe' : ''}`);
// The budget counts billed-at-full-price tokens: input that missed the cache, plus output. The owner chose this after
// the pilot (r3), where 96% of 10.8M tokens were cache reads and the full run would have been about 65M in total.
const LIMITS = {
  uncachedTokens: 30_000_000, reservePerRun: 500_000, callsPerRun: 40, toolCallsPerRun: 150,
  wallMs: 20 * 60_000, judgeMs: 8 * 60_000, settleMs: 20_000, indexAttempts: 10,
};
const INDEX_TOOLS = ['find_symbol', 'file_outline'];
const MAP_HEADING = '## Repository Map';
const FORBIDDEN = /\bas any\b|:\s*any\b|@ts-(?:ignore|nocheck|expect-error)|\b(?:it|describe|test)\.(?:skip|only)\(/;

type Arm = 'on' | 'off';
const ARMS: readonly Arm[] = ['on', 'off'];
interface LaneCommits { base: string; T2: string }
interface Judgement {
  pass: boolean;
  guard: string[];
  tsc?: { ok: boolean; tail: string };
  tests?: { ok: boolean; tail: string };
  listed?: string[];
  missing?: string[];
  extra?: string[];
}
interface Meter {
  calls: number; toolCalls: number;
  tokens: { total: number; input: number; output: number; cachedRead: number };
  tools: Record<string, number>;
  indexAtStart?: { tools: boolean; map: boolean };
  capped?: string;
  /** The last request's messages: an aborted run returns no transcript. */
  lastMessages?: readonly KodaXMessage[];
  stop: (reason: string) => void;
}
interface Cell {
  alias: ModelAlias; arm: Arm; task: AbTaskId; rep: number;
  phase: string; error?: string; wallMs: number;
  calls: number; toolCalls: number; tokens: Meter['tokens']; tools: Record<string, number>;
  indexAtStart?: Meter['indexAtStart']; indexAttempts?: number; capped?: string;
  answer: string; judge: Judgement;
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const slug = (alias: ModelAlias) => alias.replace(/[^\w.-]+/g, '-');
const laneDir = (alias: ModelAlias, arm: Arm) => path.join(LANES, `${slug(alias)}-${arm}`);
const lanesFile = () => path.join(LANES, 'lanes.json');
const cellFile = (revision: string, alias: ModelAlias, arm: Arm, task: AbTaskId, rep: number) =>
  path.join(ROOT, revision, 'cells', `${slug(alias)}-${arm}-${task}-r${rep}.json`);
const taskById = (id: AbTaskId): AbTask => {
  const task = TASKS.find(candidate => candidate.id === id);
  if (!task) throw new Error(`unknown task ${id}`);
  return task;
};

function git(lane: string, args: readonly string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: lane, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...(input === undefined ? {} : { input }),
    env: { ...process.env, GIT_AUTHOR_NAME: 'Eval Fixture', GIT_AUTHOR_EMAIL: 'eval-fixture@example.invalid', GIT_AUTHOR_DATE: '2026-11-26T00:00:00Z',
      GIT_COMMITTER_NAME: 'Eval Fixture', GIT_COMMITTER_EMAIL: 'eval-fixture@example.invalid', GIT_COMMITTER_DATE: '2026-11-26T00:00:00Z' },
  });
}

/** The repository at SNAPSHOT_REF as one commit, and the planted-bug variant as an unrelated one-commit history. */
async function writeLane(lane: string): Promise<LaneCommits> {
  await mkdir(lane, { recursive: true });
  git(lane, ['init', '-q']);
  const archive = execFileSync('git', ['archive', SNAPSHOT_REF], { cwd: REPO, windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-f', '-'], { cwd: lane, input: archive, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  git(lane, ['config', 'core.autocrlf', 'false']);
  git(lane, ['add', '--all']);
  git(lane, ['commit', '-qm', 'Snapshot', '--no-gpg-sign']);
  const base = git(lane, ['rev-parse', 'HEAD']).trim();
  const plant = taskById('T2').plant!;
  const file = path.join(lane, plant.file);
  const source = readFileSync(file, 'utf8');
  if (source.split(plant.from).length !== 2) throw new Error(`plant anchor must occur once in ${plant.file}`);
  await writeFile(file, source.replace(plant.from, plant.to));
  git(lane, ['add', plant.file]);
  const T2 = git(lane, ['commit-tree', git(lane, ['write-tree']).trim(), '-m', 'Snapshot']).trim();
  git(lane, ['checkout', '-q', '-f', base]);
  return { base, T2 };
}

function resetLane(lane: string, commit: string): void {
  git(lane, ['checkout', '-q', '-f', '-B', 'main', commit]);
  // node_modules lives in the lanes' parent folder (a junction to this repository's), never inside a lane.
  // The llm build stays: the agent package's project reference type-checks against it, as in a developer checkout.
  git(lane, ['clean', '-q', '-f', '-d', '-x', '-e', '/packages/llm/dist/']);
  // Agents stash work to compare against the baseline; a stash left behind would hand one run's edits to the next.
  git(lane, ['stash', 'clear']);
  // In r3 a ds-off Run removed packages/llm/dist; later agent type-checks then failed in files no one had touched.
  buildLlm(lane);
}

/** Builds the llm package once per lane, the way a developer checkout already has it. */
function buildLlm(lane: string): void {
  if (existsSync(path.join(lane, 'packages/llm/dist/index.d.ts'))) return;
  const built = run(lane, [path.join(LANES, 'node_modules/typescript/bin/tsc'), '-b', 'packages/llm/tsconfig.json']);
  if (!built.ok) throw new Error(`llm build failed in ${lane}\n${built.tail}`);
}

function run(lane: string, args: readonly string[]): { ok: boolean; tail: string } {
  const result = spawnSync(process.execPath, args, { cwd: lane, encoding: 'utf8', windowsHide: true, timeout: LIMITS.judgeMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
  return { ok: result.status === 0, tail: output.slice(-4000) };
}

/** The paths after the answer's last `CALLERS:` line. */
function listedCallers(answer: string): string[] {
  const at = answer.lastIndexOf('CALLERS:');
  if (at < 0) return [];
  const paths = answer.slice(at).match(/[\w@.-]+(?:\/[\w@.-]+)+\.tsx?/g) ?? [];
  return [...new Set(paths.map(entry => entry.replace(/^\.\//, '')))];
}

function judge(lane: string, task: AbTask, answer: string, diff: string): Judgement {
  if (task.callers) {
    const listed = listedCallers(answer);
    const missing = task.callers.filter(file => !listed.includes(file));
    const extra = listed.filter(file => !task.callers!.includes(file));
    return { pass: missing.length === 0 && extra.length === 0, guard: [], listed, missing, extra };
  }
  const guard = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++') && FORBIDDEN.test(line));
  for (const file of task.hidden) execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', path.join(lane, file.path), file.content]);
  const modules = path.join(LANES, 'node_modules');
  // Grade the source change: a Run that removed the llm build must not fail on files it never touched.
  if (task.tsconfig) buildLlm(lane);
  const tsc = task.tsconfig ? run(lane, [path.join(modules, 'typescript/bin/tsc'), '-p', task.tsconfig, '--noEmit']) : undefined;
  const tests = task.tests.length ? run(lane, [path.join(modules, 'vitest/vitest.mjs'), 'run', ...task.tests]) : undefined;
  return { pass: guard.length === 0 && (tsc?.ok ?? true) && (tests?.ok ?? true), guard, tsc, tests };
}

function changes(lane: string): string {
  git(lane, ['add', '--all']);
  return git(lane, ['diff', '--cached', '--binary', 'HEAD']);
}

async function prepare(): Promise<void> {
  await mkdir(LANES, { recursive: true });
  const modules = path.join(LANES, 'node_modules');
  if (!existsSync(modules)) symlinkSync(path.join(REPO, 'node_modules'), modules, 'junction');
  const lanes: Record<string, LaneCommits> = existsSync(lanesFile()) ? await readJson(lanesFile()) : {};
  for (const alias of POOL) for (const arm of ARMS) {
    const lane = laneDir(alias, arm);
    if (lanes[lane]) continue;
    if (existsSync(lane)) throw new Error(`${lane} exists without a lanes.json entry; remove it by hand`);
    lanes[lane] = await writeLane(lane);
    process.stdout.write(`lane ${lane}\n`);
  }
  for (const alias of POOL) for (const arm of ARMS) buildLlm(laneDir(alias, arm));
  await writeFile(lanesFile(), JSON.stringify(lanes, null, 2));
  await selfCheck(laneDir(POOL[0]!, 'off'), lanes[laneDir(POOL[0]!, 'off')]!);
}

/** The graders must fail every untouched baseline and pass the known answers. */
async function selfCheck(lane: string, commits: LaneCommits): Promise<void> {
  const expect = (label: string, judgement: Judgement, pass: boolean) => {
    process.stdout.write(`${label}: ${judgement.pass ? 'pass' : 'fail'}\n`);
    if (judgement.pass !== pass) throw new Error(`self-check ${label}: expected ${pass ? 'pass' : 'fail'}\n${JSON.stringify(judgement, null, 2)}`);
  };
  for (const task of TASKS.filter(candidate => !candidate.callers)) {
    resetLane(lane, task.plant ? commits.T2 : commits.base);
    expect(`${task.id} baseline`, judge(lane, task, '', ''), false);
  }
  resetLane(lane, commits.base);
  expect('T2 without the planted bug', judge(lane, taskById('T2'), '', ''), true);
  resetLane(lane, commits.base);
  /** Anchors are written with `\n`; the snapshot keeps the repository's own line endings. */
  const edit = async (file: string, from: string, to: string) => {
    const full = path.join(lane, file);
    const source = await readFile(full, 'utf8');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const [anchor, replacement] = [from, to].map(text => text.replace(/\n/g, eol)) as [string, string];
    if (!source.includes(anchor)) throw new Error(`self-check anchor missing in ${file}`);
    await writeFile(full, source.replace(anchor, replacement));
  };
  await edit('packages/agent/src/messaging/types.ts', "export type MessagePriority = 'user' | 'background';", "export type MessagePriority = 'urgent' | 'user' | 'background';");
  await edit('packages/agent/src/messaging/queue.ts', '  user: 0,\n  background: 1,', '  urgent: 0,\n  user: 1,\n  background: 2,');
  expect('T4 reference answer', judge(lane, taskById('T4'), '', changes(lane)), true);
  const t3 = taskById('T3');
  expect('T3 reference answer', judge(lane, t3, `They are:\nCALLERS:\n${t3.callers!.map(file => `- \`${file}\``).join('\n')}`, ''), true);
  expect('T3 with an extra file', judge(lane, t3, `CALLERS:\n${[...t3.callers!, 'packages/coding/src/repo-intelligence/semantic-worker.ts'].join('\n')}`, ''), false);
  resetLane(lane, commits.base);
}

async function cells(revision: string): Promise<Cell[]> {
  const dir = path.join(ROOT, revision, 'cells');
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter(name => name.endsWith('.json') && !name.endsWith('.messages.json'));
  return Promise.all(names.map(name => readJson<Cell>(path.join(dir, name))));
}

async function runOuter(revision: string, aliases: readonly ModelAlias[], reps: number, tasks: readonly AbTaskId[]): Promise<void> {
  if (!existsSync(lanesFile())) throw new Error('run prepare first');
  if (!existsSync(ENGINE)) throw new Error(`Build the engine first: ${ENGINE}`);
  const env: NodeJS.ProcessEnv = { ...process.env, KODAX_TASK_AB: JSON.stringify({ revision, aliases, reps, tasks }), KODAX_REPO_INTELLIGENCE_ENGINE_PATH: ENGINE };
  delete env.KODAX_REPO_INTELLIGENCE_ENGINE;
  // vite-node with the vitest config resolves @kodax-ai/* to source, so the Runtime is the working tree's.
  execFileSync(process.execPath, [path.join(REPO, 'node_modules/vite-node/vite-node.mjs'), '-c', 'vitest.config.ts', 'benchmark/repo-intel-task-ab.eval.ts'],
    { cwd: REPO, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
}

/** Runs under vite-node, started by runOuter. */
async function runUnderRuntime(): Promise<void> {
  const config = JSON.parse(process.env.KODAX_TASK_AB!) as { revision: string; aliases: ModelAlias[]; reps: number; tasks: AbTaskId[] };
  // vite-node sets NODE_ENV=development. The agent's shell and the judge inherit it, and the coding tests then take
  // the production path and fail (revision r2). A real CLI Host has no NODE_ENV.
  delete process.env.NODE_ENV;
  const { KodaXBaseProvider, registerModelProvider, getProvider } = await import('@kodax-ai/llm');
  const { createKodaXRuntime } = await import('../tests/runtime-fixture.js');
  type Runtime = Awaited<ReturnType<typeof createKodaXRuntime>>;
  const lanes = await readJson<Record<string, LaneCommits>>(lanesFile());
  let spent = (await cells(config.revision)).reduce((sum, cell) => sum + cell.tokens.total - cell.tokens.cachedRead, 0);
  const meters = new Map<string, Meter>();
  let budgetStop = false;

  for (const alias of config.aliases) {
    const prototype = Object.getPrototypeOf(getProvider(resolveAlias(alias).provider)) as KodaXBaseProvider;
    if (Object.prototype.hasOwnProperty.call(prototype, 'stream')) continue;
    const original = prototype.stream;
    Object.defineProperty(prototype, 'stream', { configurable: true, writable: true, value: async function metered(this: KodaXBaseProvider, ...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const meter = meters.get(this.name);
      if (!meter) return original.apply(this, args);
      if (meter.capped) throw new Error(`task A/B cap reached: ${meter.capped}`);
      if (meter.calls >= LIMITS.callsPerRun) { meter.stop('calls'); throw new Error('task A/B cap reached: calls'); }
      const [messages, tools, system] = args;
      meter.calls++;
      meter.lastMessages = messages;
      meter.indexAtStart ??= { tools: INDEX_TOOLS.every(name => tools.some(tool => tool.name === name)), map: `${system}${JSON.stringify(messages)}`.includes(MAP_HEADING) };
      const result = await original.apply(this, args);
      const usage = result.usage;
      if (usage) {
        meter.tokens.total += usage.totalTokens; meter.tokens.input += usage.inputTokens; meter.tokens.output += usage.outputTokens;
        meter.tokens.cachedRead += usage.cachedReadTokens ?? 0; spent += usage.totalTokens - (usage.cachedReadTokens ?? 0);
      }
      for (const block of result.toolBlocks) meter.tools[block.name] = (meter.tools[block.name] ?? 0) + 1;
      meter.toolCalls += result.toolBlocks.length;
      if (meter.toolCalls > LIMITS.toolCallsPerRun) meter.stop('tool calls');
      if (spent > LIMITS.uncachedTokens) { budgetStop = true; meter.stop('uncached tokens'); }
      return result;
    } });
  }

  let captured: { tools: boolean; map: boolean } | undefined;
  const lastCapture = () => captured;
  class CaptureProvider extends KodaXBaseProvider {
    readonly name = 'task-ab-capture';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'TASK_AB_CAPTURE_KEY', model: 'capture-model', contextWindow: 128000, supportsThinking: false };
    override isConfigured(): boolean { return true; }
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string) {
      if (tools.length > 1 && !captured) captured = { tools: INDEX_TOOLS.every(name => tools.some(tool => tool.name === name)), map: `${system}${JSON.stringify(messages)}`.includes(MAP_HEADING) };
      return { textBlocks: [{ type: 'text' as const, text: 'capture only' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' as const };
    }
  }
  const unregister = registerModelProvider('task-ab-capture', () => new CaptureProvider());
  let captureLock: Promise<unknown> = Promise.resolve();

  const startRun = async (runtime: Runtime, lane: string, prompt: string, provider: string, model: string, maxIter: number) => {
    const session = await runtime.sessions.create({ projectPath: lane });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: lane });
    const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt, options: {
      // kimi-for-coding always thinks and rejects the reasoning 'none' an unset Run sends; deepseek keeps the pilot's default.
      provider, model, maxIter, ...(provider === 'task-ab-capture' ? { reasoningMode: 'off' as const } : provider === 'kimi-code' ? { reasoningMode: 'auto' as const } : {}),
      learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' as const, reasonCodes: ['eval-isolated'] } }),
      agentMode: 'ama', workMode: 'coding',
      context: { executionCwd: lane, gitRoot: lane, resolveShellPermissionMode: () => 'full-access' },
    } });
    return { session, handle };
  };

  /** Capture-only Runs, zero network, until a first request carries the index. One lane at a time: `captured` is shared. */
  const ensureIndex = (runtime: Runtime, lane: string): Promise<number> => {
    const attempt = async (): Promise<number> => {
      for (let tries = 1; tries <= LIMITS.indexAttempts; tries++) {
        captured = undefined;
        const { session, handle } = await startRun(runtime, lane, 'Say hello.', 'task-ab-capture', 'capture-model', 2);
        await handle.result;
        await runtime.sessions.delete(session.id);
        const seen = lastCapture();
        if (seen?.tools && seen.map) return tries;
        await delay(3_000);
      }
      return -1;
    };
    const next = captureLock.then(attempt);
    captureLock = next.catch(() => undefined);
    return next;
  };

  const runtimes = new Map<string, Runtime>();
  for (const alias of config.aliases) for (const arm of ARMS) {
    const target = resolveAlias(alias);
    if (arm === 'on') process.env.KODAX_REPO_INTELLIGENCE_ENGINE = 'v2';
    try {
      runtimes.set(`${alias}:${arm}`, await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(ROOT, config.revision, 'homes', `${slug(alias)}-${arm}`),
        defaultProvider: target.provider, defaultModel: target.model }));
    } finally {
      delete process.env.KODAX_REPO_INTELLIGENCE_ENGINE;
    }
  }

  const runCell = async (alias: ModelAlias, arm: Arm, task: AbTask, rep: number): Promise<void> => {
    const target = resolveAlias(alias);
    const runtime = runtimes.get(`${alias}:${arm}`)!;
    const lane = laneDir(alias, arm);
    const commits = lanes[lane]!;
    resetLane(lane, task.plant ? commits.T2 : commits.base);
    await delay(LIMITS.settleMs);
    const indexAttempts = arm === 'on' ? await ensureIndex(runtime, lane) : undefined;
    const meter: Meter = { calls: 0, toolCalls: 0, tokens: { total: 0, input: 0, output: 0, cachedRead: 0 }, tools: {}, stop: () => undefined };
    meters.set(target.provider, meter);
    const started = Date.now();
    const { session, handle } = await startRun(runtime, lane, task.prompt, target.provider, target.model, LIMITS.callsPerRun);
    meter.stop = reason => {
      if (meter.capped) return;
      meter.capped = reason;
      void runtime.runs.abort(handle.runId).catch((error: unknown) => process.stderr.write(`stop failed: ${String(error)}\n`));
    };
    const timer = setTimeout(() => meter.stop('time'), LIMITS.wallMs);
    const result = await handle.result.finally(() => clearTimeout(timer));
    const wallMs = Date.now() - started;
    meters.delete(target.provider);
    const answer = result.result?.lastText ?? '';
    const diff = changes(lane);
    const out = cellFile(config.revision, alias, arm, task.id, rep);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out.replace(/\.json$/, '.diff'), diff);
    await writeFile(out.replace(/\.json$/, '.messages.json'), JSON.stringify(result.result?.messages ?? meter.lastMessages ?? [], null, 1));
    const cell: Cell = {
      alias, arm, task: task.id, rep, phase: result.phase, ...(result.error ? { error: `${result.error.name}: ${result.error.message}` } : {}),
      wallMs, calls: meter.calls, toolCalls: meter.toolCalls, tokens: meter.tokens, tools: meter.tools,
      indexAtStart: meter.indexAtStart, indexAttempts, capped: meter.capped, answer, judge: judge(lane, task, answer, diff),
    };
    await writeFile(out, JSON.stringify(cell, null, 2));
    await runtime.sessions.delete(session.id);
    process.stdout.write(`${alias} ${arm} ${task.id} r${rep}: ${cell.judge.pass ? 'PASS' : 'fail'} calls=${cell.calls} tokens=${cell.tokens.total} ${Math.round(wallMs / 1000)}s${cell.capped ? ` capped=${cell.capped}` : ''}${cell.error ? ` error=${cell.error}` : ''}\n`);
  };

  const lane = async (alias: ModelAlias) => {
    for (let rep = 1; rep <= config.reps; rep++) {
      for (const [index, id] of config.tasks.entries()) {
        const order: readonly Arm[] = (rep + index) % 2 === 0 ? ['on', 'off'] : ['off', 'on'];
        for (const arm of order) {
          if (existsSync(cellFile(config.revision, alias, arm, id, rep))) continue;
          if (budgetStop || spent + LIMITS.reservePerRun > LIMITS.uncachedTokens) { budgetStop = true; process.stdout.write(`${alias}: token budget reached, stopping\n`); return; }
          await runCell(alias, arm, taskById(id), rep);
        }
      }
    }
  };
  try {
    await Promise.all(config.aliases.map(lane));
  } finally {
    for (const runtime of runtimes.values()) await runtime.close();
    unregister();
  }
  process.stdout.write(`spent ${spent} uncached tokens\n`);
}

async function rejudge(revision: string): Promise<void> {
  const lanes = await readJson<Record<string, LaneCommits>>(lanesFile());
  const dir = path.join(ROOT, revision, 'cells');
  for (const cell of await cells(revision)) {
    const task = taskById(cell.task);
    const lane = laneDir(cell.alias, cell.arm);
    resetLane(lane, task.plant ? lanes[lane]!.T2 : lanes[lane]!.base);
    const name = `${slug(cell.alias)}-${cell.arm}-${cell.task}-r${cell.rep}`;
    const diff = await readFile(path.join(dir, `${name}.diff`), 'utf8');
    if (diff.trim()) git(lane, ['apply', '--binary', '--whitespace=nowarn', '-'], diff);
    const judgement = judge(lane, task, cell.answer, diff);
    resetLane(lane, lanes[lane]!.base);
    if (judgement.pass !== cell.judge.pass) process.stdout.write(`${name}: ${cell.judge.pass} -> ${judgement.pass}\n`);
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ ...cell, judge: judgement }, null, 2));
  }
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

async function report(revision: string): Promise<void> {
  const all = await cells(revision);
  const groups = new Map<string, Cell[]>();
  for (const cell of all) for (const key of [`${cell.alias} ${cell.task} ${cell.arm}`, `${cell.alias} all ${cell.arm}`, `all all ${cell.arm}`]) {
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => ({
    key, n: group.length, pass: group.filter(cell => cell.judge.pass).length,
    tokens: median(group.map(cell => cell.tokens.total)), sumTokens: group.reduce((sum, cell) => sum + cell.tokens.total, 0),
    calls: median(group.map(cell => cell.calls)), seconds: median(group.map(cell => Math.round(cell.wallMs / 1000))),
    capped: group.filter(cell => cell.capped).length, errors: group.filter(cell => cell.error).length,
    indexTools: group.reduce((sum, cell) => sum + (cell.tools.find_symbol ?? 0) + (cell.tools.file_outline ?? 0), 0),
    indexMissing: group.filter(cell => cell.arm === 'on' && !(cell.indexAtStart?.tools && cell.indexAtStart.map)).length,
  }));
  await writeFile(path.join(ROOT, revision, 'report.json'), JSON.stringify(rows, null, 2));
  process.stdout.write('group\tn\tpass\tmedTokens\tsumTokens\tmedCalls\tmedSec\tcapped\terrors\tindexToolCalls\tindexMissing\n');
  for (const row of rows) process.stdout.write(`${row.key}\t${row.n}\t${row.pass}\t${row.tokens}\t${row.sumTokens}\t${row.calls}\t${row.seconds}\t${row.capped}\t${row.errors}\t${row.indexTools}\t${row.indexMissing}\n`);
}

async function main(): Promise<void> {
  if (process.env.KODAX_TASK_AB) return runUnderRuntime();
  const [command, revision, aliases, reps, tasks] = process.argv.slice(2);
  if (command === 'prepare') return prepare();
  if (!revision) throw new Error('usage: prepare | run <revision> <aliases> [reps] [tasks] | rejudge <revision> | report <revision>');
  if (command === 'run') {
    const chosen = (aliases ?? '').split(',').filter(Boolean) as ModelAlias[];
    if (!chosen.length || chosen.some(alias => !POOL.includes(alias))) throw new Error(`aliases must come from ${POOL.join(', ')}`);
    return runOuter(revision, chosen, Number(reps ?? 3), (tasks ? tasks.split(',') : TASKS.map(task => task.id)) as AbTaskId[]);
  }
  if (command === 'rejudge') return rejudge(revision);
  if (command === 'report') return report(revision);
  throw new Error(`unknown command ${command}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
