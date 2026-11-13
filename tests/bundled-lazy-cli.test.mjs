import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

const cli = new URL('../scripts/kodax-bin.cjs', import.meta.url);
const cliFile = (await import('node:url')).fileURLToPath(cli);
// The archive gate reuses these assertions against its extracted standalone executable.
const executable = process.env.KODAX_LAZY_CLI_BINARY ?? process.execPath;
const prefix = process.env.KODAX_LAZY_CLI_BINARY ? [] : [cliFile];
const run = (args, env) => {
  const result = spawnSync(executable, [...prefix, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};

test('bundled optional CLI roots retain populated help and real command parsing', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-lazy-help-'));
  const env = { ...process.env, KODAX_HOME: path.join(home, '.kodax'), KODAX_TRACING: '0' };
  try {
    assert.match(run(['--help'], env), /KodaX/);
    assert.match(run(['mcp', '--help'], env), /list/);
    assert.match(run(['a2a', '--help'], env), /serve/);
    assert.match(run(['a2a', 'serve', '--help'], env), /--port/);
    assert.match(run(['sandbox', '--help'], env), /doctor/);
    assert.match(run(['extensions', '--help'], env), /reload/);
    assert.match(run(['config', 'template', 'core'], env), /provider/);
    assert.equal(run(['extensions', 'list'], env).trim(), '[]');
    assert.match(run(['integrations', 'status'], env), /mcp/);
    assert.match(run(['acp', 'serve', '--help'], env), /stdio ACP server/);
    assert.match(run(['auth', '--help'], env), /login/);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('bundled ACP loads its adapter and initializes the protocol without a model call', { timeout: 90_000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-lazy-acp-'));
  const env = { ...process.env, KODAX_HOME: path.join(home, '.kodax'), KODAX_TRACING: '0' };
  const child = spawn(executable, [...prefix, 'acp', 'serve'], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: t.signal,
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  try {
    const initialized = await Promise.race([
      client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      closed.then(([code]) => { throw new Error(`ACP exited before initialization (${code}): ${stderr}`); }),
    ]);
    assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
    assert.equal(initialized.agentInfo.name, 'kodax-acp-server');
  } finally {
    try { child.stdin.end(); await closed; }
    finally {
      run(['daemon', 'stop'], env);
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test('bundled daemon loads hosted A2A with its configured card and authentication', { timeout: 90_000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-lazy-hosted-a2a-'));
  const configHome = path.join(home, '.kodax');
  const env = { ...process.env, KODAX_HOME: configHome, KODAX_TRACING: '0',
    KODAX_LAZY_A2A_TOKEN: 'local-fixture-only' };
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  try {
    await mkdir(path.join(configHome, 'integrations'), { recursive: true });
    await writeFile(path.join(configHome, 'integrations/a2a.json'), JSON.stringify({
      version: 2, agents: {}, server: {
        execution: { kind: 'runtime-default' },
        published: { name: 'Lazy hosted fixture', description: 'Local artifact smoke', version: '1.0.0',
          skills: [], inputModes: ['text/plain'], outputModes: ['text/plain'] },
        listen: { hostname: '127.0.0.1', port },
        authentication: { type: 'bearer-env', tokenEnv: 'KODAX_LAZY_A2A_TOKEN', principalId: 'fixture' },
        dataDir: path.join(configHome, 'a2a-tasks'),
      },
    }));
    // `daemon start` defaults to a 5s readiness wait, sized for interactive
    // use. On a cold Windows CI runner (this suite runs right after the full
    // build) the first start can need longer, which surfaced as Release flakes
    // (run 42779240164 attempts 1 and 3). Ask for a CI-sized budget; the
    // spawnSync cap in run() stays the outer bound.
    run(['daemon', 'start', '--home', home, '--provider', 'mock-provider',
      '--timeout-ms', '25000'], env);
    const card = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, { signal: t.signal });
    assert.equal(card.status, 200);
    assert.equal((await card.json()).name, 'Lazy hosted fixture');
    const refused = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: 'POST', signal: t.signal, headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture', method: 'SendMessage', params: {} }),
    });
    assert.equal(refused.status, 401);
    await refused.arrayBuffer();
  } finally {
    try { run(['daemon', 'stop', '--home', home], env); }
    finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
