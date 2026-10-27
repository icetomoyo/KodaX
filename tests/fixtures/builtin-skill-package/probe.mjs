import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KodaXBaseProvider, registerModelProvider } from '@kodax-ai/kodax/llm';
import { SkillRegistry } from '@kodax-ai/kodax/skills';
import { runKodaX } from '@kodax-ai/kodax';
import { registerArtifactTools } from '@kodax-ai/kodax/artifacts/kodax';

const packageRoot = path.join(process.cwd(), 'node_modules/@kodax-ai/kodax');
const scripts = path.join(packageRoot, 'dist/builtin/skill-creator/scripts');
const helpers = {};
for (const file of await readdir(scripts)) {
  if (file.endsWith('.js')) helpers[file.slice(0, -3)] = await import(pathToFileURL(path.join(scripts, file)).href);
}
const registry = new SkillRegistry(process.cwd(), { projectPaths: [], userPaths: [], pluginPaths: [],
  builtinPath: path.join(packageRoot, 'dist/builtin') });
await registry.discover();
assert.equal(registry.size, 5);
for (const name of ['git-workflow', 'tdd', 'code-review', 'skill-creator', 'visual-review']) {
  assert.equal((await registry.loadFull(name)).name, name);
}
assert.match(registry.getSystemPromptSnippet(), /git-workflow/);
assert.match(registry.getSystemPromptSnippet(), /- tdd:/);
const artifactPaths = [];
const removeArtifact = registerArtifactTools({ registerTool: () => () => undefined,
  registerSkillPath: value => { artifactPaths.push(value); return () => undefined; },
  getExecutionScope: () => undefined,
}, { nodeExecutable: process.execPath, execute: async () => { throw new Error('Registration must not execute tools.'); } });
const optionalRegistry = new SkillRegistry(process.cwd(), { projectPaths: [], userPaths: [], pluginPaths: artifactPaths,
  builtinPath: path.join(packageRoot, 'dist/builtin') });
await optionalRegistry.discover();
assert.equal(optionalRegistry.size, 6);
assert.equal((await optionalRegistry.loadFull('artifact-review')).name, 'artifact-review');
removeArtifact();

// Execute real local commands through the installed SDK, not just a policy matcher.
const commandCwd = path.join(process.cwd(), 'command-workspace');
await mkdir(commandCwd);
await promisify(execFile)('git', ['init', '--quiet', commandCwd], { windowsHide: true });
await writeFile(path.join(commandCwd, 'policy-command.cjs'), "process.stdout.write('POLICY_COMMAND_RAN');");
await writeFile(path.join(commandCwd, 'package.json'), JSON.stringify({ scripts: { test: 'node policy-command.cjs' } }));
const apiRequests = [];
const server = createServer((request, response) => {
  apiRequests.push({ method: request.method, url: request.url });
  request.resume();
  response.end('POLICY_API_RAN');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
await writeFile(path.join(commandCwd, 'git-hosting-request.cjs'),
  `fetch('http://127.0.0.1:${address.port}/repos/fixture/project/pulls', { method: 'POST' })`
  + ".then(async response => process.stdout.write(await response.text())).catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });");
let command = '';
let policyCalls = 0;
class PolicyProvider extends KodaXBaseProvider {
  name = 'packed-policy';
  config = { name: 'packed-policy', model: 'fixture', apiKeyEnv: 'KODAX_PACKED_EVAL_KEY' };
  async stream(messages) {
    assert.ok(++policyCalls <= 14, 'Offline command smoke exceeded its fixed call budget.');
    const finished = messages.some(message => Array.isArray(message.content)
      && message.content.some(block => block.type === 'tool_result'));
    return { textBlocks: finished ? [{ type: 'text', text: 'Done.' }] : [], thinkingBlocks: [],
      toolBlocks: finished ? [] : [{ type: 'tool_use', id: 'command', name: 'bash', input: { command } }],
      stopReason: finished ? 'end_turn' : 'tool_use' };
  }
}
registerModelProvider('packed-policy', () => new PolicyProvider());
try {
  for (const [name, candidate, outcome] of [
    ['git-workflow', 'git status --short', 'allowed'],
    ['git-workflow', 'node git-hosting-request.cjs', 'allowed'],
    ['tdd', 'npm test', 'allowed'],
    ['code-review', 'git diff --stat', 'allowed'],
    ['skill-creator', 'node policy-command.cjs', 'allowed'],
    ['code-review', 'git commit -m unrequested', 'skill-denied'],
    ['git-workflow', 'node git-hosting-request.cjs', 'host-denied'],
  ]) {
    command = candidate;
    const skill = await registry.loadFull(name);
    let hostCalls = 0;
    const results = [];
    await runKodaX({ provider: 'packed-policy', model: 'fixture', maxIter: 3,
      context: { executionCwd: commandCwd, gitRoot: commandCwd, skillRegistry: registry,
        skillInvocation: { name, path: skill.skillFilePath, expandedContent: skill.content,
          runtimePolicy: { enforceAtRuntime: true } } },
      events: { beforeToolExecute: async () => {
        hostCalls++;
        return outcome === 'host-denied' ? '[Blocked] Host authorization denied.' : true;
      }, onToolResult: result => { results.push(result.content); } },
    }, 'Execute the fixture command.');
    assert.equal(hostCalls, outcome === 'skill-denied' ? 0 : 1, `${name}: Host authority`);
    const output = JSON.stringify(results);
    if (outcome === 'allowed') {
      assert.match(output, /Exit: 0/, `${name}: command did not execute`);
      if (name === 'tdd' || name === 'skill-creator') assert.match(output, /POLICY_COMMAND_RAN/);
      if (candidate === 'node git-hosting-request.cjs') assert.match(output, /POLICY_API_RAN/);
    } else {
      assert.match(output, outcome === 'host-denied' ? /Host authorization denied/ : /not allowed by code-review/);
    }
  }
  assert.equal(policyCalls, 14);
  assert.deepEqual(apiRequests, [{ method: 'POST', url: '/repos/fixture/project/pulls' }]);
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const created = await helpers['init-skill'].initSkill({ name: 'packed-example', baseDir: path.join(process.cwd(), 'skills'),
  description: 'Write release notes when asked to draft release notes.' });
const skillPath = created.skillDir;
await writeFile(path.join(skillPath, 'SKILL.md'), '---\nname: packed-example\ndescription: Write release notes when asked to draft release notes.\n---\nSummarize auth and billing.\n');
assert.equal((await helpers['quick-validate'].validateSkillDirectory(skillPath)).valid, true);
const evalsPath = path.join(process.cwd(), 'evals.json');
await writeFile(evalsPath, JSON.stringify({ evals: [{ id: 1, prompt: 'Draft release notes for auth and billing.',
  assertions: [{ text: 'mentions auth and billing' }] }] }));
let calls = 0;
class FixtureProvider extends KodaXBaseProvider {
  name = 'packed-fixture';
  config = { name: 'packed-fixture', model: 'fixture', apiKeyEnv: 'KODAX_PACKED_EVAL_KEY' };
  async stream() {
    assert.ok(++calls <= 2, 'Offline script smoke exceeded its fixed call budget.');
    return { textBlocks: [{ type: 'text', text: 'Auth and billing changed.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}
registerModelProvider('packed-fixture', () => new FixtureProvider());
const workspaceDir = path.join(process.cwd(), 'eval-workspace');
const report = await helpers['run-eval'].runEvalWorkspace({ skillPath, evalsPath, workspaceDir,
  provider: 'packed-fixture', model: 'fixture', cwd: process.cwd(), maxIter: 1, runsPerConfig: 1 });
assert.equal(calls, 2);
assert.equal(report.eval_count, 1);
assert.match(await readFile(path.join(workspaceDir, 'eval-0/with_skill/run-1/outputs/prompt.txt'), 'utf8'), /<skill name="packed-example"/);
const grading = await helpers['grade-evals'].gradeWorkspace({ workspaceDir }, async () => JSON.stringify({
  overall_summary: 'Scripted fixture grading, not a model quality judgment.',
  expectations: [{ text: 'mentions auth and billing', passed: true, evidence: 'The fixture explicitly names both.' }],
  user_notes_summary: { uncertainties: [], needs_review: [], workarounds: [] },
}));
assert.equal(grading.processed, 2);
const benchmark = helpers['aggregate-benchmark'].buildBenchmarkDocument(workspaceDir, 'packed-example',
  await helpers['aggregate-benchmark'].loadRunResults(workspaceDir));
await writeFile(path.join(workspaceDir, 'benchmark.json'), JSON.stringify(benchmark));
await writeFile(path.join(workspaceDir, 'benchmark.md'), helpers['aggregate-benchmark'].renderBenchmarkMarkdown(benchmark));
await helpers['analyze-benchmark'].analyzeBenchmark({ workspaceDir }, async () => JSON.stringify({
  verdict: 'inconclusive', release_readiness: 'needs_iteration', recommendation: 'This is an offline wiring smoke.',
  key_findings: [], variance_hotspots: [], suggested_actions: [], watchouts: ['No real model quality evidence.'],
}));
const comparison = await helpers['compare-runs'].compareWorkspace({ workspaceDir }, async () => JSON.stringify({
  winner: 'tie', confidence: 1, rationale: 'Both outputs are scripted.', strengths_a: [], strengths_b: [], risks: [],
}));
assert.equal(comparison.document.summary.total_pairs, 1);
const payload = await helpers['generate-review'].buildPayload(workspaceDir, { skillName: 'packed-example' });
assert.match(helpers['generate-review'].renderHtml(payload, true), /packed-example/);
const triggersPath = path.join(process.cwd(), 'description-cases.json');
await writeFile(triggersPath, JSON.stringify({ evals: [{ query: 'Draft release notes.', should_trigger: true }] }));
const semantic = await helpers['run-trigger-eval'].runTriggerEval({ skillPath, evalsPath: triggersPath },
  async () => '{"trigger":true,"reason":"Fixture only; not actual tool selection."}');
const semanticPath = path.join(process.cwd(), 'description-results.json');
await writeFile(semanticPath, JSON.stringify(semantic));
await helpers['improve-description'].improveDescription({ skillPath, evalResultsPath: semanticPath },
  async () => '<new_description>Draft release notes for requested changes.</new_description>');
await helpers['run-loop'].runDescriptionLoop({ skillPath, evalsPath: triggersPath,
  workspaceDir: path.join(process.cwd(), 'description-loop'), maxIterations: 1, holdout: 0 }, {
  runTriggerEvalFn: async () => semantic,
});
const archive = await helpers['package-skill'].buildSkillPackage(skillPath);
const archivePath = path.join(process.cwd(), 'packed-example.skill');
await writeFile(archivePath, archive.bytes);
const destination = path.join(process.cwd(), 'isolated-install');
const installed = await helpers['install-skill'].installSkill(archivePath, { skillsDir: destination });
assert.equal(installed.skillName, 'packed-example');
assert.match(await readFile(path.join(destination, 'packed-example/SKILL.md'), 'utf8'), /packed-example/);
process.stdout.write('PACKED_SKILL_CHAIN_PASSED\n');
