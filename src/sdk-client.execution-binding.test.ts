import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ensureKodaXClient } from './sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from './sdk-runtime.js';

it('resolves the last committed expert at actual queued consumption without adopting an uncommitted selection', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-binding-'));
  const configHome = path.join(homeDir, '.kodax');
  const requests: string[] = [];
  const gates = Array.from({ length: 4 }, () => {
    let release = () => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  });
  const wire = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const index = requests.push(body) - 1;
    if (gates[index]) await gates[index]!.promise;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0,
      delta: { content: 'Fixture answer.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port.');
  for (const name of ['expert-a', 'expert-b']) {
    const directory = path.join(configHome, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture method.\n---\nMETHOD-${name}: Apply this method to $ARGUMENTS.`);
  }
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: 'binding-fixture',
    protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_BINDING_UNUSED_KEY', model: 'fixture' }] }));
  let committed = { id: 'expert-a', revision: 'a1' };
  const draft = { id: 'expert-b', revision: 'b1' };
  const resolutions: string[] = [];
  let bindingId: string | undefined;
  let credentialId: string | undefined;
  let useDefault = true;
  const client = await ensureKodaXClient({ homeDir, async authorizeExecution(_request, services) {
    bindingId ??= (await services.executionBindings.register(async (request, scoped) => {
      if (request.input?.inputId === 'denied-sixth') throw new Error('Expert was disabled before consumption.');
      resolutions.push(`${request.phase}:${committed.id}`);
      credentialId ??= (await scoped.credentials.registerScoped({ providers: ['binding-fixture'] }, async () => 'fixture-only')).id;
      return { credential: { mode: 'scoped', leaseId: credentialId, providers: ['binding-fixture'] },
        businessBinding: structuredClone(committed), profile: await scoped.createExecutionProfile({
          agentProfile: { name: committed.id, instructions: `PERSONA-${committed.id}` },
          ...(useDefault ? { defaultSkill: { name: committed.id } } : {}),
        }) };
    })).id;
    return { binding: { leaseId: bindingId } };
  } });
  let sessionId: string | undefined;
  const inputIds: string[] = [];
  try {
    const session = await client.sessions.create({ projectPath: homeDir, surface: 'partner' });
    sessionId = session.id;
    await client.sessions.updateSettings(session.id, { provider: 'binding-fixture', model: 'fixture', workMode: 'agent',
      agentMode: 'sa', permissionMode: 'full-access' });
    inputIds.push('first');
    const first = await client.inputs.submit({ sessionId: session.id, inputId: 'first', text: 'Original first question' });
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
    inputIds.push('second');
    expect(await client.inputs.submit({ sessionId: session.id, inputId: 'second', text: 'Original second question', delivery: 'after_turn' }))
      .toMatchObject({ state: 'queued' });
    expect(resolutions).toEqual(['admission:expert-a']);
    // The UI draft exists, but no successful business-store commit has occurred.
    expect(draft.id).toBe('expert-b');
    gates[0]!.release();
    await client.runs.await(first.runId!);
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2);
    expect(requests[1]!.includes('METHOD-expert-a'), 'Uncommitted choice must not become authority').toBe(true);
    inputIds.push('third');
    expect(await client.inputs.submit({ sessionId: session.id, inputId: 'third', text: 'Original third question', delivery: 'after_turn' }))
      .toMatchObject({ state: 'queued' });
    committed = structuredClone(draft);
    gates[1]!.release();
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(3);
    const third = await client.inputs.read(session.id, 'third');
    expect(third?.runId).toBeTruthy();
    inputIds.push('removed-explicit');
    await client.inputs.submit({ sessionId: session.id, inputId: 'removed-explicit', text: '/expert-a Original explicit method', delivery: 'after_turn' });
    await rm(path.join(configHome, 'skills', 'expert-a'), { recursive: true });
    gates[2]!.release();
    expect((await client.runs.await(third!.runId!)).phase).toBe('completed');
    expect(requests[2]!.includes('METHOD-expert-b'), 'Committed binding at consumption').toBe(true);
    expect(requests[2]!.includes('PERSONA-expert-b'), 'Committed persona at consumption').toBe(true);
    await expect.poll(async () => (await client.inputs.read(session.id, 'removed-explicit'))?.admissionError?.code, { timeout: 15_000 })
      .toBe('default_skill_unavailable');
    expect(requests).toHaveLength(3);
    await client.inputs.withdraw(session.id, 'removed-explicit');
    const history = await client.sessions.readHistory(session.id);
    expect(history.items.filter(item => item.type === 'user').map(item => item.text)).toEqual([
      'Original first question', 'Original second question', 'Original third question',
    ]);
    useDefault = false;
    committed = { ...committed, revision: 'b2' };
    inputIds.push('plain-fourth', 'plain-fifth', 'denied-sixth');
    const fourth = await client.inputs.submit({ sessionId: session.id, inputId: 'plain-fourth', text: 'Plain fourth question' });
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(4);
    await client.inputs.submit({ sessionId: session.id, inputId: 'plain-fifth', text: 'Plain follow-up constraint', delivery: 'after_turn' });
    await client.inputs.submit({ sessionId: session.id, inputId: 'denied-sixth', text: 'Must retain rejected intent', delivery: 'after_turn' });
    gates[3]!.release();
    expect((await client.runs.await(fourth.runId!)).phase).toBe('completed');
    const fifth = await client.inputs.read(session.id, 'plain-fifth');
    expect(fifth?.runId).toBe(fourth.runId);
    expect(requests).toHaveLength(5);
    expect(requests[4]!.includes('Plain follow-up constraint')).toBe(true);
    await expect.poll(async () => (await client.inputs.read(session.id, 'denied-sixth'))?.admissionError?.code)
      .toBe('execution_binding_rejected');
    await client.inputs.withdraw(session.id, 'denied-sixth');
  } finally {
    for (const gate of gates) gate.release();
    if (sessionId) for (const inputId of inputIds) {
      const input = await client.inputs.read(sessionId, inputId);
      if (input?.runId) await client.runs.await(input.runId);
      else if (input?.state === 'queued') await client.inputs.withdraw(sessionId, inputId);
    }
    const owner = getKodaXRuntimeOwnerState({ homeDir }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome, owner })).toMatchObject({ status: 'succeeded' });
    await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
