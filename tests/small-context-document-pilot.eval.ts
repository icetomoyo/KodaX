/** Manual r2 pilot. prepare is offline; run requires main-session GO and a frozen combined manifest.
 * Fixed reference(1) versus G1/S1/G2/S2/G3(5). Never execute model tool proposals or judge with another model.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getProvider, type KodaXBaseProvider } from '../packages/llm/src/index.js';
import type { KodaXMessage, KodaXStreamResult, KodaXToolDefinition } from '../packages/llm/src/types.js';
import { compact, COMPACTION_SUMMARY_PREFIX, COMPACTED_HISTORY_RECOVERY_GUIDANCE } from '../packages/agent/src/session-lineage/compaction/compaction.js';
import { getAgentConfigHome, setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { buildSystemPromptSnapshot } from '../packages/coding/src/prompts/builder.js';
import { CODING_SUMMARY_PROMPT, CODING_UPDATE_SUMMARY_PROMPT } from '../packages/coding/src/agent-runtime/coding-compaction-prompts.js';
import { KODAX_TOOLS } from '../packages/coding/src/tools/registry.js';
import { toolRead } from '../packages/coding/src/tools/read.js';
import { PILOT_LIMITS, capturePilotWire, createPilotBudget, createBudgetedProvider, pilotHash, type PilotBudget, type PilotRoute } from './small-context-document-pilot-support.js';

export const DOCUMENT_PILOT_REVISION = 'small-context-document-r2-20261107';
export const DOCUMENT_PILOT_ROUTES: readonly PilotRoute[] = [
  { provider: 'deepseek', model: 'deepseek-flash', billing: 'token-bill', peakInputUsdPerMillion: 0.3, peakOutputUsdPerMillion: 1.2 },
  { provider: 'zhipu-coding', model: 'glm-5.3-flash', billing: 'coding-subscription', peakInputUsdPerMillion: 0, peakOutputUsdPerMillion: 0 },
];
interface SourcePage { offset: number; limit: number; output: string }
export interface DocumentPilotFixture {
  id: string; file: string; documentHash: string; totalLines: number; pages: SourcePage[]; task: string;
  groundTruth: { normal: number; exception: number; correctionCitation: string; exceptionCitation: string; completedCitation: string };
}
export interface DocumentPilotCapture {
  revision: string; sourceRevision: string; system: string; systemHash: string; tools: KodaXToolDefinition[]; toolsHash: string;
  fixtures: DocumentPilotFixture[]; routes: readonly PilotRoute[]; sourceHashes: Record<string, string>;
  wirePreflight: Array<{ provider: string; model: string; fixture: string; wireBytes: number; reservedTokens: number; wireHash: string }>;
  method: Record<string, unknown>;
}
const jsonWriteNew = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx' });
const assistant = (result: KodaXStreamResult): KodaXMessage => ({ role: 'assistant', content: [
  ...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks,
] });
const text = (result: KodaXStreamResult) => result.textBlocks.map(block => block.text).join('\n');

/** Actual local read output and production prompt/tool bytes; no transport is created. */
export async function prepareDocumentPilot(directory: string, options: { providerForRoute?: (route: PilotRoute) => KodaXBaseProvider } = {}): Promise<DocumentPilotCapture> {
  const root = path.resolve(directory);
  if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Pilot preparation requires OS temporary storage.');
  const workspace = path.join(root, 'sc-workspace');
  const configHome = path.join(root, 'sc-home');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(configHome, { recursive: true });
  const oldHome = process.env.KODAX_HOME;
  const oldAgentHome = getAgentConfigHome();
  let system: string;
  process.env.KODAX_HOME = configHome;
  setAgentConfigHome(configHome);
  try {
    system = (await buildSystemPromptSnapshot({ provider: 'deepseek', model: 'deepseek-flash', workMode: 'coding',
      context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off' } }, true)).rendered;
  } finally {
    if (oldHome === undefined) delete process.env.KODAX_HOME; else process.env.KODAX_HOME = oldHome;
    setAgentConfigHome(oldAgentHome);
  }
  const read = KODAX_TOOLS.find(tool => tool.name === 'read');
  if (!read) throw new Error('Production read definition is unavailable.');
  const tools: KodaXToolDefinition[] = [{ name: read.name, description: read.description,
    input_schema: structuredClone(read.input_schema), ...(read.strict ? { strict: read.strict } : {}),
    ...(read.grammar ? { grammar: structuredClone(read.grammar) } : {}) }];
  const fixtures: DocumentPilotFixture[] = [];
  for (const [id, normal, exception] of [['RUNBOOK_A', 90, 5], ['PROTOCOL_B', 45, 7]] as const) {
    const lines = Array.from({ length: 2400 }, (_, index) => `${id}:L${String(index + 1).padStart(4, '0')} Chapter record ${index + 1}. Background operating notes; no additional authority is implied.`);
    lines[7] = `${id}:L0008 Base policy: ordinary submissions wait 60 seconds; see chapter 9 for the separately scoped emergency exception.`;
    lines[11] = `${id}:L0012 EDIT019 is already completed and verified. It inserted the approved ledger marker. Do not perform or propose EDIT019 again.`;
    lines[907] = `${id}:L0908 Chapter 9 exception: authenticated critical emergency submissions wait ${exception} seconds instead of the ordinary delay. The exception never applies to unverified or ordinary submissions.`;
    lines[1507] = `${id}:L1508 Later correction, effective 2026-11-07: replace the ordinary 60-second delay in L0008 with ${normal} seconds. The chapter-9 critical-emergency exception remains ${exception} seconds.`;
    const file = path.join(workspace, `${id}.txt`);
    const document = lines.join('\n');
    await fs.writeFile(file, document, { flag: 'wx' });
    const pages: SourcePage[] = [];
    for (const offset of [1, 901, 1501]) {
      const output = await toolRead({ path: file, offset, limit: 30 }, { backups: new Map(), executionCwd: workspace, gitRoot: workspace });
      if (typeof output !== 'string') throw new Error('Expected production text read output.');
      pages.push({ offset, limit: 30, output });
    }
    fixtures.push({ id, file, totalLines: lines.length, documentHash: pilotHash(document), pages,
      task: `Read-scope task for ${id}: only the supplied source ranges 1–30, 901–930 and 1501–1530 of this 2400-line document have been read. `
        + 'Use exact source citation IDs. Give the current ordinary delay, the precisely scoped cross-chapter emergency exception, and the later correction. '
        + 'Report completed EDIT019 without replaying it. Explicitly state that the remaining source ranges are unread; do not claim a whole-document review. '
        + 'Final answer must be JSON with readScope, unreadScope, ordinaryDelaySeconds, emergencyException, correction, citations, completedWork and nextActions. No tools or side effects are needed beyond the fixed supplied reads.',
      groundTruth: { normal, exception, correctionCitation: `${id}:L1508`, exceptionCitation: `${id}:L0908`, completedCitation: `${id}:L0012` } });
  }
  const wirePreflight: DocumentPilotCapture['wirePreflight'] = [];
  for (const route of DOCUMENT_PILOT_ROUTES) for (const fixture of fixtures) {
    const captured = await capturePilotWire(options.providerForRoute?.(route) ?? getProvider(route.provider), route, {
      system, tools, messages: [{ role: 'user', content: fixture.task }, ...fixture.pages.flatMap(page => suppliedPage(fixture, page, 'reference'))],
    });
    await fs.writeFile(path.join(root, `sc-offline-wire-${route.provider}-${route.model}-${fixture.id}.json`), captured.wire, { flag: 'wx' });
    wirePreflight.push({ provider: route.provider, model: route.model, fixture: fixture.id,
      wireBytes: captured.wireBytes, reservedTokens: captured.reservedTokens, wireHash: captured.wireHash });
  }
  const sourceHashes: Record<string, string> = {};
  const sourceFiles = ['tests/small-context-document-pilot.eval.ts', 'tests/small-context-document-pilot-support.ts',
    'packages/agent/src/session-lineage/compaction/compaction.ts', 'packages/agent/src/session-lineage/compaction/summary-generator.ts',
    'packages/agent/src/session-lineage/compaction/query-ledger.ts', 'packages/agent/src/tokenizer.ts',
    'packages/coding/src/agent-runtime/coding-compaction-prompts.ts', 'packages/coding/src/prompts/builder.ts',
    'packages/coding/src/prompts/capability-sections.ts', 'packages/coding/src/tools/tool-definitions.ts', 'packages/coding/src/tools/read.ts'];
  const providerSources = (await fs.readdir('packages/llm/src', { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  for (const file of [...sourceFiles, ...providerSources.map(file => `packages/llm/src/${file.replaceAll('\\', '/')}`)]) {
    sourceHashes[file] = pilotHash(await fs.readFile(file, 'utf8'));
  }
  const capture: DocumentPilotCapture = { revision: DOCUMENT_PILOT_REVISION,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    system, systemHash: pilotHash(system), tools, toolsHash: pilotHash(tools), fixtures,
    routes: DOCUMENT_PILOT_ROUTES, sourceHashes, wirePreflight,
    method: { layer: 3, plannedCalls: 24, callsPerModelFixture: 6, referenceCalls: 1, candidateCalls: 5,
      globalLimits: PILOT_LIMITS, nativeContext: 'User-selected routes are known to exceed 100K; 64K here is an artificial application ceiling, not a native-window claim.',
      comparison: 'Bounded full-evidence reference versus forced two-summary recovery chain. This is not pre-change/post-change prompt lift; bounded summary bytes may be identical.',
      forcedCompaction: 'Production compact(force=true), triggerTokens=1, newest registered stage-boundary message protected; production generateSummary, Coding summary/update prompts, query ledger and reinsertion retained. One summary transport per boundary or stop.',
      tools: 'Only the unchanged production read definition is exposed; fixed local read results are injected. Model tool proposals are recorded and never executed.',
      fixtures: 'Controlled large text files with three bounded source pages; no claim of a public corpus or whole-book read.',
      wirePreflight: 'Reference envelopes captured through the actual selected adapters with injected first-fetch stop, no HTTP. Dynamic summary/generation envelopes are rechecked by the same inspectPilotWire guard before every live transport; unknown future model outputs cannot be precaptured.',
      deepseekPricing: { verified: '2026-11-07', url: 'https://api-docs.deepseek.com/quick_start/pricing/', inputPeakUsdPerMillion: 0.3, outputPeakUsdPerMillion: 1.2 },
      subscription: 'GLM consumes coding-subscription quota; zero incremental token-bill liability is not zero quota or a measured cost improvement.',
      review: 'Main session reviews blind final-answer pairs against source ground truth, records validity/preference/reasons, then reveals mapping. Schema/mechanical diagnostics never decide shipping.',
    } };
  await jsonWriteNew(path.join(root, 'sc-manifest.json'), capture);
  return capture;
}

function suppliedPage(fixture: DocumentPilotFixture, page: SourcePage, stage: string): KodaXMessage[] {
  const id = `${fixture.id}-${stage}-${page.offset}`;
  return [{ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: { path: fixture.file, offset: page.offset, limit: page.limit } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: page.output }] }];
}

/** Six registered calls maximum. Any failure stops this pair, preserving prior evidence. */
export async function runDocumentPilotPair(capture: DocumentPilotCapture, fixture: DocumentPilotFixture, route: PilotRoute,
  budget: PilotBudget, options: { provider?: KodaXBaseProvider; manifestHash?: string } = {}) {
  if (pilotHash(capture.system) !== capture.systemHash || pilotHash(capture.tools) !== capture.toolsHash) throw new Error('Captured production prompt/tool hashes changed.');
  const provider = options.provider ?? getProvider(route.provider);
  const prefix = `sc-${route.provider}-${route.model}-${fixture.id}`;
  let calls = 0;
  const nextProvider = (stage: string, summary = false) => {
    if (++calls > 6) throw new Error('Fixed six-call document pair graph exhausted.');
    return createBudgetedProvider(provider, route, budget, { callId: `${prefix}-${stage}`, summary, manifestHash: options.manifestHash });
  };
  const generation = async (stage: string, messages: KodaXMessage[]) => nextProvider(stage).stream(messages, capture.tools, capture.system,
    { enabled: false, effort: 'none' }, { modelOverride: route.model });
  const compactAt = async (stage: string, messages: KodaXMessage[]) => {
    const result = await compact([...messages, { role: 'user', content: `Registered ${stage} boundary: retain the task, exact citations, corrections, completed work and unread scope for the next fixed stage.` }],
      { enabled: true, triggerPercent: 15, triggerTokens: 1, reasoning: false }, nextProvider(stage, true), PILOT_LIMITS.applicationWindow,
      undefined, capture.system, undefined, CODING_SUMMARY_PROMPT, CODING_UPDATE_SUMMARY_PROMPT, route.model, true, PILOT_LIMITS.maxOutputTokens);
    const checkpoint = result.messages.find(message => message._source === 'compaction-checkpoint');
    if (!result.compacted || typeof checkpoint?.content !== 'string' || !checkpoint.content.startsWith(COMPACTION_SUMMARY_PREFIX)
      || !checkpoint.content.endsWith(COMPACTED_HISTORY_RECOVERY_GUIDANCE)) throw new Error('Production compaction did not produce its canonical reinsertion format.');
    await jsonWriteNew(path.join(budget.directory, `${prefix}-${stage}.compacted.json`), result);
    return result.messages;
  };
  const task: KodaXMessage = { role: 'user', content: fixture.task };
  const reference = await generation('reference', [task, ...fixture.pages.flatMap(page => suppliedPage(fixture, page, 'reference'))]);
  const first: KodaXMessage[] = [task, ...suppliedPage(fixture, fixture.pages[0]!, 'g1'),
    { role: 'user', content: 'G1: retain the first-page facts and read boundary. Do not give the final answer yet.' }];
  const g1 = await generation('g1', first);
  const s1 = await compactAt('s1', [...first, assistant(g1)]);
  const second = [...s1, ...fixture.pages.slice(1).flatMap(page => suppliedPage(fixture, page, 'g2')),
    { role: 'user' as const, content: 'G2: incorporate the newly supplied cross-chapter exception and later correction. Preserve exact citations, completed EDIT019 and unread scope; do not give the final answer yet.' }];
  const g2 = await generation('g2', second);
  const s2 = await compactAt('s2', [...second, assistant(g2)]);
  const candidate = await generation('g3', [...s2, { role: 'user', content: 'G3: give the final JSON answer to the original task using only retained evidence. Report missing evidence honestly; never replay completed work or imply the unread document remainder was inspected.' }]);
  const reverse = randomInt(2) === 1;
  const visible = (result: KodaXStreamResult) => ({ text: text(result), toolCalls: result.toolBlocks, stopReason: result.stopReason,
    diagnostics: { jsonSchemaOnly: (() => { try { const value: unknown = JSON.parse(text(result)); return typeof value === 'object' && value !== null && !Array.isArray(value); } catch { return false; } })() } });
  const pairId = `${route.provider}-${route.model}-${fixture.id}`;
  const pair = { pairId, task: fixture.task, sourcePages: fixture.pages, groundTruth: fixture.groundTruth,
    A: visible(reverse ? candidate : reference), B: visible(reverse ? reference : candidate) };
  await jsonWriteNew(path.join(budget.directory, `${pairId}.blind.json`), pair);
  await jsonWriteNew(path.join(budget.directory, `${pairId}.reveal.json`), { pairHash: pilotHash(pair),
    A: reverse ? 'candidate' : 'reference', B: reverse ? 'reference' : 'candidate' });
  return { pairId, calls, blindHash: pilotHash(pair) };
}

async function main() {
  const directory = process.env.KODAX_DOCUMENT_PILOT_DIR;
  if (!directory) throw new Error('KODAX_DOCUMENT_PILOT_DIR must name the shared OS-temp evidence directory.');
  if (process.env.KODAX_DOCUMENT_PILOT_COMMAND === 'prepare') {
    const capture = await prepareDocumentPilot(directory);
    process.stdout.write(JSON.stringify({ directory, scManifestHash: pilotHash(capture), noProviderCalls: true, plannedCalls: 24 }) + '\n');
    return;
  }
  if (process.env.KODAX_DOCUMENT_PILOT_COMMAND !== 'run' || process.env.KODAX_DOCUMENT_PILOT_GO !== '1') throw new Error('Manual prepare or main-session GO is required; no provider calls dispatched.');
  const capture = JSON.parse(await fs.readFile(path.join(directory, 'sc-manifest.json'), 'utf8')) as DocumentPilotCapture;
  const freeze = JSON.parse(await fs.readFile(path.join(directory, 'frozen-candidate.json'), 'utf8')) as { manifestHash: string; scManifestHash: string };
  if (freeze.manifestHash !== process.env.KODAX_DOCUMENT_PILOT_MANIFEST_HASH || freeze.scManifestHash !== pilotHash(capture)) throw new Error('Frozen combined manifest does not match the SC capture.');
  for (const [file, hash] of Object.entries(capture.sourceHashes)) if (pilotHash(await fs.readFile(file, 'utf8')) !== hash) throw new Error(`Source changed after capture: ${file}`);
  for (const fixture of capture.fixtures) if (pilotHash(await fs.readFile(fixture.file, 'utf8')) !== fixture.documentHash) throw new Error('Controlled document changed after capture.');
  const budget = await createPilotBudget(directory);
  const lanes = await Promise.allSettled(capture.routes.map(async route => {
    try {
      for (const fixture of capture.fixtures) await runDocumentPilotPair(capture, fixture, route, budget, { manifestHash: freeze.manifestHash });
    } catch (error: unknown) {
      await budget.stop(`Document route ${route.provider}/${route.model} stopped; retain already dispatched lane evidence.`);
      throw error;
    }
  }));
  const failures = lanes.flatMap(lane => lane.status === 'rejected' ? [lane.reason as unknown] : []);
  if (failures.length) throw new AggregateError(failures, 'Document pilot failed; all already dispatched route requests have settled.');
  process.stdout.write(JSON.stringify({ directory, ledger: await budget.snapshot(), semanticReview: 'Main session must review *.blind.json before *.reveal.json; no automated shipping decision.' }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
