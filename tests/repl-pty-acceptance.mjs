import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectKodaXClient } from '../dist/sdk-client.js';

// Keep native terminal drivers outside the product dependency graph.
const toolRequire = createRequire(path.join(
  process.env.KODAX_ACCEPTANCE_TOOLS ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json',
));
const pty = toolRequire('node-pty');
const { Terminal } = toolRequire('@xterm/headless');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'kodax-repl-acceptance-'));
const results = [];
process.stdout.write(`Artifacts: ${artifacts}\n`);

async function waitFor(label, predicate, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function openTerminal(homeDir, mode, extraArgs = []) {
  const terminal = new Terminal({ cols: 110, rows: 32, scrollback: 10000, allowProposedApi: true });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'NO_COLOR'));
  const child = pty.spawn(process.execPath, [path.join(repo, 'scripts/kodax-bin.cjs'),
    '--provider', 'acceptance-local', '--model', 'acceptance-model', '--effort', 'off',
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
  // Answer terminal cursor/device queries through an actual terminal emulator.
  terminal.onData(data => child.write(data));
  return {
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
      await writeFile(path.join(artifacts, `${mode}-${name}.ansi`), raw);
      await writeFile(path.join(artifacts, `${mode}-${name}.txt`), this.screen());
    },
    async type(text) { child.write(text); await delay(150); },
    async submit(text) { await this.type(text); child.write('\r'); },
    dispose() { if (!exited) child.kill(); terminal.dispose(); },
  };
}

function lastUserText(messages) {
  const last = messages.filter(message => message.role === 'user').at(-1);
  return typeof last?.content === 'string' ? last.content
    : last?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

function respondWithQuestion(response) {
  response.end(`data: ${JSON.stringify({ id: 'acceptance-question', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'acceptance-question', type: 'function',
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
  const token = lastUserText(data.messages).match(/^ACCEPT_[A-Z_]+/)?.[0] ?? 'AUXILIARY';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (token === 'ACCEPT_QUESTION' && data.messages.at(-1).role !== 'tool') {
    respondWithQuestion(response);
    return;
  }
  const send = content => response.write(`data: ${JSON.stringify({
    id: 'acceptance', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`);
  const finish = () => {
    send(` END_${token}`);
    response.end(`data: ${JSON.stringify({ id: 'acceptance', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    })}\n\ndata: [DONE]\n\n`);
  };
  send(`BEGIN_${token}`);
  if (token.includes('HOLD')) state.pending.set(token, finish);
  else setTimeout(finish, 350);
}

async function setupProvider(state) {
  state.server = createServer((request, response) => {
    respondToModelRequest(state, request, response).catch(error => {
      state.providerErrors.push(String(error));
      process.stderr.write(`Fixture provider failed: ${String(error)}\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  state.server.listen(0, '127.0.0.1');
  await once(state.server, 'listening');
  await mkdir(path.join(state.homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(state.homeDir, '.kodax', 'config.json'), JSON.stringify({
    provider: 'acceptance-local', customProviders: [{
      name: 'acceptance-local', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${state.server.address().port}/v1`,
      apiKeyEnv: 'KODAX_ACCEPTANCE_KEY', model: 'acceptance-model',
      contextWindow: 65536, maxOutputTokens: 1024,
    }],
  }));
}

function received(state, token) {
  return state.requests.filter(request => lastUserText(request.messages).startsWith(token));
}

async function observeSession(state, sessionId) {
  state.observation?.close();
  state.sessionId = sessionId;
  state.view = undefined;
  state.observation = await state.client.sessions.observe(sessionId, next => {
    state.view = next;
    state.views.set(sessionId, next);
    state.runEvents.push({ observedAt: new Date().toISOString(), sessionId,
      runs: next.runs, activity: next.activity, queue: next.queue, interactions: next.interactions });
  });
  await waitFor('initial Host view', () => state.view);
}

async function saveFacts(state, name) {
  const runs = [];
  for (const view of state.views.values()) {
    for (const run of view.runs) {
      try { runs.push(await state.client.runs.read(run.runId)); }
      catch (error) { runs.push({ runId: run.runId, readError: String(error) }); }
    }
  }
  await writeFile(path.join(artifacts, `${state.mode}-${name}-host.json`), JSON.stringify({
    sessionId: state.sessionId, originalSessionId: state.originalSessionId,
    views: Object.fromEntries(state.views), runs, runEvents: state.runEvents,
    providerErrors: state.providerErrors,
  }, null, 2));
}

async function check(state, name, action) {
  state.checkName = name;
  await action(state);
  if (state.view) await waitFor('Host run settlement', () =>
    state.view.runs.every(run => !['accepted', 'queued', 'running'].includes(run.phase)));
  if (state.mode === 'classic' && !state.terminal.exited) {
    await waitFor('readline prompt ready', () => /^kodax:.*>\s*$/.test(state.terminal.cursorLine()));
  } else if (!state.terminal.exited) {
    await waitFor('Ink prompt ready', () => /^>\s+Type a message/m.test(state.terminal.screen()));
    await delay(300); // Host settlement and the CLI's awaiting input handler render on separate turns.
  }
  assert.deepEqual(state.providerErrors, [], 'Fixture provider must handle every request successfully');
  await state.terminal.save(name);
  await saveFacts(state, name);
  results.push({ mode: state.mode, name, status: 'passed' });
  process.stdout.write(`PASS ${state.mode}: ${name}\n`);
}

async function checkStartup(state) {
  await waitFor('interactive ready', () => /acceptance-local|acceptance-model/.test(state.terminal.screen()), 45_000);
  state.client = await waitFor('Host connection', async () => {
    try { return await connectKodaXClient({ homeDir: state.homeDir }); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error;
      return undefined; // The banner may precede the socket opening.
    }
  });
  await waitFor('cold-start Host session', async () => (await state.client.sessions.list()).length === 1);
  const [session] = await state.client.sessions.list();
  state.originalSessionId = session.id;
  await observeSession(state, session.id);
  await delay(1000);
  await assertSelectedSettings(state);
}

async function assertSelectedSettings(state) {
  const settings = await state.client.sessions.getSettings(state.sessionId);
  assert.equal(settings.provider, 'acceptance-local');
  assert.equal(settings.model, 'acceptance-model');
  assert.equal(settings.agentMode, 'sa');
  assert.equal(settings.thinking, false);
  assert.equal(settings.permissionMode, 'accept-edits');
  assert.equal(settings.maxIter, 7);
}

async function checkSettings(state) {
  for (const [command, field, expected] of [
    ['/agent-mode ama', 'agentMode', 'ama'], ['/agent-mode sa', 'agentMode', 'sa'],
    ['/mode plan', 'permissionMode', 'plan'], ['/mode accept-edits', 'permissionMode', 'accept-edits'],
  ]) {
    await state.terminal.submit(command);
    await waitFor(`${command} updates Host`, async () =>
      (await state.client.sessions.getSettings(state.sessionId))[field] === expected);
  }
  await state.client.sessions.updateSettings(state.sessionId, { model: 'another-client-model' });
  await state.terminal.submit('/model /acceptance-model');
  await waitFor('explicit old model selection reaches Host', async () =>
    (await state.client.sessions.getSettings(state.sessionId)).model === 'acceptance-model');
  await assertSelectedSettings(state);
}

async function checkPrompt(state) {
  await state.terminal.submit('ACCEPT_HELLO');
  await waitFor('model received prompt', () => received(state, 'ACCEPT_HELLO').length === 1);
  await waitFor('terminal final reply', () => state.terminal.screen().includes('END_ACCEPT_HELLO'));
  assert.equal((await state.client.sessions.list()).length, 1);
  await waitFor('Host saved assistant', () => state.view.items.some(item => item.text.includes('END_ACCEPT_HELLO')));
}

async function checkLongInput(state) {
  const payload = state.mode === 'ink'
    ? 'ACCEPT_LONG\n' + 'This line must reach the model intact.\n'.repeat(170) + 'LONG_INPUT_TAIL'
    : 'ACCEPT_LONG\n' + 'Complete original text. '.repeat(130) + '\n' + 'More original text. '.repeat(150) + '\nLONG_INPUT_TAIL';
  if (state.mode === 'ink') {
    await state.terminal.type('\x1b[200~' + payload + '\x1b[201~');
    await delay(1000); // Product paste cooldown must finish before Enter.
    assert.equal(received(state, 'ACCEPT_LONG').length, 0, 'Paste must not submit itself');
    await state.terminal.type('\r');
  } else {
    const lines = payload.split('\n');
    for (const line of lines.slice(0, -1)) {
      await typeClassicLine(state, line + '\\');
      await waitFor('continuation prompt', () => /^\.\.\.\s*$/.test(state.terminal.cursorLine()));
    }
    assert.equal(received(state, 'ACCEPT_LONG').length, 0, 'Continuation must not submit an incomplete input');
    await typeClassicLine(state, lines.at(-1));
  }
  await waitFor('long input reply', () => state.terminal.screen().includes('END_ACCEPT_LONG'));
  assert.equal(received(state, 'ACCEPT_LONG').length, 1);
  const text = lastUserText(received(state, 'ACCEPT_LONG')[0].messages);
  assert.ok(text.replaceAll('\r\n', '\n').includes(payload), 'Model must receive the complete original paste');
}

async function typeClassicLine(state, text) {
  // Readline echoes each character; pace large lines so its console writes settle.
  for (let offset = 0; offset < text.length; offset += 100) {
    state.terminal.child.write(text.slice(offset, offset + 100));
    await delay(20);
  }
  await waitFor('readline text echoed', () => state.terminal.cursorLine().endsWith(text.slice(-30)));
  await state.terminal.type('\r');
}

async function checkQuestion(state) {
  await state.terminal.submit('ACCEPT_QUESTION');
  await waitFor('Host interaction', () => state.view.interactions.length === 1);
  await waitFor('terminal question dialog', () => state.terminal.screen().includes('Which acceptance option?'));
  if (state.mode === 'ink') {
    await state.terminal.type('\x1b[B');
    await state.terminal.type('\r');
  } else {
    await waitFor('classic choice prompt', () => state.terminal.screen().includes('Choice (number'));
    await state.terminal.submit('2');
  }
  await waitFor('question answer response', () => state.terminal.screen().includes('END_ACCEPT_QUESTION'));
  const answer = received(state, 'ACCEPT_QUESTION').at(-1).messages.filter(message => message.role === 'tool').at(-1);
  assert.ok(answer?.content.includes('beta'), 'Keyboard selection must return Beta to the model');
  await waitFor('interaction removed', () => state.view.interactions.length === 0);
}

async function checkQueue(state) {
  await state.terminal.submit('ACCEPT_HOLD_QUEUE');
  await waitFor('stream visible before completion', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_QUEUE'));
  await state.terminal.submit('ACCEPT_WITHDRAW');
  await waitFor('Host queued input', () => state.view.queue.length === 1);
  const inputId = state.view.queue[0].inputId;
  assert.equal(received(state, 'ACCEPT_WITHDRAW').length, 0);
  await state.terminal.type('\x1b[A');
  await waitFor('Host confirms withdrawal', async () =>
    (await state.client.inputs.read(state.sessionId, inputId))?.state === 'withdrawn');
  await waitFor('withdrawn text restored in editor', () => /^>.*ACCEPT_WITHDRAW/m.test(state.terminal.screen()));
  await state.terminal.type('\x05'); // Ctrl+E moves to the end of the restored draft.
  await state.terminal.type('_EDITED');
  await state.terminal.type('\r');
  await waitFor('edited input requeued', () => state.view.queue.some(input => input.text.includes('ACCEPT_WITHDRAW_EDITED')));
  state.pending.get('ACCEPT_HOLD_QUEUE')();
  await waitFor('edited input executed', () => state.terminal.screen().includes('END_ACCEPT_WITHDRAW_EDITED'));
  assert.equal(received(state, 'ACCEPT_WITHDRAW').length, 1, 'Withdrawn original must never execute');
}

async function checkStop(state) {
  await state.terminal.submit('ACCEPT_HOLD_STOP');
  await waitFor('stop target stream', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_STOP'));
  const runId = state.view.activity?.runId;
  assert.ok(runId);
  await state.terminal.type('\x03');
  await waitFor('Run cancellation', async () => {
    const run = await state.client.runs.read(runId);
    assert.notEqual(run.phase, 'failed', `Ctrl+C must cancel, not fail: ${JSON.stringify(run)}`);
    return run.phase === 'interrupted' && run.stop?.state === 'confirmed' && run.stop.outcome === 'interrupted';
  });
  if (state.mode === 'classic') await waitFor('readline ready after stop', () => /^kodax:.*>\s*$/.test(state.terminal.cursorLine()));
  await state.terminal.submit('ACCEPT_AFTER_STOP');
  await waitFor('next prompt after stop', () => state.terminal.screen().includes('END_ACCEPT_AFTER_STOP'));
  assert.equal(received(state, 'ACCEPT_AFTER_STOP').length, 1);
}

async function checkFrozenHistory(state) {
  await state.terminal.submit('ACCEPT_HOLD_HISTORY');
  await waitFor('history test streaming', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_HISTORY'));
  await state.terminal.type('\x0f'); // Ctrl+O opens transcript mode.
  await state.terminal.type('\x06'); // Ctrl+F searches the saved conversation.
  await waitFor('search editor ready', () => state.terminal.screen().includes('Type to search transcript'));
  await state.terminal.type('BEGIN_ACCEPT_HELLO');
  await waitFor('search text displayed', () => state.terminal.screen().includes('BEGIN_ACCEPT_HELLO'));
  await delay(500);
  await state.terminal.save('history-search-query');
  await state.terminal.type('\r');
  await waitFor('old conversation visible', () => state.terminal.screen().includes('BEGIN_ACCEPT_HELLO'));
  await state.terminal.save('history-before-live-update');
  state.pending.get('ACCEPT_HOLD_HISTORY')();
  await waitFor('Host receives new content while browsing', () =>
    state.view.items.some(item => item.text.includes('END_ACCEPT_HOLD_HISTORY')));
  await delay(500);
  assert.ok(state.terminal.screen().includes('BEGIN_ACCEPT_HELLO'), 'Live output must not displace the selected old conversation');
  assert.ok(!state.terminal.screen().includes('END_ACCEPT_HOLD_HISTORY'), 'Browsing must preserve its frozen content');
  await state.terminal.type('\x0f');
  await waitFor('return to live display', () => state.terminal.screen().includes('END_ACCEPT_HOLD_HISTORY'));
}

async function checkNewSession(state) {
  await state.terminal.submit('/new');
  if (state.mode === 'ink') {
    await waitFor('new-session confirmation', () => state.terminal.screen().includes('Start a new session?'));
    assert.equal((await state.client.sessions.list()).length, 1, 'Confirmation must precede creation');
    await state.terminal.type('y');
  }
  const next = await waitFor('new Host session', async () =>
    (await state.client.sessions.list()).find(session => session.id !== state.originalSessionId));
  assert.notEqual(next.id, state.originalSessionId);
  await observeSession(state, next.id);
  await waitFor('new-session terminal ready', () => state.mode === 'ink'
    ? /^>\s+Type a message/m.test(state.terminal.screen())
    : /^kodax:.*>\s*$/.test(state.terminal.cursorLine()));
  assert.ok(!state.view.items.some(item => item.type === 'user'), 'New Host view must be empty before input');
  await delay(300);
  await assertSelectedSettings(state);
  await state.terminal.submit('ACCEPT_FRESH');
  await waitFor('fresh-session response', () => state.terminal.screen().includes('END_ACCEPT_FRESH'));
  const request = received(state, 'ACCEPT_FRESH')[0];
  const userTexts = request.messages.filter(message => message.role === 'user')
    .map(message => lastUserText([message]));
  assert.equal(userTexts.length, 1, 'New session must exclude previous user history');
  assert.ok(userTexts[0].startsWith('ACCEPT_FRESH'), 'New session must contain the submitted prompt');
  assert.ok(!JSON.stringify(request.messages).includes('ACCEPT_HELLO'), 'New session must exclude previous conversation');
  assert.equal((await state.client.sessions.list()).length, 2, 'Previous session must remain saved');
  await waitFor('new Host assistant', () => state.view.items.some(item => item.text.includes('END_ACCEPT_FRESH')));
}

async function checkExit(state) {
  await state.terminal.submit('/exit');
  await waitFor('CLI exit', () => state.terminal.exited);
  assert.equal(state.terminal.exited.exitCode, 0);
}

async function checkResume(state) {
  state.terminal.dispose();
  state.terminal = openTerminal(state.homeDir, state.mode, ['--resume', state.originalSessionId]);
  await observeSession(state, state.originalSessionId);
  await waitFor('resumed terminal ready', () => /acceptance-local/.test(state.terminal.screen()), 45_000);
  if (state.mode === 'classic') {
    await waitFor('resumed readline ready', () => /^kodax:.*>\s*$/.test(state.terminal.cursorLine()));
  } else await delay(1500);
  await assertSelectedSettings(state);
  await state.terminal.submit('ACCEPT_RESUMED');
  await waitFor('resumed response', () => state.terminal.screen().includes('END_ACCEPT_RESUMED'));
  const request = received(state, 'ACCEPT_RESUMED')[0];
  assert.ok(JSON.stringify(request.messages).includes('ACCEPT_HELLO'), 'Resume must retain prior conversation');
  assert.ok(!JSON.stringify(request.messages).includes('ACCEPT_FRESH'), 'Old session must exclude new-session history');
  assert.equal((await state.client.sessions.list()).length, 2);
}

async function cleanupHost(state) {
  if (!state.client) return;
  try {
    for (const view of state.views.values()) {
      for (const run of view.runs) {
        if (['accepted', 'queued', 'running'].includes(run.phase)) {
          await state.client.runs.stop(run.runId);
          await state.client.runs.await(run.runId);
        }
      }
    }
    await state.client.host.shutdown();
  } catch (error) {
    results.push({ mode: state.mode, name: 'cleanup', status: 'failed', error: String(error) });
    process.stderr.write(`Cleanup failed (${state.mode}): ${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await state.client.disconnect();
  }
}

async function cleanup(state) {
  state.observation?.close();
  state.terminal?.dispose();
  try { await cleanupHost(state); }
  finally {
    state.server?.closeAllConnections();
    if (state.server?.listening) {
      await new Promise((resolve, reject) => state.server.close(error => error ? reject(error) : resolve()));
    }
    await writeFile(path.join(artifacts, `${state.mode}-requests.json`), JSON.stringify(state.requests, null, 2));
  }
}

async function run(mode) {
  const state = { mode, homeDir: path.join(artifacts, mode), requests: [], pending: new Map(),
    views: new Map(), runEvents: [], providerErrors: [] };
  try {
    await setupProvider(state);
    state.terminal = openTerminal(state.homeDir, mode);
    await check(state, 'startup', checkStartup);
    await check(state, 'prompt-stream-complete', checkPrompt);
    await check(state, 'session-settings-roundtrip', checkSettings);
    await check(state, 'multiline-long-input', checkLongInput);
    await check(state, 'question-dialog-roundtrip', checkQuestion);
    if (mode === 'ink') await check(state, 'busy-queue-withdraw-edit', checkQueue);
    if (mode === 'ink') await check(state, 'history-search-frozen-live-view', checkFrozenHistory);
    await check(state, 'stop-and-next-input', checkStop);
    await check(state, 'new-session-isolation', checkNewSession);
    await check(state, 'exit', checkExit);
    await check(state, 'resume-persisted-session', checkResume);
    await check(state, 'resumed-exit', checkExit);
  } catch (error) {
    await state.terminal?.save('failure');
    await saveFacts(state, 'failure');
    results.push({ mode, name: state.checkName, status: 'failed', error: String(error),
      screen: state.terminal?.screen() });
    throw error;
  } finally {
    await cleanup(state);
  }
}

try {
  const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['ink', 'classic'];
  assert.ok(modes.every(mode => ['ink', 'classic'].includes(mode)), 'Modes must be ink or classic');
  for (const mode of modes) await run(mode);
} catch (error) {
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
}
// node-pty 1.1.0 retains ConPTY worker ports after natural child exit on Windows.
// Product exits and Host shutdown are checked above; finish this standalone driver.
process.exit(results.some(result => result.status === 'failed') ? 1 : (process.exitCode ?? 0));
