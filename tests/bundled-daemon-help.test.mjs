import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureKodaXRuntime, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/kodax_cli.js', import.meta.url));
const names = ['start', 'stop', 'restart', 'logs', 'serve', 'status'];

test('informational commands remain available with corrupt core config and preserve all files', { timeout: 90_000 }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-bundle-invalid-config-'));
  const configHome = path.join(homeDir, '.kodax');
  await mkdir(configHome);
  try {
    for (const raw of ['', '{"provider":', '{"apiKey":"NEVER_PRINT_CREDENTIAL",}']) {
      await writeFile(path.join(configHome, 'config.json'), raw);
      const before = await files(configHome);
      for (const args of [['--version'], ['--help'], ['doctor', '--help'], ['config', '--help'], ['doctor', '--json']]) {
        const { stdout, stderr } = await run(homeDir, args);
        assert.ok(stdout.trim(), `${args.join(' ')} must produce information`);
        assert.doesNotMatch(stdout + stderr, /NEVER_PRINT_CREDENTIAL/);
        if (args.includes('--json')) assert.equal(JSON.parse(stdout).coreConfig.state, 'invalid');
        assert.deepEqual(await files(configHome), before, `${args.join(' ')} must not mutate retained files`);
      }
      await assert.rejects(run(homeDir, ['--print', 'do not execute']), /Core configuration is unreadable or invalid/);
      assert.deepEqual(await files(configHome), before);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(homeDir)), path.resolve(os.tmpdir()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function run(homeDir, args) {
  return execute(process.execPath, [cli, ...args], {
    cwd: homeDir, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, KODAX_HOME: path.join(homeDir, '.kodax'), FORCE_COLOR: '0', KODAX_TRACING: '1' },
  });
}

async function files(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push([`${entry.name}/`, null]);
      for (const [child, hash] of await files(file)) result.push([`${entry.name}/${child}`, hash]);
    }
    else result.push([entry.name, createHash('sha256').update(await readFile(file)).digest('hex')]);
  }
  return result;
}

async function cleanup(homeDir) {
  const configHome = path.join(homeDir, '.kodax');
  let owner;
  try { owner = JSON.parse(await readFile(path.join(configHome, 'runtime/daemon/default/daemon.lock'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { stdout } = await run(homeDir, ['daemon', 'stop', '--home', homeDir, '--json']);
  const result = JSON.parse(stdout);
  assert.ok(result.stopped || result.reason === 'missing', 'The isolated fixture must stop safely');
  if (owner) assert.equal((await waitForRuntimeDaemonShutdown({ configHome, owner })).status, 'succeeded');
}

test('daemon group and every leaf help leave an absent Host and its files untouched', { timeout: 60_000 }, async t => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-bundle-help-absent-'));
  const configHome = path.join(homeDir, '.kodax');
  let passed = false;
  try {
    await mkdir(configHome);
    await writeFile(path.join(configHome, 'config.json'), '{"provider":"help-fixture-not-configured"}\n');
    const before = await files(configHome);
    for (const name of names) for (const flag of ['--help', '-h']) {
      const { stdout } = await run(homeDir, ['daemon', name, '--home', homeDir, flag]);
      assert.match(stdout, new RegExp(`Usage: kodax daemon ${name}`));
      assert.deepEqual(await files(configHome), before, `${name} ${flag} must not create a Host or modify configuration`);
    }
    for (const flag of ['--help', '-h']) {
      const { stdout } = await run(homeDir, ['daemon', flag]);
      assert.match(stdout, /Usage: kodax daemon \[options\] \[command\]/);
      assert.deepEqual(await files(configHome), before);
    }
    passed = true;
  } finally {
    await cleanup(homeDir);
    if (passed) {
      assert.equal(path.dirname(path.resolve(homeDir)), path.resolve(os.tmpdir()));
      await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else t.diagnostic(`Retained isolated fixture: ${homeDir}`);
  }
});

test('daemon help leaves an existing independent Host and its ownership intact', { timeout: 60_000 }, async t => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-bundle-help-live-'));
  const configHome = path.join(homeDir, '.kodax');
  let runtime;
  let owner;
  let passed = false;
  try {
    runtime = await ensureKodaXRuntime({ homeDir, daemonStartupTimeoutMs: 15_000 });
    owner = (await runtime.daemon.inspect()).owner;
    assert.notEqual(owner.pid, process.pid);
    const directory = path.join(configHome, 'runtime/daemon/default');
    const critical = ['daemon.lock', 'daemon.json', 'daemon.token'];
    const hashes = await Promise.all(critical.map(async file => createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex')));
    for (const name of names) for (const flag of ['--help', '-h']) {
      const { stdout } = await run(homeDir, ['daemon', name, '--home', homeDir, flag]);
      assert.match(stdout, new RegExp(`Usage: kodax daemon ${name}`));
      assert.equal((await runtime.daemon.inspect()).runtimeId, owner.runtimeId);
      const after = await Promise.all(critical.map(async file => createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex')));
      assert.deepEqual(after, hashes, `${name} ${flag} must not stop, restart or replace the fixture Host`);
    }
    passed = true;
  } finally {
    const failures = [];
    if (runtime) {
      try { await runtime.daemon.shutdown(); } catch (error) { failures.push(error); }
      try { await runtime.close(); } catch (error) { failures.push(error); }
      if (owner) {
        try { assert.equal((await waitForRuntimeDaemonShutdown({ configHome, owner })).status, 'succeeded'); }
        catch (error) { failures.push(error); }
      }
    }
    try { await cleanup(homeDir); } catch (error) { failures.push(error); }
    if (failures.length) {
      t.diagnostic(`Retained isolated fixture after cleanup failure: ${homeDir}`);
      throw new AggregateError(failures, 'Help fixture cleanup failed');
    }
    if (passed) {
      assert.equal(path.dirname(path.resolve(homeDir)), path.resolve(os.tmpdir()));
      await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else t.diagnostic(`Retained isolated fixture: ${homeDir}`);
  }
});
