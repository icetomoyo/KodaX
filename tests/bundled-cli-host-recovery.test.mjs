import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connectKodaXRuntime } from '../dist/sdk-runtime.js';
import { ensureKodaXClient } from '../dist/sdk-client.js';

const cli = fileURLToPath(new URL('../dist/kodax_cli.js', import.meta.url));
const prompt = 'RECOVERY_CONSTRAINT_322: Keep protected.txt unchanged. Append RECEIPT_322 once to marker.txt, then return JSON only with status and receipt. Never repeat the append.';
async function until(label, read, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(75); }
  throw new Error(`Timed out: ${label}`);
}
function finish(response, delta, reason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'recovery', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
}

// PTY variants run explicitly on developer/acceptance machines with the same
// external terminal dependencies as repl-pty-acceptance.mjs.
const modes = process.env.KODAX_RECOVERY_PTY === '1' ? ['print', 'scoped', 'ink', 'classic'] : ['print', 'scoped'];
for (const mode of modes) test(`bundled ${mode} automatically continues its original Run after Host death`, { timeout: 120_000 }, async t => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-generation-'));
  const configHome = path.join(homeDir, '.kodax');
  const daemonFile = path.join(configHome, 'runtime/daemon/default/daemon.json');
  let providerReady = false;
  let toolIssued = false;
  const resumedRequests = [];
  let child, terminal, observer, product;
  let childExited = false;
  const authorities = [];
  const observedKeys = [];
  let output = '';
  let exit;
  const promptReady = () => {
    const buffer = terminal.buffer.active;
    if (mode === 'classic') return /kodax:.*>\s*$/.test(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '');
    const screen = Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '').join('\n');
    return /^>\s+Type a message/m.test(screen);
  };
  const env = { ...process.env, KODAX_HOME: configHome, KODAX_RECOVERY_TEST_KEY: 'local-test-only',
    KODAX_TRACING: '0', KODAX_FORCE_CLASSIC_REPL: mode === 'classic' ? '1' : '0',
    KODAX_FORCE_INK: '0', KODAX_TUI_RENDERER: 'owned', CI: 'false', CONTINUOUS_INTEGRATION: 'false' };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    observedKeys.push(request.headers.authorization);
    const parsed = JSON.parse(body);
    if (!toolIssued) {
      toolIssued = true;
      finish(response, { tool_calls: [{ index: 0, id: 'append-once', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: 'echo RECEIPT_322 >> marker.txt && echo RECEIPT_322' }),
      } }] }, 'tool_calls');
    } else if (!providerReady && !parsed.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'summary', choices: [{ message: { role: 'assistant', content:
        'RECOVERY_CONSTRAINT_322: Keep protected.txt unchanged. RECEIPT_322 append is complete. Do not repeat tools. Return JSON only.' }, finish_reason: 'stop' }] }));
    } else if (!providerReady) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'context_length_exceeded: maximum context length exceeded', code: 'context_length_exceeded' } }));
    } else {
      resumedRequests.push(parsed);
      finish(response, { content: '{"status":"completed","receipt":"RECEIPT_322"}' });
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await mkdir(configHome, { recursive: true });
    await writeFile(path.join(homeDir, 'protected.txt'), 'KEEP_EXACTLY');
    await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ provider: 'recovery-local', model: 'fixture',
      permissionMode: 'full-access', agentMode: 'sa', customProviders: [{ name: 'recovery-local', protocol: 'openai',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: mode === 'scoped' ? 'KODAX_RECOVERY_UNSET_KEY' : 'KODAX_RECOVERY_TEST_KEY', model: 'fixture',
        contextWindow: 32768, maxOutputTokens: 1024 }] }));
    const args = [cli, '--provider', 'recovery-local', '--agent-mode', 'sa', '--effort', 'off'];
    if (mode === 'scoped') {
      product = await ensureKodaXClient({ homeDir, authorizeExecution: async (request, host) => {
        const key = `fixture-lease-${authorities.length + 1}`;
        const lease = await host.credentials.registerScoped({ providers: ['recovery-local'] }, async () => key);
        authorities.push({ kind: request.kind, lease: lease.id, runtime: host.identity.runtimeId });
        return { credential: { leaseId: lease.id, mode: 'scoped', providers: ['recovery-local'] } };
      } });
      const session = await product.sessions.create({ projectPath: homeDir });
      await product.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access', provider: 'recovery-local' });
      const accepted = await product.inputs.submit({ sessionId: session.id, inputId: 'original-input', text: prompt });
      exit = product.runs.await(accepted.runId);
      // Keep rejection handled while the test observes the checkpoint.
      void exit.catch(() => {});
    } else if (mode === 'print') {
      child = spawn(process.execPath, [...args, '-p', prompt], { cwd: homeDir, env, windowsHide: true });
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      exit = once(child, 'exit');
      child.on('exit', () => { childExited = true; });
    } else {
      const require = createRequire(path.join(process.env.KODAX_ACCEPTANCE_TOOLS ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json'));
      const { Terminal } = require('@xterm/headless');
      terminal = new Terminal({ cols: 110, rows: 32, scrollback: 5000, allowProposedApi: true });
      const { Unicode11Addon } = require('@xterm/addon-unicode11');
      terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
      child = require('node-pty').spawn(process.execPath, args, { cwd: homeDir, env, cols: 110, rows: 32, name: 'xterm-256color' });
      child.onData(data => { output += data; terminal.write(data); });
      child.onExit(() => { childExited = true; });
      terminal.onData(data => child.write(data));
    }
    const descriptor = await until('initial Host', async () => {
      try { return JSON.parse(await readFile(daemonFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
    observer = await connectKodaXRuntime({ homeDir, endpoint: descriptor.endpoint });
    if (mode === 'ink' || mode === 'classic') {
      await until('REPL ready', promptReady);
      child.write(prompt); await delay(200); child.write('\r');
    }
    const run = await until('durable checkpoint', async () => {
      const runs = await observer.runs.list({});
      for (const item of runs) {
        const status = await observer.runs.get(item.runId);
        if (status.phase === 'failed') throw new Error(JSON.stringify({ status, session: await observer.sessions.transcript(status.sessionId) }));
        if (status.phase === 'recovering' && status.contextRecovery?.checkpoint) return status;
      }
    });
    const before = await observer.sessions.transcript(run.sessionId);
    assert.match(JSON.stringify(before), /RECOVERY_CONSTRAINT_322/);
    assert.equal((await readFile(path.join(homeDir, 'marker.txt'), 'utf8')).trim(), 'RECEIPT_322');
    await observer.close(); observer = undefined;
    providerReady = true;
    process.kill(descriptor.pid, 'SIGKILL');
    const replacement = await until('automatic Host replacement', async () => {
      try { const value = JSON.parse(await readFile(daemonFile, 'utf8')); return value.runtimeId !== descriptor.runtimeId && value; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
    observer = await connectKodaXRuntime({ homeDir, endpoint: replacement.endpoint });
    const completed = await until('original Run completion', async () => {
      const status = await observer.runs.get(run.runId); return status.phase === 'completed' && status;
    });
    assert.equal(completed.runId, run.runId);
    assert.equal(resumedRequests.length, 1);
    assert.match(JSON.stringify(resumedRequests[0]), /RECOVERY_CONSTRAINT_322/);
    assert.ok(resumedRequests[0].messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('RECEIPT_322')));
    assert.equal((await readFile(path.join(homeDir, 'marker.txt'), 'utf8')).trim(), 'RECEIPT_322');
    assert.equal(await readFile(path.join(homeDir, 'protected.txt'), 'utf8'), 'KEEP_EXACTLY');
    const after = await observer.sessions.transcript(run.sessionId);
    assert.deepEqual(after.activeMessages.slice(0, before.activeMessages.length), before.activeMessages);
    assert.equal(after.activeMessages.filter(message => message.content === prompt).length, 1);
    assert.equal((await observer.runs.list({ sessionId: run.sessionId })).length, 1);
    if (mode === 'scoped') {
      assert.equal((await exit).phase, 'completed');
      assert.deepEqual(authorities.map(value => value.kind), ['input', 'recovery']);
      assert.notEqual(authorities[0].runtime, authorities[1].runtime);
      assert.notEqual(authorities[0].lease, authorities[1].lease);
      assert.equal(observedKeys.at(-1), 'Bearer fixture-lease-2');
    } else if (mode === 'print') { const [code] = await exit; assert.equal(code, 0, output); }
    else {
      await until('REPL displays resumed answer', () => output.includes('completed'));
      await until('REPL prompt ready after recovery', promptReady);
      await delay(300);
      child.write('/exit'); await delay(200); child.write('\r');
      await until('REPL exits cleanly', () => childExited, 10_000);
    }
  } catch (error) {
    t.diagnostic(output.slice(-6000));
    if (terminal) t.diagnostic(`Cursor: ${terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)?.translateToString(true)}`);
    for (const file of await readdir(path.join(configHome, 'runtime'), { recursive: true })) {
      if (String(file).endsWith('.jsonl') || String(file).endsWith('.log')) t.diagnostic((await readFile(path.join(configHome, 'runtime', file), 'utf8')).slice(-6000));
    }
    throw error;
  }
  finally {
    if (child && !childExited) child.kill();
    terminal?.dispose(); await product?.disconnect(); await observer?.close();
    execFileSync(process.execPath, [cli, 'daemon', 'stop', '--json'], { env, windowsHide: true, timeout: 20_000 });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(homeDir), path.resolve(os.tmpdir()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
