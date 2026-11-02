import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureKodaXClient } from '../dist/sdk-client.js';
import { createProviderCredentialManager, getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

const replUrl = new URL('../dist/sdk-repl.js', import.meta.url).href;
const configWorker = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const sdk = await import(${JSON.stringify(replUrl)});
const file = process.env.KODAX_HOME + '/config.json';
const mode = process.env.FIXTURE_MODE;
const provider = { name: 'new-provider', protocol: 'openai', baseUrl: 'https://fixture.local/v1', apiKeyEnv: 'FIXTURE_UNUSED_KEY', model: 'fixture' };
if (mode === 'pause') {
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, data, options) => {
    if (typeof data !== 'string' || !data.includes('fixture-preserve-account')) return write(target, data, options);
    write(target, data.slice(0, 17), options);
    process.send('staged');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(process.env.FIXTURE_RELEASE)) {
      if (Date.now() > deadline) throw new Error('Fixture release was not received');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    if (typeof target === 'number') { fs.ftruncateSync(target, 0); fs.writeSync(target, data, 0, 'utf8'); }
    else write(target, data, options);
  };
  syncBuiltinESMExports();
  sdk.upsertCustomProvider(provider);
} else {
  for (let i = 0; i < 20; i++) {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        sdk.withCoreConfigWriteLock(file, () => {
          const config = sdk.readCoreConfig(file);
          if (mode === 'rename') config.customProviders = config.customProviders.map(p => p.name === 'old-provider' ? { ...p, name: 'renamed-provider' } : p);
          else config.fixtureCounter = i + 1;
          sdk.writeCoreConfigAtomically(file, JSON.stringify(config));
        });
        break;
      } catch (error) {
        if (!(error instanceof sdk.CoreConfigWriteConflictError) || Date.now() > deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    process.send('committed');
  }
}
process.disconnect();
`;

function startConfigWorker(home, mode, release) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', configWorker], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, KODAX_HOME: home, FIXTURE_MODE: mode, FIXTURE_RELEASE: release ?? '' },
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-2000); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  return { child, exited };
}

test('core config readers see complete committed bytes during a paused write and after writer crash', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-config-publication-'));
  const file = path.join(home, 'config.json');
  const original = JSON.stringify({ apiKeys: { deepseek: 'fixture-preserve-account' }, unknown: { keep: true } });
  try {
    for (const crash of [false, true]) {
      await writeFile(file, original);
      const release = path.join(home, `release-${crash}`);
      const worker = startConfigWorker(home, 'pause', release);
      try {
        await Promise.race([
          new Promise(resolve => worker.child.once('message', resolve)),
          worker.exited.then(result => { throw new Error(`Writer exited before staging: ${JSON.stringify(result)}`); }),
        ]);
        assert.equal(await readFile(file, 'utf8'), original);
        if (crash) worker.child.kill();
        else await writeFile(release, 'release');
        const result = await worker.exited;
        if (crash) assert.equal(await readFile(file, 'utf8'), original);
        else {
          assert.equal(result.code, 0, result.stderr);
          const next = JSON.parse(await readFile(file, 'utf8'));
          assert.deepEqual(next.apiKeys, { deepseek: 'fixture-preserve-account' });
          assert.deepEqual(next.unknown, { keep: true });
          assert.equal(next.customProviders[0].name, 'new-provider');
        }
      } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill(); await worker.exited; }
    }
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('independent rename and setting writers preserve credentials and unrelated fields for unlocked readers', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-config-concurrent-'));
  const file = path.join(home, 'config.json');
  const provider = { name: 'old-provider', protocol: 'openai', baseUrl: 'https://fixture.local/v1', apiKeyEnv: 'FIXTURE_UNUSED_KEY', model: 'fixture' };
  const preserved = 'fixture-preserve-account';
  await writeFile(file, JSON.stringify({ customProviders: [provider], apiKeys: { deepseek: preserved }, unknown: { keep: true }, padding: 'x'.repeat(128 * 1024) }));
  const credentials = createProviderCredentialManager({ configPath: file, environment: () => ({}) });
  const saved = await credentials.setApiKey(provider.name, preserved, await credentials.describe(provider.name));
  const authBefore = await readFile(credentials.filePath, 'utf8');
  const workers = ['rename', 'settings'].map(mode => startConfigWorker(home, mode));
  let done = false, reads = 0;
  const finished = Promise.all(workers.map(worker => worker.exited)).finally(() => { done = true; });
  try {
    do {
      const value = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(value.apiKeys, { deepseek: preserved });
      assert.deepEqual(value.unknown, { keep: true });
      assert.equal(value.customProviders.length, 1);
      assert.ok(['old-provider', 'renamed-provider'].includes(value.customProviders[0].name));
      reads++;
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (!done);
    for (const result of await finished) assert.equal(result.code, 0, result.stderr);
    const final = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(final.customProviders[0].name, 'renamed-provider');
    assert.equal(final.fixtureCounter, 20);
    assert.ok(reads > 1);
    await assert.rejects(credentials.setApiKey(provider.name, 'must-not-rebind', saved), /provider|configuration/i);
    assert.equal(await readFile(credentials.filePath, 'utf8'), authBefore);
    assert.equal((await credentials.describe('renamed-provider')).configured, false);
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    await finished;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

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
