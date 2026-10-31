import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getDefaultSkillPaths, initializeSkillRegistry, SkillRegistry } from '../dist/sdk-skills.js';
import { KodaXBaseProvider, registerModelProvider } from '../dist/sdk-llm.js';
import { createDefaultCodingAgent, runKodaX } from '../dist/sdk-coding.js';
import { Runner } from '../dist/sdk-agent.js';
import { ensureKodaXRuntime, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';
import { createServer } from 'node:http';

test('split SDK discovers packaged built-in skills from the installed distribution', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const expected = path.join(root, 'dist', 'builtin');
  assert.equal(getDefaultSkillPaths().builtinPath, expected);
  assert.ok(existsSync(path.join(expected, 'visual-review', 'SKILL.md')));
  const registry = await initializeSkillRegistry(root, {
    projectPaths: [], userPaths: [], pluginPaths: [],
  });
  const skill = registry.get('visual-review');
  assert.equal(skill?.source, 'builtin');
  assert.match((await registry.loadFull('visual-review')).content, /Temporal/);
});

for (const agentMode of ['sa', 'ama']) for (const kind of ['default', 'profile']) {
  test(`shared Host retains a bounded Skill catalog: ${agentMode}/${kind}`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shared-skill-catalog-'));
    const configHome = path.join(root, '.kodax');
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    for (let index = 0; index < 40; index++) {
      const name = `audit-${String(index).padStart(2, '0')}`;
      const directory = path.join(configHome, 'skills', name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${'Inspect detailed catalog evidence. '.repeat(25)}\n---\nBODY_${name}\n`);
    }
    let loaded = false;
    const requests = [], requestErrors = [];
    const server = createServer(async (request, response) => {
      try {
        let body = ''; for await (const chunk of request) body += String(chunk);
        const payload = JSON.parse(body);
        const names = payload.tools?.map(tool => tool.function.name) ?? [];
        let tool, input;
        if (names.includes('commit_episode_learning_review')) {
          tool = 'commit_episode_learning_review'; input = { memoryPlan: { actions: [], warnings: [] },
            capabilityDecision: { disposition: 'discard', reasonCodes: ['fixture-no-reusable-method'] } };
        } else if (names.includes('skill')) {
          requests.push(payload);
          if (!loaded && JSON.stringify(payload.messages).includes('- audit-00:')) {
            loaded = true; tool = 'skill'; input = { skill: 'audit-00' };
          }
        }
        const delta = tool ? { tool_calls: [{ index: 0, id: 'load-audit', type: 'function',
          function: { name: tool, arguments: JSON.stringify(input) } }] } : { content: 'Done.' };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'catalog', object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        requestErrors.push(error); response.writeHead(500); response.end(String(error));
      }
    });
    let runtime, owner;
    const connection = { homeDir: root, profile: 'skill-catalog', daemonOrphanExitMs: 1000 };
    t.after(async () => {
      try {
        try { await runtime?.daemon.shutdown(); }
        finally { await runtime?.close(); }
        if (owner) assert.equal((await waitForRuntimeDaemonShutdown({ configHome, profile: connection.profile, owner })).status, 'succeeded');
      } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = 'shared-skill-catalog';
    await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: provider,
      protocol: 'openai', model: 'fixture', contextWindow: 262144, maxOutputTokens: 1024,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'KODAX_SHARED_CATALOG_UNUSED_KEY' }] }));
    runtime = await ensureKodaXRuntime(connection);
    owner = (await runtime.daemon.inspect()).owner;
    assert.ok(owner); assert.notEqual(owner.pid, process.pid);
    const lease = await runtime.credentials.registerScoped({ providers: [provider] }, async () => 'offline-fixture');
    const session = await runtime.sessions.create({ projectPath: workspace });
    await runtime.sessions.updateSettings(session.id, { provider, model: 'fixture', agentMode, permissionMode: 'full-access', reasoningMode: 'off' });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'Inspect evidence.',
      authorization: { credential: { leaseId: lease.id, mode: 'scoped', providers: [provider] },
        ...(kind === 'profile' ? { profile: { agentProfile: { instructions: 'PROFILE_SHARED' } } } : {}) } });
    assert.equal((await run.result).phase, 'completed');
    assert.deepEqual(requestErrors, []);
    const context = requests[0].messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
    const catalog = /## Available Skills\n[\s\S]*?\[Skill catalog shortened:[^\n]*\]/.exec(context)?.[0];
    assert.ok(catalog); assert.ok(catalog.length <= 8000); assert.ok(!catalog.includes('- audit-39:'));
    if (kind === 'profile') assert.equal(context.split('PROFILE_SHARED').length, 2);
    assert.ok(JSON.stringify(requests[1]?.messages).includes('BODY_audit-00'));
    const omitted = await runtime.invocations.prepareSkill({ projectRoot: workspace, name: 'audit-39', sessionId: session.id });
    assert.equal(omitted.kind, 'prepared', 'Catalog omission must retain explicit access to an admitted Skill');
  });
}
test('built SDK preserves Skill discovery, activation, permissions and refresh across public entry points', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-bundled-skill-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const skillDir = path.join(root, '.agents', 'skills', 'team', 'bundle-audit');
  const cwd = path.join(root, 'src');
  await mkdir(skillDir, { recursive: true });
  await mkdir(cwd);
  const file = path.join(skillDir, 'SKILL.md');
  const save = (body, flags = '') => writeFile(file,
    `---\nname: bundle-audit\ndescription: Inspect source code\nallowed-tools: Read\n${flags}---\n${body}\n`);
  await save('BUNDLED_SKILL_BODY');
  const oldKey = process.env.KODAX_BUNDLED_SKILL_KEY;
  process.env.KODAX_BUNDLED_SKILL_KEY = 'offline-fixture';
  t.after(() => {
    if (oldKey === undefined) delete process.env.KODAX_BUNDLED_SKILL_KEY;
    else process.env.KODAX_BUNDLED_SKILL_KEY = oldKey;
  });
  let actions = [], cursor = 0, requests = [];
  class Provider extends KodaXBaseProvider {
    name = 'bundled-skill-fixture';
    config = { name: this.name, model: 'fixture', apiKeyEnv: 'KODAX_BUNDLED_SKILL_KEY' };
    async stream(messages, tools, system) {
      requests.push({ system, tools: tools.map(tool => tool.name), messages: structuredClone(messages) });
      const action = actions[cursor++];
      return { textBlocks: action ? [] : [{ type: 'text', text: 'Done.' }], thinkingBlocks: [],
        toolBlocks: action ? [{ type: 'tool_use', id: `call-${cursor}`, ...action }] : [],
        stopReason: action ? 'tool_use' : 'end_turn' };
    }
  }
  registerModelProvider('bundled-skill-fixture', () => new Provider());
  const base = { provider: 'bundled-skill-fixture', maxIter: 4, reasoningMode: 'off',
    context: { configHome: path.join(root, 'home'), gitRoot: root, executionCwd: cwd, repoIntelligenceMode: 'off' } };
  for (const mode of ['model', 'explicit', 'runner-model', 'runner-explicit', 'hidden']) {
    const activation = mode.replace('runner-', '');
    cursor = 0; requests = [];
    const results = [];
    const registry = new SkillRegistry(root, { userPaths: [], pluginPaths: [], builtinPath: path.join(root, 'none') });
    await registry.discover();
    const skill = await registry.loadFull('bundle-audit');
    actions = activation === 'hidden' ? [] : [
      ...(activation === 'model' ? [{ name: 'skill', input: { skill: 'bundle-audit' } }] : []),
      { name: 'glob', input: { pattern: '**/SKILL.md' } },
    ];
    const options = { ...base, context: { ...base.context,
      ...(activation === 'explicit' ? { skillRegistry: registry, skillInvocation: { name: skill.name,
        path: file, expandedContent: skill.content, runtimePolicy: { enforceAtRuntime: true } } } : {}),
      ...(activation === 'hidden' ? { excludeTools: ['skill'] } : {}),
    }, events: { onToolResult: event => results.push(event.content) } };
    const result = mode.startsWith('runner-')
      ? (await Runner.run(createDefaultCodingAgent(), 'Inspect source code.', { presetOptions: options })).data
      : await runKodaX(options, 'Inspect source code.');
    assert.equal(result.success, true);
    if (activation === 'hidden') {
      assert.ok(!requests[0].tools.includes('skill'));
      assert.ok(!requests[0].system.includes('- bundle-audit:'));
    } else {
      assert.match(results.join('\n'), /Tool 'glob' is not allowed by bundle-audit/);
      if (activation === 'model') {
        assert.match(requests[0].system, /- bundle-audit:/);
        assert.match(results[0], /BUNDLED_SKILL_BODY/);
      }
    }
  }
  const registry = new SkillRegistry(root, { userPaths: [], pluginPaths: [], builtinPath: path.join(root, 'none') });
  await registry.discover();
  await registry.loadFull('bundle-audit');
  await save('UPDATED_BODY', 'disable-model-invocation: true\n');
  await registry.discover();
  const current = await registry.loadFull('bundle-audit');
  assert.equal(current.disableModelInvocation, true);
  assert.match(current.content, /UPDATED_BODY/);
  cursor = 0; requests = [];
  actions = [{ name: 'skill', input: { skill: 'bundle-audit' } }];
  const refused = [];
  await runKodaX({ ...base, context: { ...base.context, skillRegistry: registry,
    skillsPrompt: registry.getSystemPromptSnippet() },
    events: { onToolResult: event => refused.push(event.content) } }, 'Inspect source code.');
  assert.match(refused[0], /model invocation disabled/);

  for (let index = 0; index < 40; index++) {
    const name = `z-catalog-${String(index).padStart(2, '0')}`;
    const directory = path.join(root, '.agents', 'skills', 'collection', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${'Inspect detailed project evidence. '.repeat(40)}\n---\nCATALOG_BODY_${index}\n`);
  }
  await registry.discover();
  const catalog = registry.getSystemPromptSnippet();
  assert.ok(catalog.length <= 8_000);
  assert.match(catalog, /Skills omitted/);
  assert.ok(!catalog.includes('- z-catalog-39:'));
  cursor = 0; requests = [];
  actions = [{ name: 'skill', input: { skill: 'missing' } }];
  await runKodaX({ ...base, context: { ...base.context, skillRegistry: registry,
    skillsPrompt: catalog } }, 'Inspect source code.');
  const unknown = requests[1].messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'tool_result') : []).at(-1);
  assert.match(String(unknown.content), /unknown skill "missing"/);
  assert.ok(String(unknown.content).length <= 8_000);
  assert.ok(!String(unknown.content).includes('bundle-audit'));
  assert.ok(!String(unknown.content).includes('z-catalog-39'));
  for (const activation of ['model', 'explicit']) {
    cursor = 0; requests = [];
    const name = activation === 'model' ? 'z-catalog-00' : 'z-catalog-39';
    const skill = await registry.loadFull(name);
    actions = activation === 'model' ? [{ name: 'skill', input: { skill: name } }] : [];
    const outputs = [];
    await runKodaX({ ...base, context: { ...base.context, skillRegistry: registry,
      skillsPrompt: catalog,
      ...(activation === 'explicit' ? { skillInvocation: { name, path: skill.skillFilePath,
        expandedContent: skill.content, runtimePolicy: { enforceAtRuntime: true } } } : {}),
    }, events: { onToolResult: event => outputs.push(event.content) } }, 'Inspect source code.');
    assert.ok(requests[0].system.includes(catalog.trim()), 'The actual Provider must receive the bounded catalog');
    if (activation === 'model') assert.match(outputs[0], /CATALOG_BODY_0/);
    else assert.match(requests[0].system, /CATALOG_BODY_39/);
  }
});
