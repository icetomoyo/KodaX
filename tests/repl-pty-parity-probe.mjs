// Two-branch REPL behavior parity probe. Pure PTY: drives the target repo's
// scripts/kodax-bin.cjs with an identical stub provider and identical
// keystrokes, asserting only the observable REPL contract both branches must
// satisfy. Screen/ANSI artifacts land in a temp dir for side-by-side diffing.
//
// Usage: node tests/repl-pty-parity-probe.mjs [--repo <path>] [--classic-only]
// Requires node-pty + @xterm/headless (+unicode11) in KODAX_ACCEPTANCE_TOOLS.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const selfRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoArg = process.argv.indexOf('--repo');
const targetRepo = repoArg >= 0 ? path.resolve(process.argv[repoArg + 1]) : selfRepo;
const modes = process.argv.includes('--classic-only') ? ['classic'] : ['ink', 'classic'];
// Main-branch only flag (the fixed-Host refactor always runs daemon): put the
// target's classic fallback into daemon mode so its event bridge streams.
const targetExtraArgs = process.argv.includes('--runtime-mode-daemon') ? ['--runtime-mode', 'daemon'] : [];
// Debug: run the target from TypeScript sources through tsx (no dist rebuild).
const sourceEntry = process.argv.includes('--source');

const toolRequire = createRequire(path.join(
  process.env.KODAX_ACCEPTANCE_TOOLS ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json',
));
const pty = toolRequire('node-pty');
const { Terminal } = toolRequire('@xterm/headless');
let Unicode11Addon;
try { ({ Unicode11Addon } = toolRequire('@xterm/addon-unicode11')); }
catch (error) { throw new Error('PTY probe requires @xterm/addon-unicode11 in KODAX_ACCEPTANCE_TOOLS.', { cause: error }); }

const artifacts = await mkdtemp(path.join(os.tmpdir(), 'kodax-repl-parity-'));
const BAR = String.fromCharCode(10);
const label = path.basename(targetRepo) + '-' + targetRepo.slice(-6).replace(/[^\w]/g, '');
const results = [];
process.stdout.write(`Target repo: ${targetRepo}\nArtifacts: ${artifacts}\n`);

async function waitFor(stamp, predicate, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`Timed out: ${stamp}${lastError ? ` (last: ${lastError.message})` : ''}`);
}

function openTerminal(homeDir, mode, extraArgs = []) {
  const terminal = new Terminal({ cols: 110, rows: 32, scrollback: 10000, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'NO_COLOR'));
  const bootstrap = sourceEntry ? ['--require', path.join(targetRepo, 'scripts/production-env.cjs'),
    '--import', pathToFileURL(path.join(targetRepo, 'node_modules/tsx/dist/loader.mjs')).href,
    path.join(targetRepo, 'src/kodax_bootstrap.ts')] : [path.join(targetRepo, 'scripts/kodax-bin.cjs')];
  const child = pty.spawn(process.execPath, [...bootstrap,
    ...targetExtraArgs,
    '--provider', 'parity-local', '--model', 'parity-model', '--effort', 'off',
    '--agent-mode', 'sa', '--max-iter', '7', ...extraArgs], {
    name: 'xterm-256color', cols: 110, rows: 32, cwd: homeDir,
    env: { ...environment, HOME: homeDir, USERPROFILE: homeDir, KODAX_HOME: path.join(homeDir, '.kodax'),
      KODAX_ACCEPTANCE_KEY: 'local-fixture-only', KODAX_TRACING: '0',
      KODAX_FORCE_INK: '0', KODAX_TUI_RENDERER: 'owned',
      KODAX_FORCE_CLASSIC_REPL: mode === 'classic' ? '1' : '0',
      TERM: 'xterm-256color', CI: 'false', CONTINUOUS_INTEGRATION: 'false', FORCE_COLOR: '1' },
  });
  let raw = '';
  let exited;
  const exit = new Promise(resolve => child.onExit(value => { exited = value; resolve(value); }));
  child.onData(data => { raw += data; terminal.write(data); });
  terminal.onData(data => child.write(data));
  return {
    async resize(columns, rows) { terminal.resize(columns, rows); child.resize(columns, rows); await delay(400); },
    child, exit, get exited() { return exited; },
    cursorLine() {
      const buffer = terminal.buffer.active;
      return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
    },
    screen() {
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminal.rows }, (_, i) =>
        buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '').join('\n');
    },
    async save(name) {
      await writeFile(path.join(artifacts, `${label}-${mode}-${name}.ansi`), raw);
      await writeFile(path.join(artifacts, `${label}-${mode}-${name}.txt`), this.screen());
    },
    async type(text) { child.write(text); await delay(150); },
    async submit(text) { await this.type(text); child.write('\r'); },
    dispose() { child.kill(); },
  };
}

function lastUserText(messages) {
  const last = messages.filter(message => message.role === 'user').at(-1);
  return typeof last?.content === 'string' ? last.content
    : last?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

function received(state, token) {
  return state.requests.filter(request =>
    lastUserText(request.messages).match(/(ACCEPT_[A-Z_]+)/)?.[1] === token);
}

function respondWithQuestion(response) {
  response.end(`data: ${JSON.stringify({ id: 'parity-question', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'parity-question', type: 'function',
      function: { name: 'ask_user_question', arguments: JSON.stringify({
        question: 'Which acceptance option?', options: [
          { label: 'Alpha', value: 'alpha' }, { label: 'Beta', value: 'beta' },
        ], allow_custom_input: false,
      }) },
    }] }, finish_reason: 'tool_calls' }],
  })}\n\ndata: [DONE]\n\n`);
}

async function respondToModelRequest(state, request, response) {
  let body = '';
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body);
  state.requests.push(data);
  if (lastUserText(data.messages) === 'ping') state.probeRequests += 1;
  const token = lastUserText(data.messages).match(/(ACCEPT_[A-Z_]+)/)?.[1] ?? 'AUXILIARY';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = content => response.write(`data: ${JSON.stringify({
    id: 'parity', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`);
  const finish = () => {
    send(` END_${token}`);
    response.end(`data: ${JSON.stringify({ id: 'parity', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    })}\n\ndata: [DONE]\n\n`);
  };
  if (token === 'ACCEPT_QUESTION' && data.messages.at(-1).role !== 'tool') {
    respondWithQuestion(response);
    return;
  }
  if ((token.includes('HOLD') || token === 'ACCEPT_HOLD_QUEUE' || token === 'ACCEPT_HOLD_STOP') && data.messages.at(-1).role !== 'tool') {
    send(`BEGIN_${token}`);
    state.pending.set(token, finish);
    return;
  }
  if (token === 'AUXILIARY' && data.messages.at(-1).role === 'user') {
    send('AUX_RECEIVED');
    setTimeout(finish, 200);
    return;
  }
  setTimeout(finish, 350);
}

async function setupProvider(state) {
  state.server = createServer((request, response) => {
    respondToModelRequest(state, request, response).catch(error => {
      state.providerErrors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  state.server.listen(0, '127.0.0.1');
  await once(state.server, 'listening');
  await mkdir(path.join(state.homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(state.homeDir, '.kodax', 'config.json'), JSON.stringify({
    provider: 'parity-local', customProviders: [{
      name: 'parity-local', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${state.server.address().port}/v1`,
      apiKeyEnv: 'KODAX_ACCEPTANCE_KEY', model: 'parity-model',
      contextWindow: 65536, maxOutputTokens: 1024,
    }],
  }));
}

async function inkReady(state) {
  return /^>\s+Type a message/m.test(state.terminal.screen());
}

async function promptReady(state, timeout = 30_000) {
  if (state.mode === 'classic') {
    await waitFor('readline prompt ready', () => /^kodax:.*>\s*$/.test(state.terminal.cursorLine()), timeout);
  } else {
    await waitFor('Ink prompt ready', () => inkReady(state), timeout);
    await delay(400);
  }
}

async function scenario(state, name, action) {
  try {
    await action(state);
    if (!state.terminal.exited) await promptReady(state);
    assert.deepEqual(state.providerErrors, [], 'Fixture provider must handle every request');
    await state.terminal.save(name);
    results.push({ mode: state.mode, name, status: 'passed' });
    process.stdout.write(`PASS ${state.mode}: ${name}\n`);
  } catch (error) {
    results.push({ mode: state.mode, name, status: 'failed', error: String(error.message ?? error) });
    process.stdout.write(`FAIL ${state.mode}: ${name} — ${error.message}\n`);
    try { await state.terminal.save(name); } catch { /* artifact best-effort */ }
    throw Object.assign(new Error(`Scenario ${state.mode}/${name} failed`), { cause: error });
  } finally {
    await writeFile(path.join(artifacts, `${label}-${state.mode}-requests.json`),
      JSON.stringify(state.requests.map(request => ({
        lastUser: lastUserText(request.messages).slice(0, 120),
        messages: request.messages.length,
      })), null, 2)).catch(() => { /* best-effort */ });
  }
}

const scenarios = {
  async startup(state) {
    await waitFor('provider visible on screen', () => state.terminal.screen().includes('parity-local'), 45_000);
    await promptReady(state);
  },
  async prompt(state) {
    await state.terminal.submit('ACCEPT_HELLO');
    await waitFor('model received prompt', () => received(state, 'ACCEPT_HELLO').length === 1);
    await waitFor('terminal final reply', () => state.terminal.screen().includes('END_ACCEPT_HELLO'));
    if (state.mode === 'ink') {
      const rows = state.terminal.screen().split(BAR).filter(line => line.trim() === 'END_ACCEPT_HELLO');
      assert.equal(rows.length, 1, `The completed reply must render exactly once (got ${rows.length})`);
    }
  },
  async 'slash-help'(state) {
    await state.terminal.submit('/help');
    // /help overflows one screen; anchor on sections that stay visible on both branches.
    await waitFor('help lists mcp', () => state.terminal.screen().includes('/mcp'));
    await waitFor('help footer reached', () => state.terminal.screen().includes('Tip:'));
  },
  async 'slash-status'(state) {
    await state.terminal.submit('/status');
    await delay(1200);
  },
  async 'provider-probe'(state) {
    await state.terminal.submit('/provider probe');
    await waitFor('probe output rendered', () => state.terminal.screen().includes('rejections recorded'));
    await waitFor('three effort probes reached the provider', () => state.probeRequests >= 3);
  },
  async question(state) {
    await state.terminal.submit('ACCEPT_QUESTION');
    await waitFor('terminal question dialog', () => state.terminal.screen().includes('Which acceptance option?'));
    if (state.mode === 'ink') {
      await state.terminal.type('\x1b[B');
      await state.terminal.type('\r');
    } else {
      await waitFor('classic choice prompt', () => state.terminal.screen().toLowerCase().includes('choice'), 8_000)
        .catch(() => process.stdout.write('NOTE classic: no "choice" prompt text matched; answering 2 blindly\n'));
      await state.terminal.submit('2');
    }
    await waitFor('question answer response', () => state.terminal.screen().includes('END_ACCEPT_QUESTION'));
    const answer = received(state, 'ACCEPT_QUESTION').at(-1).messages.filter(message => message.role === 'tool').at(-1);
    assert.ok(answer?.content.includes('beta'), 'Keyboard selection must return Beta to the model');
  },
  async queue(state) {
    assert.equal(state.mode, 'ink');
    await state.terminal.submit('ACCEPT_HOLD_QUEUE');
    await waitFor('stream visible before completion', () => {
      const screen = state.terminal.screen();
      // Ours streams partial text live; main may only show the busy queue placeholder.
      return screen.includes('BEGIN_ACCEPT_HOLD_QUEUE') || screen.includes('Queue a follow-up');
    });
    await state.terminal.submit('ACCEPT_WITHDRAW');
    await delay(2500); // Indicator capture window; wording is compared via artifacts.
    await state.terminal.type('\x1b[A'); // Recall the queued input into the editor.
    await waitFor('recalled text in editor', () => /^>.*ACCEPT_WITHDRAW/m.test(state.terminal.screen()));
    await delay(2000); // Let the withdraw roundtrip settle before ending the turn.
    state.pending.get('ACCEPT_HOLD_QUEUE')();
    await delay(800);
    await state.terminal.type('\x05'); // Ctrl+E: end of the recalled draft.
    await state.terminal.type('_EDITED');
    await state.terminal.submit('');
    await waitFor('edited input executed', () => state.terminal.screen().includes('END_ACCEPT_WITHDRAW_EDITED'), 40_000);
    await delay(1500);
    const rows = state.terminal.screen().split(BAR).filter(line => line.trim() === 'END_ACCEPT_WITHDRAW_EDITED');
    assert.equal(rows.length, 1, `The queued-round reply must render exactly once (got ${rows.length})`);
    assert.equal(received(state, 'ACCEPT_WITHDRAW').length, 0, 'Withdrawn original must never execute');
  },
  async stop(state) {
    await state.terminal.submit('ACCEPT_HOLD_STOP');
    await waitFor('stop target stream', () => {
      const screen = state.terminal.screen();
      return screen.includes('BEGIN_ACCEPT_HOLD_STOP') || screen.includes('Queue a follow-up');
    });
    await state.terminal.type('\x03');
    await promptReady(state, 40_000).catch(() => {
      process.stdout.write('NOTE stop: prompt-ready wait timed out; asserting via next round\n');
    });
    await state.terminal.submit('ACCEPT_AFTER_STOP');
    await waitFor('next prompt after stop', () => state.terminal.screen().includes('END_ACCEPT_AFTER_STOP'), 40_000);
    assert.equal(received(state, 'ACCEPT_AFTER_STOP').length, 1);
  },
  async exit(state) {
    await state.terminal.submit('/exit');
    await waitFor('CLI exit', () => state.terminal.exited);
    assert.equal(state.terminal.exited.exitCode, 0);
  },
  async resume(state) {
    state.terminal.dispose();
    state.terminal = openTerminal(state.homeDir, state.mode, ['-c']);
    await waitFor('resumed terminal ready', () => state.terminal.screen().includes('parity-local'), 45_000);
    await promptReady(state);
    await state.terminal.submit('ACCEPT_RESUMED');
    await waitFor('resumed response', () => state.terminal.screen().includes('END_ACCEPT_RESUMED'));
    const request = received(state, 'ACCEPT_RESUMED')[0];
    assert.ok(JSON.stringify(request.messages).includes('ACCEPT_HELLO'), 'Resume must retain prior conversation');
    assert.ok(!JSON.stringify(request.messages).includes('ACCEPT_FRESH'), 'Old session must exclude foreign history');
  },
};

async function run(mode) {
  const state = { mode, homeDir: path.join(artifacts, `${label}-${mode}`), requests: [], pending: new Map(), providerErrors: [], probeRequests: 0 };
  await mkdir(state.homeDir, { recursive: true });
  await setupProvider(state);
  // The question dialog runs last: a Host without askUser callbacks fails it
  // without blocking the independent scenarios ahead of it.
  const order = mode === 'ink'
    ? ['startup', 'prompt', 'slash-help', 'slash-status', 'provider-probe', 'queue', 'stop', 'exit', 'resume', 'question']
    : ['startup', 'prompt', 'slash-help', 'slash-status', 'provider-probe', 'stop', 'exit', 'resume', 'question'];
  try {
    state.terminal = openTerminal(state.homeDir, mode);
    for (const name of order) await scenario(state, name, scenarios[name]);
  } finally {
    if (state.terminal && !state.terminal.exited) state.terminal.dispose();
    state.pending.forEach(finish => { try { finish(); } catch { /* stream already closed */ } });
    state.server.close();
  }
}

let failures = 0;
for (const mode of modes) {
  try { await run(mode); }
  catch { failures += 1; }
}
process.stdout.write(`\n=== ${label} summary (${targetRepo}) ===\n`);
for (const entry of results) {
  process.stdout.write(`${entry.status === 'passed' ? 'PASS' : 'FAIL'} ${entry.mode}/${entry.name}${entry.error ? ` — ${entry.error}` : ''}\n`);
}
process.exit(failures > 0 ? 1 : 0);
