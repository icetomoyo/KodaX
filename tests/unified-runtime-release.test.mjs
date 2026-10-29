import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import ts from 'typescript';
import { HISTORICAL_OWNERS, loadHistoricalOwner } from './fixtures/historical-runtime-owner.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('actual npm tarball exposes one Host path and migrates real historical owner policies', { timeout: 240_000 }, async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-unified-package-'));
  const homes = [];
  const consumer = path.join(directory, 'package');
  try {
    const npm = [process.env.npm_execpath,
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      path.join(path.dirname(path.dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js'),
    ].find(candidate => candidate?.endsWith('npm-cli.js') && existsSync(candidate));
    assert.ok(npm, 'Cannot locate npm CLI for actual package verification');
    const packed = await exec(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    const [manifest] = JSON.parse(packed.stdout);
    const tarball = await readFile(path.join(directory, manifest.filename));
    context.diagnostic(`Actual npm tarball SHA-256 ${createHash('sha256').update(tarball).digest('hex')}`);
    await exec('tar', ['-xf', manifest.filename, '-C', '.'], { cwd: directory, windowsHide: true, timeout: 60_000 });
    const pkg = JSON.parse(await readFile(path.join(consumer, 'package.json'), 'utf8'));
    // Use declared, locally installed dependencies offline. The code and public
    // declaration graph under test are exclusively the freshly packed artifact.
    for (const name of [...Object.keys(pkg.dependencies), '@types/node']) {
      const target = path.join(consumer, 'node_modules', name);
      if (existsSync(target)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(path.join(root, 'node_modules', name), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    for (const name of ['probe.mjs', 'contract.mts', 'concurrent.mjs', 'profile-alias.mjs']) {
      await writeFile(path.join(consumer, name), await readFile(path.join(root, 'tests/fixtures/unified-runtime-package', name)));
    }
    const program = ts.createProgram([path.join(consumer, 'contract.mts')], {
      noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: name => name, getCurrentDirectory: () => consumer, getNewLine: () => '\n',
    }));

    for (const snapshot of HISTORICAL_OWNERS) {
      const historical = await loadHistoricalOwner(snapshot, directory);
      const homeDir = path.join(directory, snapshot.version);
      homes.push({ homeDir, profile: 'legacy' });
      const paths = historical.resolveRuntimeDaemonPaths(homeDir, 'legacy');
      const identity = { runtimeId: 'inline_packed_historical', pid: process.pid,
        createdAt: new Date().toISOString(), kind: 'inline' };
      const handle = historical.acquireRuntimeInlineOwner(paths, identity, true);
      assert.equal(historical.releaseRuntimeDaemonOwnership(paths, handle), true);
      try {
        const result = await exec(process.execPath, ['probe.mjs', homeDir], {
          cwd: consumer, windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, KODAX_HOME: path.join(homeDir, '.kodax'), NODE_PATH: '', NODE_OPTIONS: '' },
        });
        assert.match(result.stdout, /PACKED_UNIFIED_HOST_PASSED/);
      } catch (cause) {
        throw new Error(`Packed Host migration from ${snapshot.version} failed: ${cause.stderr || cause.message}`, { cause });
      }
      // The Host has now exited: the old runtime still cannot switch ownership back.
      assert.throws(() => historical.acquireRuntimeInlineOwner(paths, identity, true), /corrupt/i);
      context.diagnostic(`Passed old policy ${snapshot.revision} -> packed Host -> shutdown -> rollback rejection`);

      // Keep bootstrap policy installation separate: simultaneous ordinary
      // launchers must converge, while nonempty administrator bootstrap policy
      // intentionally belongs only to the caller creating a new owner above.
      const concurrentHome = path.join(directory, `${snapshot.version}-concurrent`);
      homes.push({ homeDir: concurrentHome, profile: 'legacy' });
      const concurrentPaths = historical.resolveRuntimeDaemonPaths(concurrentHome, 'legacy');
      const concurrentOwner = historical.acquireRuntimeInlineOwner(concurrentPaths, identity, true);
      assert.equal(historical.releaseRuntimeDaemonOwnership(concurrentPaths, concurrentOwner), true);
      const barrier = path.join(concurrentHome, 'barrier');
      await mkdir(barrier);
      const abort = new AbortController();
      const failures = [];
      const concurrentOptions = { cwd: consumer, windowsHide: true, timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024, signal: abort.signal,
        env: { ...process.env, KODAX_HOME: path.join(concurrentHome, '.kodax'), NODE_PATH: '', NODE_OPTIONS: '' } };
      const callers = ['first', 'second'].map(role => exec(process.execPath,
        ['concurrent.mjs', concurrentHome, barrier, role], concurrentOptions)
        .then(result => ({ result }), error => { failures.push(error); return { error }; }));
      try {
        const deadline = Date.now() + 30_000;
        while (!['first', 'second'].every(role => existsSync(path.join(barrier, `${role}.ready`)))) {
          if (failures.length) throw failures[0];
          assert.ok(Date.now() < deadline, 'Both packed SDK callers must reach the first-start barrier');
          await delay(20);
        }
        await writeFile(path.join(barrier, 'go'), 'start');
        const completed = await Promise.all(callers);
        if (failures.length) throw failures[0];
        const [first, second] = completed.map(entry => JSON.parse(entry.result.stdout.trim().split('\n').at(-1)));
        assert.equal(first.runtimeId, second.runtimeId);
        assert.equal(first.pid, second.pid);
        assert.notEqual(first.sessionId, second.sessionId);
        const verified = await exec(process.execPath, ['concurrent.mjs', concurrentHome, barrier, 'verify'], concurrentOptions);
        const saved = JSON.parse(verified.stdout.trim().split('\n').at(-1));
        assert.equal(saved.runtimeId, first.runtimeId);
        assert.equal(saved.pid, first.pid);
        assert.ok(saved.sessionIds.includes(first.sessionId));
        assert.ok(saved.sessionIds.includes(second.sessionId));
        assert.throws(() => historical.acquireRuntimeInlineOwner(concurrentPaths, identity, true), /corrupt/i);
        context.diagnostic(`Passed concurrent first startup from ${snapshot.version}: two processes, one Host, both Sessions retained`);
      } finally {
        abort.abort();
        await Promise.all(callers);
      }

      const aliasHome = path.join(directory, `${snapshot.version}-alias`);
      homes.push({ homeDir: aliasHome, profile: 'owner' }, { homeDir: aliasHome, profile: 'legacy' });
      const aliasPaths = historical.resolveRuntimeDaemonPaths(aliasHome, 'legacy');
      const aliasOwner = historical.acquireRuntimeInlineOwner(aliasPaths, identity, true);
      assert.equal(historical.releaseRuntimeDaemonOwnership(aliasPaths, aliasOwner), true);
      try {
        const result = await exec(process.execPath, ['profile-alias.mjs', aliasHome], {
          cwd: consumer, windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, KODAX_HOME: path.join(aliasHome, '.kodax'), NODE_PATH: '', NODE_OPTIONS: '' },
        });
        assert.match(result.stdout, /PACKED_PROFILE_ALIAS_CUTOVER_PASSED/);
      } catch (cause) {
        throw new Error(`Packed cross-profile migration from ${snapshot.version} failed: ${cause.stderr || cause.message}`, { cause });
      }
      assert.throws(() => historical.acquireRuntimeInlineOwner(aliasPaths, identity, true), /corrupt/i);
      context.diagnostic(`Passed ${snapshot.version} requested profile B -> live storage owner A -> shutdown -> B rollback rejection`);
    }
  } finally {
    // A timed-out probe may lose its finally block. Stop only this fixture's
    // exact profile through the normal CLI management path before deleting it.
    for (const { homeDir, profile } of homes) {
      if (!existsSync(path.join(homeDir, '.kodax/runtime/daemon', profile, 'daemon.lock'))) continue;
      const result = await exec(process.execPath, ['dist/kodax_cli.js', 'daemon', 'stop', '--home', homeDir, '--profile', profile, '--json'], {
        cwd: consumer, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, KODAX_HOME: path.join(homeDir, '.kodax'), NODE_PATH: '', NODE_OPTIONS: '' },
      });
      const stopped = JSON.parse(result.stdout);
      assert.ok(stopped.stopped || stopped.reason === 'missing', result.stdout);
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
