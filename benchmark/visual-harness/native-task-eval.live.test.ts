/** Explicit online entrypoint. Normal test discovery never contacts a provider. */
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeTaskCellInput } from './native-task-cell.js';
import { createNativeTaskTransport, parseNativeResponseEvents } from './native-task-transport.js';
import { assertTaskDumpDirectory } from './task-transport.js';

interface FrozenCell {
  id: string; caseId: 'L' | 'H' | 'V'; workspace: string; home: string;
  provider: NativeTaskCellInput['provider']; model: string; prompt: string;
  images?: string[]; history?: NativeTaskCellInput['history']; historyResponsesPerRound?: 1 | 2; files: Record<string, string>;
  directory: string; root: string; online: boolean;
  frozenLimits?: FrozenLimits;
  resumeSessionId?: string;
  resumeFrom?: { originalInput: string; originalInputSha256: string; result: string; resultSha256: string;
    originalPromptSha256: string; archiveManifest: string; archiveManifestSha256: string };
}
interface FrozenLimits {
  maxOutputTokens: 4096 | 8192; maxTotalCalls: number; maxTotalTokens: number;
  maxSpendUsd: number; maxMetadataRequests: number;
  scope?: 'r4-joint-remainder' | 'r5-complete-panel' | 'r5e-relaxed-completion'; jointBudgetEvidence?: string;
  mainResponses?: 12 | 24; maxCellTokens?: 400000 | 600000 | 2000000; maxCallsPerCell?: 14 | 21 | 28 | 40;
}
interface JointBudget {
  revision: 'r4-joint-remainder'; global: { calls: number; tokens: number; metadata: number };
  deepseek: { calls: number; accountedTokens: number; reservedTokens: number; reservationRequest: string; reservationResponse: string };
  kimi: { calls: number; accountedCalls: number; accountedTokens: number; metadata: number };
  otherMetadata: number; reservedPreflightMetadata: number;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateResumeBinding(cell: FrozenCell, previous: unknown, outcome: unknown): void {
  const result = isRecord(outcome) && isRecord(outcome.result) && isRecord(outcome.result.result) ? outcome.result.result : undefined;
  if (cell.caseId !== 'H' || cell.provider !== 'kimi-code' || cell.frozenLimits?.scope !== 'r5e-relaxed-completion'
    || cell.prompt !== '继续完成上一条任务。' || cell.history !== undefined || (cell.images?.length ?? 0) !== 0
    || !cell.resumeSessionId || !cell.resumeFrom || !isRecord(previous) || previous.caseId !== 'H' || previous.id !== cell.id
    || previous.provider !== cell.provider || previous.model !== cell.model || previous.workspace !== cell.workspace || previous.home !== cell.home
    || typeof previous.prompt !== 'string' || digest(previous.prompt) !== cell.resumeFrom.originalPromptSha256
    || !isRecord(outcome) || outcome.id !== cell.id || result?.sessionId !== cell.resumeSessionId || result.phase !== 'interrupted') {
    throw new Error('Invalid H continuation binding; preserve the interrupted session and original task without history replay.');
  }
}
function validateJointBudget(value: unknown): JointBudget {
  if (!isRecord(value) || value.revision !== 'r4-joint-remainder' || !isRecord(value.global) || !isRecord(value.deepseek) || !isRecord(value.kimi)
    || value.global.calls !== 140 || value.global.tokens !== 3000000 || value.global.metadata !== 320
    || value.deepseek.calls !== 15 || value.deepseek.accountedTokens !== 256156 || value.deepseek.reservedTokens !== 23156
    || typeof value.deepseek.reservationRequest !== 'string' || typeof value.deepseek.reservationResponse !== 'string'
    || value.kimi.calls !== 40 || value.kimi.accountedCalls !== 40 || value.kimi.accountedTokens !== 900198 || value.kimi.metadata !== 80
    || value.otherMetadata !== 3 || value.reservedPreflightMetadata !== 1) throw new Error('Invalid r4 joint budget; reviewed historical usage and reservation must remain explicit.');
  return value as unknown as JointBudget;
}
function reservedDeepSeekTokens(request: unknown, events: readonly Record<string, unknown>[]): number {
  const starts = events.filter(event => event.type === 'message_start');
  const usage = starts.length === 1 && isRecord(starts[0]?.message) ? starts[0].message.usage : undefined;
  if (!isRecord(request) || request.model !== 'deepseek-flash' || request.max_tokens !== 8192
    || !isRecord(usage) || usage.input_tokens !== 14964 || usage.cache_read_input_tokens !== 0
    || usage.cache_creation_input_tokens !== 0 || usage.output_tokens !== 0
    || events.some(event => event.type === 'message_stop' || (event.type !== 'message_start' && event.usage !== undefined))) {
    throw new Error('Invalid incomplete DeepSeek reservation evidence; never substitute it for actual final usage.');
  }
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + request.max_tokens;
}
function resolveFrozenLimits(value: unknown, jointValue?: unknown, selection?: { provider: FrozenCell['provider']; caseId: FrozenCell['caseId'] }): FrozenLimits {
  if (value === undefined) return { maxOutputTokens: 4096, maxTotalCalls: 70, maxTotalTokens: 1500000, maxSpendUsd: 6, maxMetadataRequests: 160 };
  const boundedInteger = (number: unknown, ceiling: number) => typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= ceiling;
  if (isRecord(value) && (value.scope === 'r5-complete-panel' || value.scope === 'r5e-relaxed-completion')) {
    const relaxed = value.scope === 'r5e-relaxed-completion';
    const maxCellTokens = relaxed ? 2000000 : 600000;
    if (selection?.provider !== 'kimi-code' || !selection.caseId || value.jointBudgetEvidence !== undefined
      || (relaxed && selection.caseId === 'L')
      || value.maxOutputTokens !== 8192 || value.mainResponses !== 24 || value.maxCellTokens !== maxCellTokens
      || value.maxCallsPerCell !== (selection.caseId === 'H' ? 40 : 28)
      || !boundedInteger(value.maxTotalCalls, 100) || !boundedInteger(value.maxTotalTokens, relaxed ? 5000000 : 2000000)
      || !boundedInteger(value.maxMetadataRequests, 218) || typeof value.maxSpendUsd !== 'number'
      || !Number.isFinite(value.maxSpendUsd) || value.maxSpendUsd <= 0 || value.maxSpendUsd > 6) throw new Error('Invalid frozen r5 completion limits.');
    return { scope: value.scope, mainResponses: 24, maxCellTokens, maxCallsPerCell: value.maxCallsPerCell as 28 | 40,
      maxOutputTokens: 8192, maxTotalCalls: value.maxTotalCalls as number, maxTotalTokens: value.maxTotalTokens as number,
      maxSpendUsd: value.maxSpendUsd, maxMetadataRequests: value.maxMetadataRequests as number };
  }
  if (isRecord(value) && value.scope === 'r4-joint-remainder') {
    const budget = validateJointBudget(jointValue);
    const remainingCalls = budget.global.calls - budget.deepseek.calls - budget.kimi.calls;
    const remainingTokens = budget.global.tokens - budget.deepseek.accountedTokens - budget.deepseek.reservedTokens - budget.kimi.accountedTokens;
    const remainingMetadata = budget.global.metadata - budget.kimi.metadata - budget.otherMetadata - budget.reservedPreflightMetadata;
    if (selection?.provider !== 'kimi-code' || !selection.caseId || typeof value.jointBudgetEvidence !== 'string'
      || value.maxOutputTokens !== 8192 || value.mainResponses !== 12 || value.maxCellTokens !== 400000
      || value.maxCallsPerCell !== (selection.caseId === 'H' ? 21 : 14)
      || !boundedInteger(value.maxTotalCalls, remainingCalls) || !boundedInteger(value.maxTotalTokens, remainingTokens)
      || !boundedInteger(value.maxMetadataRequests, remainingMetadata) || typeof value.maxSpendUsd !== 'number'
      || !Number.isFinite(value.maxSpendUsd) || value.maxSpendUsd <= 0 || value.maxSpendUsd > 6) throw new Error('Invalid frozen limits for the reviewed r4 Kimi remainder.');
    return { scope: 'r4-joint-remainder', jointBudgetEvidence: value.jointBudgetEvidence, maxOutputTokens: 8192,
      mainResponses: 12, maxCellTokens: 400000, maxCallsPerCell: value.maxCallsPerCell as 14 | 21,
      maxTotalCalls: value.maxTotalCalls as number, maxTotalTokens: value.maxTotalTokens as number,
      maxSpendUsd: value.maxSpendUsd, maxMetadataRequests: value.maxMetadataRequests as number };
  }
  if (!isRecord(value) || (value.maxOutputTokens !== 4096 && value.maxOutputTokens !== 8192)
    || value.scope !== undefined || value.jointBudgetEvidence !== undefined || value.mainResponses !== undefined
    || value.maxCellTokens !== undefined || value.maxCallsPerCell !== undefined
    || !boundedInteger(value.maxTotalCalls, 70) || !boundedInteger(value.maxTotalTokens, 1500000)
    || !boundedInteger(value.maxMetadataRequests, 160) || typeof value.maxSpendUsd !== 'number'
    || !Number.isFinite(value.maxSpendUsd) || value.maxSpendUsd <= 0 || value.maxSpendUsd > 6) throw new Error('Invalid frozen limits; r3 may only use the registered output cap and remaining r2 budget.');
  return { maxOutputTokens: value.maxOutputTokens, maxTotalCalls: value.maxTotalCalls as number,
    maxTotalTokens: value.maxTotalTokens as number, maxSpendUsd: value.maxSpendUsd, maxMetadataRequests: value.maxMetadataRequests as number };
}
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function accountObservation(value: unknown) {
  const wallet = isRecord(value) && isRecord(value.booster_wallet) ? value.booster_wallet : undefined;
  if (!wallet || typeof wallet.monthlyChargeLimitEnabled !== 'boolean' || typeof wallet.allowTopup !== 'boolean'
    || typeof wallet.status !== 'string') throw new Error('Kimi account settings missing.');
  const money = (name: string) => {
    const entry = wallet[name];
    if (!isRecord(entry) || entry.currency !== 'CNY' || typeof entry.priceInCents !== 'string' || !/^\d+$/.test(entry.priceInCents)
      || !Number.isSafeInteger(Number(entry.priceInCents))) throw new Error(`Kimi account ${name} missing/invalid.`);
    return { currency: 'CNY' as const, priceInCents: Number(entry.priceInCents) };
  };
  const settings = { monthlyChargeLimitEnabled: wallet.monthlyChargeLimitEnabled, monthlyChargeLimit: money('monthlyChargeLimit'),
    autoRefillCharge: money('autoRefillCharge'), autoRefillThreshold: money('autoRefillThreshold'), topupLimit: money('topupLimit'),
    allowTopup: wallet.allowTopup, status: wallet.status };
  return { ...money('monthlyUsed'), configurationHash: digest(JSON.stringify(settings)) };
}
interface FailureEvidence { name: string; message: string; causes?: FailureEvidence[]; }
const errorEvidence = (error: unknown): FailureEvidence => error instanceof Error
  ? { name: error.name, message: error.message, ...(error instanceof AggregateError ? { causes: (error.errors as unknown[]).map(errorEvidence) } : {}) }
  : { name: 'UnknownError', message: String(error) };
const inputFile = process.env.KODAX_NATIVE_EVAL_INPUT;

it('keeps r2 defaults and accepts only an explicit remaining r3 budget', () => {
  expect(resolveFrozenLimits(undefined)).toEqual({ maxOutputTokens: 4096, maxTotalCalls: 70,
    maxTotalTokens: 1500000, maxSpendUsd: 6, maxMetadataRequests: 160 });
  const remaining = { maxOutputTokens: 8192, maxTotalCalls: 56, maxTotalTokens: 1243844,
    maxSpendUsd: 5.980555584, maxMetadataRequests: 132 };
  expect(resolveFrozenLimits(remaining)).toEqual(remaining);
});

it.each([
  { maxOutputTokens: 12288 }, { maxTotalCalls: 71 }, { maxTotalTokens: 1500001 }, { maxSpendUsd: 6.01 },
  { maxMetadataRequests: 161 }, { maxTotalCalls: 0 }, { maxTotalTokens: -1 }, { maxSpendUsd: Number.NaN },
  { maxTotalCalls: 1.5 }, { maxMetadataRequests: 0 },
])('rejects invalid or expanded frozen budgets: %j', change => {
  expect(() => resolveFrozenLimits({ maxOutputTokens: 4096, maxTotalCalls: 70, maxTotalTokens: 1500000,
    maxSpendUsd: 6, maxMetadataRequests: 160, ...change })).toThrow('Invalid frozen limits');
});

const jointFixture = { revision: 'r4-joint-remainder', global: { calls: 140, tokens: 3000000, metadata: 320 },
  deepseek: { calls: 15, accountedTokens: 256156, reservedTokens: 23156, reservationRequest: 'request.json', reservationResponse: 'response.txt' },
  kimi: { calls: 40, accountedCalls: 40, accountedTokens: 900198, metadata: 80 }, otherMetadata: 3, reservedPreflightMetadata: 1 };
const r4Fixture = { scope: 'r4-joint-remainder', jointBudgetEvidence: 'joint-budget.json', mainResponses: 12, maxCellTokens: 400000,
  maxCallsPerCell: 14, maxOutputTokens: 8192, maxTotalCalls: 85, maxTotalTokens: 1820490, maxSpendUsd: 6, maxMetadataRequests: 236 };
it('allows only the reviewed r4 Kimi remainder and task-specific cell allowances', () => {
  expect(resolveFrozenLimits(r4Fixture, jointFixture, { provider: 'kimi-code', caseId: 'L' })).toMatchObject(r4Fixture);
  expect(resolveFrozenLimits({ ...r4Fixture, maxCallsPerCell: 21 }, jointFixture, { provider: 'kimi-code', caseId: 'H' })).toMatchObject({ maxCallsPerCell: 21 });
  expect(() => resolveFrozenLimits(r4Fixture, jointFixture, { provider: 'deepseek', caseId: 'L' })).toThrow('Invalid frozen limits');
  expect(() => resolveFrozenLimits(r4Fixture, undefined, { provider: 'kimi-code', caseId: 'L' })).toThrow('joint budget');
});
it.each([{ maxTotalCalls: 86 }, { maxTotalTokens: 1820491 }, { maxMetadataRequests: 237 }, { maxCallsPerCell: 15 },
  { mainResponses: 13 }, { maxCellTokens: 400001 }, { maxSpendUsd: 6.01 }])('does not expand a reviewed r4 remainder: %j', change => {
  expect(() => resolveFrozenLimits({ ...r4Fixture, ...change }, jointFixture, { provider: 'kimi-code', caseId: 'L' })).toThrow('Invalid frozen limits');
});
it('rejects changed historical usage and verifies an incomplete DS reservation without inventing final usage', () => {
  expect(() => resolveFrozenLimits(r4Fixture, { ...jointFixture, kimi: { ...jointFixture.kimi, calls: 39 } }, { provider: 'kimi-code', caseId: 'L' }))
    .toThrow('joint budget');
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 14964, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }, { type: 'ping' }];
  expect(reservedDeepSeekTokens({ model: 'deepseek-flash', max_tokens: 8192 }, events)).toBe(23156);
  expect(() => reservedDeepSeekTokens({ model: 'deepseek-flash', max_tokens: 8192 }, [...events, { type: 'message_delta', usage: { output_tokens: 5 } }]))
    .toThrow('reservation');
  expect(() => reservedDeepSeekTokens({ model: 'deepseek-flash', max_tokens: 16384 }, events)).toThrow('reservation');
});

const r5Fixture = { scope: 'r5-complete-panel', mainResponses: 24, maxCellTokens: 600000, maxCallsPerCell: 28,
  maxOutputTokens: 8192, maxTotalCalls: 100, maxTotalTokens: 2000000, maxSpendUsd: 6, maxMetadataRequests: 218 };
it('r5 admits only the symmetric completion limits and bounded Kimi panel', () => {
  expect(resolveFrozenLimits(r5Fixture, undefined, { provider: 'kimi-code', caseId: 'L' })).toMatchObject(r5Fixture);
  expect(resolveFrozenLimits({ ...r5Fixture, maxCallsPerCell: 40 }, undefined, { provider: 'kimi-code', caseId: 'H' })).toMatchObject({ maxCallsPerCell: 40 });
  for (const change of [{ maxTotalCalls: 101 }, { maxTotalTokens: 2000001 }, { maxSpendUsd: 6.01 },
    { mainResponses: 25 }, { maxCellTokens: 600001 }, { maxCallsPerCell: 40 }, { maxMetadataRequests: 219 }]) {
    expect(() => resolveFrozenLimits({ ...r5Fixture, ...change }, undefined, { provider: 'kimi-code', caseId: 'L' })).toThrow();
  }
  expect(() => resolveFrozenLimits(r5Fixture, undefined, { provider: 'deepseek', caseId: 'L' })).toThrow();
});

it('admits the explicit r5e H/V completion allocation without changing prior revision limits', () => {
  const limits = { ...r5Fixture, scope: 'r5e-relaxed-completion', maxCellTokens: 2000000, maxTotalTokens: 5000000 };
  expect(resolveFrozenLimits(limits, undefined, { provider: 'kimi-code', caseId: 'V' })).toEqual(limits);
  expect(resolveFrozenLimits({ ...limits, maxCallsPerCell: 40 }, undefined, { provider: 'kimi-code', caseId: 'H' })).toMatchObject({ maxCallsPerCell: 40 });
  expect(() => resolveFrozenLimits({ ...limits, scope: 'r5-complete-panel' }, undefined, { provider: 'kimi-code', caseId: 'V' })).toThrow();
  expect(() => resolveFrozenLimits(limits, undefined, { provider: 'kimi-code', caseId: 'L' })).toThrow();
  for (const change of [{ maxCellTokens: 2000001 }, { maxTotalTokens: 5000001 }, { maxTotalCalls: 101 },
    { maxMetadataRequests: 219 }, { maxCallsPerCell: 40 }, { maxOutputTokens: 16384 }, { mainResponses: 25 }]) {
    expect(() => resolveFrozenLimits({ ...limits, ...change }, undefined, { provider: 'kimi-code', caseId: 'V' })).toThrow();
  }
});

it('binds H continuation to its interrupted session, original paths and question without replaying history', () => {
  const original = { id: 'kimi-code-H-2', caseId: 'H', provider: 'kimi-code', model: 'kimi-for-coding',
    workspace: 'C:/raw/r5d/workspaces/kimi-code/H', home: 'C:/raw/r5d/homes/kimi-code-H-2', prompt: 'Original frozen question' };
  const outcome = { id: original.id, result: { result: { sessionId: 'original-session', phase: 'interrupted' } } };
  const resumed = { ...original, caseId: 'H' as const, provider: 'kimi-code' as const, root: 'C:/raw/r5f', directory: 'C:/raw/r5f/ledgers/kimi-code',
    files: {}, online: true, prompt: '继续完成上一条任务。', resumeSessionId: 'original-session',
    resumeFrom: { originalInput: 'input.json', originalInputSha256: 'input-sha', result: 'result.json', resultSha256: 'result-sha',
      originalPromptSha256: digest(original.prompt), archiveManifest: 'archive.json', archiveManifestSha256: 'archive-sha' },
    frozenLimits: { ...r5Fixture, scope: 'r5e-relaxed-completion' as const, maxCellTokens: 2000000 as const, maxTotalTokens: 5000000,
      maxCallsPerCell: 40 as const, maxOutputTokens: 8192 as const, mainResponses: 24 as const } };
  expect(() => validateResumeBinding(resumed, original, outcome)).not.toThrow();
  for (const change of [{ history: [] }, { prompt: 'New instructions' }, { resumeSessionId: 'different-session' },
    { home: 'C:/different-home' }, { workspace: 'C:/different-workspace' }, { caseId: 'V' },
    { frozenLimits: { ...resumed.frozenLimits, scope: 'r5-complete-panel' } }]) {
    expect(() => validateResumeBinding({ ...resumed, ...change } as unknown as FrozenCell, original, outcome)).toThrow('continuation');
  }
  expect(() => validateResumeBinding(resumed, { ...original, prompt: 'Changed question' }, outcome)).toThrow('continuation');
});

it.skipIf(!inputFile)('runs one explicitly frozen native Runtime task cell', async () => {
  const originalInputEnv = process.env.KODAX_NATIVE_EVAL_INPUT;
  delete process.env.KODAX_NATIVE_EVAL_INPUT;
  try {
    if (!path.isAbsolute(inputFile!)) throw new Error('KODAX_NATIVE_EVAL_INPUT must be an absolute frozen JSON path.');
    const parsed: unknown = JSON.parse(await readFile(inputFile!, 'utf8'));
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(parsed.id)
      || !['L', 'H', 'V'].includes(String(parsed.caseId)) || typeof parsed.root !== 'string') throw new Error('Invalid frozen cell identity.');
    const cell = parsed as unknown as FrozenCell;
    const root = await assertTaskDumpDirectory(cell.root);
    let transport: Awaited<ReturnType<typeof createNativeTaskTransport>> | undefined;
    let result: Awaited<ReturnType<typeof import('./native-task-cell.js').runNativeTaskCell>> | undefined;
    let deliverable: string | null = null;
    let failure: unknown;
    let resumeVerified = false;
    let frozenLimits: FrozenLimits | undefined;
    let jointEvidence: { path: string; sha256: string; reservationRequestSha256: string; reservationResponseSha256: string } | undefined;
    try {
      if (cell.online !== true) throw new Error('This explicit entrypoint requires online:true; use native-task-cell tests for offline replay.');
      if (!path.isAbsolute(cell.workspace) || !path.isAbsolute(cell.home) || !path.isAbsolute(cell.directory)
        || typeof cell.prompt !== 'string' || !isRecord(cell.files)) throw new Error('Invalid frozen workspace/input.');
      const workspace = await realpath(cell.workspace);
      const directory = await assertTaskDumpDirectory(cell.directory);
      if (cell.resumeSessionId !== undefined || cell.resumeFrom !== undefined) {
        if (!cell.resumeFrom || !cell.resumeSessionId || cell.id !== 'kimi-code-H-2') throw new Error('Invalid H continuation evidence.');
        const priorRoot = await realpath(path.join(path.dirname(root), 'r5d'));
        const readBound = async (file: string, expectedHash: string, expectedPath?: string) => {
          if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error('Invalid H continuation Host evidence.');
          const resolved = await realpath(file);
          if (expectedPath ? resolved !== await realpath(expectedPath) : !inside(root, resolved)) throw new Error('H continuation evidence escapes its frozen location.');
          const bytes = await readFile(resolved);
          if (digest(bytes) !== expectedHash.toLowerCase()) throw new Error('H continuation evidence hash mismatch.');
          return bytes;
        };
        const previous: unknown = JSON.parse((await readBound(cell.resumeFrom.originalInput, cell.resumeFrom.originalInputSha256,
          path.join(priorRoot, 'kimi-code-H-2.input.json'))).toString('utf8'));
        const outcome: unknown = JSON.parse((await readBound(cell.resumeFrom.result, cell.resumeFrom.resultSha256,
          path.join(priorRoot, 'kimi-code-H-2.result.json'))).toString('utf8'));
        validateResumeBinding(cell, previous, outcome);
        if (!inside(priorRoot, workspace) || !inside(priorRoot, await realpath(cell.home))) throw new Error('H continuation state escapes the prior raw root.');
        const archive: unknown = JSON.parse((await readBound(cell.resumeFrom.archiveManifest, cell.resumeFrom.archiveManifestSha256)).toString('utf8'));
        if (!isRecord(archive) || archive.sessionId !== cell.resumeSessionId || !Array.isArray(archive.sources) || archive.sources.length !== 2) throw new Error('H continuation backup manifest is invalid.');
        for (const [label, originalPath] of [['workspace', cell.workspace], ['home', cell.home]]) {
          const source: unknown = archive.sources.find(item => isRecord(item) && item.label === label);
          if (!isRecord(source) || source.path !== originalPath || typeof source.archive !== 'string' || typeof source.archiveSha256 !== 'string') throw new Error('H continuation backup source is invalid.');
          await readBound(source.archive, source.archiveSha256);
        }
        resumeVerified = true;
      }
      if (!inside(root, directory) || (!resumeVerified && (!inside(root, path.resolve(cell.home)) || !inside(root, workspace)))) throw new Error('Cell directories must stay in the dedicated raw root.');
      if (inside(workspace, directory) || inside(workspace, path.resolve(cell.home)) || inside(workspace, path.resolve(inputFile!))) {
        throw new Error('Host ledger/home/frozen inputs must not be inside the model workspace.');
      }
      let jointBudget: JointBudget | undefined;
      if (cell.frozenLimits?.scope === 'r4-joint-remainder') {
        const readHostFile = async (file: string | undefined) => {
          if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Joint budget evidence requires absolute Host paths.');
          const resolved = await realpath(file);
          await assertTaskDumpDirectory(path.dirname(resolved));
          if (inside(workspace, resolved)) throw new Error('Joint budget evidence must stay outside the model workspace.');
          return { path: resolved, text: await readFile(resolved, 'utf8') };
        };
        const evidence = await readHostFile(cell.frozenLimits.jointBudgetEvidence);
        jointBudget = validateJointBudget(JSON.parse(evidence.text));
        const reservationRequest = await readHostFile(jointBudget.deepseek.reservationRequest);
        const reservationResponse = await readHostFile(jointBudget.deepseek.reservationResponse);
        const reservation = reservedDeepSeekTokens(JSON.parse(reservationRequest.text), parseNativeResponseEvents(reservationResponse.text, true));
        if (reservation !== jointBudget.deepseek.reservedTokens) throw new Error('DeepSeek reservation does not match the joint budget.');
        jointEvidence = { path: evidence.path, sha256: digest(evidence.text), reservationRequestSha256: digest(reservationRequest.text),
          reservationResponseSha256: digest(reservationResponse.text) };
      }
      frozenLimits = resolveFrozenLimits(cell.frozenLimits, jointBudget, { provider: cell.provider, caseId: cell.caseId });
      for (const [file, expected] of Object.entries(cell.files)) {
        if (path.isAbsolute(file) || typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Invalid frozen file/hash.');
        const resolved = await realpath(path.resolve(workspace, file));
        if (!inside(workspace, resolved)) throw new Error('Frozen file escapes the workspace.');
        if (digest(await readFile(resolved)) !== expected.toLowerCase()) throw new Error(`Frozen file hash mismatch: ${file}`);
      }
      const suppliedImages = [...(cell.images ?? []), ...(cell.history?.flatMap(round => round.images) ?? [])];
      if (suppliedImages.some(file => typeof file !== 'string' || !Object.hasOwn(cell.files, file))) throw new Error('Every supplied image requires a frozen file hash.');
      if ((cell.caseId === 'H' && !resumeVerified) !== Boolean(cell.history) || (cell.history && (cell.history.length !== 2
        || cell.history.some(round => typeof round.text !== 'string' || !Array.isArray(round.images))))) throw new Error('H requires exactly two real historical input rounds.');
      const originalFetch = globalThis.fetch;
      const controller = new AbortController();
      let walletRead = 0;
      const preflightPath = path.join(root, 'kimi-usage-preflight.json');
      const preflight = cell.provider === 'kimi-code' ? accountObservation(JSON.parse(await readFile(preflightPath, 'utf8'))) : undefined;
      const completionScope = frozenLimits.scope === 'r5-complete-panel' || frozenLimits.scope === 'r5e-relaxed-completion';
      transport = await createNativeTaskTransport({ directory, cell: cell.id, provider: cell.provider, model: cell.model,
        ...frozenLimits, maxCallsPerCell: frozenLimits.maxCallsPerCell ?? (cell.caseId === 'H' ? 15 : 10),
        maxCellTokens: frozenLimits.maxCellTokens ?? 250000, timeoutMs: completionScope ? 180000 : 60000,
        failurePolicy: completionScope ? 'r5-cell-isolated' : undefined, fetcher: originalFetch,
        onStop: error => controller.abort(error),
        rates: cell.provider === 'deepseek' ? { inputUsdPerMillion: 0.3, cacheReadUsdPerMillion: 0.006,
          cacheWriteUsdPerMillion: 0.3, outputUsdPerMillion: 1.2,
          source: 'https://api-docs.deepseek.com/quick_start/pricing/ ; 2026-10-30 peak upper bound, not invoice; off-peak may be lower' } : undefined,
        spendObservation: preflight ? { preflightEvidence: preflightPath, read: async signal => {
          const key = process.env.KIMI_CODE_API_KEY;
          if (!key) throw new Error('KIMI_CODE_API_KEY unavailable.');
          const response = await originalFetch('https://api.kimi.com/coding/v1/usages', { redirect: 'error', signal,
            headers: { authorization: `Bearer ${key}`, 'user-agent': 'KodaX' } });
          const raw = await response.text();
          await writeFile(path.join(directory, `${cell.id}.wallet-raw-${++walletRead}.json`), raw, { flag: 'wx' });
          if (!response.ok) throw new Error(`Kimi usage observation HTTP ${response.status}; no retry.`);
          const observed = accountObservation(JSON.parse(raw));
          if (observed.configurationHash !== preflight.configurationHash) throw new Error('Kimi account settings changed since preflight.');
          if (observed.priceInCents < preflight.priceInCents) throw new Error('Kimi account spend counter reset since preflight.');
          return observed;
        } } : undefined,
      });
      const { runNativeTaskCell } = await import('./native-task-cell.js');
      result = await runNativeTaskCell({ workspace, home: cell.home, provider: cell.provider, model: cell.model, prompt: cell.prompt,
        resumeSessionId: resumeVerified ? cell.resumeSessionId : undefined,
        images: cell.images, history: cell.history, historyResponsesPerRound: completionScope ? undefined
          : frozenLimits.scope === 'r4-joint-remainder' ? 2 : cell.historyResponsesPerRound,
        maxOutputTokens: frozenLimits.maxOutputTokens,
        mainResponses: frozenLimits.mainResponses === 12 ? 12 : undefined,
        limits: completionScope ? { mainResponses: 24, historyResponsesPerRound: 24, maxTools: 64,
          toolTimeoutMs: 90000, cellTimeoutMs: 1500000, maxOutputTokens: 8192 } : undefined,
        transportFetch: transport.fetch, signal: controller.signal });
      if (result.error || result.result?.phase !== 'completed') throw new Error(result.error?.message ?? `Runtime task ended ${result.result?.phase ?? result.phase}.`);
    } catch (error) { failure = error; }
    finally {
      try { await transport?.settle(); }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Cell execution and transport settlement failed.'); }
      const stoppedCell = transport?.getLedger().cells[cell.id];
      if (stoppedCell?.stopped && failure === undefined) failure = new Error(stoppedCell.stopReason ?? 'Native task cell stopped.');
      const deliverableName = { L: 'review.md', H: 'regression.md', V: 'video-bug.md' }[cell.caseId];
      try {
          if (typeof cell.workspace === 'string' && path.isAbsolute(cell.workspace) && (resumeVerified || inside(root, path.resolve(cell.workspace)))) {
          const deliveredPath = await realpath(path.join(cell.workspace, deliverableName));
          if (!inside(await realpath(cell.workspace), deliveredPath)) throw new Error('Deliverable escapes workspace.');
          deliverable = await readFile(deliveredPath, 'utf8');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure = failure === undefined ? error : new AggregateError([failure, error], 'Cell and deliverable read failed.');
      }
      await writeFile(path.join(root, `${cell.id}.result.json`), JSON.stringify({ id: cell.id, caseId: cell.caseId,
        frozenLimits: frozenLimits ?? null,
        resumeSessionId: resumeVerified ? cell.resumeSessionId : null, resumeFrom: resumeVerified ? cell.resumeFrom : null,
        jointBudgetEvidence: jointEvidence ?? null,
        result: result ?? null, error: failure === undefined ? null : errorEvidence(failure), ledger: transport?.getLedger() ?? null,
        deliverable: { path: deliverableName, text: deliverable } }, null, 2), { flag: 'wx' });
    }
    if (failure !== undefined) throw failure;
  } finally {
    if (originalInputEnv === undefined) delete process.env.KODAX_NATIVE_EVAL_INPUT;
    else process.env.KODAX_NATIVE_EVAL_INPUT = originalInputEnv;
  }
}, 1560000);
