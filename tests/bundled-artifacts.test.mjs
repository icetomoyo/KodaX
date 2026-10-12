import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKodaXRuntime } from '../dist/sdk-runtime.js';
import { KodaXBaseProvider, registerModelProvider } from '../dist/sdk-llm.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifactEntry = path.join(root, 'packages/artifacts/dist/runtime-entry.js');
const run = promisify(execFile);
test('built worker rejects a changed manifest before executing or writing artifact output', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact tamper '));
 try {
  const manifest = path.join(directory, '.artifact-request-' + randomUUID() + '.json');
  await fs.writeFile(manifest, JSON.stringify({ request: { operation: 'create', input: { output: 'bad.pptx', slides: [{ elements: [] }] } }, options: { workspaceRoot: directory, browserExecutable: 'untrusted.exe' } }));
  await assert.rejects(run(process.execPath, [artifactEntry, manifest, 'a'.repeat(64)]), error => /changed after admission/.test(error.stderr));
  assert.deepEqual(await fs.readdir(directory), []);
 } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('built KodaX Host owns PPT tool Runs and returns current pixels through the managed bridge', { timeout: 120_000 }, async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact Host 中文 '));
 const home = path.join(directory, 'home'), workspace = path.join(directory, 'work');
 await fs.mkdir(path.join(home, '.kodax', 'extensions'), { recursive: true }); await fs.mkdir(workspace);
 const options = { nodeExecutable: process.execPath, browserExecutable: process.env.KODAX_ARTIFACT_TEST_BROWSER };
 await fs.writeFile(path.join(home, '.kodax', 'extensions', 'artifacts.mjs'),
  'import {registerArtifactTools} from ' + JSON.stringify(pathToFileURL(path.join(root, 'packages/artifacts/dist/kodax.js')).href) + ';\n' +
  'import {executeManagedProcess} from ' + JSON.stringify(pathToFileURL(path.join(root, 'dist/sdk-coding.js')).href) + ';\n' +
  'export default api=>registerArtifactTools(api,{execute:executeManagedProcess,...' + JSON.stringify(options) + '});');
 let modelCalls = 0, modelScenario, modelMessages;
 class NoModel extends KodaXBaseProvider {
  name = 'artifact-no-model'; supportsThinking = false;
  config = { apiKeyEnv: 'KODAX_ARTIFACT_TEST_KEY', model: 'offline', supportsThinking: false };
  async stream(messages) {
   if (!modelScenario) { modelCalls++; throw new Error('Tool-only smoke must not call a model.'); }
   modelCalls++; modelMessages = messages;
   return { textBlocks: modelCalls === 1 ? [] : [{ type: 'text', text: 'Evidence prepared; no visual approval.' }], thinkingBlocks: [],
    toolBlocks: modelCalls === 1 ? [{ type: 'tool_use', id: 'scripted-render', name: 'artifact_render', input: { path: 'deck.pptx', pages: [1] } }] : [],
    stopReason: modelCalls === 1 ? 'tool_use' : 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
  }
 }
 process.env.KODAX_ARTIFACT_TEST_KEY = 'offline-fixture';
 const unregister = registerModelProvider('artifact-no-model', () => new NoModel());
 const runtime = await createKodaXRuntime({ homeDir: home, sharedDaemonHost: true, defaultProvider: 'artifact-no-model' });
 try {
  assert.equal((await runtime.catalog.extensions()).extensions.length, 1);
  const session = await runtime.sessions.create({ projectPath: workspace, title: 'Artifact Host smoke' });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'ama' });
  const invoke = async (name, input) => {
   const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'Artifact smoke ' + name, options: { lsp: false,
    toolInvocation: { name, input }, context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off' } } });
   const terminal = await handle.result;
   assert.equal(terminal.phase, 'completed', JSON.stringify(terminal)); assert.equal(terminal.result.success, true, terminal.result.lastText);
   return JSON.parse(terminal.result.lastText.split('\n')[0]);
  };
  const created = await invoke('artifact_create', { output: 'deck.pptx', slides: [{ elements: [{ type: 'text', text: 'Current pixels', x: 1, y: 1, width: 8, height: 1 }] }] });
  const opened = await invoke('artifact_open', { path: 'deck.pptx' });
  assert.equal(opened.artifact.sourceHash, created.artifact.sourceHash);
  assert.equal(opened.objects[0].text, 'Current pixels');
  const capture = await invoke('artifact_capture', { kind: 'temporal', target: 'video.webm', times: [0, 1] });
  assert.equal(capture.status, 'unverified');
  if (options.browserExecutable) {
   const rendered = await invoke('artifact_render', { path: 'deck.pptx', expectedSourceHash: opened.artifact.sourceHash, pages: [1] });
   assert.equal(rendered.status, 'ready');
   assert.equal(rendered.evidence.sourceHash, opened.artifact.sourceHash);
   const raster = rendered.evidence.evidence[0];
   assert.equal(createHash('sha256').update(await fs.readFile(raster.path)).digest('hex'), raster.sha256);
   assert.equal(raster.locator.page, 1);
  }
  assert.equal(modelCalls, 0);
  if (options.browserExecutable) {
   modelScenario = 'AMA render';
   const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Render deck.pptx with artifact_render once and return evidence readiness only.', options: { lsp: false, maxIter: 3, reasoningMode: 'off',
    context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off' } } });
   const terminal = await handle.result;
   assert.equal(terminal.phase, 'completed', JSON.stringify(terminal));
   const result = modelMessages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(item => item.type === 'tool_result' && item.tool_use_id === 'scripted-render');
   assert.ok(result && Array.isArray(result.content), JSON.stringify(result));
   assert.ok(result.content.some(item => item.type === 'image'));
   assert.equal(JSON.parse(result.content.find(item => item.type === 'text').text).status, 'ready');
  }
 } finally { await runtime.close(); unregister(); delete process.env.KODAX_ARTIFACT_TEST_KEY; await fs.rm(directory, { recursive: true, force: true }); }
});
