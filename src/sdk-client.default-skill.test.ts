import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ensureKodaXClient } from './sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from './sdk-runtime.js';

it('applies a Main-declared default Skill in the Host while preserving the original question and persona', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-default-skill-'));
  const configHome = path.join(homeDir, '.kodax');
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const wire = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0,
      delta: { content: 'Fixture answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port.');
  const skillDir = path.join(configHome, 'skills', 'expert-method');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), [
    '---', 'name: expert-method', 'description: Fixture expert method.', '---',
    'DEFAULT-EXPERT-METHOD: Use this method for $ARGUMENTS.', '!`echo DYNAMIC-CONTEXT`',
  ].join('\n'));
  const explicitDir = path.join(configHome, 'skills', 'explicit-method');
  await mkdir(explicitDir, { recursive: true });
  await writeFile(path.join(explicitDir, 'SKILL.md'), '---\nname: explicit-method\ndescription: Explicit method.\n---\nEXPLICIT-METHOD-ONLY $ARGUMENTS');
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: 'expert-fixture',
    protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_EXPERT_UNUSED_KEY', model: 'fixture' }] }));
  let credentialId: string | undefined;
  let method = 'expert-method';
  const profile = 'default-skill';
  const client = await ensureKodaXClient({ homeDir, profile, async authorizeExecution(_request, services) {
    credentialId ??= (await services.credentials.registerScoped({ providers: ['expert-fixture'] }, async () => 'fixture-only')).id;
    return { credential: { mode: 'scoped', leaseId: credentialId, providers: ['expert-fixture'] },
      profile: await services.createExecutionProfile({ agentProfile: { name: 'Fixture expert', instructions: 'KEEP-EXPERT-PERSONA' },
        defaultSkill: { name: method } }) };
  } });
  try {
    const session = await client.sessions.create({ projectPath: homeDir, surface: 'partner' });
    await client.sessions.updateSettings(session.id, { provider: 'expert-fixture', model: 'fixture', workMode: 'agent',
      agentMode: 'sa', permissionMode: 'full-access' });
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'plain-question', text: 'My original question' });
    expect(accepted.runId).toBeTruthy();
    expect((await client.runs.await(accepted.runId!)).phase).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]).includes('DEFAULT-EXPERT-METHOD'), 'Host-expanded default method').toBe(true);
    expect(JSON.stringify(requests[0]).includes('KEEP-EXPERT-PERSONA'), 'Admitted persona').toBe(true);
    expect(requests[0]!.messages.filter(message => message.role === 'user').at(-1)?.content).toBe('My original question');
    expect((await client.sessions.readHistory(session.id)).items.find(item => item.type === 'user')?.text).toBe('My original question');
    expect(JSON.stringify(requests[0]).includes('!`echo DYNAMIC-CONTEXT`'), 'Dynamic command was expanded by Host').toBe(false);
    for (const [inputId, text] of [['explicit', '/explicit-method This round'], ['again', 'Back to the expert']] as const) {
      const result = await client.inputs.submit({ sessionId: session.id, inputId, text });
      expect((await client.runs.await(result.runId!)).phase).toBe('completed');
    }
    expect(JSON.stringify(requests[1]).includes('EXPLICIT-METHOD-ONLY')).toBe(true);
    expect(JSON.stringify(requests[1]).includes('KEEP-EXPERT-PERSONA')).toBe(true);
    expect(JSON.stringify(requests[2]).includes('DEFAULT-EXPERT-METHOD')).toBe(true);
    method = 'uninstalled-method';
    await expect(client.inputs.submit({ sessionId: session.id, inputId: 'missing', text: 'Must not lose my method' }))
      .rejects.toMatchObject({ code: 'default_skill_unavailable' });
    expect(requests).toHaveLength(3);
  } finally {
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome, profile, owner })).toMatchObject({ status: 'succeeded' });
    await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
