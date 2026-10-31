import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { connectKodaXClient } from '../src/sdk-client.js';
import type { RuntimeCredentialLease, RuntimeHostToolLease, RuntimeExecutionProfile } from '../src/client-host-authorization.js';
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { CODING_SUMMARY_PROMPT, CODING_UPDATE_SUMMARY_PROMPT, LEARNING_REVIEW_TOOL, getRegisteredToolDefinition } from '@kodax-ai/coding';
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
function isRootRecoverySummary(wire: WireRequest): boolean {
  return wire.messages.some(message => message.role === 'user' && typeof message.content === 'string'
    && (message.content.includes(CODING_SUMMARY_PROMPT) || message.content.includes(CODING_UPDATE_SUMMARY_PROMPT)));
}
function respondRootRecoveryFixture(wire: WireRequest & { stream?: boolean }, response: ServerResponse): void {
  if (!isRootRecoverySummary(wire)) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'context_length_exceeded: maximum context length exceeded' } }));
    return;
  }
  if (wire.stream) { finish(response, { content: 'Preserve the original root tool ceiling.' }); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'summary', choices: [{ message: { role: 'assistant', content: 'Preserve the original root tool ceiling.' }, finish_reason: 'stop' }] }));
}
async function startHost(homeDir: string): Promise<{ child: ChildProcess; endpoint: string; close(): Promise<void> }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
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

it('uses the Host catalog and enforces root and Actor ceilings across native and MCP calls', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-profile-audit-'));
  const requests: WireRequest[] = [];
  const calls: string[] = [];
  let actor = false;
  let derived = false;
  let freezeMetadata = false;
  let firstProfile: RuntimeExecutionProfile | undefined;
  let lease: RuntimeHostToolLease | undefined;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const wire = JSON.parse(body) as WireRequest;
    if (wire.tools?.some(tool => tool.function.name === LEARNING_REVIEW_TOOL.name)) { finish(response, { content: '{}' }); return; }
    requests.push(wire);
    const hasResult = (id: string) => wire.messages.some(message => message.tool_call_id === id);
    if (derived) {
      const child = wire.messages.some(message => message.role === 'user' && String(message.content).includes('DERIVED_CHILD_CHECK'));
      let name: string | undefined; let id = ''; let args: Record<string, unknown> = {};
      if (child && !hasResult('child-write')) { name = 'write'; id = 'child-write'; args = { path: join(homeDir, 'child-forbidden.txt'), content: 'DENIED' }; }
      else if (child && !hasResult('child-alias')) { name = 'mcp_call'; id = 'child-alias'; args = { id: `host:${lease!.id}:audit_denied`, args: {} }; }
      else if (child && !hasResult('child-allowed')) { name = 'audit_allowed'; id = 'child-allowed'; }
      else if (!child && !hasResult('spawn-child')) { name = 'spawn_agent'; id = 'spawn-child'; args = { task_name: 'restricted_child', objective: 'DERIVED_CHILD_CHECK', fork_turns: 'none', read_only: false }; }
      else if (!child && !hasResult('wait-child')) { name = 'wait_agent'; id = 'wait-child'; args = { timeout_ms: 10000 }; }
      if (name) finish(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
      else finish(response, { content: 'Derived authority verified.' });
      return;
    }
    let name: string | undefined; let input: Record<string, unknown> = {}; let id = '';
    if (actor && !hasResult('actor-allowed')) { name = 'audit_allowed'; id = 'actor-allowed'; }
    else if (actor && !hasResult('actor-denied')) { name = 'mcp_call'; id = 'actor-denied'; input = { id: `host:${lease!.id}:audit_denied`, args: {} }; }
    if (!actor && !hasResult('root-search')) { name = 'mcp_search'; id = 'root-search'; input = { query: 'audit_denied', server: 'host' }; }
    else if (!actor && !hasResult('root-denied')) { name = 'mcp_call'; id = 'root-denied'; input = { id: `host:${lease!.id}:audit_denied`, args: {} }; }
    else if (!actor && !hasResult('host-only')) { name = 'host_only_readonly'; id = 'host-only'; }
    if (name) finish(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls');
    else finish(response, { content: 'Audit finished.' });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  await mkdir(join(homeDir, '.kodax'), { recursive: true });
  await mkdir(join(homeDir, '.kodax', 'extensions'), { recursive: true });
  await writeFile(join(homeDir, '.kodax', 'extensions', 'host-only.mjs'), `export default api => {
    api.registerTool({ name: 'host_only_readonly', description: 'Host-only readonly evidence',
      input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly', planModeAllowed: true,
      handler: async () => 'HOST_ONLY_EXECUTED' });
  };`);
  expect(getRegisteredToolDefinition('host_only_readonly')).toBeUndefined();
  await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'audit-loopback', model: 'fixture',
    customProviders: [{ name: 'audit-loopback', protocol: 'openai', model: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_UNUSED_AUDIT_KEY' }] }));
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let client: KodaXProductClient | undefined;
  let credential: RuntimeCredentialLease | undefined;
  try {
    host = await startHost(homeDir);
    client = await connectKodaXClient({ homeDir, endpoint: host.endpoint, async authorizeExecution(request, services) {
      credential ??= await services.credentials.registerScoped({ providers: ['audit-loopback'] }, async () => 'test-only');
      lease ??= await services.hostTools.register(['audit_allowed', 'audit_denied'].map(name => ({ name, description: name,
        inputSchema: { type: 'object', properties: {} }, sideEffect: 'none' as const })),
      Object.fromEntries(['audit_allowed', 'audit_denied'].map(name => [name, async () => { calls.push(name); return { content: `EXECUTED_${name}` }; }])));
      const base = { credential: { leaseId: credential.id, mode: 'scoped' as const, providers: ['audit-loopback'] }, hostTools: { leaseId: lease.id } };
      if (request.kind === 'agent_spawn' || request.kind === 'agent_followup') return { ...base, tools: ['audit_allowed', 'mcp_call'] };
      if (request.kind === 'tool' && request.input.rawInput === 'ROOT_DENY') return { ...base, tools: ['read'] };
      const profile = freezeMetadata ? firstProfile! : await services.createExecutionProfile({ agentProfile: { id: 'partner' },
        toolVisibilityPolicy: tool => tool.name !== 'audit_denied' && (!derived || !['write', 'edit', 'bash'].includes(tool.name)) }, lease.tools);
      firstProfile ??= profile;
      return { ...base, profile };
    } });
    const partner = await client.sessions.create({ surface: 'partner', projectPath: homeDir });
    await client.sessions.updateSettings(partner.id, { agentMode: 'ama', workMode: 'agent', permissionMode: 'full-access', reasoningMode: 'off' });
    const accepted = await client.inputs.submit({ sessionId: partner.id, inputId: 'root-audit', text: 'Exercise the declared tool policy.' });
    await client.runs.await(accepted.runId!);
    expect(requests[0]!.tools!.map(tool => tool.function.name)).not.toContain('audit_denied');
    const actual = await client.runs.read(accepted.runId!);
    expect(actual.workMode).toBe('agent');
    const rootSearch = requests.flatMap(value => value.messages).find(message => message.tool_call_id === 'root-search');
    expect.soft(String(rootSearch?.content)).not.toContain(`host:${lease!.id}:audit_denied`);
    expect.soft(calls).not.toContain('audit_denied');
    expect(requests[0]!.tools!.map(tool => tool.function.name)).toContain('host_only_readonly');
    const hostOnly = requests.flatMap(value => value.messages).find(message => message.tool_call_id === 'host-only');
    expect(String(hostOnly?.content)).toContain('HOST_ONLY_EXECUTED');
    const snapshot = (await client.runs.read(accepted.runId!)).effectiveConfig;
    expect(snapshot).toMatchObject({ workMode: 'agent', toolScope: expect.arrayContaining(['host_only_readonly', 'write', 'edit', 'bash', 'spawn_agent']) });
    expect(snapshot!.toolScope).not.toContain('run_skill_script');
    const observer = await connectKodaXRuntime({ homeDir, endpoint: host.endpoint });
    try {
      expect(observer.capabilities?.sessionAdmission).toMatchObject({
        surfaces: expect.arrayContaining(['partner']), partnerDenied: false,
      });
      expect((await observer.runs.get(accepted.runId!)).effectiveConfig).toEqual(snapshot);
    }
    finally { await observer.close(); }
    const outputPath = join(homeDir, 'partner-write-probe.txt');
    const written = await client.runs.startTool({ sessionId: partner.id, inputId: 'partner-write', rawInput: 'Write an authorized document',
      name: 'write', input: { path: outputPath, content: 'PARTNER_WRITE_ALLOWED' } });
    expect((await client.runs.await(written.runId)).phase).toBe('completed');
    expect(await readFile(outputPath, 'utf8')).toBe('PARTNER_WRITE_ALLOWED');
    const rootDeniedPath = join(homeDir, 'root-forbidden.txt');
    const rootDenied = await client.runs.startTool({ sessionId: partner.id, inputId: 'root-tools-only', rawInput: 'ROOT_DENY',
      name: 'write', input: { path: rootDeniedPath, content: 'DENIED' } });
    await client.runs.await(rootDenied.runId);
    await expect(readFile(rootDeniedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await client.runs.read(rootDenied.runId)).effectiveConfig?.toolScope).toEqual(['read']);

    derived = true;
    const derivedStart = requests.length;
    const restricted = await client.sessions.create({ surface: 'partner', projectPath: homeDir });
    await client.sessions.updateSettings(restricted.id, { agentMode: 'ama', workMode: 'agent', permissionMode: 'full-access', reasoningMode: 'off' });
    const derivation = await client.inputs.submit({ sessionId: restricted.id, inputId: 'derived', text: 'ROOT_DERIVE: delegate and wait.' });
    expect((await client.runs.await(derivation.runId!)).phase).toBe('completed');
    const childMessages = requests.slice(derivedStart).flatMap(value => value.messages);
    for (const id of ['child-write', 'child-alias']) {
      expect(String(childMessages.find(message => message.tool_call_id === id)?.content), id).toContain('not active');
    }
    expect(String(childMessages.find(message => message.tool_call_id === 'child-allowed')?.content)).toContain('EXECUTED_audit_allowed');
    await expect(readFile(join(homeDir, 'child-forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const childRequest = requests.slice(derivedStart).find(value => value.messages.some(message => message.role === 'user' && String(message.content).includes('DERIVED_CHILD_CHECK')));
    expect(childRequest).toBeDefined();
    expect(childRequest!.tools!.map(tool => tool.function.name)).not.toContain('write');
    expect(calls).not.toContain('audit_denied');
    derived = false;
    actor = true;
    const before = requests.length;
    const coder = await client.sessions.create({ surface: 'code', projectPath: homeDir });
    await client.sessions.updateSettings(coder.id, { permissionMode: 'full-access', reasoningMode: 'off' });
    const spawned = await client.agents.spawn(coder.id, { taskName: 'audit-expert', objective: 'Use the permitted audit tool.' });
    await waitUntil(async () => {
      const output = await client!.agents.output(coder.id, spawned.actorPath, spawned.turnId);
      if (['failed', 'cancelled', 'unknown'].includes(output.state)) throw new Error(`Actor failed: ${output.state}`);
      return output.state === 'completed' ? output : undefined;
    });
    expect(requests[before]!.tools!.map(tool => tool.function.name)).toContain('audit_allowed');
    const actorResult = requests.slice(before).flatMap(value => value.messages).find(message => message.tool_call_id === 'actor-allowed');
    expect.soft(String(actorResult?.content)).toContain('EXECUTED_audit_allowed');
    expect.soft(calls).toContain('audit_allowed');
    const actorDenied = requests.slice(before).flatMap(value => value.messages).find(message => message.tool_call_id === 'actor-denied');
    expect(String(actorDenied?.content)).toContain('not active');
    expect(calls).not.toContain('audit_denied');

    const mutationPath = join(homeDir, 'metadata-mutation.txt');
    await writeFile(join(homeDir, '.kodax', 'extensions', 'host-only.mjs'), `import { writeFile } from 'node:fs/promises';
      export default api => api.registerTool({ name: 'host_only_readonly', description: 'Changed mutating implementation',
        input_schema: { type: 'object', properties: {} }, sideEffect: 'mutates-fs', planModeAllowed: false,
        handler: async () => { await writeFile(${JSON.stringify(mutationPath)}, 'REAUTHORIZED_MUTATION'); return 'MUTATED'; } });`);
    const control = await connectKodaXRuntime({ homeDir, endpoint: host.endpoint });
    try { await control.catalog.reloadExtensions(); } finally { await control.close(); }
    freezeMetadata = true;
    const stale = await client.runs.startTool({ sessionId: partner.id, inputId: 'stale-metadata', rawInput: 'Use original authority', name: 'host_only_readonly', input: {} });
    await client.runs.await(stale.runId);
    await expect(readFile(mutationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await client.runs.read(stale.runId)).effectiveConfig!.toolScope).not.toContain('host_only_readonly');
    freezeMetadata = false;
    const fresh = await client.runs.startTool({ sessionId: partner.id, inputId: 'fresh-metadata', rawInput: 'Authorize the changed tool', name: 'host_only_readonly', input: {} });
    expect((await client.runs.await(fresh.runId)).phase).toBe('completed');
    expect(await readFile(mutationPath, 'utf8')).toBe('REAUTHORIZED_MUTATION');
    // A new Host must retain the last assembled configuration without rebuilding it from defaults.
    await client.disconnect(); client = undefined;
    await host.close(); host = await startHost(homeDir);
    const restarted = await connectKodaXRuntime({ homeDir, endpoint: host.endpoint });
    try { expect((await restarted.runs.get(accepted.runId!)).effectiveConfig).toEqual(snapshot); }
    finally { await restarted.close(); }
  } finally {
    await client?.disconnect(); await host?.close();
    await new Promise<void>(done => server.close(() => done()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 120_000);

it.each([
  { label: 'ordinary non-streaming turn', stream: false, content: 'Continue the same root task after recovery.', status: 400 },
  { label: 'streaming compaction summary', stream: true, content: CODING_SUMMARY_PROMPT, status: 200 },
  { label: 'non-streaming compaction update', stream: false, content: CODING_UPDATE_SUMMARY_PROMPT, status: 200 },
])('routes root recovery fixture requests by their intent: $label', async ({ stream, content, status }) => {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    respondRootRecoveryFixture(JSON.parse(body) as WireRequest & { stream?: boolean }, response);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream, messages: [{ role: 'user', content }] }),
    });
    const body = await response.text();
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain(status === 200 && stream ? 'text/event-stream' : 'application/json');
    if (status === 200 && stream) expect(body).toContain('data: [DONE]');
    expect(body).toContain(status === 400 ? 'context_length_exceeded' : 'Preserve the original root tool ceiling.');
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

it.each([
  { original: 'profile', freshProfile: 'wider' },
  { original: 'profile', freshProfile: 'persona-only' },
  { original: 'tools', freshProfile: 'wider' },
  { original: 'tools-only', freshProfile: 'wider' },
  { original: 'tools-only', freshProfile: 'tools-only' },
  { original: 'profile', freshProfile: 'none' },
  { original: 'persona-only', freshProfile: 'none' },
  { original: 'profile', freshProfile: 'narrow' },
  { original: 'profile', freshProfile: 'empty' },
] as const)('retains the original root $original and metadata ceiling after Host recovery with a $freshProfile profile', async ({ original, freshProfile }) => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-root-profile-recovery-'));
  const allowedCalls: string[] = [];
  const requests: WireRequest[] = [];
  let recoveryRound = 0;
  const recoveryRequests = [
    { stream: 0, nonstream: 0, summary: 0 }, { stream: 0, nonstream: 0, summary: 0 }, { stream: 0, nonstream: 0, summary: 0 },
  ];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const wire = JSON.parse(body) as WireRequest & { stream?: boolean };
    const traffic = recoveryRequests[recoveryRound]!;
    if (wire.stream) traffic.stream += 1;
    else traffic.nonstream += 1;
    if (isRootRecoverySummary(wire)) traffic.summary += 1;
    if (recoveryRound < 2) {
      respondRootRecoveryFixture(wire, response);
      return;
    }
    if (wire.tools?.some(tool => tool.function.name === LEARNING_REVIEW_TOOL.name)) { finish(response, { content: '{}' }); return; }
    requests.push(wire);
    const calls = [
      { id: 'widen-write', name: 'write', input: { path: join(homeDir, 'forbidden.txt'), content: 'DENIED' } },
      { id: 'widen-metadata', name: 'tool_call', input: { name: 'recovery_extension', input: {} } },
      { id: 'fresh-lease', name: 'recovery_allowed', input: {} },
      { id: 'read-original', name: 'read', input: { path: join(homeDir, 'evidence.txt') } },
    ];
    const call = calls.find(value => !wire.messages.some(message => message.tool_call_id === value.id));
    if (call) finish(response, { tool_calls: [{ index: 0, id: call.id, type: 'function', function: {
      name: call.name, arguments: JSON.stringify(call.input),
    } }] }, 'tool_calls');
    else finish(response, { content: 'Root recovery ceiling verified.' });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  await mkdir(join(homeDir, '.kodax', 'extensions'), { recursive: true });
  await writeFile(join(homeDir, 'evidence.txt'), 'ORIGINAL_READ_SCOPE');
  await writeFile(join(homeDir, '.kodax', 'extensions', 'recovery.mjs'), `export default api => api.registerTool({
    name: 'recovery_extension', description: 'Originally readonly', input_schema: { type: 'object', properties: {} },
    sideEffect: 'readonly', planModeAllowed: true, handler: async () => 'ORIGINAL_METADATA' });`);
  await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'root-recovery-loopback', model: 'fixture', customProviders: [{
    name: 'root-recovery-loopback', protocol: 'openai', model: 'fixture', apiKeyEnv: 'KODAX_ROOT_RECOVERY_UNSET_KEY',
    contextWindow: 32768, maxOutputTokens: 1024, baseUrl: `http://127.0.0.1:${address.port}/v1`,
  }] }));
  const identity = { name: 'root-recovery-test', instanceId: 'sdk-root-profile-recovery', instanceSecret: 'fixture-only-root-profile-secret-1234567890' };
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let client: KodaXProductClient | undefined;
  let bindings = 0;
  const originalProfile = { id: 'original-partner', instructions: 'ORIGINAL_PROFILE_INSTRUCTIONS',
    verification: { requiredChecks: ['ORIGINAL_PROFILE_CHECK'] } };
  const originalTaskVerification = { summary: 'ORIGINAL_TASK_VERIFICATION' };
  const connect = () => connectKodaXClient({ homeDir, endpoint: host!.endpoint, clientInfo: identity,
    async authorizeExecution(_request, services) {
      const credential = await services.credentials.registerScoped({ providers: ['root-recovery-loopback'] }, async () => 'fixture-only');
      const lease = await services.hostTools.register([{ name: 'recovery_allowed', description: 'Fresh allowed lease',
        inputSchema: { type: 'object', properties: {} }, sideEffect: 'none' }],
      { recovery_allowed: async () => { allowedCalls.push('FRESH_LEASE_EXECUTED'); return { content: 'FRESH_LEASE_EXECUTED' }; } });
      bindings += 1;
      const restricted = ['read', 'tool_call', 'recovery_allowed', ...(original === 'tools-only' ? [] : ['recovery_extension'])];
      const toolsOnly = recoveryRound === 0 ? original === 'tools-only' : freshProfile === 'tools-only';
      const profile = toolsOnly || (recoveryRound > 0 && freshProfile === 'none') ? undefined
        : await services.createExecutionProfile({
        agentProfile: recoveryRound === 0 ? originalProfile : { id: 'fresh-partner', instructions: 'FRESH_PROFILE_INSTRUCTIONS',
          verification: { requiredChecks: ['FRESH_PROFILE_CHECK'] } },
        taskVerification: recoveryRound === 0 ? originalTaskVerification : { summary: 'FRESH_TASK_VERIFICATION' },
        ...(recoveryRound === 0 && original !== 'persona-only' ? { toolVisibilityPolicy: (tool: { name: string }) => original === 'tools' || restricted.includes(tool.name) }
          : freshProfile === 'wider' ? { toolVisibilityPolicy: () => true } : {}),
      }, lease.tools);
      return { credential: { leaseId: credential.id, mode: 'scoped', providers: ['root-recovery-loopback'] }, hostTools: { leaseId: lease.id },
        ...(profile === undefined ? {} : { profile }),
        ...(toolsOnly || (recoveryRound === 0 && original === 'tools') ? { tools: restricted } : {}),
        ...(recoveryRound > 0 && freshProfile === 'narrow' ? { tools: ['read', 'tool_call'] } : {}),
        ...(recoveryRound > 0 && freshProfile === 'empty' ? { tools: [] } : {}),
      };
    },
  });
  try {
    host = await startHost(homeDir);
    client = await connect();
    const session = await client.sessions.create({ surface: 'partner', projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'agent', permissionMode: 'full-access', reasoningMode: 'off' });
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'root-recovery', text: 'Continue the same root task after recovery.' });
    let previousWaitingSince: string | undefined;
    for (let next = 1; next <= 2; next += 1) {
      const observer = await connectKodaXRuntime({ homeDir, endpoint: host.endpoint });
      let lastRun: Awaited<ReturnType<typeof observer.runs.get>> | undefined;
      try {
        const boundary = await waitUntil(async () => {
          const run = await observer.runs.get(accepted.runId!);
          lastRun = run;
          const value = run.contextRecovery;
          return run.phase === 'recovering' && value?.checkpoint !== undefined
            && value.waitingSince !== previousWaitingSince ? value : undefined;
        });
        previousWaitingSince = boundary.waitingSince;
      } catch (error: unknown) {
        throw new Error(`[SDK_RECOVERY_BOUNDARY] ${JSON.stringify({ next, recoveryRound, previousWaitingSince,
          phase: lastRun?.phase, error: lastRun?.error, lifecycleError: lastRun?.lifecycleError,
          waitingSince: lastRun?.contextRecovery?.waitingSince,
          hasCheckpoint: lastRun?.contextRecovery?.checkpoint !== undefined, recoveryRequests,
        })}`, { cause: error });
      } finally { await observer.close(); }
      const exited = once(host.child, 'exit'); host.child.kill('SIGKILL'); await exited;
      await client.disconnect(); client = undefined;
      if (next === 1) await writeFile(join(homeDir, '.kodax', 'extensions', 'recovery.mjs'), `import { writeFile } from 'node:fs/promises';
      export default api => api.registerTool({ name: 'recovery_extension', description: 'Changed mutating implementation',
        input_schema: { type: 'object', properties: {} }, sideEffect: 'mutates-fs', planModeAllowed: false,
        handler: async () => { await writeFile(${JSON.stringify(join(homeDir, 'metadata-forbidden.txt'))}, 'DENIED'); return 'MUTATED'; } });`);
      recoveryRound = next;
      host = await startHost(homeDir);
      client = await connect();
      await client.runs.recover({ sessionId: session.id, runId: accepted.runId! });
    }
    expect((await client.runs.await(accepted.runId!)).phase).toBe('completed');
    expect(bindings).toBe(3);
    expect(allowedCalls).toEqual(freshProfile === 'narrow' || freshProfile === 'empty' ? [] : ['FRESH_LEASE_EXECUTED']);
    const messages = requests.flatMap(value => value.messages);
    expect(String(messages.find(message => message.tool_call_id === 'read-original')?.content))
      .toContain(freshProfile === 'empty' ? 'not active' : 'ORIGINAL_READ_SCOPE');
    const snapshot = (await client.runs.read(accepted.runId!)).effectiveConfig!;
    const scope = snapshot.toolScope;
    if (freshProfile === 'empty') expect(scope).toEqual([]);
    else if (freshProfile === 'narrow') {
      expect(scope).toContain('read');
      expect(scope).not.toContain('recovery_allowed');
    } else expect(scope).toEqual(expect.arrayContaining(['read', 'recovery_allowed']));
    if (original === 'persona-only') {
      expect(await readFile(join(homeDir, 'forbidden.txt'), 'utf8')).toBe('DENIED');
      expect(await readFile(join(homeDir, 'metadata-forbidden.txt'), 'utf8')).toBe('DENIED');
      expect(scope).toContain('write');
      expect(scope).toContain('recovery_extension');
    } else {
      for (const id of ['widen-write', 'widen-metadata']) {
        expect(String(messages.find(message => message.tool_call_id === id)?.content), id).toContain('not active');
      }
      await expect(readFile(join(homeDir, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(homeDir, 'metadata-forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(scope).not.toContain('write');
      expect(scope).not.toContain('recovery_extension');
    }
    if (original === 'tools-only') {
      expect(snapshot).not.toHaveProperty('agentProfile');
      expect(snapshot).not.toHaveProperty('verification');
    } else {
      expect(snapshot.agentProfile).toEqual(originalProfile);
      expect(snapshot.verification).toEqual({ ...originalProfile.verification, ...originalTaskVerification });
      expect(JSON.stringify(messages)).toContain('ORIGINAL_PROFILE_INSTRUCTIONS');
      expect(JSON.stringify(messages)).toContain('ORIGINAL_PROFILE_CHECK');
      expect(JSON.stringify(messages)).toContain('ORIGINAL_TASK_VERIFICATION');
    }
    expect(JSON.stringify(messages)).not.toContain('FRESH_PROFILE_');
    expect(JSON.stringify(messages)).not.toContain('FRESH_TASK_VERIFICATION');
  } finally {
    await client?.disconnect(); await host?.close();
    await new Promise<void>(done => server.close(() => done()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 120_000);
