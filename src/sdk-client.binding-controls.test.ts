import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ensureKodaXClient } from './sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from './sdk-runtime.js';
import type { RuntimeExecutionAuthorization, RuntimeExecutionBindingRequest } from './client-host-authorization.js';

type ResolvedAuthorization = Omit<RuntimeExecutionAuthorization, 'binding'>;
function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function bindingFixture() {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-binding-controls-'));
  const configHome = path.join(homeDir, '.kodax');
  const profile = 'controls';
  const requests: string[] = [];
  const resolutions: RuntimeExecutionBindingRequest[] = [];
  const selection = { defaultSkill: 'default-method' };
  const firstRequest = gate();
  const responseGates = [firstRequest];
  const releases = [firstRequest.release];
  const behavior: { resolve?: (input: RuntimeExecutionBindingRequest, original: ResolvedAuthorization) => Promise<ResolvedAuthorization> } = {};
  const wire = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const index = requests.push(body) - 1;
    await responseGates[index]?.promise;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port.');
  for (const name of ['default-method', 'explicit-method']) {
    const directory = path.join(configHome, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture method.\n---\nMETHOD-${name} $ARGUMENTS`);
  }
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: 'controls-fixture', protocol: 'openai',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'UNUSED_BINDING_CONTROLS_KEY', model: 'fixture' }] }));
  let bindingId: string | undefined;
  let original: ResolvedAuthorization | undefined;
  let revokeBinding: (() => Promise<boolean>) | undefined;
  const client = await ensureKodaXClient({ homeDir, profile,
    clientInfo: { name: 'Binding controls', instanceId: 'binding-controls', instanceSecret: 'b'.repeat(64) },
    async authorizeExecution(_request, services) {
      bindingId ??= (await services.executionBindings.register(async (input, scoped) => {
        resolutions.push(structuredClone(input));
        const profile = await scoped.createExecutionProfile({ defaultSkill: { name: selection.defaultSkill } });
        original ??= { businessBinding: { id: 'expert', revision: '1' },
          credential: { mode: 'scoped', leaseId: (await scoped.credentials.registerScoped({ providers: ['controls-fixture'] }, async () => 'fixture-only')).id,
            providers: ['controls-fixture'] },
          profile };
        const resolved = { ...original, profile };
        return behavior.resolve ? behavior.resolve(input, resolved) : resolved;
      })).id;
      revokeBinding = () => services.executionBindings.revoke(bindingId!);
      return { binding: { leaseId: bindingId } };
    },
  });
  const session = await client.sessions.create({ projectPath: homeDir, surface: 'partner' });
  await client.sessions.updateSettings(session.id, { provider: 'controls-fixture', model: 'fixture', workMode: 'agent', agentMode: 'ama', permissionMode: 'full-access' });
  return { client, session, requests, resolutions, selection, behavior, firstRequest, homeDir, profile, configHome,
    get authorization() { if (!original) throw new Error('Run authority was not resolved.'); return original; },
    async revokeBinding() { if (!revokeBinding) throw new Error('Binding was not registered.'); return revokeBinding(); },
    gate() { const pending = gate(); releases.push(pending.release); return pending; },
    holdNextResponse() { const pending = gate(); responseGates[requests.length] = pending; releases.push(pending.release); return pending; },
    async close() {
      for (const release of releases) release();
      const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
      await client.lifecycle.requestExit({ requestId: 'fixture-close', shutdownHost: true });
      await client.disconnect();
      if (owner) expect((await waitForRuntimeDaemonShutdown({ configHome, profile, owner })).status).toBe('succeeded');
      wire.closeAllConnections();
      await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
      await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

it('resolves steer bindings before comparing authority and rejects replacements or revocation during resolution', async () => {
  const fixture = await bindingFixture();
  const { client, session, resolutions } = fixture;
  try {
    const active = await client.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start' });
    await expect.poll(() => fixture.requests.length, { timeout: 15_000 }).toBe(1);
    const steer = { sessionId: session.id, inputId: 'steer', text: 'Keep this constraint', delivery: 'steer' as const, targetRunId: active.runId! };
    await expect(client.inputs.submit(steer)).resolves.toMatchObject({ state: 'queued', runId: active.runId });
    expect(resolutions.map(request => request.input?.inputId)).toEqual(['initial', 'steer']);
    // A retry reconciles the accepted intent without invoking its resolver again.
    await expect(client.inputs.submit(steer)).resolves.toMatchObject({ state: 'queued', runId: active.runId });
    expect(resolutions).toHaveLength(2);
    for (const change of ['business', 'profile', 'credential', 'tools'] as const) {
      fixture.behavior.resolve = async (_input, original) => change === 'business'
        ? { ...original, businessBinding: { id: 'different-expert', revision: '1' } }
        : change === 'profile' ? { ...original, profile: { ...original.profile, agentProfile: { instructions: 'Different persona' } } }
          : change === 'credential' ? { ...original, credential: { mode: 'scoped', leaseId: 'different-lease', providers: ['controls-fixture'] } }
            : { ...original, tools: [] };
      await expect(client.inputs.submit({ ...steer, inputId: `replace-${change}` })).rejects.toMatchObject({ code: 'conflict' });
      expect(await client.inputs.read(session.id, `replace-${change}`)).toBeNull();
    }
    const resolvedCount = resolutions.length;
    await expect(client.inputs.submit({ ...steer, inputId: 'wrong-target', targetRunId: 'run_missing' })).rejects.toMatchObject({ code: 'conflict' });
    expect(resolutions).toHaveLength(resolvedCount);
    const foreign = await ensureKodaXClient({ homeDir: fixture.homeDir, profile: fixture.profile,
      clientInfo: { name: 'Foreign controls', instanceId: 'foreign-controls', instanceSecret: 'f'.repeat(64) },
      authorizeExecution: async () => fixture.authorization });
    try {
      await expect(foreign.inputs.submit({ ...steer, inputId: 'foreign-steer' })).rejects.toMatchObject({ code: 'conflict' });
    } finally { await foreign.disconnect(); }
    fixture.firstRequest.release();
    expect((await client.runs.await(active.runId!)).phase).toBe('completed');
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toContain('Keep this constraint');
    fixture.behavior.resolve = undefined;
    const nextResponse = fixture.holdNextResponse();
    const next = await client.inputs.submit({ sessionId: session.id, inputId: 'next', text: 'Another active Run' });
    await expect.poll(() => fixture.requests.length, { timeout: 15_000 }).toBe(3);
    const waiting = fixture.gate();
    fixture.behavior.resolve = async (_input, original) => { await waiting.promise; return original; };
    const late = client.inputs.submit({ ...steer, inputId: 'late-steer', targetRunId: next.runId })
      .then(accepted => ({ accepted }), (error: unknown) => ({ error }));
    await expect.poll(() => resolutions.at(-1)?.input?.inputId, { timeout: 15_000 }).toBe('late-steer');
    expect(await fixture.revokeBinding()).toBe(true);
    waiting.release();
    expect(await late).toMatchObject({ error: { code: 'execution_binding_unavailable' } });
    nextResponse.release();
    expect((await client.runs.await(next.runId!)).phase).toBe('completed');
    expect(await client.inputs.read(session.id, 'late-steer')).toBeNull();
  } finally { await fixture.close(); }
}, 90_000);

it('retains a redirect explicit method while blocked and refuses default fallback after that method is uninstalled', async () => {
  const fixture = await bindingFixture();
  const { client, session } = fixture;
  fixture.behavior.resolve = async (request, original) => {
    if (request.input?.inputId === 'blocker') throw new Error('Fixture holds the consumption queue');
    return original;
  };
  try {
    const active = await client.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start' });
    await expect.poll(() => fixture.requests.length, { timeout: 15_000 }).toBe(1);
    await client.inputs.submit({ sessionId: session.id, inputId: 'blocker', text: 'Blocked committed selection', delivery: 'after_turn' });
    const redirect = { sessionId: session.id, inputId: 'redirect', text: '/explicit-method Keep this original question',
      delivery: 'redirect' as const, targetRunId: active.runId! };
    await expect(client.inputs.submit(redirect)).resolves.toMatchObject({ state: 'queued' });
    fixture.firstRequest.release();
    expect((await client.runs.await(active.runId!)).phase).toBe('interrupted');
    await expect.poll(async () => (await client.inputs.read(session.id, 'blocker'))?.admissionError?.code, { timeout: 15_000 })
      .toBe('execution_binding_rejected');
    await rm(path.join(fixture.configHome, 'skills', 'explicit-method'), { recursive: true });
    await client.inputs.withdraw(session.id, 'blocker');
    // Reconcile the same queued intent after the blocker is removed.
    await client.inputs.submit(redirect);
    await expect.poll(async () => (await client.inputs.read(session.id, 'redirect'))?.admissionError?.code, { timeout: 15_000 })
      .toBe('default_skill_unavailable');
    expect(await client.inputs.read(session.id, 'redirect')).toMatchObject({ state: 'queued' });
    expect(fixture.requests).toHaveLength(1);
    expect(await client.inputs.withdraw(session.id, 'redirect')).toMatchObject({
      sessionId: session.id, inputId: 'redirect', text: redirect.text,
    });
    const method = path.join(fixture.configHome, 'skills', 'explicit-method');
    await mkdir(method, { recursive: true });
    await writeFile(path.join(method, 'SKILL.md'), '---\nname: explicit-method\ndescription: Restored method.\n---\nMETHOD-explicit-method $ARGUMENTS');
    const restored = await client.inputs.submit({ sessionId: session.id, inputId: 'restored', text: '/explicit-method Use the restored method' });
    expect((await client.runs.await(restored.runId!)).phase).toBe('completed');
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toContain('METHOD-explicit-method');
  } finally { await fixture.close(); }
}, 90_000);

it.each([
  { text: 'Plain redirect with no Skill reference', defaultSkill: 'default-method' },
  { text: '/unknown-method Plain redirect with an unrecognized reference', defaultSkill: 'default-method' },
  { text: 'Plain redirect with a newly committed default', defaultSkill: 'explicit-method' },
])('runs a plain redirect behind after-turn input ($text; default=$defaultSkill)', async ({ text, defaultSkill }) => {
  const fixture = await bindingFixture();
  const { client, session } = fixture;
  try {
    const active = await client.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start' });
    await expect.poll(() => fixture.requests.length, { timeout: 15_000 }).toBe(1);
    const before = { sessionId: session.id, inputId: 'before', text: 'Earlier queued question', delivery: 'after_turn' as const };
    await client.inputs.submit(before);
    const response = fixture.holdNextResponse();
    const redirect = { sessionId: session.id, inputId: 'plain-redirect', text,
      delivery: 'redirect' as const, targetRunId: active.runId! };
    await client.inputs.submit(redirect);
    fixture.firstRequest.release();
    expect((await client.runs.await(active.runId!)).phase).toBe('interrupted');
    await expect.poll(() => fixture.requests.length, { timeout: 15_000 }).toBe(2);
    fixture.selection.defaultSkill = defaultSkill;
    response.release();
    await expect.poll(async () => {
      const result = await client.inputs.read(session.id, redirect.inputId);
      return result?.state === 'submitted' || result?.admissionError !== undefined;
    }, { timeout: 15_000 }).toBe(true);
    const accepted = await client.inputs.read(session.id, redirect.inputId);
    expect(accepted).toMatchObject({ state: 'submitted' });
    expect(accepted?.admissionError).toBeUndefined();
    expect(accepted?.runId).not.toBe((await client.inputs.read(session.id, before.inputId))?.runId);
    expect((await client.runs.await(accepted!.runId!)).phase).toBe('completed');
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2]).toContain(`METHOD-${defaultSkill}`);
    expect(fixture.requests[2]).toContain(redirect.text);
  } finally { await fixture.close(); }
}, 90_000);
