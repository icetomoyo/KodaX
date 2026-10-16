/** Manual, bounded control-contract pilot. Raw evidence stays in OS temporary storage. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getCostRate, getProviderModels } from '../packages/llm/src/index.js';
import { CONTROL_CONTRACT_CASES } from '../benchmark/datasets/control-contracts/cases.js';
import { EDIT_LIMITS, EditRevisionBudget, type EditRoute } from './first-turn-edit-eval-support.js';
import { inputHash, firstTurnReasoningFor, type FrozenInput, type BudgetSnapshot } from './first-turn-eval-support.js';
import { runEditRuntimeSmoke, runEditSmokeLanes } from './first-turn-edit-runtime-smoke.js';
import { writeControlEvidence } from './control-contract-artifacts.js';

const REVISION = 'control-contract-smoke-v6';
const CONTROL_LIMITS = Object.freeze({ ...EDIT_LIMITS, plannedLayer2Calls: 12, plannedSmokeCalls: 6 });
interface Row { route: string; provider: string; model: string; caseId: string; rubric: string; input: FrozenInput; hash: string }
interface Manifest {
  revision: string; limits: typeof CONTROL_LIMITS; routes: readonly EditRoute[];
  inputs: Record<'baseline' | 'candidate', string>; sourceHashes: Record<string, string>;
  cases: typeof CONTROL_CONTRACT_CASES; analysis: string;
  pairedReview: { directory: string; manifestHash: string; evidenceHash: string; reviewHash: string; failureHash: string; driverHash: string };
}
interface Ledger { revision: string; prior: { path: string; sha256: string; snapshot: unknown }; budget: BudgetSnapshot }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;

function dumpRoot(): string {
  const root = process.env.KODAX_CONTROL_EVAL_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error('Set an absolute KODAX_CONTROL_EVAL_ROOT');
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Raw evidence must be inside OS temporary storage');
  return path.resolve(root);
}
async function writeNew(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
async function inputs(root: string, arm: 'baseline' | 'candidate'): Promise<readonly Row[]> {
  const file = path.join(root, `${arm === 'candidate' ? 'candidate-fixed' : arm}-inputs.json`);
  const result = await read<{ captures: readonly Row[] }>(file);
  if (result.captures.length !== 4) throw new Error('Expected two frozen cases by two routes');
  for (const row of result.captures) {
    const testCase = CONTROL_CONTRACT_CASES.find(testCase => testCase.id === row.caseId);
    if (!testCase || row.rubric !== testCase.rubric || row.hash !== inputHash(row.input)
      || !row.input.messages.some(message => message.role === 'user' && message.content === testCase.task)) {
      throw new Error('Changed frozen case, rubric or input');
    }
  }
  return result.captures;
}
async function prepare(root: string): Promise<void> {
  const baseline = await inputs(root, 'baseline');
  await inputs(root, 'candidate');
  const routes: EditRoute[] = [...new Map(baseline.map(row => [row.route, row])).values()].map(row => {
    const env = row.provider === 'kimi-code' ? 'KIMI_CODE_API_KEY' : 'ZAI_CODING_API_KEY';
    const rate = getCostRate(row.provider, row.model);
    if (!rate || !process.env[env] || !getProviderModels(row.provider).includes(row.model)) throw new Error(`Unavailable route ${row.route}`);
    return { id: row.route, provider: row.provider, model: row.model, env, rate,
      reasoning: firstTurnReasoningFor(row.provider), billing: 'coding-plan-reference-only' };
  });
  const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', 'src', 'packages'], { encoding: 'utf8', windowsHide: true })
    .trim().split(/\r?\n/).filter(file => file.endsWith('.ts') || file.endsWith('.tsx'));
  const frozenFiles = [...changed.filter(file => !file.includes('.test.')),
    'tests/control-contract-native.eval.ts', 'tests/first-turn-edit-v2.eval.ts', 'tests/first-turn-edit-eval-support.ts',
    'tests/first-turn-eval-support.ts', 'tests/first-turn-edit-runtime-smoke.ts', 'tests/control-contract-artifacts.ts', 'benchmark/datasets/control-contracts/cases.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(frozenFiles
    .map(async file => [file, hash(await fs.readFile(file, 'utf8'))])));
  const priorPath = process.env.KODAX_CONTROL_PRIOR_LEDGER;
  if (!priorPath || !path.isAbsolute(priorPath)) throw new Error('Final v5 ledger path required');
  const priorText = await fs.readFile(priorPath, 'utf8');
  const prior = JSON.parse(priorText) as Ledger;
  if (prior.revision !== 'control-contract-final-v5' || prior.budget.calls !== 14 || prior.budget.unknownUsageCalls !== 0
    || prior.budget.reservedTokens !== 0) throw new Error('Expected settled fourteen-call provenance');
  const directory = path.dirname(priorPath);
  const priorManifest = await read<Manifest>(path.join(directory, 'manifest.json'));
  const reviewed = await read<{ manifestHash: string; evidenceHash: string; reviewer: string; taskValid: boolean; recommendation: string }>(path.join(directory, 'semantic-review.json'));
  const packet = await read<unknown>(path.join(directory, 'glm-review_coordination.blind.json'));
  if (reviewed.reviewer !== 'main-session' || !reviewed.taskValid || reviewed.recommendation !== 'recommend-ship'
    || reviewed.manifestHash !== inputHash(priorManifest) || reviewed.evidenceHash !== inputHash([packet])) throw new Error('Invalid prior paired review');
  for (const [file, expected] of Object.entries(priorManifest.sourceHashes)) {
    if (file !== 'tests/control-contract-native.eval.ts' && hash(await fs.readFile(file, 'utf8')) !== expected) throw new Error('Production or unchanged support source changed: ' + file);
  }
  const pairedReview = { directory, manifestHash: inputHash(priorManifest), evidenceHash: inputHash([packet]),
    reviewHash: hash(await fs.readFile(path.join(directory, 'semantic-review.json'), 'utf8')),
    failureHash: hash(await fs.readFile(path.join(directory, 'smoke-persistence-failure.json'), 'utf8')),
    driverHash: hash(await fs.readFile(path.join(directory, 'executed-final-v5-driver.ts'), 'utf8')) };
  const manifest: Manifest = { revision: REVISION, limits: CONTROL_LIMITS, routes, sourceHashes, pairedReview,
    inputs: { baseline: inputHash(baseline), candidate: inputHash(await inputs(root, 'candidate')) }, cases: CONTROL_CONTRACT_CASES,
    analysis: 'Smoke-only recovery: production source is unchanged from final v5. Reuse the recorded blinded GLM pair, do not generate new A/B responses. Two v5 smoke responses were lost to the Windows evidence-writer path mismatch before tool execution; retain failed Runtime fixtures and all14charges. Canonical writer is tested offline and probed before dispatch. Remaining four requests are two responses per Kimi/GLM lane: real Node loopback-fixture check then honest final report. Final live edit verification is absent; deterministic actual-Runtime edit regression remains. Cumulative max18dispatches/600k tokens/$1 reference, 2048output/120s each, one inflight/provider, zero children/repair/fallback. No model-quality conclusion from lost raw or global non-inferiority claim.' };
  const ledger: Ledger = { revision: REVISION, prior: { path: priorPath, sha256: hash(priorText), snapshot: JSON.parse(priorText) as unknown },
    budget: new EditRevisionBudget(prior.budget).state };
  await writeControlEvidence(root, path.join(root, 'artifact-probe.json'), JSON.stringify({ externalCalls: 0, writer: 'canonical-root', status: 'preflight' }), true);
  await writeNew(path.join(root, 'manifest.json'), manifest);
  await writeNew(path.join(root, 'paid-budget-ledger.json'), ledger);
  process.stdout.write('Prepared frozen control-contract revision; provider calls: 0\n');
}
async function smoke(root: string): Promise<void> {
  if (process.env.KODAX_CONTROL_EVAL_RUN !== '1' || process.env.KODAX_EDIT_EVAL_COMMAND !== undefined) throw new Error('Live gate missing or legacy command active');
  const manifest = await read<Manifest>(path.join(root, 'manifest.json'));
  const ledger = await read<Ledger>(path.join(root, 'paid-budget-ledger.json'));
  const review = await read<{ revision: string; manifestHash: string; evidenceHash: string; reviewer: string;
    taskValid: boolean; recommendation: string; reasons: readonly string[] }>(path.join(root, 'semantic-review.json'));
  const blind = await Promise.all(manifest.routes.filter(route => route.id === 'glm').flatMap(route => CONTROL_CONTRACT_CASES
    .filter(testCase => testCase.id === 'review_coordination').map(testCase => read<unknown>(path.join(root, `${route.id}-${testCase.id}.blind.json`)))));
  if (manifest.revision !== REVISION || ledger.revision !== REVISION || inputHash(manifest.limits) !== inputHash(CONTROL_LIMITS)
    || ledger.budget.calls !== 14 || ledger.budget.unknownUsageCalls !== 0 || review.recommendation !== 'recommend-ship'
    || review.reviewer !== 'main-session' || review.taskValid !== true || review.revision !== REVISION
    || review.manifestHash !== inputHash(manifest) || review.evidenceHash !== inputHash(blind)
    || !review.reasons.length) throw new Error('Complete the paired pilot and main-session semantic review before Runtime smokes');
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
    if (hash(await fs.readFile(file, 'utf8')) !== expected) throw new Error(`Source changed: ${file}`);
  }
  const lock = await fs.open(path.join(root, 'smoke.lock'), 'wx');
  try {
    const { budgetedEditCall } = await import('./first-turn-edit-v2.eval.js');
    const budget = new EditRevisionBudget(ledger.budget);
    let writes = Promise.resolve();
    const save = () => {
      writes = writes.then(async () => {
        const temporary = path.join(root, `${randomUUID()}.ledger.tmp`);
        await fs.writeFile(temporary, JSON.stringify({ ...ledger, budget: budget.state }, null, 2) + '\n');
        await fs.rename(temporary, path.join(root, 'paid-budget-ledger.json'));
      });
      return writes;
    };
    await runEditSmokeLanes(manifest.routes,
      (route, input, signal, onFailure, beforeDispatch) => budgetedEditCall(route, input, budget, save, signal, onFailure, beforeDispatch),
      (route, call, control) => runEditRuntimeSmoke(route, call, path.join(root, `${route.id}-runtime-smoke.json`), 'live', control, 'managed_task',
        (file, contents, exclusive) => writeControlEvidence(root, file, contents, exclusive), 'fixture-check'));
  } finally { await lock.close(); }
}

const command = process.env.KODAX_CONTROL_EVAL_COMMAND;
if (command !== undefined) {
  if (command === 'prepare') await prepare(dumpRoot());
  else if (command === 'smoke') await smoke(dumpRoot());
  else throw new Error('Expected prepare or smoke');
}
