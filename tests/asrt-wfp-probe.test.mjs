import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Resolve through the SDK in cwd, so the same test also exercises a freshly
// installed tarball without reaching back into this repository's dependencies.
const consumerRequire = createRequire(path.resolve('package.json'));
const sdkRequire = createRequire(consumerRequire.resolve('@kodax-ai/kodax/package.json'));
const { SandboxManager, verifyWindowsWfpEgress } = await import(pathToFileURL(
  sdkRequire.resolve('@anthropic-ai/sandbox-runtime'),
).href);

test('SDK ASRT avoids repeated in-range ephemeral allocations and retains its probe listener', async (t) => {
  const originalListen = Server.prototype.listen;
  const originalAddress = Server.prototype.address;
  const listeners = new Set();
  const ephemeral = new Set();
  t.mock.method(Server.prototype, 'listen', function (...args) {
    listeners.add(this);
    if (args[0] === 0) ephemeral.add(this);
    return Reflect.apply(originalListen, this, args);
  });
  t.mock.method(Server.prototype, 'address', function () {
    return ephemeral.has(this)
      ? { address: '127.0.0.1', family: 'IPv4', port: 60080 }
      : originalAddress.call(this);
  });
  let probes = 0;
  t.mock.method(childProcess, 'spawnSync', (_exe, args) => {
    probes += 1;
    assert.deepEqual(args.slice(0, 3), ['wfp', 'verify', '--target']);
    const target = args[3];
    assert.ok([...listeners].some((server) => server.listening
      && originalAddress.call(server)?.port === Number(target.split(':')[1])));
    return { status: 0, stdout: JSON.stringify({ egress_probe: 'blocked', target }), stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const server of listeners) if (server.listening) server.close();
  });

  await verifyWindowsWfpEgress({
    proxyPortRange: [60080, 60143],
    srtWin: { exe: process.execPath, prependArgs: [] },
  });
  assert.equal(probes, 1);
  assert.equal(ephemeral.size, 0);
  assert.ok([...listeners].every((server) => !server.listening));
});

for (const [code, failures, succeeds] of [
  ['EADDRINUSE', 1, true], ['EACCES', 1, true], ['EADDRINUSE', 5, false], ['EMFILE', 1, false],
]) {
  test(`ASRT handles ${failures} ${code} bindings with bounded distinct candidates`, async (t) => {
    const originalListen = Server.prototype.listen;
    const ports = [];
    t.mock.method(Server.prototype, 'listen', function (...args) {
      ports.push(args[0]);
      if (ports.length <= failures) {
        queueMicrotask(() => this.emit('error', Object.assign(new Error(code), { code })));
        return this;
      }
      return Reflect.apply(originalListen, this, args);
    });
    t.mock.method(childProcess, 'spawnSync', (_exe, args) => ({
      status: 0, stdout: JSON.stringify({ egress_probe: 'blocked', target: args[3] }),
    }));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const verification = verifyWindowsWfpEgress({
      proxyPortRange: [60080, 60143], srtWin: { exe: process.execPath, prependArgs: [] },
    });
    if (succeeds) await verification;
    else await assert.rejects(verification, code === 'EMFILE' ? /EMFILE/ : /in 5 attempts/);
    assert.equal(ports.length, failures + Number(succeeds));
    assert.equal(new Set(ports).size, ports.length);
    assert.ok(ports.every((port) => port >= 1024 && (port < 60080 || port > 60143)));
  });
}

test('ASRT concurrent verifications hold independent listeners without occupying proxy ports', async (t) => {
  const originalListen = Server.prototype.listen;
  const listeners = [];
  t.mock.method(Server.prototype, 'listen', function (...args) {
    assert.ok(args[0] >= 1024 && (args[0] < 60080 || args[0] > 60143));
    listeners.push(this);
    return Reflect.apply(originalListen, this, args);
  });
  let maximumLive = 0;
  t.mock.method(childProcess, 'spawnSync', (_exe, args) => {
    maximumLive = Math.max(maximumLive, listeners.filter((server) => server.listening).length);
    return { status: 0, stdout: JSON.stringify({ egress_probe: 'blocked', target: args[3] }) };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await Promise.all(Array.from({ length: 16 }, () => verifyWindowsWfpEgress({
    proxyPortRange: [60080, 60143], srtWin: { exe: process.execPath, prependArgs: [] },
  })));
  assert.ok(maximumLive > 1);
  assert.ok(listeners.every((server) => !server.listening));
});

test('ASRT initialization reaches native verification outside the permit range and fails closed', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const originalListen = Server.prototype.listen;
  const ports = [];
  const listeners = [];
  t.mock.method(Server.prototype, 'listen', function (...args) {
    ports.push(args[0]);
    listeners.push(this);
    assert.ok(args[0] >= 1024 && (args[0] < 60080 || args[0] > 60143));
    return Reflect.apply(originalListen, this, args);
  });
  let verified = false;
  t.mock.method(childProcess, 'spawnSync', (_exe, argv) => {
    const args = argv.filter((arg) => arg !== '--srt-win');
    if (args[0] === 'user') {
      assert.equal(args[1], 'status');
      return { status: 0, stdout: JSON.stringify({ user: { exists: true }, cred_present: true }) };
    }
    if (args[1] === 'status') {
      return { status: 0, stdout: JSON.stringify({ state: 'installed', filters: 3 }) };
    }
    assert.deepEqual(args.slice(0, 3), ['wfp', 'verify', '--target']);
    verified = true;
    assert.ok(listeners.some((server) => server.listening));
    return { status: 3, stdout: JSON.stringify({ egress_probe: 'connected', target: args[3] }) };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [], parentProxy: false },
    filesystem: { disabled: true, allowWrite: [], denyRead: [], denyWrite: [] },
    windows: { proxyPortRange: [60080, 60143], srtWin: { path: process.execPath } },
  }), /WFP egress fence is not active/);
  assert.equal(verified, true);
  assert.equal(ports.length, 1);
  assert.ok(listeners.every((server) => !server.listening));
});
