/** Manual bounded Layer-2 probe: does the first response invoke a Skill only when one fits?
 * Default is preflight only (no model calls). KODAX_SKILL_EVAL_RUN=1 dispatches one reviewed batch.
 * Inputs are frozen captures from tests/skill-trigger.capture.ts; model tool calls are observed, never executed.
 * Run: vite-node -c vitest.config.ts tests/skill-trigger.eval.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomInt } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost } from '../packages/llm/src/index.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

const LIMITS = Object.freeze({ maxProviderCalls: 3000, maxCallsPerCell: 1, maxRoundsPerCell: 1, maxOutputTokens: 8192, maxTotalTokens: 60_000_000, maxExternalSpendUsd: 30, timeoutMs: 180_000 });
const routes = {
  'zhipu/glm52': { provider: 'zhipu-coding', model: 'glm-5.2', env: 'ZHIPU_CODING_API_KEY' },
  'ark/k27': { provider: 'ark-coding', model: 'kimi-k2.7-code', env: 'ARK_CODING_API_KEY', alwaysThinks: true },
  'mmx/m3': { provider: 'minimax-coding', model: 'MiniMax-M3', env: 'MINIMAX_CODING_API_KEY' },
  'ark/v4pro': { provider: 'ark-coding', model: 'deepseek-v4-pro', env: 'ARK_CODING_API_KEY' },
  'ark/v4flash': { provider: 'ark-coding', model: 'deepseek-v4-flash', env: 'ARK_CODING_API_KEY' },
  'zhipu/glm53flash': { provider: 'zhipu-coding', model: 'glm-5.3-flash', env: 'ZHIPU_CODING_API_KEY' },
  'deepseek/flash': { provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
  'kimicode/k4c': { provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY', alwaysThinks: true },
} as const;
type RouteId = keyof typeof routes;
const isRoute = (value: string): value is RouteId => Object.hasOwn(routes, value);
// 'auto' is what the product sends under its default reasoning mode; 'off' isolates the prompt from thinking.
const reasoningSetting = process.env.KODAX_SKILL_EVAL_REASONING ?? 'off';
if (reasoningSetting !== 'off' && reasoningSetting !== 'auto') throw new Error('KODAX_SKILL_EVAL_REASONING must be off or auto');
const REASONING = reasoningSetting === 'auto' ? { enabled: true, effort: 'auto' } as const : { enabled: false, effort: 'none' } as const;
/** Always-thinking models reject an explicit 'none'; omitting reasoning lets them use their default effort. */
const reasoningFor = (id: RouteId) => ('alwaysThinks' in routes[id] ? undefined : REASONING);

interface CapturedCase { id: string; task: string; input: FrozenInput; hash: string }
interface Capture { stage: string; source: string; catalog: string; cases: CapturedCase[] }
interface CaseMeta { id: string; group: string; expected: string }
interface Ledger { calls: number; chargedTokens: number; chargedUsd: number; reservedTokens: number; reservedUsd: number; unknownUsageCalls: number }

// v1 (panel-1) is closed with its own ledger; v2 evaluates the iterated candidate on the 2026-11 model pool.
const dumpRoot = path.join(os.tmpdir(), 'kodax-eval-dumps', 'skill-trigger-v2');
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const armA = await readJson<Capture>(process.env.KODAX_SKILL_EVAL_A ?? path.join(dumpRoot, 'baseline-builtin-inputs.json'));
const armB = await readJson<Capture>(process.env.KODAX_SKILL_EVAL_B ?? path.join(dumpRoot, 'candidate-builtin-inputs.json'));
const meta = await readJson<CaseMeta[]>(process.env.KODAX_SKILL_EVAL_META ?? path.join(dumpRoot, 'cases.json'));
for (const capture of [armA, armB]) for (const c of capture.cases) if (inputHash(c.input) !== c.hash) throw new Error(`Frozen hash mismatch: ${capture.stage}/${c.id}`);

const requestedRoutes = (process.env.KODAX_SKILL_EVAL_ROUTES ?? 'ark/v4flash,zhipu/glm52').split(',');
if (requestedRoutes.some(r => !isRoute(r)) || new Set(requestedRoutes).size !== requestedRoutes.length) throw new Error('Unknown/duplicate route');
const selectedRoutes = requestedRoutes.filter(isRoute);
const caseIds = (process.env.KODAX_SKILL_EVAL_CASES ?? 'customer_docker_rpm').split(',');
const runs = Number(process.env.KODAX_SKILL_EVAL_RUNS ?? '2');
if (!Number.isInteger(runs) || runs < 1 || runs > 3) throw new Error('Runs per arm must be 1..3');
const cells = caseIds.map(id => {
  const a = armA.cases.find(c => c.id === id), b = armB.cases.find(c => c.id === id), m = meta.find(c => c.id === id);
  if (!a || !b || !m) throw new Error(`Case ${id} missing from an arm or cases.json`);
  if (a.task !== b.task) throw new Error(`Case ${id} task differs across arms; freeze a new revision`);
  return { id, meta: m, a, b };
});
const availability = selectedRoutes.map(id => ({ id, ...routes[id], credentialPresent: Boolean(process.env[routes[id].env]), descriptorPresent: getProviderModels(routes[id].provider).includes(routes[id].model), rate: getCostRate(routes[id].provider, routes[id].model) ?? null }));
const batchCalls = selectedRoutes.length * cells.length * 2 * runs;
const preflight = { limits: LIMITS, reasoning: Object.fromEntries(selectedRoutes.map(id => [id, reasoningFor(id) ?? 'provider-default'])), arms: { A: { stage: armA.stage, source: armA.source }, B: { stage: armB.stage, source: armB.source } }, routes: availability, cases: cells.map(c => ({ id: c.id, group: c.meta.group, sameInput: c.a.hash === c.b.hash })), runs, batchCalls };
process.stdout.write(JSON.stringify(preflight, null, 2) + '\n');
if (cells.some(c => c.a.hash === c.b.hash)) throw new Error('Arms are byte-identical for a selected case');

/** Text-form tool syntaxes some models emit instead of structured calls (EVAL_GUIDELINES anti-pattern 7). */
const textualSkillCall = (text: string): boolean => [/\bskill\s*\(/, /"name"\s*:\s*"skill"/, /<skill>/, /name\s*[=:]\s*"?skill\b/].some(p => p.test(text));
const observe = (toolCalls: readonly { name: string; input: unknown }[], text: string) => {
  const skill = toolCalls.find(t => t.name === 'skill');
  const skillName = skill && typeof skill.input === 'object' && skill.input !== null && 'skill' in skill.input ? String(skill.input.skill) : null;
  return { toolNames: toolCalls.map(t => t.name), firstTool: toolCalls[0]?.name ?? null, skillInvoked: Boolean(skill), skillName, textualSkillCall: textualSkillCall(text),
    note: 'Diagnostic only. Correctness of invoking/not invoking and of any "no skill" talk needs blind main-session review.' };
};

if (process.env.KODAX_SKILL_EVAL_RUN === '1') {
  if (availability.some(r => !r.credentialPresent || !r.descriptorPresent || !r.rate)) throw new Error('Credential, model descriptor or cost rate missing; no fallback');
  const batchId = process.env.KODAX_SKILL_EVAL_BATCH_ID;
  if (!batchId || !/^[a-z0-9-]+$/.test(batchId)) throw new Error('Explicit unique batch id required');
  const directory = path.join(dumpRoot, batchId);
  await fs.mkdir(directory); // Never overwrite or silently retry an existing batch.
  await fs.writeFile(path.join(directory, 'preflight.json'), JSON.stringify(preflight, null, 2));
  const ledgerPath = path.join(dumpRoot, 'paid-budget-ledger.json');
  const lockPath = path.join(dumpRoot, 'paid-budget.lock');
  const lock = await fs.open(lockPath, 'wx');
  try {
    const ledger = await readJson<Ledger>(ledgerPath); // Created once at zero for this experiment; never reset.
    if (ledger.reservedTokens !== 0) throw new Error('Ledger has unsettled reservations; review before dispatch');
    if (ledger.calls + batchCalls > LIMITS.maxProviderCalls) throw new Error('Batch would exceed the call budget');
    let writes = Promise.resolve();
    const persist = (file: string, content: unknown): Promise<void> => (writes = writes.then(() => fs.writeFile(file, JSON.stringify(content, null, 2))));
    const mapping: unknown[] = [];
    const evidence: unknown[] = [];
    const call = async (id: RouteId, input: FrozenInput) => {
      const route = routes[id];
      const rate = getCostRate(route.provider, route.model)!;
      const reservedInput = Buffer.byteLength(JSON.stringify(input)) + 4096;
      const reservedTokens = reservedInput + LIMITS.maxOutputTokens;
      const reservedUsd = calculateCost(rate, reservedInput, LIMITS.maxOutputTokens);
      if (ledger.chargedTokens + ledger.reservedTokens + reservedTokens > LIMITS.maxTotalTokens || ledger.chargedUsd + ledger.reservedUsd + reservedUsd > LIMITS.maxExternalSpendUsd) throw new Error('Budget exhausted');
      ledger.calls += 1; ledger.reservedTokens += reservedTokens; ledger.reservedUsd += reservedUsd;
      await persist(ledgerPath, ledger);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Frozen per-call timeout')), LIMITS.timeoutMs);
      const start = Date.now();
      let result: Awaited<ReturnType<ReturnType<typeof getProvider>['stream']>> | undefined;
      let error: string | null = null;
      try {
        result = await getProvider(route.provider).stream([...input.messages], [...input.tools], input.system, reasoningFor(id),
          { modelOverride: route.model, maxOutputTokensOverride: LIMITS.maxOutputTokens, singleAttempt: true, signal: controller.signal });
      } catch (caught: unknown) {
        error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
        for (const r of Object.values(routes)) { const key = process.env[r.env]; if (key) error = error.replaceAll(key, '[REDACTED]'); }
      } finally { clearTimeout(timer); }
      const usage = result?.usage;
      const cost = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      ledger.reservedTokens -= reservedTokens; ledger.reservedUsd = Math.max(0, ledger.reservedUsd - reservedUsd);
      const known = usage !== undefined && usage.totalTokens > 0 && cost !== undefined && Number.isFinite(cost);
      ledger.chargedTokens += known ? usage.totalTokens : reservedTokens; ledger.chargedUsd += known ? cost : reservedUsd;
      if (!known) ledger.unknownUsageCalls += 1;
      await persist(ledgerPath, ledger);
      return { result, error, usage: usage ?? null, cost: known ? cost : null, durationMs: Date.now() - start };
    };
    // One in-flight request per route lane; ark's three model lanes are the verified provider exception.
    // A failure stops only its own lane: one provider's overload must not cut short independent routes.
    const outcomes = await Promise.allSettled(selectedRoutes.map(async id => {
      for (const cell of cells) for (let runIndex = 0; runIndex < runs; runIndex += 1) {
        const reverse = randomInt(2) === 1;
        const ordered = reverse ? [['B', cell.b], ['A', cell.a]] as const : [['A', cell.a], ['B', cell.b]] as const;
        for (const [slot, [arm, frozen]] of ordered.entries()) {
          const blindArm = slot === 0 ? 'X' : 'Y';
          mapping.push({ route: id, case: cell.id, runIndex, blindArm, arm, stage: arm === 'A' ? armA.stage : armB.stage, inputHash: frozen.hash });
          await persist(path.join(directory, 'unblind-mapping.json'), mapping);
          const out = await call(id, frozen.input);
          const text = out.result?.textBlocks.map(t => t.text).join('') ?? '';
          const toolCalls = out.result?.toolBlocks.map(t => ({ name: t.name, input: t.input })) ?? [];
          const row = { route: id, provider: routes[id].provider, model: routes[id].model, case: cell.id, group: cell.meta.group, task: cell.a.task, expected: cell.meta.expected,
            runIndex, blindArm, inputHash: frozen.hash, text, thinking: out.result?.thinkingBlocks ?? [], toolCalls, stopReason: out.result?.stopReason ?? null,
            usage: out.usage, estimatedUsd: out.cost, durationMs: out.durationMs, error: out.error, mechanical: observe(toolCalls, text) };
          evidence.push(row);
          await persist(path.join(directory, `${id.replace('/', '-')}-${cell.id}-r${runIndex}-${blindArm}.json`), row);
          await persist(path.join(directory, 'blind-evidence.json'), { rubric: 'Blind paired review per route×case×run: X vs Y. Was invoking/not invoking a Skill right for the request? Any ritual tool/skill-availability talk, wrong Skill, missed fitting Skill, or refusal? preferred X/Y/tie, severity, reason.', runsRaw: evidence, mainSessionReview: [] });
          if (out.error || !out.usage) throw new Error(`Provider error or missing usage on ${id}/${cell.id}; lane stopped for review, no retry`);
        }
      }
    }));
    const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected').map(o => String(o.reason));
    await writes;
    process.stdout.write(JSON.stringify({ directory, ledger, failed, status: 'generated-awaiting-main-session-blind-review' }, null, 2) + '\n');
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
