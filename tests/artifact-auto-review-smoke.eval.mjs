// Opt-in Layer 3.5 smoke: ordinary request, actual Host/tools/provider images, no slash or review hints.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createKodaXRuntime } from '../dist/sdk-runtime.js';
import { KODAX_PROVIDERS } from '../dist/sdk-llm.js';
import { executeArtifactRequest } from '../packages/artifacts/dist/runtime.js';

if (process.env.KODAX_ARTIFACT_E2E !== '1') throw new Error('Explicit paid smoke opt-in required.');
const repository = fileURLToPath(new URL('../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-artifact-auto-e2e-'));
const browserExecutable = process.env.KODAX_ARTIFACT_TEST_BROWSER ?? chromium.executablePath();
const targets = [{ provider: 'zai-coding', model: 'glm-5.3-flash' }, { provider: 'deepseek', model: 'deepseek-flash' }];
const priorDirectory = process.env.KODAX_ARTIFACT_PRIOR_E2E;
const prior = priorDirectory ? JSON.parse(await fs.readFile(path.join(priorDirectory, 'raw.json'), 'utf8')) : undefined;
const priorExperiment = priorDirectory ? JSON.parse(await fs.readFile(path.join(priorDirectory, 'experiment.json'), 'utf8')) : undefined;
const limits = { maxPhysicalCalls: (prior?.calls ?? 0) + 20, maxCallsThisRevision: 20, maxCallsPerCell: 10, maxRounds: 10, maxToolCallsPerCell: 50, maxChildren: 0,
 maxOutputTokensPerCall: 64000, maxReservedTokens: 6_800_000, maxReservedUsd: 30, timeoutMs: 300_000 };
const prompt = '把当前 deck.pptx 的标题改为“Quarterly revenue review”，另存为 final.pptx，供会议展示，保留收入表和其他内容。完成后告诉我交付文件路径。';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const state = { calls: prior?.calls ?? 0, reservedTokens: prior?.reservedTokens ?? 0, reservedUsd: prior?.reservedUsd ?? 0, cells: [] };
const callsBeforeRevision = state.calls;
let persistence = Promise.resolve();
const persist = () => persistence = persistence.then(() => fs.writeFile(path.join(directory, 'raw.json'), JSON.stringify(state, null, 2)));
const experiment = { layer: '3.5', revision: (priorExperiment?.revision ?? 0) + 1, priorEvidence: priorDirectory, callsBeforeRevision, targets, prompt, limits, samplesPerModel: 1,
 revisionReason: 'One shared Host with admitted fixture hooks. Prior 2048-token smoke caused the normal provider 64000-token escalation to hit its frozen wire ceiling. Use an 8192-token initial response budget with that existing escalation ceiling; preserve all prior calls/reservations/raw. No production prompt or implementation change.',
 reasonLayer1Insufficient: 'Code/unit checks establish shared guidance and tool/image wiring, but cannot show these requested models autonomously choose final visual inspection for an ordinary edit task.',
 taskValidity: 'Same real PPTX with a title-covering rectangle; no user review request, tool/skill names, slash command, injected reminders or follow-up. Production AMA guidance and tool definitions remain.',
 billing: 'Existing GLM coding subscription and DeepSeek token API; reservations use conservative 4/12 USD per million input/output tokens, not billed-cost claims.',
 rubric: 'Separately record successful requested edit, autonomous current-output render, actual matching provider-wire image bytes, grounded visual finding, repair/re-render and remaining limitations. Main session reviews raw/images; N=1 smoke does not measure reliability or compare prompts.',
 restrictions: 'No extra child/workflow/model route; non-managed shell blocked; workspace/cell-owned files only. Fixed-argv Artifact execution and ordinary skill discovery stay on production Host paths.',
 sourceIdentity: sha(await fs.readFile(path.join(repository, 'packages/artifacts/dist/kodax.js'))) };
await fs.writeFile(path.join(directory, 'experiment.json'), JSON.stringify(experiment, null, 2));
process.stdout.write('Auto-review evidence: ' + directory + '\n');

const template = path.join(directory, 'template'); await fs.mkdir(template);
const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
try { const page = await browser.newPage({ viewport: { width: 520, height: 100 } });
 await page.setContent('<body style="margin:0;background:white;font:40px Arial;padding:20px">View: A83C61</body>');
 await page.screenshot({ path: path.join(template, 'badge.png') });
} finally { await browser.close(); }
const created = await executeArtifactRequest({ operation: 'create', input: { output: 'deck.pptx', slides: [{ elements: [
 { type: 'text', text: 'Quarterly review', x: 1, y: 1, width: 10, height: 1, fontSize: 32 },
 { type: 'rectangle', color: '152C45', x: 0.8, y: 0.8, width: 11.5, height: 1.5 },
 { type: 'table', rows: [['Month', 'Revenue'], ['January', '12'], ['February', '24'], ['March', '36']], x: 1, y: 3, width: 6, height: 2 },
 { type: 'image', path: 'badge.png', x: 9, y: 6.5, width: 3.5, height: 0.7 },
 ] }] } }, { workspaceRoot: template });
await fs.writeFile(path.join(directory, 'ground-truth.json'), JSON.stringify({ created, issue: 'Opaque dark rectangle after title covers its complete geometry.' }, null, 2));

const factories = new Map(Object.entries(KODAX_PROVIDERS));
for (const name of factories.keys()) if (!targets.some(t => t.provider === name)) KODAX_PROVIDERS[name] = () => { throw new Error('Smoke forbids unregistered model/provider route: ' + name); };
const home = path.join(directory, 'home'), extensions = path.join(home, '.kodax', 'extensions'); await fs.mkdir(extensions, { recursive: true });
await fs.writeFile(path.join(extensions, 'artifacts.mjs'), 'import {registerArtifactTools} from ' + JSON.stringify(pathToFileURL(path.join(repository, 'packages/artifacts/dist/kodax.js')).href) + ';\nimport {executeManagedProcess} from ' + JSON.stringify(pathToFileURL(path.join(repository, 'dist/sdk-coding.js')).href) + ';\nexport default api=>{api.hook("tool:before",({name,input})=>{if(name==="bash"&&!String(input.command).startsWith("Fixed argv: ["))return "[Blocked] Non-managed shell is outside this bounded smoke.";if(["task_spawn","task_delegate","task_fan_out","run_workflow"].includes(name))return "[Blocked] Additional children are outside this bounded smoke.";});return registerArtifactTools(api,{execute:executeManagedProcess,nodeExecutable:' + JSON.stringify(process.execPath) + ',browserExecutable:' + JSON.stringify(browserExecutable) + '});};');
const runtime = await createKodaXRuntime({ homeDir: home, sharedDaemonHost: true, defaultProvider: targets[0].provider, defaultModel: targets[0].model });
try {
await Promise.all(targets.map(async target => {
 const root = path.join(directory, target.provider), workspace = path.join(root, 'project');
 await fs.mkdir(workspace, { recursive: true }); await fs.copyFile(path.join(template, 'deck.pptx'), path.join(workspace, 'deck.pptx'));
 await fs.copyFile(path.join(template, 'badge.png'), path.join(workspace, 'badge.png'));
 const cell = { ...target, root, calls: 0, inFlight: 0, maxInFlight: 0, tools: [], responses: [], wire: [], text: [] }; state.cells.push(cell);
 const controller = new AbortController();
 KODAX_PROVIDERS[target.provider] = () => {
  const provider = factories.get(target.provider)(), build = provider.buildClient.bind(provider), stream = provider.stream.bind(provider);
  provider.buildClient = async () => { const client = await build(), create = client.messages.create.bind(client.messages);
   client.messages.create = (body, options) => {
    const images = []; const walk = item => { if (!item || typeof item !== 'object') return;
     if (item.type === 'image' && item.source?.data) { const bytes = Buffer.from(item.source.data, 'base64'); images.push({ sha256: sha(bytes), bytes: bytes.length }); }
     for (const value of Object.values(item)) if (typeof value === 'object') { if (Array.isArray(value)) value.forEach(walk); else walk(value); } };
    walk(body.messages);
    const input = Buffer.byteLength(JSON.stringify(body).replace(/[A-Za-z0-9+/]{500,}={0,2}/g, '')) + images.length * 12000;
    const reserved = input + body.max_tokens, usd = input * 4 / 1e6 + body.max_tokens * 12 / 1e6;
    if (body.model !== target.model || body.max_tokens > limits.maxOutputTokensPerCall || cell.calls >= limits.maxCallsPerCell || state.calls >= limits.maxPhysicalCalls || state.calls - callsBeforeRevision >= limits.maxCallsThisRevision || state.reservedTokens + reserved > limits.maxReservedTokens || state.reservedUsd + usd > limits.maxReservedUsd) {
     cell.rejectedRequest = { model: body.model, maxOutputTokens: body.max_tokens, inputReservation: input, reserved, usd, calls: state.calls, reservedTokens: state.reservedTokens, reservedUsd: state.reservedUsd };
     controller.abort(new Error('Frozen smoke route/call/token/spend ceiling reached.')); throw controller.signal.reason;
    }
    const id = ++state.calls; cell.calls++; state.reservedTokens += reserved; state.reservedUsd += usd;
    cell.wire.push({ id, model: body.model, images, maxOutputTokens: body.max_tokens });
    persistence = persistence.then(() => fs.writeFile(path.join(root, 'wire-' + id + '.json'), JSON.stringify(body)));
    return create(body, { ...options, maxRetries: 0 });
   }; return client; };
  provider.stream = async (...args) => { if (cell.inFlight) throw new Error('Concurrent request in one provider lane.'); cell.inFlight++; cell.maxInFlight = Math.max(cell.maxInFlight, cell.inFlight);
   const started = Date.now(), record = {};
   try { const result = await stream(...args); record.result = result; return result; }
   catch (error) { record.error = { name: error.name, message: error.message }; throw error; }
   finally { record.durationMs = Date.now() - started; cell.responses.push(record); cell.inFlight--; await persist(); }
  }; return provider;
 };
 const timer = setTimeout(() => controller.abort(new Error('Frozen smoke timeout.')), limits.timeoutMs);
 try {
  const session = await runtime.sessions.create({ projectPath: workspace, title: 'Ordinary PPT edit' });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'ama', ...target });
  const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt, options: { ...target, reasoningMode: 'low', maxIter: limits.maxRounds, maxOutputTokens: 8192, abortSignal: controller.signal,
   context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off' },
   events: { beforeToolExecute: (name, input) => {
    if (['task_spawn', 'task_delegate', 'task_fan_out', 'run_workflow'].includes(name)) return '[Blocked] Additional children/workflows are outside this bounded smoke.';
    if (name === 'bash' && !String(input.command).startsWith('Fixed argv: [')) return '[Blocked] Non-managed shell is outside this bounded smoke.';
    if (['read', 'write', 'edit', 'glob', 'grep'].includes(name) && typeof input.path === 'string') { const resolved = path.resolve(workspace, input.path), relative = path.relative(root, resolved); if (relative.startsWith('..') || path.isAbsolute(relative)) return '[Blocked] Read/write only the owned smoke fixture.'; }
    return undefined;
   }, onTextDelta: text => cell.text.push(text), onToolUseStart: tool => { cell.tools.push({ start: tool }); process.stdout.write(target.provider + ' tool: ' + tool.name + '\n'); if (cell.tools.filter(item => item.start).length > limits.maxToolCallsPerCell) controller.abort(new Error('Frozen tool budget exhausted.')); }, onToolResult: result => cell.tools.push({ result }) },
  } }); cell.terminal = await handle.result;
 } catch (error) { cell.error = { name: error.name, message: error.message }; }
 finally { clearTimeout(timer); await persist(); }
 process.stdout.write(target.provider + ' finished; physicalCalls=' + cell.calls + '\n');
}));
} finally { await runtime.close(); }
await persistence;
process.stdout.write('Auto-review finished: ' + directory + '\n');
