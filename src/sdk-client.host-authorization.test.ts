import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { registerCustomProviders, clearRuntimeModelProviders } from '@kodax-ai/llm';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import type { RuntimeCredentialLease, RuntimeCredentialService, RuntimeHostToolLease, RuntimeScopedCredentialRequest } from './sdk-runtime.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it('binds Main-owned credentials and tools to Product inputs, queued Runs and explicit tool execution', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-authorization-'));
  const mcp = await createMcpTestServerFixture(homeDir);
  await mkdir(path.join(homeDir, '.kodax', 'commands'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'commands', 'space-check.md'),
    '---\nname: space-check\nallowed-tools: Bash, Read\ncontext: fork\nhooks:\n  SessionStart:\n    - command: echo fixture-hook > command-hook.txt\n---\nCOMMAND-AUTHORITY-PROBE: Inspect the Space task.');
  await mkdir(path.join(homeDir, '.kodax', 'skills', 'space-skill'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'skills', 'space-skill', 'SKILL.md'),
    '---\nname: space-skill\ndescription: Inspect a Space task.\n---\nInspect the Space task.');
  const headers: Array<string | undefined> = [];
  const workflowToolSets: string[][] = [];
  const actorToolSets: string[][] = [];
  let commandProbes = 0;
  let retryProbe = false;
  let release = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered = () => {};
  const entering = new Promise<void>(resolve => { entered = resolve; });
  let enteredCompact!: () => void;
  const compactEntering = new Promise<void>(resolve => { enteredCompact = resolve; });
  let releaseCompact!: () => void;
  const compactWaiting = new Promise<void>(resolve => { releaseCompact = resolve; });
  const wire = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const workflowProbe = body.includes('WORKFLOW-AUTHORITY-PROBE');
    const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string; tool_call_id?: string }> };
    if (workflowProbe) workflowToolSets.push((payload.tools ?? []).flatMap(tool => tool.function?.name ? [tool.function.name] : []));
    const commandProbe = body.includes('COMMAND-AUTHORITY-PROBE');
    const actorProbe = body.includes('INDEPENDENT-WRITE-PROBE');
    if (actorProbe) actorToolSets.push((payload.tools ?? []).flatMap(tool => tool.function?.name ? [tool.function.name] : []));
    if (commandProbe) commandProbes += 1;
    headers.push(request.headers.authorization);
    if (headers.length === 1) { entered(); await waiting; }
    if (body.includes('COMPACTION-CANCEL-PROBE')) { enteredCompact(); await compactWaiting; }
    if (body.includes('RETRY-WIRE-PROBE') && !retryProbe) {
      retryProbe = true; response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(JSON.stringify({ error: { message: 'Fixture is briefly unavailable.', type: 'server_error' } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((workflowProbe || commandProbe || actorProbe) && !payload.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'space-call')) {
      response.end(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'space-call', type: 'function', function: { name: actorProbe ? 'write' : workflowProbe ? 'space_read' : 'space_artifact',
          arguments: actorProbe ? JSON.stringify({ path: path.join(homeDir, 'forbidden-actor.txt'), content: 'Forbidden.' }) : '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.end(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 } },
      choices: [{ index: 0, delta: { content: 'Preserve the approved release decisions, the scoped Provider authorization, and the confirmed Host Tool outcomes. The next step is to inspect the remaining fixture evidence.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-authorized' });
  registerCustomProviders([{ name: 'product-authorized', protocol: 'openai',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_NO_AMBIENT_AUTHORIZATION_KEY', model: 'test' }]);
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Missing fixture Host lock');
  const endpointPath = process.platform === 'win32' ? `\\\\.\\pipe\\kodax-product-auth-${randomUUID()}` : path.join(homeDir, 'host.sock');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: {
    kind: process.platform === 'win32' ? 'pipe' : 'unix', path: endpointPath,
  } });
  let credentialLease: RuntimeCredentialLease | undefined;
  let otherLease: RuntimeCredentialLease | undefined;
  let credentialService: RuntimeCredentialService | undefined;
  let toolLease: RuntimeHostToolLease | undefined;
  const brokerRequests: RuntimeScopedCredentialRequest[] = [];
  const toolCalls: Array<{ sessionId: string; runId: string }> = [];
  const client = await connectKodaXClient({ homeDir, endpoint: endpointPath,
    async authorizeExecution(_request, services) {
      credentialService = services.credentials;
      credentialLease ??= await services.credentials.registerScoped({ providers: ['product-authorized'] }, async request => {
        brokerRequests.push(request);
        return 'fixture-key-from-main';
      });
      toolLease ??= await services.hostTools.register([{ name: 'space_artifact', description: 'Create a fixture artifact.',
        inputSchema: { type: 'object', properties: {} }, sideEffect: 'non_idempotent' },
      { name: 'space_read', description: 'Read a fixture artifact.', inputSchema: { type: 'object', properties: {} }, sideEffect: 'none' }], {
        async space_artifact(call) { toolCalls.push(call); return { content: 'Artifact created.' }; },
        async space_read(call) { toolCalls.push(call); return { content: 'Read-only artifact evidence.' }; },
      });
      const other = 'inputId' in _request.input && _request.input.inputId.startsWith('other');
      if (other) otherLease ??= await services.credentials.registerScoped({ providers: ['product-authorized'] }, async request => {
        brokerRequests.push(request); return 'fixture-other-key';
      });
      if (_request.kind === 'agent_spawn' || _request.kind === 'agent_followup') return {
        credential: { mode: 'scoped', leaseId: credentialLease.id, providers: ['product-authorized'] }, tools: ['read'],
      };
      return { credential: { mode: 'scoped', leaseId: other ? otherLease!.id : credentialLease.id, providers: ['product-authorized'] },
        hostTools: { leaseId: toolLease.id } };
    },
  });
  try {
    const session = await client.sessions.create({ projectPath: homeDir,
      mcpServers: { private: mcp.servers[mcp.serverId]! } });
    await client.sessions.updateSettings(session.id, { provider: 'product-authorized', agentMode: 'sa', permissionMode: 'full-access' });
    const first = await client.inputs.submit({ sessionId: session.id, inputId: 'first', text: 'Wait.' });
    await Promise.race([entering, client.runs.await(first.runId!).then(outcome => {
      if (outcome.phase !== 'completed') throw new Error(`Authorized input failed: ${outcome.phase}: ${outcome.error}`);
    })]);
    const queued = await client.inputs.submit({ sessionId: session.id, inputId: 'next', text: 'Continue.', delivery: 'after_turn' });
    expect(queued.state).toBe('queued');
    const unbound = await connectKodaXClient({ homeDir, endpoint: endpointPath });
    try {
      await expect(unbound.inputs.submit({ sessionId: session.id, inputId: 'unbound-steer', text: 'Borrow authority.',
        delivery: 'steer', targetRunId: first.runId }))
        .rejects.toMatchObject({ code: 'conflict', message: 'Steer cannot replace active-run execution authorization.' });
    } finally { await unbound.disconnect(); }
    await expect(client.inputs.submit({ sessionId: session.id, inputId: 'other-steer', text: 'Change authority.',
      delivery: 'steer', targetRunId: first.runId })).rejects.toMatchObject({ code: 'conflict' });
    expect((await client.inputs.submit({ sessionId: session.id, inputId: 'other-next', text: 'Separate authority.', delivery: 'after_turn' })).state).toBe('queued');
    release();
    expect((await client.runs.await(first.runId!)).phase).toBe('completed');
    await expect.poll(async () => (await client.inputs.read(session.id, 'next'))?.runId).toBeTruthy();
    const next = await client.inputs.read(session.id, 'next');
    expect((await client.runs.await(next!.runId!)).phase).toBe('completed');
    await expect.poll(async () => (await client.inputs.read(session.id, 'other-next'))?.runId).toBeTruthy();
    const otherNext = await client.inputs.read(session.id, 'other-next');
    expect(otherNext!.runId).not.toBe(next!.runId);
    expect((await client.runs.await(otherNext!.runId!)).phase).toBe('completed');
    expect(headers).toEqual(['Bearer fixture-key-from-main', 'Bearer fixture-key-from-main', 'Bearer fixture-other-key']);
    expect(brokerRequests).toHaveLength(3);
    expect(brokerRequests.map(request => request.target)).toEqual([
      { kind: 'run', runId: first.runId }, { kind: 'run', runId: next!.runId }, { kind: 'run', runId: otherNext!.runId },
    ]);
    expect(brokerRequests.every(request => request.sessionId === session.id && request.purpose === 'primary')).toBe(true);
    const statistics = await client.statistics.read(session.id);
    expect(statistics.usage).toMatchObject({ inputTokens: 30, outputTokens: 9, totalTokens: 39, cacheReadTokens: 6 });
    const requests = await client.statistics.readRequests(session.id);
    expect(requests.items).toHaveLength(3);
    expect(new Set(requests.items.map(item => item.requestId)).size).toBe(3);
    expect(requests.items.every(item => item.boundary === 'physical_attempt' && item.state === 'succeeded')).toBe(true);
    expect(statistics.contexts).toContainEqual(expect.objectContaining({ contextKind: 'root', pressure: expect.any(String), tokenBreakdown: expect.objectContaining({ total: expect.any(Number) }) }));
    const tool = await client.runs.startTool({ sessionId: session.id, inputId: 'artifact', rawInput: 'Create artifact.', name: 'space_artifact', input: {} });
    expect((await client.runs.await(tool.runId)).phase).toBe('completed');
    expect(toolCalls).toEqual([expect.objectContaining({ sessionId: session.id, runId: tool.runId })]);
    expect((await client.statistics.readTools(session.id)).items).toContainEqual(expect.objectContaining({
      toolId: expect.any(String), name: 'space_artifact', state: 'completed', result: 'succeeded', sandbox: [],
    }));
    const mcpRun = await client.runs.startTool({ sessionId: session.id, inputId: 'private-mcp', rawInput: 'Read private MCP.',
      name: 'mcp_call', input: { id: mcp.toolId.replace(':demo:', ':private:'), args: { text: 'mixed-host-tools' } } });
    expect((await client.runs.await(mcpRun.runId)).result)
      .toMatchObject({ success: true, lastText: expect.stringContaining('mixed-host-tools') });
    // Even a JS/IPC caller carrying a real lease cannot manufacture Main authority.
    const plain = await connectKodaXClient({ homeDir, endpoint: endpointPath });
    try {
      const spoof = await plain.inputs.submit({ sessionId: session.id, inputId: 'spoof', text: 'Use a stolen binding.',
        ...{ authorization: { credential: { mode: 'scoped', leaseId: credentialLease!.id, providers: ['product-authorized'] } } } });
      expect((await plain.runs.await(spoof.runId!)).phase).toBe('failed');
      expect(headers).toHaveLength(3);
    } finally { await plain.disconnect(); }
    const command = await client.commands.execute({ sessionId: session.id, inputId: 'command', name: 'space-check' });
    if (command.kind !== 'started') throw new Error('Expected a prompt-command Run');
    const commandOutcome = await client.runs.await(command.runId);
    expect(commandOutcome.phase, commandOutcome.error).toBe('completed');
    expect(commandProbes).toBeGreaterThan(0);
    expect(toolCalls).toHaveLength(1);
    expect(await readFile(path.join(homeDir, 'command-hook.txt'), 'utf8')).toContain('fixture-hook');
    const skill = await client.inputs.submit({ sessionId: session.id, inputId: 'skill', text: '/skill:space-skill inspect' });
    expect((await client.runs.await(skill.runId!)).phase).toBe('completed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: homeDir, windowsHide: true, stdio: 'ignore' });
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(homeDir, 'fixture.ts'), 'export const gate = false;\n');
    git('add', 'fixture.ts'); git('commit', '-m', 'fixture');
    await writeFile(path.join(homeDir, 'fixture.ts'), 'export const gate = true;\n');
    const review = await client.review.start({ sessionId: session.id, inputId: 'review', args: ['--lean'] });
    if (review.kind !== 'started') throw new Error('Expected a review Run');
    expect((await client.runs.await(review.runId)).phase).toBe('completed');
    const workflow = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir, source: {
      kind: 'inline', manifest: { name: 'authorized-workflow', description: 'Inspect a fixture.', readOnly: true,
        maxAgents: 2, maxConcurrency: 1, phases: ['inspect'], patterns: ['fan-out-and-synthesize'] },
      source: 'async function run(wf) { const result = await wf.runAgent({ name: "reader", prompt: "WORKFLOW-AUTHORITY-PROBE: Inspect the fixture.", readOnly: true }); return { synthesis: result.finalText }; }',
    } });
    if (workflow.kind !== 'started') throw new Error(workflow.reason);
    expect((await client.runs.await(workflow.runId)).phase).toBe('completed');
    expect(brokerRequests.some(request => request.target.kind === 'actor_turn' && request.target.parentRunId === workflow.runId)).toBe(true);
    expect(workflowToolSets.length).toBeGreaterThan(0);
    expect(workflowToolSets.every(names => names.includes('space_read') && !names.includes('space_artifact'))).toBe(true);
    expect(toolCalls).toHaveLength(2);
    const detached = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(detached.id, { provider: 'product-authorized', permissionMode: 'full-access' });
    const actor = await client.agents.spawn(detached.id, { taskName: 'independent', objective: 'INDEPENDENT-WRITE-PROBE: Inspect independently.',
      capabilities: { providers: ['product-authorized'], tools: ['*'], filesystem: 'write' } });
    await expect.poll(async () => (await client.agents.output(detached.id, actor.actorPath, actor.turnId)).state, { timeout: 10_000 }).toBe('completed');
    expect(actorToolSets.length).toBeGreaterThan(0);
    expect(actorToolSets.every(names => !names.includes('write') && !names.includes('bash') && names.includes('read'))).toBe(true);
    await expect(readFile(path.join(homeDir, 'forbidden-actor.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(brokerRequests).toContainEqual(expect.objectContaining({ sessionId: detached.id, purpose: 'primary',
      target: { kind: 'actor_turn', actorPath: actor.actorPath, turnId: actor.turnId } }));
    const followup = await client.agents.followup(detached.id, actor.actorPath, 'Inspect the next evidence.');
    expect(followup.delivery).toBe('started_turn');
    await expect.poll(async () => (await client.agents.output(detached.id, actor.actorPath)).state, { timeout: 10_000 }).toBe('completed');
    expect(new Set(brokerRequests.filter(request => request.sessionId === detached.id).map(request => JSON.stringify(request.target))).size)
      .toBe(2);
    const retry = await client.inputs.submit({ sessionId: session.id, inputId: 'retry-wire', text: 'RETRY-WIRE-PROBE: Inspect again.' });
    expect((await client.runs.await(retry.runId!)).phase).toBe('completed');
    const attempts = (await client.statistics.readRequests(session.id)).items.filter(row => row.target.kind === 'run' && row.target.runId === retry.runId);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(row => [row.state, row.attempt, row.dispatch])).toEqual([['failed', 1, 'dispatched'], ['succeeded', 2, 'dispatched']]);
    expect(attempts[1]).toMatchObject({ previousRequestId: attempts[0]!.requestId, logicalRequestId: attempts[0]!.logicalRequestId });
    for (let index = 0; index < 3; index += 1) {
      const warm = await client.inputs.submit({ sessionId: session.id, inputId: `warm-${index}`,
        text: `Evidence ${index}. ` + 'Preserve the release decision. '.repeat(600) });
      expect((await client.runs.await(warm.runId!)).phase).toBe('completed');
    }
    await client.sessions.updateSettings(session.id, { compactionTriggerTokens: 5000 });
    expect((await client.sessions.compact(session.id)).compacted).toBe(true);
    expect(brokerRequests.some(request => request.purpose === 'compaction' && request.target.kind === 'operation'
      && request.target.operation === 'session.compact' && request.sessionId === session.id)).toBe(true);
    const compactRequest = [...brokerRequests].reverse().find(request => request.purpose === 'compaction' && request.target.kind === 'operation');
    expect((await client.statistics.readRequests(session.id)).items).toContainEqual(expect.objectContaining({
      purpose: 'compaction', target: compactRequest!.target, state: 'succeeded',
    }));
    expect((await client.statistics.read(session.id)).contexts).toContainEqual(expect.objectContaining({ contextKind: 'child' }));
    await credentialService!.revoke(credentialLease!.id);
    await expect(client.inputs.submit({ sessionId: session.id, inputId: 'revoked', text: 'Do not dispatch.' }))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
    credentialLease = undefined;
    for (let index = 0; index < 3; index += 1) {
      const warm = await client.inputs.submit({ sessionId: session.id, inputId: `cancel-warm-${index}`,
        text: `Keep evidence ${index}. ` + 'Preserve the exit decision. '.repeat(600) });
      expect((await client.runs.await(warm.runId!)).phase).toBe('completed');
    }
    const beforeCompact = await client.sessions.readHistory(session.id);
    const compact = client.sessions.compact(session.id, { customInstructions: 'COMPACTION-CANCEL-PROBE' })
      .then(result => ({ result }), error => ({ error: error as Error }));
    await compactEntering;
    await client.lifecycle.requestExit({ requestId: 'cancel-compaction' });
    const compactResult = await compact;
    expect('error' in compactResult || !compactResult.result.compacted).toBe(true);
    await expect.poll(async () => {
      const receipt = await client.lifecycle.readExit('cancel-compaction');
      // Bounded cleanup can return unknown under load; recover using the same idempotent request.
      if (receipt?.cleanup.state === 'unknown') await client.lifecycle.requestExit({ requestId: 'cancel-compaction' });
      return (await client.lifecycle.readExit('cancel-compaction'))?.cleanup.state;
    }).toBe('succeeded');
    const quit = await client.lifecycle.readExit('cancel-compaction');
    expect(quit!.cleanup.operationIds).toHaveLength(1);
    expect((await client.sessions.readHistory(session.id)).sourceRevision).toBe(beforeCompact.sourceRevision);
    expect((await client.statistics.readRequests(session.id)).items).toContainEqual(expect.objectContaining({
      target: { kind: 'operation', operation: 'session.compact', operationId: quit!.cleanup.operationIds[0] },
      state: 'cancelled', boundary: 'physical_attempt',
    }));
  } finally {
    release();
    releaseCompact();
    await client.disconnect();
    await host.close();
    await runtime.close();
    await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
    clearRuntimeModelProviders();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
