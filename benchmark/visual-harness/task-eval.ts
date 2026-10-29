/** Prepare, preflight, then explicitly execute the approved A/B/D paired batch. */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskFixtures } from './task-fixtures.js';
import { assertTaskDumpDirectory } from './task-transport.js';

const exec = promisify(execFile);
const primary = fileURLToPath(new URL('../../', import.meta.url));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2);
const baselineRevision = '1826cc228f299995fe5b22e608c7fbd90c3dc9ee';
const candidateRevision = '3b2d48e8ffeebdd0f14cd81c5c04b65736884938';
interface Plan {
  revision: number; authorization: string; baseline: string; candidate: string;
  roots: Record<string, string>; cells: { id: string; caseId: 'A' | 'B' | 'D'; source: string }[];
  inputRoot: string; oracleSha256: string; ready?: boolean;
}

async function prepare(baseline: string) {
  for (const [root, revision] of [[primary, candidateRevision], [baseline, baselineRevision]]) {
    await exec('git', ['diff', '--exit-code', revision!, '--', 'src', 'packages', 'package-lock.json'], { cwd: root, windowsHide: true });
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-task-r6-'));
  await assertTaskDumpDirectory(directory);
  const inputRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-inputs-'));
  const fixtures = await createTaskFixtures(randomBytes(4));
  const oracle = Object.fromEntries(Object.entries(fixtures).map(([id, fixture]) => [id, fixture.oracle]));
  const cells: Plan['cells'] = [];
  for (const caseId of ['A', 'B', 'D'] as const) {
    const roots = randomInt(2) ? [primary, baseline] : [baseline, primary];
    for (const [index, source] of roots.entries()) {
      const id = `${caseId}-${index ? 'Y' : 'X'}`;
      cells.push({ id, caseId, source });
      const fixture = fixtures[caseId];
      const workspace = path.join(inputRoot, caseId);
      const canonical = path.join(directory, 'inputs', caseId);
      await mkdir(canonical, { recursive: true });
      for (const [file, bytes] of Object.entries(fixture.files)) await writeFile(path.join(canonical, file), bytes);
      await writeFile(path.join(directory, `${id}.input.json`), json({ id, caseId, workspace,
        home: path.join(inputRoot, 'home'), prompt: fixture.prompt + '\n\n本次受控任务最多三次模型响应，每次最多两个工具调用。', images: caseId === 'B' ? [] : fixture.images,
        history: fixture.history, files: Object.fromEntries(Object.entries(fixture.files).map(([file, bytes]) => [file, sha(bytes)])) }), { flag: 'wx' });
    }
  }
  const plan: Plan = { revision: 6, authorization: '',
    baseline: baselineRevision, candidate: candidateRevision, roots: { primary, baseline }, cells, inputRoot, oracleSha256: sha(json(oracle)) };
  await writeFile(path.join(directory, 'plan.json'), json(plan), { flag: 'wx' });
  await writeFile(path.join(directory, 'limits.json'), json({ maxProviderCalls: 26, maxMainResponsesPerCell: 3,
    maxToolsPerResponse: 2, maxOutputTokensPerCall: 2048, maxTotalTokens: 550_000, maxMetadataRequests: 64,
    perArmTokens: { A: 80_000, B: 100_000, D: 80_000 }, timeoutMs: 60_000, retries: 0, fallback: 0, repair: 0,
    judge: 0, child: 0, maxExternalSpendUsd: 2, spendObservation: 'Monthly booster-wallet CNY delta; 1 CNY conservatively counts as USD1. Counter may lag; not an invoice or allocated subscription price.' }), { flag: 'wx' });
  // Truth is emitted only to the controlling Host. It is never written next to
  // public inputs, raw requests, or child process arguments/environment.
  return { directory, oracle, inputRoot };
}

async function run(directory: string, online: boolean) {
  directory = await assertTaskDumpDirectory(directory);
  const planPath = path.join(directory, 'plan.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
  if (online && (!plan.ready || !plan.authorization.trim())) throw new Error('Both historical preflights and fresh human authorization are required before generation.');
  const mode = online ? 'online' : 'offline';
  await writeFile(path.join(directory, `${mode}.started.json`), json({ at: new Date().toISOString() }), { flag: 'wx' });
  if (online) {
    if (!process.env.KIMI_CODE_API_KEY) throw new Error('KIMI_CODE_API_KEY is unavailable.');
    const files = ['task-cell.ts', 'task-transport.ts', 'task-workspace.ts', 'task-eval.live.test.ts', 'task-eval.ts', 'task-fixtures.ts'];
    const harnessSha256 = Object.fromEntries(await Promise.all(files.map(async file => [file,
      sha(await readFile(path.join(primary, 'benchmark', 'visual-harness', file)))])));
    await writeFile(path.join(directory, 'execution-freeze.json'), json({ at: new Date().toISOString(), harnessSha256,
      planSha256: sha(await readFile(planPath)), limitsSha256: sha(await readFile(path.join(directory, 'limits.json'))),
      privateTruth: 'Only in controlling Host memory; digest frozen in plan. No oracle is written to the fixture, raw dump or child environment.',
      control: 'Common task text discloses three main responses/two tools per response. Native/portable ordinary tools retain production behavior. Child generation is refused before dispatch.' }), { flag: 'wx' });
    const response = await fetch('https://api.kimi.com/coding/v1/models', { redirect: 'error', headers: {
      authorization: `Bearer ${process.env.KIMI_CODE_API_KEY}`, 'user-agent': 'KodaX' }, signal: AbortSignal.timeout(15_000) });
    const raw = await response.text(); await writeFile(path.join(directory, 'models.json'), raw, { flag: 'wx' });
    const listing = JSON.parse(raw) as { data?: { id: string }[] };
    const model = listing.data?.find(item => item.id === 'kimi-for-coding');
    if (!response.ok || !model) throw new Error('Frozen Kimi Code model alias unavailable; no fallback.');
    await writeFile(path.join(directory, 'route.json'), json({ model, endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
      resolvedRoute: 'K2.8 Preview without thinking', checked: new Date().toISOString(),
      officialModelSource: 'https://www.kimi.com/code/docs/kimi-code/models.html',
      subscriptionSource: 'https://www.kimi.com/code/docs/kimi-code/membership.html',
      protocol: 'OpenAI Chat Completions', stream: false, max_tokens: 2048, thinking: { type: 'disabled' },
      adaptation: 'Same custom-provider transport on both historical versions. SDK serialization and production tools/messages are retained; physical reply is re-enveloped as SSE for the SDK. This is not the built-in Anthropic kimi-code transport.' }), { flag: 'wx' });
    await writeFile(path.join(directory, 'ledger.json'), json({ calls: 0, accountedCalls: 0, tokens: 0, metadata: 1, stopped: false, cells: {} }), { flag: 'wx' });
  }
  for (const cell of plan.cells) {
    await exec('git', ['diff', '--exit-code', cell.source === primary ? candidateRevision : baselineRevision, '--', 'src', 'packages', 'package-lock.json'], { cwd: cell.source, windowsHide: true });
    const input = JSON.parse(await readFile(path.join(directory, `${cell.id}.input.json`), 'utf8')) as { workspace: string; home: string; files: Record<string, string> };
    for (const target of [input.workspace, input.home]) {
      const relative = path.relative(plan.inputRoot, path.resolve(target));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture reset path.');
      await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true });
    }
    for (const file of Object.keys(input.files)) await copyFile(path.join(directory, 'inputs', cell.caseId, file), path.join(input.workspace, file));
    // Copy only this transparent adapter; production code comes from its actual
    // checkout and that checkout's own workspace aliases/dependencies/build.
    if (cell.source !== primary) for (const file of ['task-cell.ts', 'task-transport.ts', 'task-workspace.ts', 'task-eval.live.test.ts']) {
      await copyFile(path.join(primary, 'benchmark', 'visual-harness', file), path.join(cell.source, 'benchmark', 'visual-harness', file));
    }
    try {
      const result = await exec(process.execPath, [path.join(cell.source, 'node_modules/vitest/vitest.mjs'), 'run', 'benchmark/visual-harness/task-eval.live.test.ts'], {
        cwd: cell.source, windowsHide: true, timeout: cell.caseId === 'B' ? 390_000 : 330_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, KODAX_VISUAL_TASK_DUMP: directory, KODAX_VISUAL_TASK_CELL: cell.id, KODAX_VISUAL_TASK_MODE: mode },
      });
      await writeFile(path.join(directory, `${cell.id}.${mode}.log`), result.stdout + result.stderr, { flag: 'wx' });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      await writeFile(path.join(directory, `${cell.id}.${mode}.log`), (failure.stdout ?? '') + (failure.stderr ?? '') + '\n' + failure.message, { flag: 'wx' });
      throw new Error(`${cell.id} ${mode} preflight/execution failed; inspect preserved log.`, { cause: error });
    }
    process.stdout.write(`${cell.id} ${mode} settled\n`);
  }
  if (!online) {
    plan.ready = true; await writeFile(planPath, json(plan));
  } else {
    const blinded = []; const reveal: Record<string, string> = {};
    for (const caseId of ['A', 'B', 'D']) {
      const pair = plan.cells.filter(cell => cell.caseId === caseId);
      if (randomInt(2)) pair.reverse();
      for (const [index, cell] of pair.entries()) {
        const result = JSON.parse(await readFile(path.join(directory, `${cell.id}.online.result.json`), 'utf8')) as { answer: string; result: { phase: string }; patch?: string; codeValidation?: unknown;
          workspaceEvidence?: { changes: { path: string; before: string | null; after: string | null }[] } };
        const label = index ? 'Y' : 'X';
        const changes = result.workspaceEvidence?.changes.map(change => change.path.startsWith('.agent/managed-tasks/') || change.path.startsWith('.agent/repo-intelligence/')
          ? { path: change.path.replace(/(^|\/)runner-[^/]+/g, '$1<runner>').replace(/(^|\/)run_[^/]+/g, '$1<run>'),
            runtimeArtifact: true, beforeSha256: change.before === null ? null : sha(change.before), afterSha256: change.after === null ? null : sha(change.after),
            content: 'Full content retained in raw; sealed during first quality review to avoid usage/arm disclosure.' } : change);
        blinded.push({ caseId: cell.caseId, label, answer: result.answer, phase: result.result.phase, patch: result.patch, codeValidation: result.codeValidation, changes });
        reveal[`${caseId}-${label}`] = cell.source === primary ? 'candidate' : 'baseline';
      }
    }
    await writeFile(path.join(directory, 'blinded.json'), json(blinded), { flag: 'wx' });
    await writeFile(path.join(directory, 'reveal.json'), json(reveal), { flag: 'wx' });
  }
}

const [, , command, argument] = process.argv;
if (command === 'prepare' && argument) process.stdout.write(json(await prepare(path.resolve(argument))));
else if ((command === 'offline' || command === 'online') && argument) await run(path.resolve(argument), command === 'online');
else throw new Error('Use prepare <baseline-worktree>, offline <dump>, or online <dump>.');
