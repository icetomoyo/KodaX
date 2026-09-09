import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Requires the final `npm run build` output. This script never compiles or touches
// the user's Host. It simulates clean/build file replacement using a frozen copy
// of dist and distinct legal JS comments; this is a byte-identity acceptance,
// not a semantic-difference test or a claim to have run a second npm build.
const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const stateDirectory = (home, profile) => path.join(home, '.kodax/runtime/daemon', profile);
async function readOwner(home, profile) {
  const directory = stateDirectory(home, profile);
  const state = JSON.parse(await readFile(path.join(directory, 'daemon.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(directory, 'daemon.lock'), 'utf8'));
  assert.equal(lock.runtimeId, state.runtimeId, 'Exactly the published Host must own the lock');
  assert.equal(lock.pid, state.pid, 'State and lock must identify one owner process');
  return { runtimeId: state.runtimeId, pid: state.pid, version: state.version };
}

async function workerMain() {
  const [, , , installation, homeDir, profile] = process.argv;
  // Import now, before commands arrive: the stale-launcher case keeps this
  // actual module graph loaded across replacement of the installation files.
  const sdk = await import(pathToFileURL(path.join(installation, 'dist/sdk-client.js')).href);
  let heldClient;
  let observation;
  let updates = 0;
  const options = { homeDir, profile, daemonStartupTimeoutMs: 30_000,
    clientInfo: { name: 'host-build-acceptance', instanceId: randomUUID(), instanceSecret: randomUUID() } };
  const closeHeld = async () => {
    observation?.close();
    observation = undefined;
    await heldClient?.disconnect();
    heldClient = undefined;
  };
  process.on('message', async ({ id, action, sessionId }) => {
    try {
      if (action === 'close') {
        await closeHeld();
        process.send({ id, ok: true });
        process.disconnect();
        return;
      }
      if (action === 'observe') {
        heldClient = await sdk.connectKodaXClient(options);
        observation = await heldClient.sessions.observe(sessionId, () => { updates += 1; });
        process.send({ id, ok: true, owner: await readOwner(homeDir, profile), updates });
        return;
      }
      if (action === 'ping') {
        assert.ok(heldClient, 'Observer connection remains available');
        const session = await heldClient.sessions.read(sessionId);
        process.send({ id, ok: true, owner: await readOwner(homeDir, profile), session, updates });
        return;
      }
      const client = await (action === 'ensure' ? sdk.ensureKodaXClient(options) : sdk.connectKodaXClient(options));
      try {
        if (action === 'shutdown') {
          await client.host.shutdown();
          process.send({ id, ok: true });
        } else {
          const session = sessionId ? await client.sessions.read(sessionId)
            : await client.sessions.create({ title: 'Saved across same-version Host replacement', projectPath: homeDir });
          if (!sessionId) await client.sessions.appendNotice(session.id, { content: 'HOST_BUILD_SAVED_NOTICE' });
          let history;
          const snapshot = await client.sessions.observe(session.id, view => { history = view.items; });
          snapshot.close();
          process.send({ id, ok: true, owner: await readOwner(homeDir, profile), session,
            history: JSON.stringify(history) });
        }
      } finally { await client.disconnect(); }
    } catch (error) {
      process.send({ id, ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code });
    }
  });
  process.send({ ready: true });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function waitFor(label, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

async function acceptanceMain() {
  const artifacts = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-host-build-'));
  const installation = path.join(artifacts, 'installation');
  const baseline = path.join(artifacts, 'baseline-dist');
  const homeDir = path.join(artifacts, 'home');
  const profile = 'build-acceptance';
  const workers = new Set();
  const owners = [];
  const results = [];
  let workerNumber = 0;
  let failure;
  process.stdout.write(`Artifacts: ${artifacts}\n`);
  const environment = { ...process.env, HOME: homeDir, USERPROFILE: homeDir,
    KODAX_HOME: path.join(homeDir, '.kodax'), KODAX_TRACING: '0' };
  delete environment.KODAX_BUNDLED;
  delete environment.KODAX_VERSION;
  delete environment.NODE_OPTIONS;
  async function openWorker() {
    const index = ++workerNumber;
    const child = spawn(process.execPath, [script, '--worker', installation, homeDir, profile], {
      cwd: installation, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let log = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    const pending = new Map();
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let exited = false;
    child.on('message', message => {
      if (message.ready) readyResolve();
      else pending.get(message.id)?.resolve(message);
    });
    child.on('error', error => readyReject(error));
    child.on('exit', (code, signal) => {
      exited = true;
      const error = new Error(`SDK worker ${index} exited (${code}/${signal}): ${log.slice(-4000)}`);
      readyReject(error);
      for (const request of pending.values()) request.reject(error);
    });
    const worker = {
      child,
      async request(action, sessionId) {
        const id = randomUUID();
        let timer;
        try {
          return await new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            timer = setTimeout(() => reject(new Error(`SDK worker ${action} timed out: ${log.slice(-4000)}`)), 60_000);
            child.send({ id, action, sessionId });
          });
        } finally { clearTimeout(timer); pending.delete(id); }
      },
      async close() {
        try { if (!exited) await worker.request('close'); }
        finally {
          if (!exited) await waitFor(`SDK worker ${index} exit`, () => exited, 5000).catch(() => child.kill());
          await writeFile(path.join(artifacts, `worker-${index}.log`), log);
          workers.delete(worker);
        }
      },
    };
    workers.add(worker);
    const readyTimer = setTimeout(() => readyReject(new Error(`SDK worker import timed out: ${log.slice(-4000)}`)), 30_000);
    try { await ready; return worker; } finally { clearTimeout(readyTimer); }
  }
  async function once(action, sessionId) {
    const worker = await openWorker();
    try { return await worker.request(action, sessionId); } finally { await worker.close(); }
  }
  async function replaceDist(marker) {
    const target = path.resolve(installation, 'dist');
    assert.equal(path.relative(artifacts, target), path.join('installation', 'dist'));
    await rm(target, { recursive: true, force: true });
    await cp(baseline, target, { recursive: true });
    const cli = path.join(target, 'kodax_cli.js');
    await writeFile(cli, `${await readFile(cli, 'utf8')}\n// Host build acceptance variant ${marker}\n`);
  }
  async function assertOwner(owner, previous) {
    assert.deepEqual(await readOwner(homeDir, profile), owner);
    assert.ok(alive(owner.pid), 'Published owner process is alive');
    if (previous) {
      assert.notEqual(owner.runtimeId, previous.runtimeId);
      assert.equal(owner.version, previous.version, 'This must be a same-version replacement');
      await waitFor(`old Host ${previous.pid} exit`, () => !alive(previous.pid));
    }
    for (const old of owners) if (old.pid !== owner.pid) assert.equal(alive(old.pid), false, 'No earlier owner remains alive');
    if (!owners.some(saved => saved.runtimeId === owner.runtimeId)) owners.push(owner);
  }
  function saved(result, sessionId) {
    assert.equal(result.ok, true, result.error);
    assert.equal(result.session.id, sessionId);
    assert.ok(result.history.includes('HOST_BUILD_SAVED_NOTICE'), 'Saved lineage notice survives replacement');
  }
  try {
    await mkdir(installation, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await cp(path.join(repo, 'dist'), baseline, { recursive: true,
      filter: file => !path.relative(path.join(repo, 'dist'), file).split(path.sep).includes('binary') });
    await cp(path.join(repo, 'package.json'), path.join(installation, 'package.json'));
    await mkdir(path.join(installation, 'scripts'));
    for (const file of ['kodax-bin.cjs', 'production-env.cjs']) {
      await cp(path.join(repo, 'scripts', file), path.join(installation, 'scripts', file));
    }
    await cp(path.join(repo, 'config-templates'), path.join(installation, 'config-templates'), { recursive: true });
    await symlink(path.join(repo, 'node_modules'), path.join(installation, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await replaceDist('A');
    const initial = await once('ensure');
    assert.equal(initial.ok, true, initial.error);
    const sessionId = initial.session.id;
    saved(initial, sessionId);
    await assertOwner(initial.owner);
    const staleLauncher = await openWorker();

    await replaceDist('B');
    const updated = await once('ensure', sessionId);
    saved(updated, sessionId);
    await assertOwner(updated.owner, initial.owner);
    results.push({ scenario: 'same-version changed bytes replace idle Host and preserve Session', passed: true });

    await replaceDist('B');
    const unchanged = await once('ensure', sessionId);
    saved(unchanged, sessionId);
    assert.deepEqual(unchanged.owner, updated.owner);
    results.push({ scenario: 'same bytes rebuilt at new mtimes preserve owner', passed: true });

    await replaceDist('C');
    const passive = await once('passive', sessionId);
    saved(passive, sessionId);
    assert.deepEqual(passive.owner, updated.owner);
    results.push({ scenario: 'passive Client never replaces same-version older build', passed: true });

    const observer = await openWorker();
    assert.equal((await observer.request('observe', sessionId)).ok, true);
    const blocked = await once('ensure', sessionId);
    assert.equal(blocked.ok, false, 'A connected observer must block replacement');
    assert.match(blocked.error, /client|busy|block|active|in use/i);
    const stillObserved = await observer.request('ping', sessionId);
    assert.equal(stillObserved.ok, true, stillObserved.error);
    assert.ok(stillObserved.updates > 0);
    assert.deepEqual(stillObserved.owner, updated.owner);
    await assertOwner(updated.owner);
    results.push({ scenario: 'connected observer blocks replacement and keeps readable Session', passed: true, refusal: blocked.error });
    await observer.close();
    const released = await once('ensure', sessionId);
    saved(released, sessionId);
    await assertOwner(released.owner, updated.owner);
    results.push({ scenario: 'observer release permits safe replacement', passed: true });

    const stale = await staleLauncher.request('ensure', sessionId);
    assert.equal(stale.ok, false, 'A loaded old launcher must not replace the current Host');
    assert.match(stale.error, /loaded|stale|changed|restart|relaunch/i);
    assert.deepEqual(await readOwner(homeDir, profile), released.owner);
    await staleLauncher.close();
    results.push({ scenario: 'long-lived launcher refuses after its loaded installation changes', passed: true, refusal: stale.error });

    await replaceDist('D');
    const cli = spawn(process.execPath, [path.join(installation, 'scripts/kodax-bin.cjs'),
      'daemon', 'start', '--home', homeDir, '--profile', profile, '--timeout-ms', '30000', '--json'],
      { cwd: installation, env: environment, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    let cliOutput = '';
    cli.stdout.on('data', data => { cliOutput += data; });
    cli.stderr.on('data', data => { cliOutput += data; });
    const cliCode = await new Promise((resolve, reject) => { cli.once('error', reject); cli.once('exit', resolve); });
    await writeFile(path.join(artifacts, 'daemon-start.log'), cliOutput);
    assert.equal(cliCode, 0, cliOutput);
    const started = await once('passive', sessionId);
    saved(started, sessionId);
    await assertOwner(started.owner, released.owner);
    results.push({ scenario: 'daemon start shares same-version build validation', passed: true });
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ results, owners,
      boundary: 'Actual independent processes and built SDK/CLI; clean/build simulated by deleting/copying isolated dist and appending a legal comment. No compiler run, external LLM request, or user Host access.' }, null, 2));
    process.stdout.write(`${results.length} scenarios passed.\n`);
  } catch (error) {
    failure = error;
    await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ results, owners,
      error: error instanceof Error ? error.stack : String(error) }, null, 2));
    throw error;
  } finally {
    for (const worker of [...workers]) await worker.close().catch(error => process.stderr.write(`Worker cleanup: ${error.message}\n`));
    // Passive cleanup from the original built SDK also works if replacement
    // stopped halfway through copying the isolated installation.
    try {
      const { connectKodaXClient } = await import(pathToFileURL(path.join(repo, 'dist/sdk-client.js')).href);
      const client = await connectKodaXClient({ homeDir, profile });
      const owner = await readOwner(homeDir, profile);
      try { await client.host.shutdown(); } finally { await client.disconnect(); }
      await waitFor(`final isolated Host ${owner.pid} exit`, () => !alive(owner.pid));
    } catch (error) {
      process.stderr.write(`Isolated Host cleanup: ${error.message}\n`);
      if (!failure) throw error;
    }
  }
}

if (process.argv[2] === '--worker') await workerMain();
else await acceptanceMain();
