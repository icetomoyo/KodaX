import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureKodaXClient } from '../dist/sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

function historyFacts(page) {
  const { revision: _revision, sourceRevision: _source, items, ...facts } = page;
  return { ...facts, items: items.map(({ id: _id, historyBoundary, ...item }) => ({ ...item, historyEntryId: historyBoundary?.entryId })) };
}

test('published-layout SDK and independent Host bind default methods and reconcile promotion after cold restart', { timeout: 60_000 }, async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-bundle-space-'));
  const configHome = path.join(homeDir, '.kodax');
  const profile = 'bundle-space';
  const requests = [];
  const wire = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'Bundled answer.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  assert.ok(address && typeof address !== 'string');
  const skillDir = path.join(configHome, 'skills', 'bundled-method');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: bundled-method\ndescription: Bundled method.\n---\nBUNDLED-EXPERT-METHOD $ARGUMENTS');
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: 'bundle-space', protocol: 'openai',
    model: 'fixture', apiKeyEnv: 'UNUSED_BUNDLED_SPACE_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1` }] }));
  const connect = () => {
    let bindingId;
    return ensureKodaXClient({ homeDir, profile, async authorizeExecution(_request, services) {
      bindingId ??= (await services.executionBindings.register(async (_input, scoped) => {
        const credential = await scoped.credentials.registerScoped({ providers: ['bundle-space'] }, async () => 'bundle-fixture-key');
        return { businessBinding: { id: 'expert', revision: 'r1' }, credential: { mode: 'scoped', leaseId: credential.id, providers: ['bundle-space'] },
          profile: await scoped.createExecutionProfile({ defaultSkill: { name: 'bundled-method' }, agentProfile: { instructions: 'BUNDLED-PERSONA' } }) };
      })).id;
      return { binding: { leaseId: bindingId } };
    } });
  };
  let client = await connect();
  const shutdown = async () => {
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) assert.equal((await waitForRuntimeDaemonShutdown({ configHome, profile, owner })).status, 'succeeded');
  };
  try {
    const session = await client.sessions.create({ projectPath: homeDir, surface: 'partner', tag: 'quick-ask' });
    await client.sessions.updateSettings(session.id, { provider: 'bundle-space', model: 'fixture', agentMode: 'sa', permissionMode: 'full-access', workMode: 'agent' });
    const input = await client.inputs.submit({ sessionId: session.id, inputId: 'original', text: 'Original bundled question' });
    assert.equal((await client.runs.await(input.runId)).phase, 'completed');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].includes('BUNDLED-EXPERT-METHOD'));
    assert.ok(requests[0].includes('BUNDLED-PERSONA'));
    const before = await client.sessions.read(session.id);
    const history = await client.sessions.readHistory(session.id);
    const promotion = { sessionId: session.id, requestId: 'bundle-promotion', expectedRevision: before.metadataRevision, tag: 'partner' };
    const result = await client.sessions.promote(promotion);
    assert.equal(result.session.id, session.id);
    assert.equal(result.session.tag, 'partner');
    assert.deepEqual(historyFacts(await client.sessions.readHistory(session.id)), historyFacts(history));
    await shutdown();
    client = await connect();
    assert.equal((await client.sessions.readPromotion(session.id, promotion.requestId)).session.metadataRevision, result.session.metadataRevision);
    assert.deepEqual(await client.sessions.promote(promotion), result);
    assert.deepEqual(historyFacts(await client.sessions.readHistory(session.id)), historyFacts(history));
  } finally {
    await shutdown();
    wire.closeAllConnections();
    await new Promise((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
