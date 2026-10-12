// Opt in after build: KODAX_ARTIFACT_E2E=1 node tests/artifact-review-smoke.eval.mjs
// Layer 3.5, two cases, actual KodaX Host/Run and transport pixels; not a prompt comparison.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createKodaXRuntime } from '../dist/sdk-runtime.js';
import { KODAX_PROVIDERS } from '../dist/sdk-llm.js';
import { executeArtifactRequest } from '../packages/artifacts/dist/runtime.js';

if (process.env.KODAX_ARTIFACT_E2E !== '1') throw new Error('Explicit E2E opt-in required.');
const repository = fileURLToPath(new URL('../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-artifact-e2e-'));
const browserExecutable = process.env.KODAX_ARTIFACT_TEST_BROWSER ?? chromium.executablePath();
const limits = { maxPhysicalCalls: 32, maxCallsThisRevision: 16, maxCallsPerCase: 12, maxToolCallsPerCase: 64, maxRounds: 12, maxOutputTokensPerCall: 32768, maxReservedTokens: 3_000_000, maxReservedUsd: 5, timeoutMs: 360_000 };
const priorDirectory = process.env.KODAX_ARTIFACT_PRIOR_E2E;
const prior = priorDirectory ? JSON.parse(await fs.readFile(path.join(priorDirectory, 'raw.json'), 'utf8')) : undefined;
const state = { calls: prior?.calls ?? 0, reservedTokens: prior?.reservedTokens ?? 0, reservedUsd: prior?.reservedUsd ?? 0, maxInFlight: prior?.maxInFlight ?? 0, cases: [] };
const callsBeforeRevision = state.calls;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let active, lane = Promise.resolve(), inFlight = 0;
const factory = KODAX_PROVIDERS['kimi-code'];
KODAX_PROVIDERS['kimi-code'] = () => {
 const provider = factory(), build = provider.buildClient.bind(provider), stream = provider.stream.bind(provider);
 provider.buildClient = async () => {
  const client = await build(), create = client.messages.create.bind(client.messages);
  client.messages.create = (body, options) => {
   const images = [];
   const walk = item => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'image' && item.source?.data) { const bytes = Buffer.from(item.source.data, 'base64'); images.push({ sha256: sha(bytes), bytes: bytes.length }); }
    for (const value of Object.values(item)) if (typeof value === 'object') { if (Array.isArray(value)) value.forEach(walk); else walk(value); }
   };
   walk(body.messages);
   const reserved = Buffer.byteLength(JSON.stringify(body).replace(/[A-Za-z0-9+/]{500,}={0,2}/g, '')) + images.length * 6000 + limits.maxOutputTokensPerCall;
   const cost = reserved * 0.005 / 1e6 + limits.maxOutputTokensPerCall * 0.015 / 1e6;
   if (state.calls >= limits.maxPhysicalCalls || state.calls - callsBeforeRevision >= limits.maxCallsThisRevision || active.calls >= limits.maxCallsPerCase || state.reservedTokens + reserved > limits.maxReservedTokens || state.reservedUsd + cost > limits.maxReservedUsd || body.max_tokens > limits.maxOutputTokensPerCall) throw new Error('Frozen smoke budget exhausted.');
   state.calls++; active.calls++; state.reservedTokens += reserved; state.reservedUsd += cost;
   const id = state.calls; active.wire.push({ id, model: body.model, images, maxOutputTokens: body.max_tokens });
   active.writes.push(fs.writeFile(path.join(active.dump, 'wire-' + id + '.json'), JSON.stringify(body)));
   return create(body, { ...options, maxRetries: 0 });
  };
  return client;
 };
 provider.stream = async (...args) => {
  let release; const occupied = new Promise(resolve => { release = resolve; }); const before = lane; lane = before.then(() => occupied);
  await before; inFlight++; state.maxInFlight = Math.max(state.maxInFlight, inFlight);
  const started = Date.now(), record = {};
  try { const result = await stream(...args); record.result = result; return result; }
  catch (error) { record.error = { name: error.name, message: error.message }; throw error; }
  finally { try { record.durationMs = Date.now() - started; active.responses.push(record); await Promise.all(active.writes.splice(0)); await persist(); } finally { inFlight--; release(); } }
 };
 return provider;
};
const frozen = { layer: '3.5', provider: 'kimi-code', model: 'k3-256k', billing: 'existing coding subscription; bookkeeping reservations are not billed-cost claims', limits,
 revision: prior ? 2 : 1, priorEvidence: priorDirectory, callsBeforeRevision,
 revisionReason: prior ? 'Real AMA smoke exposed missing extension scope; fixed shared checked dispatch. Preserve original failed source and raw, rerun changed implementation only.' : 'Initial product smoke',
 reasonLayer1Insufficient: 'Only a real vision-capable provider can demonstrate that current rendered wire pixels ground a finding, repair and re-review. Deterministic Host/argv/renderer tests already pass.',
 cases: ['one-page PPTX occlusion repair with pixel-only nonce', 'missing-browser and temporal-adapter negative'],
 sourceIdentity: sha(await fs.readFile(path.join(repository, 'packages/artifacts/dist/kodax.js'))),
 verdictRubric: 'Require actual exported PPTX render wire images with matching SHA256 before and after source hash changes, correct pixel-only nonce, grounded occlusion finding, repair and current re-render. Negative must report visual/temporal unverified. No quality comparison or generalization from N=1.' };
await fs.writeFile(path.join(directory, 'experiment.json'), JSON.stringify(frozen, null, 2));
async function persist() { await fs.writeFile(path.join(directory, 'raw.json'), JSON.stringify({ ...state, cases: state.cases.map(({ writes, ...row }) => row) }, null, 2)); }
const nonce = randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
const project = path.join(directory, 'positive'); await fs.mkdir(project);
const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 520, height: 100 } });
 await page.setContent('<body style="margin:0;background:white;font:40px Arial;padding:20px;box-sizing:border-box">View: ' + nonce + '</body>');
 await page.screenshot({ path: path.join(project, 'badge.png') });
} finally { await browser.close(); }
const created = await executeArtifactRequest({ operation: 'create', input: { output: 'deck.pptx', slides: [{ elements: [
 { type: 'text', text: '季度评审 / Quarterly review', x: 1, y: 1, width: 10, height: 1, fontSize: 32 },
 { type: 'rectangle', color: '152C45', x: 0.8, y: 0.8, width: 11.5, height: 1.5 },
 { type: 'table', rows: [['月份', '收入'], ['January', '12'], ['February', '24'], ['March', '36']], x: 1, y: 3, width: 6, height: 2 },
 { type: 'image', path: 'badge.png', x: 9, y: 6.5, width: 3.5, height: 0.7 },
 ] }] } }, { workspaceRoot: project });
await fs.writeFile(path.join(directory, 'ground-truth.json'), JSON.stringify({ nonce, created }));
const prompts = {
 positive: '请视觉检查并修复本目录deck.pptx。要求“季度评审 / Quarterly review”标题与January/February/March收入表清晰完整，不能遮挡。使用已发现的artifact-review技能和artifact_*工具完成导入、渲染、修复到新PPTX、再次渲染复查；不要使用PowerPoint/LibreOffice/COM/脚本，最终应自主完成。先根据实际渲染图说明问题，再修改。图中View随机码只能看图识别：修复前后报告码与对应页，不能读badge.png或测试器目录。ready不是视觉通过；报告当前文件hash/页码/剩余限制。',
 negative: '请用artifact_*工具给当前deck.pptx的视觉布局，以及movie.webm在0和1秒的动画验收结论。本轮浏览器运行时缺失，安装不在本轮授权范围，不能调用artifact_prepare或shell替代。先实际调用相应工具，再简短报告两个要求是否已验证。不要把结构读取、ready、旧图片或静态截图当作视觉/时序通过。',
};
frozen.prompts = prompts; await fs.writeFile(path.join(directory, 'experiment.json'), JSON.stringify(frozen, null, 2));
for (const name of ['positive', 'negative']) {
 const workspace = name === 'positive' ? project : path.join(directory, name); if (name !== 'positive') { await fs.mkdir(workspace); await fs.copyFile(path.join(project, 'deck.pptx'), path.join(workspace, 'deck.pptx')); }
 const home = path.join(directory, 'homes', name), extensions = path.join(home, '.kodax', 'extensions'); await fs.mkdir(extensions, { recursive: true });
 await fs.writeFile(path.join(extensions, 'artifacts.mjs'), 'import {registerArtifactTools} from ' + JSON.stringify(pathToFileURL(path.join(repository, 'packages/artifacts/dist/kodax.js')).href) + ';\nimport {executeManagedProcess} from ' + JSON.stringify(pathToFileURL(path.join(repository, 'dist/sdk-coding.js')).href) + ';\nexport default api=>{api.hook("tool:before",({name,input})=>{if(name==="bash"&&!String(input.command).startsWith("Fixed argv: ["))return "[Blocked] Use managed Artifact SDK.";if(name==="read"&&String(input.path).endsWith("badge.png"))return "[Blocked] Inspect rendered PPTX pixels.";' + (name === 'negative' ? 'if(name==="artifact_prepare")return "[Blocked] Installation outside this fixture.";' : '') + '});return registerArtifactTools(api,{execute:executeManagedProcess,nodeExecutable:' + JSON.stringify(process.execPath) + ',browserExecutable:' + JSON.stringify(name === 'positive' ? browserExecutable : path.join(directory, 'missing-browser.exe')) + '});};');
 const dump = path.join(directory, 'raw', name); await fs.mkdir(dump, { recursive: true });
 active = { name, dump, calls: 0, tools: [], wire: [], responses: [], text: [], writes: [] }; state.cases.push(active);
 const runtime = await createKodaXRuntime({ homeDir: home, sharedDaemonHost: true, defaultProvider: 'kimi-code', defaultModel: 'k3-256k' });
 try {
  const session = await runtime.sessions.create({ projectPath: workspace, title: 'Artifact visual ' + name });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'ama', provider: 'kimi-code', model: 'k3-256k' });
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(new Error('Frozen smoke timeout.')), limits.timeoutMs);
  try {
   const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: prompts[name], options: { provider: 'kimi-code', model: 'k3-256k', reasoningMode: 'low', maxIter: limits.maxRounds, maxOutputTokens: 2048, abortSignal: stop.signal,
    context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off', toolVisibilityPolicy: tool => tool.name.startsWith('artifact_') || ['read', 'write', 'bash', 'skill'].includes(tool.name) },
    events: { beforeToolExecute: (tool, input) => {
     if (name === 'negative' && tool === 'artifact_prepare') return '[Blocked] Installation is outside this fixture authorization.';
     if (tool === 'bash' && !String(input.command).startsWith('Fixed argv: [')) return '[Blocked] Use the managed Artifact SDK for this fixture.';
     if (tool === 'read' && path.basename(String(input.path)) === 'badge.png') return '[Blocked] Inspect rendered PPTX pixels.';
     return undefined;
    }, onTextDelta: text => active.text.push(text), onToolUseStart: tool => { active.tools.push({ start: tool }); process.stdout.write(name + ' tool: ' + tool.name + '\n'); if (active.tools.filter(item => item.start).length > limits.maxToolCallsPerCase) stop.abort(new Error('Frozen tool budget exhausted.')); }, onToolResult: result => active.tools.push({ result }) },
   } });
   active.terminal = await handle.result;
  } finally { clearTimeout(timer); }
 } catch (error) { active.error = { name: error.name, message: error.message }; }
 finally { await runtime.close(); await persist(); }
 process.stdout.write(name + ' complete; calls=' + active.calls + '\n');
}
process.stdout.write('Artifact E2E evidence: ' + directory + '\n');
