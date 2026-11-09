import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

const cli = new URL('../scripts/kodax-bin.cjs', import.meta.url);
const cliFile = (await import('node:url')).fileURLToPath(cli);
const run = (args, env) => {
  const result = spawnSync(process.execPath, [cliFile, ...args], {
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
    assert.match(run(['a2a', 'serve', '--help'], env), /--profile/);
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
  const child = spawn(process.execPath, [cliFile, 'acp', 'serve'], {
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
      run(['daemon', 'stop', '--profile', 'default'], env);
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
