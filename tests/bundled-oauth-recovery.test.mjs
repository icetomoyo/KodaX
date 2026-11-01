import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startRuntimeFixtureProcess } from './fixtures/runtime-fixture-process.mjs';
import { createCustomProvider, createFileProviderCredentialStore, createOAuthProviderConfig, openOAuthSession } from '../dist/sdk-llm.js';
import { FileSessionStorage, linkProviderOAuthRegistration } from '../dist/sdk-repl.js';
import { connectKodaXClient } from '../dist/sdk-client.js';
import { createProviderCredentialAuthorizer, createWindowsOAuthSessionStore, ensureKodaXRuntime,
  migrateProviderOAuthRegistration, providerOAuthStore, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

// Interrupt at the public store transaction boundary, after the new store has
// committed but before the legacy transaction can return. No private fs mocks.
if (process.argv[2] === '--interrupt-migration') {
  const configPath = process.argv[3], registrationId = process.argv[4];
  const legacy = createWindowsOAuthSessionStore(path.join(path.dirname(configPath), 'provider-oauth'));
  await migrateProviderOAuthRegistration({ configPath, registrationId, legacyStore: {
    transact(id, operation) {
      return legacy.transact(id, async previous => {
        const update = await operation(previous);
        process.send({ copied: true });
        await new Promise(() => {});
        return update;
      });
    },
  } });
} else if (process.argv[2] === '--inspect-revoked') {
  const configPath = process.argv[3];
  const connection = JSON.parse(await readFile(configPath, 'utf8')).customProviders.find(provider => provider.name === 'subscription');
  const migration = await migrateProviderOAuthRegistration({ configPath, registrationId: connection.oauthRegistration });
  let refreshes = 0, code;
  const session = await openOAuthSession({ id: connection.oauthRegistration, store: providerOAuthStore(configPath), driver: {
    async refresh() { refreshes++; throw new Error('Revoked registrations must not refresh'); },
  } });
  try { await session.acquire(); } catch (error) { code = error.code; }
  const retained = await openOAuthSession({ id: 'account-a', store: providerOAuthStore(configPath), driver: {
    async refresh() { refreshes++; throw new Error('The rotated original grant must remain usable'); },
  } });
  const retainedToken = await retained.acquire();
  process.send({ accountId: session.accountId, migration, code, refreshes, retainedAccountId: retained.accountId,
    retainedCredentialUsable: retainedToken === (retained.service === 'github-copilot' ? 'resource-account-a-1' : 'grant-account-a-1') });
  process.disconnect();
} else {
  for (const service of ['openai-chatgpt', 'openai-codex', 'github-copilot']) {
    test(`${service}: interrupted legacy migration, account selection, refresh, revocation and cold Host recovery`, {
      skip: process.platform !== 'win32', timeout: 60_000,
    }, async t => {
      const folder = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-bundle-oauth-recovery-'));
      const configHome = path.join(folder, '.kodax'), configPath = path.join(configHome, 'config.json');
      const sessionsDir = path.join(configHome, 'sessions');
      const legacyDirectory = path.join(configHome, 'provider-oauth');
      const legacy = createWindowsOAuthSessionStore(legacyDirectory);
      const previousAmbient = process.env.KODAX_OAUTH_RECOVERY_UNSET;
      process.env.KODAX_OAUTH_RECOVERY_UNSET = 'must-not-use-ambient-key';
      let runtime, client, owner, child, releaseRefresh, currentAuthorizer, lastAuthorization;
      const authorizers = [], wires = [], errors = [];
      let passed = false, rejectNext = false;
      const server = createServer((request, response) => {
        void (async () => {
          for await (const _chunk of request) { /* Drain fixture request. */ }
          wires.push(request.headers.authorization);
          if (rejectNext) {
            rejectNext = false;
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'Fixture access token revoked', type: 'authentication_error' } })); return;
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: '## Goal\nPreserve the selected account.\n## Progress\nRecovery verified.\n## Next Steps\nContinue the task.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5000, completion_tokens: 50, total_tokens: 5050 },
          })}\n\ndata: [DONE]\n\n`);
        })().catch(error => { errors.push(error); response.destroy(error); });
      });
      async function stopHost() {
        if (!runtime) return;
        const closing = runtime;
        const failures = [];
        try { await client?.disconnect(); } catch (error) { failures.push(error); }
        finally { client = undefined; }
        try { await closing.daemon.shutdown(); } catch (error) { failures.push(error); }
        try { await closing.close(); } catch (error) { failures.push(error); }
        try {
          assert.equal((await waitForRuntimeDaemonShutdown({ configHome, owner })).status, 'succeeded');
          runtime = undefined;
        } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Fixture Host cleanup failed');
      }
      t.after(async () => {
        releaseRefresh?.();
        await child?.stop();
        const closed = await Promise.allSettled(authorizers.map(authorizer => authorizer.close()));
        for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
        try { await stopHost(); } catch (error) { errors.push(error); }
        if (previousAmbient === undefined) delete process.env.KODAX_OAUTH_RECOVERY_UNSET;
        else process.env.KODAX_OAUTH_RECOVERY_UNSET = previousAmbient;
        server.closeAllConnections();
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (passed && errors.length === 0) {
          assert.equal(path.dirname(folder), await realpath(os.tmpdir()));
          assert.ok(path.basename(folder).startsWith('kodax-bundle-oauth-recovery-'));
          await rm(folder, { recursive: true, force: true });
        } else t.diagnostic(`Retained isolated OAuth evidence: ${folder}`);
        if (errors.length) throw new AggregateError(errors, 'OAuth recovery fixture cleanup failed');
      });
      await mkdir(configHome, { recursive: true });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      // The real Host uses loopback transport; native subscription wire formats
      // remain covered by oauth-routes/responses tests, without real accounts.
      const wireProvider = { name: 'oauth-recovery-wire', protocol: 'openai', model: 'fixture',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'KODAX_OAUTH_RECOVERY_UNSET', contextWindow: 32768, maxOutputTokens: 1024 };
      const subscription = { ...createOAuthProviderConfig({ service, name: 'subscription', model: 'fixture' }), oauthRegistration: 'account-a' };
      await writeFile(configPath, JSON.stringify({ customProviders: [subscription, wireProvider], unrelated: 'preserved' }));
      for (const id of ['account-a', 'account-b']) {
        await legacy.transact(id, async () => ({ record: { id, service, clientId: `client-${id}`, accountId: id, profile: 'default',
          credentials: { accessToken: `expired-${id}`, refreshToken: `original-${id}`, expiresAt: 1 } }, result: undefined }));
      }
      const legacyFile = path.join(legacyDirectory, `${createHash('sha256').update('account-a').digest('hex')}.sealed`);
      const originalLegacy = await readFile(legacyFile);
      const store = createFileProviderCredentialStore(path.join(configHome, 'auth.json'));
      const fingerprint = createCustomProvider(wireProvider).getCredentialConnectionFingerprint();
      const keyBinding = { provider: wireProvider.name, profile: 'default', connectionFingerprint: fingerprint };
      await store.setApiKey(keyBinding, 'must-not-use-unrelated-key');
      child = startRuntimeFixtureProcess(import.meta.url, ['--interrupt-migration', configPath, 'account-a'], t.signal);
      const copied = await child.message();
      assert.deepEqual(copied, { copied: true });
      await child.stop();
      assert.equal(await migrateProviderOAuthRegistration({ configPath, registrationId: 'account-a' }), 'current');
      assert.deepEqual(await readFile(legacyFile), originalLegacy);
      assert.equal(await migrateProviderOAuthRegistration({ configPath, registrationId: 'account-b' }), 'migrated');
      const refreshes = [];
      const resources = new Map();
      let enteredRefresh;
      const entered = new Promise(resolve => { enteredRefresh = resolve; });
      const driver = {
        async refresh(record) {
          refreshes.push(record.accountId);
          if (record.id === 'account-a') {
            enteredRefresh();
            await new Promise(resolve => { releaseRefresh = resolve; });
          }
          const generation = refreshes.filter(account => account === record.accountId).length;
          return { accessToken: `grant-${record.id}-${generation}`, refreshToken: `rotated-${record.id}-${generation}`, expiresAt: Date.now() + 3600_000 };
        },
        async exchangeResource(record) {
          const generation = (resources.get(record.id) ?? 0) + 1; resources.set(record.id, generation);
          return { accessToken: `resource-${record.id}-${generation}`, expiresAt: Date.now() + 3600_000 };
        },
      };
      const selectedSession = async () => {
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        const id = config.customProviders.find(provider => provider.name === 'subscription').oauthRegistration;
        return openOAuthSession({ id, store: providerOAuthStore(configPath), driver });
      };
      const authorize = session => {
        const authorizer = createProviderCredentialAuthorizer({ sources: [{ kind: 'oauth', provider: wireProvider.name,
          connectionFingerprint: fingerprint, service, profile: 'default', session }] });
        authorizers.push(authorizer); return authorizer;
      };
      const startHost = async () => {
        runtime = await ensureKodaXRuntime({ homeDir: folder, sessionsDir, daemonOrphanExitMs: 1000,
          clientInfo: { name: 'oauth-recovery-test', clientType: 'cli', instanceId: randomUUID(), instanceSecret: randomUUID() },
          requirements: { providerCredentialBroker: 2, daemonManagement: 1 } });
        owner = (await runtime.daemon.inspect()).owner;
        assert.notEqual(owner.pid, process.pid);
        client = await connectKodaXClient({ homeDir: folder,
          clientInfo: { name: 'oauth-recovery-product', clientType: 'cli' },
          authorizeExecution: async (request, services) => {
            lastAuthorization = await currentAuthorizer.authorizeExecution(request, services);
            return lastAuthorization;
          },
        });
      };
      const storage = new FileSessionStorage({ sessionsDir, configHome });
      for (const id of ['delayed-a', 'selected-b', 'restored-b', 'rejected-b', 'after-rejection-b', 'revoked-b']) {
        await storage.save(id, { title: id, gitRoot: folder, messages: Array.from({ length: 24 }, (_, index) => ({
          role: index % 2 ? 'assistant' : 'user', content: index % 2 ? 'Retain prior task evidence. '.repeat(180) : `Continue ${index}.`,
        })) });
      }
      const compact = async (authorizer, id) => {
        currentAuthorizer = authorizer;
        await runtime.sessions.updateSettings(id, { provider: wireProvider.name, model: 'fixture', compactionTriggerTokens: 2000 });
        return client.sessions.compact(id);
      };
      await startHost();
      const a = authorize(await selectedSession());
      const pending = compact(a, 'delayed-a');
      // Attach rejection handling before fencing the lease.
      const outcomeA = pending.then(result => ({ result }), error => ({ error }));
      await Promise.race([entered, outcomeA.then(outcome => {
        throw outcome.error ?? new Error('Expected refresh acquisition before compaction completed');
      }), new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason), { once: true }))]);
      linkProviderOAuthRegistration({ configPath, name: 'subscription', service, expectedRegistration: 'account-a', registration: 'account-b' });
      const closedA = a.close();
      await closedA;
      releaseRefresh();
      assert.ok((await outcomeA).error);
      assert.deepEqual(wires, [], 'An account switched during refresh must never reach the model endpoint');
      const bSession = await selectedSession();
      const replayIdentity = bSession.replayIdentity;
      let b = authorize(bSession);
      assert.equal(bSession.accountId, 'account-b');
      assert.equal((await compact(b, 'selected-b')).compacted, true);
      const stale = lastAuthorization;
      const firstRuntimeId = runtime.identity.runtimeId;
      await b.close();
      await stopHost(); await startHost();
      assert.notEqual(runtime.identity.runtimeId, firstRuntimeId);
      await assert.rejects(runtime.credentials.resumeScoped(stale.credential.leaseId, async () => 'forbidden'));
      const restoredSession = await selectedSession();
      assert.equal(restoredSession.replayIdentity, replayIdentity);
      b = authorize(restoredSession);
      assert.equal((await compact(b, 'restored-b')).compacted, true);
      assert.deepEqual(refreshes, ['account-a', 'account-b']);
      assert.equal(wires.length, 2);
      const prefix = service === 'github-copilot' ? 'Bearer resource-account-b-' : 'Bearer grant-account-b-';
      assert.ok(wires.every(value => value.startsWith(prefix)));
      rejectNext = true;
      await assert.rejects(compact(b, 'rejected-b'));
      assert.equal(wires.length, 3, 'A rejected physical POST must not be replayed automatically');
      assert.equal((await compact(b, 'after-rejection-b')).compacted, true);
      assert.equal(wires.length, 4);
      assert.notEqual(wires[3], wires[2]);
      assert.ok(wires.every(value => value.startsWith(prefix)), 'Refresh must keep the explicitly selected account');
      assert.equal(restoredSession.replayIdentity, replayIdentity);
      assert.deepEqual(refreshes, service === 'github-copilot' ? ['account-a', 'account-b'] : ['account-a', 'account-b', 'account-b']);
      assert.equal((await bSession.revoke()).leaseRevocationFailures, 0);
      await assert.rejects(compact(b, 'revoked-b'), /closed|revoked/);
      await stopHost();
      // Reconstruct both stores after revocation; legacy backups never override
      // the durable tombstone and selection never silently falls back to A.
      assert.equal(await migrateProviderOAuthRegistration({ configPath, registrationId: 'account-b' }), 'current');
      const reopened = await selectedSession();
      assert.equal(reopened.accountId, 'account-b');
      await assert.rejects(reopened.acquire(), error => error.code === 'reauthentication_required');
      await startHost();
      const revokedAuthorizer = authorize(reopened);
      await assert.rejects(compact(revokedAuthorizer, 'revoked-b'));
      await revokedAuthorizer.close();
      await stopHost();
      child = startRuntimeFixtureProcess(import.meta.url, ['--inspect-revoked', configPath], t.signal);
      const inspection = await child.message();
      assert.deepEqual(inspection, { accountId: 'account-b', migration: 'current', code: 'reauthentication_required', refreshes: 0,
        retainedAccountId: 'account-a', retainedCredentialUsable: true });
      const inspectionExit = await child.waitForExit();
      assert.equal(inspectionExit.code, 0, inspectionExit.stderr);
      assert.equal((await store.readApiKey(keyBinding)).key, 'must-not-use-unrelated-key');
      assert.equal(JSON.parse(await readFile(configPath, 'utf8')).unrelated, 'preserved');
      assert.deepEqual(await readFile(legacyFile), originalLegacy);
      assert.equal(wires.length, 4);
      passed = true;
    });
  }
}
