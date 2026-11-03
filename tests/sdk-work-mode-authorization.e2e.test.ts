import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { connectKodaXClient } from '../src/sdk-client.js';
import { connectKodaXRuntime } from '../src/sdk-runtime.js';

async function fixture(options: { holdFirst?: boolean; defaultSkill?: boolean; staticAuthorization?: boolean } = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-work-mode-authority-'));
  const requests: string[] = [];
  let release = () => {};
  const first = new Promise<void>(done => { release = done; });
  const wire = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push(body);
    if (options.holdFirst && requests.length === 1) await first;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'mode-fixture', choices: [{ index: 0,
      delta: { content: 'Mode fixture completed.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => wire.listen(0, '127.0.0.1', done));
  const address = wire.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  await mkdir(join(homeDir, '.kodax', 'skills', 'mode-method'), { recursive: true });
  await writeFile(join(homeDir, '.kodax', 'skills', 'mode-method', 'SKILL.md'),
    '---\nname: mode-method\ndescription: Mode authority test\nhooks:\n  SessionStart:\n    - command: echo hook>> mode-hook.txt\n---\nUse the trusted method.');
  await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'mode-fixture', model: 'fixture',
    customProviders: [{ name: 'mode-fixture', protocol: 'openai', model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_UNUSED_MODE_FIXTURE_KEY' }] }));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  child.stdout!.resume(); child.stderr!.resume();
  const [ready] = await once(child, 'message');
  const endpoint = (ready as { endpoint: string }).endpoint;
  let bindingId: string | undefined;
  let required = true;
  const connect = () => connectKodaXClient({ homeDir, endpoint, clientInfo: {
    name: 'Partner', instanceId: 'mode-partner', instanceSecret: 'mode-partner'.repeat(8),
  }, async authorizeExecution(_request, services) {
    if (options.staticAuthorization) {
      const credential = await services.credentials.registerScoped({ providers: ['mode-fixture'] }, async () => 'fixture-only');
      return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['mode-fixture'] },
        profile: await services.createExecutionProfile(required ? { requiredWorkMode: 'agent' } : {}) };
    }
    bindingId ??= (await services.executionBindings.register(async (_input, scoped) => {
      const credential = await scoped.credentials.registerScoped({ providers: ['mode-fixture'] }, async () => 'fixture-only');
      const constraint = required ? { requiredWorkMode: 'agent' as const } : {};
      return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['mode-fixture'] },
        businessBinding: { id: 'partner', revision: '1' },
        profile: await scoped.createExecutionProfile({ ...constraint,
          ...(options.defaultSkill === false ? {} : { defaultSkill: { name: 'mode-method' } }) }) };
    })).id;
    return { binding: { leaseId: bindingId } };
  } });
  let client = await connect();
  const peer = await connectKodaXClient({ homeDir, endpoint });
  const session = await client.sessions.create({ projectPath: homeDir, surface: 'partner' });
  return { homeDir, endpoint, get client() { return client; }, peer, session, requests, release,
    async restartMain() { await client.disconnect(); bindingId = undefined; client = await connect(); },
    requireAgent(value: boolean) { required = value; }, async close() {
    release();
    await client.disconnect(); await peer.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    wire.closeAllConnections(); await new Promise<void>((done, reject) => wire.close(error => error ? reject(error) : done()));
    const target = resolve(homeDir);
    if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/')) throw new Error('Unsafe fixture cleanup path.');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

it.each(['coding', 'script'] as const)('rejects a trusted Agent requirement in %s before model requests or Skill hooks, then admits Agent', async wrongMode => {
  const state = await fixture();
  try {
    const probe = await connectKodaXRuntime({ homeDir: state.homeDir, endpoint: state.endpoint });
    try { expect(probe.capabilities.productExecutionModeConstraint).toEqual({ version: 1 }); }
    finally { await probe.close(); }
    await state.client.sessions.updateSettings(state.session.id, { workMode: wrongMode, agentMode: 'sa', permissionMode: 'full-access' });
    await expect(state.client.inputs.submit({ sessionId: state.session.id, inputId: 'wrong-mode', text: 'Do the Partner task.' }))
      .rejects.toMatchObject({ code: 'execution_mode_mismatch' });
    expect(state.requests).toHaveLength(0);
    await expect(readFile(join(state.homeDir, 'mode-hook.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await state.peer.sessions.updateSettings(state.session.id, { workMode: 'agent' });
    const accepted = await state.client.inputs.submit({ sessionId: state.session.id, inputId: 'right-mode', text: 'Do the Partner task.' });
    expect((await state.client.runs.await(accepted.runId!)).phase).toBe('completed');
    expect(state.requests).toHaveLength(1);
    expect((await readFile(join(state.homeDir, 'mode-hook.txt'), 'utf8')).trim()).toBe('hook');
  } finally { await state.close(); }
}, 120_000);

it('retains a pending static Agent constraint when the original Main reconnects with weaker authority', async () => {
  const state = await fixture({ holdFirst: true, defaultSkill: false, staticAuthorization: true });
  try {
    await state.client.sessions.updateSettings(state.session.id, { workMode: 'agent', agentMode: 'sa', permissionMode: 'full-access' });
    const active = await state.client.inputs.submit({ sessionId: state.session.id, inputId: 'initial', text: 'Hold Agent task.' });
    await expect.poll(() => state.requests.length, { timeout: 15_000 }).toBe(1);
    const pending = { sessionId: state.session.id, inputId: 'constrained', text: 'Keep original Agent requirement.', delivery: 'after_turn' as const };
    await state.client.inputs.submit(pending);
    await state.client.runs.stop(active.runId!);
    state.release();
    await state.client.runs.await(active.runId!);
    await state.restartMain();
    await state.peer.sessions.updateSettings(state.session.id, { workMode: 'coding' });
    state.requireAgent(false);
    await state.client.inputs.submit(pending);
    await expect.poll(async () => (await state.client.inputs.read(pending.sessionId, pending.inputId))?.admissionError?.code,
      { timeout: 5_000 }).toBe('execution_mode_mismatch');
    expect(state.requests).toHaveLength(1);
    expect((await state.client.inputs.withdraw(pending.sessionId, pending.inputId)).text).toBe(pending.text);
  } finally { await state.close(); }
}, 120_000);

it.each([true, false])('preserves rejected queued input at actual mode admission (default Skill: %s)', async defaultSkill => {
  const state = await fixture({ holdFirst: true, defaultSkill });
  try {
    state.requireAgent(false);
    await state.client.sessions.updateSettings(state.session.id, { workMode: 'coding', agentMode: 'sa', permissionMode: 'full-access' });
    const active = await state.client.inputs.submit({ sessionId: state.session.id, inputId: 'initial', text: 'Hold initial Coding task.' });
    await expect.poll(() => state.requests.length, { timeout: 15_000 }).toBe(1);
    const pending = { sessionId: state.session.id, inputId: 'queued-agent', text: 'Original queued Partner input', delivery: 'after_turn' as const };
    expect(await state.client.inputs.submit(pending)).toMatchObject({ state: 'queued' });
    state.requireAgent(true);
    state.release();
    await state.client.runs.await(active.runId!);
    await expect.poll(async () => (await state.client.inputs.read(pending.sessionId, pending.inputId))?.admissionError?.code,
      { timeout: 5_000 }).toBe('execution_mode_mismatch');
    expect(state.requests).toHaveLength(1);
    if (defaultSkill) expect((await readFile(join(state.homeDir, 'mode-hook.txt'), 'utf8')).trim()).toBe('hook');
    await state.peer.sessions.updateSettings(state.session.id, { workMode: 'agent' });
    expect(await state.client.inputs.submit(pending)).toMatchObject({ state: 'queued' });
    await expect.poll(async () => (await state.client.inputs.read(pending.sessionId, pending.inputId))?.runId, { timeout: 15_000 }).toBeTruthy();
    const accepted = await state.client.inputs.read(pending.sessionId, pending.inputId);
    expect((await state.client.runs.await(accepted!.runId!)).phase).toBe('completed');
    expect(state.requests).toHaveLength(2);
  } finally { await state.close(); }
}, 120_000);
