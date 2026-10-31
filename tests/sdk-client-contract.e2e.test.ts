import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { connectKodaXClient } from '../src/sdk-client.js';
import type { RuntimeCredentialLease, RuntimeHostToolLease } from '../src/client-host-authorization.js';
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { LEARNING_REVIEW_TOOL } from '@kodax-ai/coding';
import { executeArtifactRequest } from '@kodax-ai/artifacts/runtime';
import { connectKodaXRuntime } from '../src/sdk-runtime.js';

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
async function waitUntil<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise(done => setTimeout(done, 50)); }
  throw new Error('Timed out waiting for the Actor contract boundary');
}

interface WireRequest { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>; max_tokens?: number; max_completion_tokens?: number; reasoning_effort?: string }
function finish(response: ServerResponse, delta: Record<string, unknown>, reason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'sdk-contract', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
}
async function startHost(homeDir: string, searchEndpoint?: string): Promise<{ child: ChildProcess; endpoint: string; close(): Promise<void> }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env: { ...env, ...(searchEndpoint ? { KODAX_WEB_SEARCH_ENDPOINT: searchEndpoint } : {}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let errors = '';
  child.stdout!.resume();
  child.stderr!.on('data', chunk => { errors = (errors + String(chunk)).slice(-16_000); });
  let ready: { endpoint: string; pid: number };
  try { ready = await bounded(Promise.race([
    once(child, 'message').then(([value]) => value as { endpoint: string; pid: number }),
    once(child, 'exit').then(([code]) => { throw new Error(`Fixture Host exited ${String(code)}: ${errors}`); }),
  ]), 45_000, 'Fixture Host readiness timed out'); }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      try { await bounded(exited, 5_000, 'Fixture Host cleanup timed out'); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture Host startup failed and cleanup is unconfirmed.'); }
    }
    throw error;
  }
  expect(ready.pid).not.toBe(process.pid);
  return { child, endpoint: ready.endpoint, async close() {
    if (child.exitCode !== null || child.signalCode !== null || !child.connected) return;
    const exited = once(child, 'exit');
    child.send('close');
    try { await bounded(exited, 15_000, 'Fixture Host close timed out'); }
    catch { child.kill('SIGKILL'); await bounded(exited, 5_000, 'Fixture Host could not be stopped'); }
  } };
}

it('preserves Partner ceilings and Coder work modes across an independent Host process', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-cross-process-sdk-'));
  const requests: WireRequest[] = [];
  const partnerSteps: Array<{ name: string; input: Record<string, unknown> }> = [
    { name: 'tool_call', input: { name: 'repo_overview', input: {} } },
    { name: 'tool_call', input: { name: 'bash', input: { command: 'must-not-run' } } },
    { name: 'tool_call', input: { name: 'write', input: { path: 'forbidden.txt', content: 'must-not-write' } } },
    { name: 'tool_call', input: { name: 'edit', input: { path: 'forbidden.txt', old_string: 'a', new_string: 'b' } } },
    { name: 'tool_call', input: { name: 'spawn_agent', input: { taskName: 'forbidden', objective: 'must-not-spawn' } } },
    { name: 'tool_search', input: { query: 'select:repo_overview,bash,write,edit,spawn_agent,skill,space_artifact' } },
    { name: 'tool_call', input: { name: 'skill', input: { skill: 'partner-research' } } },
    { name: 'tool_call', input: { name: 'space_artifact', input: {} } },
    { name: 'tool_call', input: { name: 'space_connector_search', input: {} } },
    { name: 'tool_call', input: { name: 'space_expert_verify', input: {} } },
  ];
  let step = 0;
  let partner = false;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url?.startsWith('/search')
        ? '<a class="result__a" href="https://example.com/evidence">RESEARCH_SEARCH_EVIDENCE</a><a class="result__snippet">Primary fixture evidence.</a>'
        : '<html><title>Primary evidence</title><body>RESEARCH_FETCH_EVIDENCE</body></html>');
      return;
    }
    let body = ''; for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as WireRequest;
    if (parsed.tools?.some(tool => tool.function.name === LEARNING_REVIEW_TOOL.name)) { finish(response, { content: '{}' }); return; }
    requests.push(parsed);
    if (!partner && parsed.tools?.some(tool => tool.function.name === 'script_exec')
      && !parsed.messages.some(message => message.tool_call_id === 'coder-script-read')) {
      finish(response, { tool_calls: [{ index: 0, id: 'coder-script-read', type: 'function', function: {
        name: 'script_exec', arguments: JSON.stringify({ code: `const result = await tools.read({path: ${JSON.stringify(join(homeDir, 'evidence.txt'))}}); return result.content;` }),
      } }] }, 'tool_calls');
      return;
    }
    const call = partner ? partnerSteps[step++] : undefined;
    if (call) finish(response, { tool_calls: [{ index: 0, id: `step-${step}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, 'tool_calls');
    else finish(response, { content: 'SDK contract verified.' });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  partnerSteps.push({ name: 'web_search', input: { query: 'contract evidence' } },
    { name: 'web_fetch', input: { url: `http://127.0.0.1:${address.port}/evidence` } });
  await mkdir(join(homeDir, '.kodax', 'skills', 'partner-research'), { recursive: true });
  await writeFile(join(homeDir, '.kodax', 'skills', 'partner-research', 'SKILL.md'),
    '---\nname: partner-research\ndescription: Partner research\n---\nUse primary evidence and expert review.');
  await writeFile(join(homeDir, 'evidence.txt'), 'SCRIPT_EVIDENCE_RETAINED');
  await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({
    provider: 'sdk-loopback', model: 'fixture', maxOutputTokens: 1234, disablePromptCache: true,
    customProviders: [{ name: 'sdk-loopback', protocol: 'openai', model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_UNUSED_CROSS_PROCESS_KEY' }],
  }));
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let client: KodaXProductClient | undefined;
  let credential: RuntimeCredentialLease | undefined;
  let hostTools: RuntimeHostToolLease | undefined;
  const calls: string[] = [];
  const denied = ['bash', 'write', 'edit', 'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents', 'interrupt_agent', 'agent_output'];
  try {
    host = await startHost(homeDir, `http://127.0.0.1:${address.port}/search`);
    client = await connectKodaXClient({ homeDir, endpoint: host.endpoint, async authorizeExecution(request, services) {
      credential ??= await services.credentials.registerScoped({ providers: ['sdk-loopback'] }, async () => 'fixture-only');
      if (request.kind === 'agent_spawn' || request.kind === 'agent_followup') {
        return { credential: { leaseId: credential.id, mode: 'scoped', providers: ['sdk-loopback'] }, tools: ['read', 'lsp_definition'] };
      }
      hostTools ??= await services.hostTools.register(['space_artifact', 'space_connector_search', 'space_expert_verify'].map(name => ({
        name, description: name, inputSchema: { type: 'object', properties: {} }, sideEffect: name === 'space_artifact' ? 'non_idempotent' as const : 'none' as const,
      })), Object.fromEntries(['space_artifact', 'space_connector_search', 'space_expert_verify'].map(name => [name,
        async () => {
          calls.push(name);
          if (name !== 'space_artifact') return { content: `Completed ${name}` };
          const result = await executeArtifactRequest({ operation: 'create', input: { output: 'partner-report.pptx',
            slides: [{ elements: [{ type: 'text', text: 'Partner evidence', x: 1, y: 1, width: 6, height: 1 }] }] } }, { workspaceRoot: homeDir });
          return { content: JSON.stringify(result) };
        }])));
      return { credential: { leaseId: credential.id, mode: 'scoped', providers: ['sdk-loopback'] }, hostTools: { leaseId: hostTools.id },
        ...(partner ? { profile: await services.createExecutionProfile({ agentProfile: { id: 'space-partner', instructions: 'PARTNER_IDENTITY',
          verification: { requiredChecks: ['EXPERT_VERIFICATION_REQUIRED'] } },
          toolVisibilityPolicy: tool => !denied.includes(tool.name) && !['mutates-shell', 'mutates-fs'].includes(tool.sideEffect),
        }, hostTools.tools) } : {}),
      };
    } });
    const session = await client.sessions.create({ surface: 'partner', profileId: 'space-partner', projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { workMode: 'agent', agentMode: 'ama', permissionMode: 'full-access', reasoningMode: 'off' });
    partner = true;
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'partner', text: 'PARTNER_CONTRACT: research and produce an artifact.' });
    expect((await client.runs.await(accepted.runId!)).phase).toBe('completed');
    expect((await client.runs.read(accepted.runId!)).workMode).toBe('agent');
    const tools = requests[0]!.tools!.map(tool => tool.function.name);
    expect((await client.runs.read(accepted.runId!)).effectiveConfig).toMatchObject({ workMode: 'agent', modelToolScope: tools, agentProfile: { id: 'space-partner' }, verification: { requiredChecks: ['EXPERT_VERIFICATION_REQUIRED'] } });
    for (const name of [...denied, 'repo_overview', 'lsp_definition', 'semantic_lookup']) expect(tools).not.toContain(name);
    expect(tools).toEqual(expect.arrayContaining(['skill', 'web_search', 'space_artifact', 'space_expert_verify']));
    const transcript = JSON.stringify(requests.at(-1)!.messages);
    expect(transcript).toContain('not active');
    expect(transcript).toContain('Use primary evidence and expert review');
    expect(transcript).toContain('PARTNER_IDENTITY');
    expect(transcript).toContain('EXPERT_VERIFICATION_REQUIRED');
    expect(transcript).toContain('RESEARCH_SEARCH_EVIDENCE');
    expect(transcript).toContain('RESEARCH_FETCH_EVIDENCE');
    for (let index = 1; index <= 5; index += 1) {
      const deniedResult = requests.flatMap(value => value.messages).find(message => message.role === 'tool' && message.tool_call_id === `step-${index}`);
      expect(deniedResult, `Missing bridge denial for step-${index}`).toBeDefined();
      expect(String(deniedResult!.content)).toContain('not active');
    }
    const discovery = requests.flatMap(value => value.messages).find(message => message.role === 'tool' && message.tool_call_id === 'step-6');
    expect(discovery).toBeDefined();
    const schemas = [...String(discovery!.content).matchAll(/<function>(.*?)<\/function>/gs)].map(match => JSON.parse(match[1]!) as { name: string });
    expect(schemas.map(schema => schema.name)).toEqual(['skill', 'space_artifact']);
    await expect(readFile(join(homeDir, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await client.agents.tree(session.id)).actors).toHaveLength(1);
    expect(calls).toEqual(['space_artifact', 'space_connector_search', 'space_expert_verify']);
    expect((await readFile(join(homeDir, 'partner-report.pptx'))).subarray(0, 2).toString()).toBe('PK');
    expect(await client.config.read()).toMatchObject({ maxOutputTokens: 1234 });
    expect(await client.config.readEffective()).toMatchObject({ maxOutputTokens: { value: 1234, applied: true }, application: { maxOutputTokens: 'next_run', extensions: 'extension_reload' } });
    expect(requests[0]!.max_tokens ?? requests[0]!.max_completion_tokens).toBe(1234);
    partner = false;
    for (const agentMode of ['sa', 'ama'] as const) for (const workMode of ['agent', 'coding', 'script'] as const) {
      const coder = await client.sessions.create({ surface: 'code', projectPath: homeDir });
      await client.sessions.updateSettings(coder.id, { agentMode, workMode, permissionMode: 'full-access', reasoningMode: 'off' });
      const before = requests.length;
      const input = await client.inputs.submit({ sessionId: coder.id, inputId: `coder-${agentMode}-${workMode}`, text: 'Reply briefly.' });
      expect((await client.runs.await(input.runId!)).phase).toBe('completed');
      expect((await client.runs.read(input.runId!)).workMode).toBe(workMode);
      const names = requests[before]!.tools!.map(tool => tool.function.name);
      expect((await client.runs.read(input.runId!)).effectiveConfig).toMatchObject({ workMode, modelToolScope: names });
      expect(names.includes('script_exec'), JSON.stringify({ agentMode, workMode, names })).toBe(workMode === 'script');
      expect(names.includes('repo_overview')).toBe(workMode === 'coding');
      expect(names.includes('spawn_agent')).toBe(agentMode === 'ama');
      if (workMode === 'script') {
        const cellResult = requests.slice(before).flatMap(value => value.messages)
          .find(message => message.role === 'tool' && message.tool_call_id === 'coder-script-read');
        expect(cellResult).toBeDefined();
        expect(String(cellResult!.content)).toContain('SCRIPT_EVIDENCE_RETAINED');
        expect(JSON.parse(String(cellResult!.content))).toMatchObject({ status: 'completed', hadToolErrors: false });
      }
    }
    const coder = await client.sessions.create({ surface: 'code', projectPath: homeDir });
    await client.sessions.updateSettings(coder.id, { workMode: 'agent', permissionMode: 'full-access', reasoningMode: 'off' });
    const before = requests.length;
    const spawned = await client.agents.spawn(coder.id, { taskName: 'expert', objective: 'Verify the supplied document.' });
    await waitUntil(async () => {
      const output = await client!.agents.output(coder.id, spawned.actorPath, spawned.turnId);
      if (['failed', 'cancelled', 'unknown'].includes(output.state)) throw new Error(`Actor failed: ${output.state}`);
      return output.state === 'completed' ? output : undefined;
    });
    expect(requests[before]!.tools!.map(tool => tool.function.name)).toContain('lsp_definition');
  } finally {
    await client?.disconnect(); await host?.close();
    await new Promise<void>(done => server.close(() => done()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 120_000);

it('resumes the same dedicated Actor turn after Host process death with fresh scoped authority', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-cross-process-actor-recovery-'));
  let providerReady = false;
  let resumed = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { stream?: boolean };
    if (!providerReady && input.stream) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'context_length_exceeded: maximum context length exceeded' } }));
    } else if (!providerReady) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'summary', choices: [{ message: { role: 'assistant', content: 'Preserve the original Actor objective.' }, finish_reason: 'stop' }] }));
    } else { resumed += 1; finish(response, { content: 'Original Actor turn resumed.' }); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture server');
  await mkdir(join(homeDir, '.kodax'), { recursive: true });
  await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'actor-loopback', model: 'fixture', customProviders: [{
    name: 'actor-loopback', protocol: 'openai', model: 'fixture', apiKeyEnv: 'KODAX_ACTOR_UNSET_KEY',
    contextWindow: 32768, maxOutputTokens: 1024, baseUrl: `http://127.0.0.1:${address.port}/v1`,
  }] }));
  const identity = { name: 'sdk-contract-test', instanceId: 'sdk-actor-recovery', instanceSecret: 'fixture-only-stable-client-secret-1234567890' };
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let client: KodaXProductClient | undefined;
  let leases = 0;
  const connect = () => connectKodaXClient({ homeDir, endpoint: host!.endpoint, clientInfo: identity,
    async authorizeExecution(_request, services) {
      const lease = await services.credentials.registerScoped({ providers: ['actor-loopback'] }, async () => 'fixture-only');
      leases += 1;
      return { credential: { leaseId: lease.id, mode: 'scoped', providers: ['actor-loopback'] }, tools: ['read'] };
    },
  });
  try {
    host = await startHost(homeDir);
    client = await connect();
    const session = await client.sessions.create({ surface: 'code', projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { permissionMode: 'full-access', reasoningMode: 'off', workMode: 'agent' });
    const turn = await client.agents.spawn(session.id, { taskName: 'expert', objective: 'Preserve this exact objective and continue after recovery.' });
    await waitUntil(async () => {
      const detail = await client!.agents.detail(session.id, turn.actorPath);
      return detail.turns.find(value => value.turnId === turn.turnId && value.checkpoint !== undefined);
    });
    const observer = await connectKodaXRuntime({ homeDir, endpoint: host.endpoint });
    try {
      await waitUntil(async () => (await observer.runs.list({ sessionId: session.id }))
        .find(run => run.phase === 'recovering' && run.contextRecovery?.checkpoint !== undefined));
    } finally { await observer.close(); }
    const exited = once(host.child, 'exit'); host.child.kill('SIGKILL'); await exited;
    await client.disconnect(); client = undefined;
    providerReady = true;
    host = await startHost(homeDir);
    client = await connect();
    const before = (await client.agents.tree(session.id)).actors.find(actor => actor.path === turn.actorPath)!;
    const recovery = await client.agents.followup(session.id, turn.actorPath, '', { resumeCheckpoint: true, expectedRevision: before.revision });
    expect(recovery.delivery).toBe('current_turn');
    const result = await waitUntil(async () => {
      const output = await client!.agents.output(session.id, turn.actorPath, turn.turnId);
      if (['failed', 'cancelled', 'unknown'].includes(output.state)) throw new Error(`Actor recovery failed: ${output.state}`);
      return output.state === 'completed' ? output : undefined;
    });
    expect(result).toBeDefined();
    expect(recovery.turn.turnId).toBe(turn.turnId);
    const detail = await client.agents.detail(session.id, turn.actorPath);
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]).toMatchObject({ turnId: turn.turnId, state: 'completed' });
    expect(leases).toBe(2);
    expect(resumed).toBeGreaterThan(0);
  } finally {
    await client?.disconnect(); await host?.close();
    await new Promise<void>(done => server.close(() => done()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 120_000);
