/** DOCX r2: eight controlled next responses; never execute model tools or call a judge.
 * Layer 1 establishes runtime behavior. This probe only tests interpretation of its bytes.
 * prepare is offline; run requires the shared manifest/ledger and explicit main-session GO.
 * Historical outputs lack exact inputs; the r2 historical arm is a newly controlled reconstruction.
 * Results: docs/test-guides/ISSUE_322_v0.7.97_REGRESSION_GUIDE.md. No per-alias Boolean shipping gate.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getProvider, type KodaXMessage, type KodaXStreamResult, type KodaXToolDefinition } from '../packages/llm/src/index.js';
import type { KodaXExtensionAPI } from '../packages/coding/src/index.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { registerArtifactTools } from '../packages/artifacts/src/kodax.js';
import { createArtifactSdk } from '../packages/artifacts/dist/index.js';
import { createNodeArtifactPort } from '../packages/artifacts/dist/runtime.js';
import { capturePilotWire, createBudgetedProvider, createPilotBudget, estimatedPilotInput, PILOT_LIMITS, pilotHash,
  type PilotRoute } from './small-context-document-pilot-support.js';

export const DOCX_REVISION = 'artifact-docx-r2';
const DOCX_R3_REVISION = 'artifact-docx-r3-continuation';
const BASELINE_REF = '58671f8dea75a0df2498ad553536b17ee2b04896';
const ROUTES = [
  { alias: 'ds/flash', provider: 'deepseek', model: 'deepseek-flash', billing: 'token-bill', peakInputUsdPerMillion: 0.3, peakOutputUsdPerMillion: 1.2 },
  { alias: 'zhipu/glm53flash', provider: 'zhipu-coding', model: 'glm-5.3-flash', billing: 'coding-subscription', peakInputUsdPerMillion: 0, peakOutputUsdPerMillion: 0 },
] as const satisfies readonly (PilotRoute & { alias: string })[];
const SOURCES = ['packages/artifacts/src/kodax.ts', 'packages/artifacts/src/document-render.ts',
  'packages/artifacts/skills/artifact-review/SKILL.md', 'packages/llm/src/providers/image-serialization.ts',
  'packages/coding/src/agents/worker-role-prompt.ts', 'packages/coding/src/prompts/static-text.json',
  'packages/coding/src/tools/tool-definitions.ts', 'packages/artifacts/dist/runtime.js', 'packages/artifacts/dist/document-render.js',
  'tests/small-context-document-pilot-support.ts', 'tests/artifact-docx-render-desc.eval.ts'];
const FACTS = {
  docx_entry: 'The file is opened and current Host capabilities are recorded. Opening or inspecting can be a legitimate precursor; artifact_open is not render. A renderer or justified conversion advances review but does not itself prove a visual pass.',
  docx_fallback: 'A real lightweight result is unverified with a blocking diagnostic and a real PNG item. Production serializers may lower the image to an unsupported-image marker. Capability checks or Word/PDF conversion can be justified; more lightweight pages do not resolve native fields/pagination. Judge actual arguments and reservations, not regex words or tool-name prefixes.',
};
type CaseId = keyof typeof FACTS;
interface Input { system: string; messages: KodaXMessage[]; tools: KodaXToolDefinition[] }
interface Call { callId: string; pairId: string; side: 'A' | 'B'; caseId: CaseId; route: typeof ROUTES[number]; inputHash: string; inputFile: string;
  wireFile: string; wireHash: string; wireBytes: number; reservedTokens: number }
export interface DocxCapture { revision: string; sourceRevision: string; baselineRef: string;
  sourceHashes: Record<string, string>; assets: Record<string, string>; calls: Call[]; facts: typeof FACTS;
  scope: string; plannedCalls: number; globalLimits: typeof PILOT_LIMITS; priorCaptureHash?: string }
const jsonNew = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx' });
const fileHash = async (file: string) => pilotHash((await fs.readFile(file)).toString('base64'));
const wireText = (operation: string, value: object) => JSON.stringify({ ...value, protocol: 'kodax-artifact/1', operation });

function productionTools(): KodaXToolDefinition[] {
  const tools: KodaXToolDefinition[] = [];
  const api = { registerTool: (tool: KodaXToolDefinition) => {
    tools.push({ name: tool.name, description: tool.description, input_schema: tool.input_schema }); return () => undefined;
  }, registerSkillPath: () => () => undefined } as unknown as KodaXExtensionAPI;
  registerArtifactTools(api, { execute: async () => '', nodeExecutable: process.execPath });
  const bash = getToolDefinition('bash');
  if (!bash || tools.length !== 9) throw new Error('Production tool registration changed; review this experiment.');
  return [bash, ...tools];
}

export async function prepareDocxPilot(directory: string): Promise<DocxCapture> {
  const root = path.resolve(directory);
  if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Use shared OS-temporary pilot storage.');
  const browserExecutable = process.env.KODAX_ARTIFACT_TEST_BROWSER;
  const libreOfficeExecutable = process.env.KODAX_ARTIFACT_TEST_LIBREOFFICE;
  if (!browserExecutable || !libreOfficeExecutable) throw new Error('Provide trusted browser/LibreOffice test paths; no implicit installation.');
  const workspace = path.join(root, 'docx-workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(root, 'docx-private'), { recursive: true });
  await fs.copyFile('tests/fixtures/artifacts/explicit-break-table.docx', path.join(workspace, 'report.docx'));
  const sdk = createArtifactSdk(createNodeArtifactPort({ workspaceRoot: workspace, browserExecutable, libreOfficeExecutable }));
  const opened = await sdk.open({ path: 'report.docx' }), capabilities = await sdk.capabilities();
  const fallback = await sdk.render({ path: 'report.docx', pages: [1], backend: 'lightweight' });
  if (fallback.status !== 'unverified' || !fallback.evidence?.evidence.length
    || !fallback.diagnostics.some(value => value.code === 'docx-preview-fidelity' && value.blocking)) throw new Error('Production fallback fixture changed.');
  const previous = (file: string) => execFileSync('git', ['show', `${BASELINE_REF}:${file}`], { encoding: 'utf8', windowsHide: true });
  const oldDescription = previous('packages/artifacts/src/kodax.ts').match(/render: \{ description: '([^']+)'/)?.[1];
  const oldFallback = previous('packages/artifacts/src/document-render.ts').match(/code: 'docx-preview-fidelity', message: '([^']+)'/)?.[1];
  if (!oldDescription || !oldFallback) throw new Error('Cannot recover historical production text exactly.');
  const tools = productionTools(), system = buildWorkerStableInstructions(tools.map(value => value.name))
    + `\nControlled workspace: ${workspace}\nWindows fixture scenario: Microsoft Word is installed.`;
  const task = 'Please visually review report.docx before I send it to the client. Check layout, table of contents, headers and pagination.';
  const calls: Call[] = [], mapping: Array<{ callId: string; arm: string }> = [];
  for (const route of ROUTES) for (const caseId of Object.keys(FACTS) as CaseId[]) {
    const pairId = randomUUID(), arms = randomInt(2) ? ['historical', 'current'] : ['current', 'historical'];
    for (const [side, arm] of arms.entries()) {
      const messages: KodaXMessage[] = [{ role: 'user', content: task }];
      if (caseId === 'docx_entry') messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: 'open', name: 'artifact_open', input: { path: 'report.docx' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'open', content: wireText('open', opened) }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'cap', name: 'artifact_capabilities', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cap', content: wireText('capabilities', capabilities) }] });
      else {
        const diagnostics = fallback.diagnostics.map(value => arm === 'historical' && value.code === 'docx-preview-fidelity' ? { ...value, message: oldFallback } : value);
        const result = { ...fallback, diagnostics, evidence: { ...fallback.evidence, diagnostics } };
        messages.push(
          { role: 'assistant', content: [{ type: 'tool_use', id: 'render', name: 'artifact_render', input: { path: 'report.docx', pages: [1], backend: 'lightweight' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'render', content: [{ type: 'text', text: wireText('render', result) },
            ...fallback.evidence.evidence.map(value => ({ type: 'image' as const, path: value.path, mediaType: value.mediaType }))] }] });
      }
      messages.push({ role: 'user', content: 'Continue the review using available tools; preserve unverified scope.' });
      const input: Input = { system, messages, tools: tools.map(value => arm === 'historical' && value.name === 'artifact_render' ? { ...value, description: oldDescription } : value) };
      if (estimatedPilotInput(messages, input.tools, system) > PILOT_LIMITS.maxEstimatedInputTokens) throw new Error('Logical input exceeds the shared 12000-token estimate bound.');
      const callId = `docx-r2-${randomUUID()}`, inputFile = path.join(root, `${callId}.input.json`);
      const capturedWire = await capturePilotWire(getProvider(route.provider), route, { messages, tools: input.tools, system });
      const wireFile = path.join(root, `${callId}.prepared-wire.json`);
      await fs.writeFile(wireFile, capturedWire.wire, { flag: 'wx' });
      await jsonNew(inputFile, input);
      calls.push({ callId, pairId, side: side === 0 ? 'A' : 'B', caseId, route, inputHash: pilotHash(input), inputFile,
        wireFile, wireHash: capturedWire.wireHash, wireBytes: capturedWire.wireBytes, reservedTokens: capturedWire.reservedTokens });
      mapping.push({ callId, arm });
    }
  }
  const assets: Record<string, string> = {}, sourceHashes: Record<string, string> = {};
  for (const file of [path.join(workspace, 'report.docx'), ...fallback.evidence.evidence.map(value => value.path)]) assets[file] = await fileHash(file);
  const providerFiles = (await fs.readdir('packages/llm/src', { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  for (const file of [...SOURCES, ...providerFiles.map(file => `packages/llm/src/${file.replaceAll('\\', '/')}`)]) sourceHashes[file] = await fileHash(file);
  const capture: DocxCapture = { revision: DOCX_REVISION, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    baselineRef: BASELINE_REF, sourceHashes, assets, calls, facts: FACTS, plannedCalls: 8, globalLimits: PILOT_LIMITS,
    scope: 'Production tool definitions, stable Worker instructions and actual runtime fallback/images in controlled histories. Historical text is reconstructed from Git, not attributed to missing old request bytes. No whole-app/skill/native small-window or visual-quality acceptance claim.' };
  await jsonNew(path.join(root, 'docx-manifest.json'), capture);
  await jsonNew(path.join(root, 'docx-private', 'mapping.json'), mapping);
  return capture;
}

/** Metadata-only successor: never rerender, rewrite inputs or recapture provider requests. */
async function prepareDocxContinuation(directory: string): Promise<DocxCapture> {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Use shared OS-temporary pilot storage.');
  const previous = JSON.parse(await fs.readFile(path.join(directory, 'docx-manifest.json'), 'utf8')) as DocxCapture;
  if (previous.revision !== DOCX_REVISION || previous.calls.length !== 8) throw new Error('Expected the preserved eight-input r2 capture.');
  const allowedChanges = new Set(['tests/artifact-docx-render-desc.eval.ts', 'tests/small-context-document-pilot-support.ts']);
  for (const [file, expected] of Object.entries({ ...previous.sourceHashes, ...previous.assets })) {
    if (!allowedChanges.has(file) && await fileHash(file) !== expected) throw new Error(`Frozen production/input asset changed: ${file}`);
  }
  for (const call of previous.calls) {
    if (pilotHash(JSON.parse(await fs.readFile(call.inputFile, 'utf8'))) !== call.inputHash
      || pilotHash(await fs.readFile(call.wireFile, 'utf8')) !== call.wireHash) throw new Error('Frozen DOCX logical/wire input changed.');
  }
  const sourceHashes = { ...previous.sourceHashes };
  for (const file of allowedChanges) sourceHashes[file] = await fileHash(file);
  const capture: DocxCapture = { ...previous, revision: DOCX_R3_REVISION, priorCaptureHash: pilotHash(previous), sourceHashes,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    scope: previous.scope + ' R3 changes only test/eval protocol metadata and shared guard; all eight r2 inputs, prepared wires, assets, call IDs and blind mapping are retained unchanged.' };
  await jsonNew(path.join(directory, 'docx-manifest.r3.json'), capture);
  return capture;
}

export async function runDocxPilot(capture: DocxCapture, directory: string, manifestHash: string,
  manifestFile?: 'frozen-candidate.r3.json'): Promise<void> {
  const budget = await createPilotBudget(directory), outcomes = new Map<string, { result?: KodaXStreamResult; error?: string }>();
  const lanes = await Promise.allSettled(ROUTES.map(async route => {
    for (const call of capture.calls.filter(value => value.route.alias === route.alias)) {
      const input = JSON.parse(await fs.readFile(call.inputFile, 'utf8')) as Input;
      if (pilotHash(input) !== call.inputHash) throw new Error('Prepared input changed.');
      const provider = createBudgetedProvider(getProvider(route.provider), route, budget, { callId: call.callId, manifestHash, manifestFile });
      try {
        const result = await provider.stream(input.messages, input.tools, input.system, { enabled: false, effort: 'none' }, { modelOverride: route.model });
        outcomes.set(call.callId, { result }); await jsonNew(path.join(directory, `${call.callId}${manifestFile ? '.r3' : ''}.outcome.json`), { result });
      } catch (error: unknown) {
        const failure = { error: error instanceof Error ? error.message : String(error) };
        await budget.stop(`DOCX pilot stopped after ${call.callId}: ${failure.error}`);
        outcomes.set(call.callId, failure); await jsonNew(path.join(directory, `${call.callId}${manifestFile ? '.r3' : ''}.outcome.json`), failure); throw error;
      }
    }
  }));
  const pairs = [...new Set(capture.calls.map(value => value.pairId))].map(pairId => {
    const calls = capture.calls.filter(value => value.pairId === pairId);
    return { pairId, caseId: calls[0]!.caseId, alias: calls[0]!.route.alias, responses: Object.fromEntries(calls.map(call => [call.side,
      { inputHash: call.inputHash, text: outcomes.get(call.callId)?.result?.textBlocks.map(value => value.text).join('\n') ?? '',
        toolCalls: outcomes.get(call.callId)?.result?.toolBlocks ?? [], error: outcomes.get(call.callId)?.error, observed: outcomes.has(call.callId) }])) };
  });
  await jsonNew(path.join(directory, manifestFile ? 'docx-blind.r3.json' : 'docx-blind.json'), { captureHash: pilotHash(capture), facts: FACTS, pairs });
  await jsonNew(path.join(directory, manifestFile ? 'docx-verdicts.r3.template.json' : 'docx-verdicts.template.json'), { unblinded: false,
    reviews: pairs.map(({ pairId, caseId, alias }) => ({ pairId, caseId, alias, taskValidity: 'pending', preference: 'pending', rationale: '', harms: [], uncertainty: [] })),
    recommendation: 'pending main-session semantic review, not an aggregate pass gate' });
  const failures = lanes.filter((lane): lane is PromiseRejectedResult => lane.status === 'rejected').map(lane => lane.reason as unknown);
  if (failures.length) throw new AggregateError(failures, 'DOCX lanes failed; all dispatched requests have settled and their evidence was retained.');
}

async function main(): Promise<void> {
  const directory = process.env.KODAX_DOCUMENT_PILOT_DIR;
  if (!directory) throw new Error('Use the document pilot shared OS-temp directory; no independent DOCX budget.');
  const command = process.env.KODAX_DOCUMENT_PILOT_COMMAND;
  if (command === 'prepare' || command === 'prepare-r3') {
    const capture = await prepareDocxContinuation(directory);
    process.stdout.write(JSON.stringify({ directory, docxManifestHash: pilotHash(capture), noProviderCalls: true, reusedInputs: 8 }) + '\n'); return;
  }
  if (!['run', 'run-r3'].includes(command ?? '') || process.env.KODAX_DOCX_PILOT_RUN !== '1' || process.env.KODAX_DOCUMENT_PILOT_GO !== '1') throw new Error('Main-session DOCX GO required; no transport dispatched.');
  const manifestFile = 'frozen-candidate.r3.json' as const;
  const capture = JSON.parse(await fs.readFile(path.join(directory, 'docx-manifest.r3.json'), 'utf8')) as DocxCapture;
  const freeze = JSON.parse(await fs.readFile(path.join(directory, manifestFile), 'utf8')) as { manifestHash: string; docxManifestHash: string };
  if (freeze.manifestHash !== process.env.KODAX_DOCUMENT_PILOT_MANIFEST_HASH || freeze.docxManifestHash !== pilotHash(capture)
    || capture.revision !== DOCX_R3_REVISION || capture.calls.length !== 8) throw new Error('Main must freeze this exact DOCX capture in the combined manifest.');
  for (const [file, hash] of Object.entries({ ...capture.sourceHashes, ...capture.assets })) if (await fileHash(file) !== hash) throw new Error(`Source/asset changed: ${file}`);
  await runDocxPilot(capture, directory, freeze.manifestHash, manifestFile);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
