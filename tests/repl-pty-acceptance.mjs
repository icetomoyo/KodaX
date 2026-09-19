import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectKodaXClient } from '../dist/sdk-client.js';

// Keep native terminal drivers outside the product dependency graph.
const toolRequire = createRequire(path.join(
  process.env.KODAX_ACCEPTANCE_TOOLS ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json',
));
const pty = toolRequire('node-pty');
const { Terminal } = toolRequire('@xterm/headless');
let Unicode11Addon;
try { ({ Unicode11Addon } = toolRequire('@xterm/addon-unicode11')); }
catch (error) { throw new Error('PTY screen checks require @xterm/addon-unicode11; install the dependencies in FEATURE_298_v0.7.97_TEST_GUIDE.md.', { cause: error }); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'kodax-repl-acceptance-'));
const results = [];
const sourceEntry = process.argv.includes('--source');
const longHistoryOnly = process.argv.includes('--long-history-only');
const queueBoundaryOnly = process.argv.includes('--queue-boundary-only');
const consumerOnly = process.argv.includes('--consumer-only');
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
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'NO_COLOR'));
  const bootstrap = sourceEntry ? ['--max-old-space-size=4096', '--require', path.join(repo, 'scripts/production-env.cjs'),
    '--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href,
    path.join(repo, 'src/kodax_bootstrap.ts')] : [path.join(repo, 'scripts/kodax-bin.cjs')];
  const child = pty.spawn(process.execPath, [...bootstrap,
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
  const token = lastUserText(data.messages).match(/^(?:\/ah-run\s+)?(ACCEPT_[A-Z_]+)/)?.[1] ?? 'AUXILIARY';
  if ((data.max_completion_tokens === 1 || token === 'ACCEPT_CAPABILITY') && data.reasoning_effort === 'high') {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: "Unsupported value: reasoning_effort 'high'.",
      type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_value' } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if ((token === 'ACCEPT_ARCHIVE_EARLY' || token.startsWith('ACCEPT_ARCHIVE_FILL_'))
    && data.messages.at(-1).role !== 'tool') {
    response.write(`data: ${JSON.stringify({ id: token, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { reasoning_content: `THINKING_${token}` }, finish_reason: null }],
    })}\n\n`);
    const calls = token === 'ACCEPT_ARCHIVE_EARLY'
      ? [1, 2].map(index => ({ name: 'bash', input: { command: `echo ACCEPT_OLD_BASH_${index}`,
        description: `Archive Bash ${index}` } }))
      : Array.from({ length: 3 }, (_, index) => ({ name: 'read',
        input: { path: path.join(state.homeDir, `archive-${(token.at(-1).charCodeAt(0) - 65) * 3 + index}.txt`) } }));
    response.end(`data: ${JSON.stringify({ id: token, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ index,
        id: `${token}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) },
      })) }, finish_reason: 'tool_calls' }],
    })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (token === 'ACCEPT_QUESTION' && data.messages.at(-1).role !== 'tool') {
    respondWithQuestion(response);
    return;
  }
  if (token === 'ACCEPT_TOOL' && data.messages.at(-1).role !== 'tool') {
    response.end(`data: ${JSON.stringify({ id: 'acceptance-tool', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'acceptance-bash', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'echo ACCEPT_TOOL_RESULT',
          description: 'Display the acceptance result' }) },
      }] }, finish_reason: 'tool_calls' }],
    })}\n\ndata: [DONE]\n\n`);
    return;
  }
  const send = content => response.write(`data: ${JSON.stringify({
    id: 'acceptance', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`);
  if (token === 'ACCEPT_BOUNDARY_HOLD' && data.messages.at(-1).role !== 'tool') {
    send('BEGIN_ACCEPT_BOUNDARY_HOLD');
    state.pending.set('boundary-tool', () => response.end(`data: ${JSON.stringify({
      id: 'acceptance-boundary', object: 'chat.completion.chunk', choices: [{ index: 0,
        delta: { tool_calls: [{ index: 0, id: 'acceptance-boundary-read', type: 'function',
          function: { name: 'read', arguments: JSON.stringify({ path: path.join(state.homeDir, 'boundary.txt') }) },
        }] }, finish_reason: 'tool_calls' }],
    })}\n\ndata: [DONE]\n\n`));
    return;
  }
  const finish = () => {
    send(` END_${token}`);
    response.end(`data: ${JSON.stringify({ id: 'acceptance', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    })}\n\ndata: [DONE]\n\n`);
  };
  if (token === 'ACCEPT_HOLD_PAINT') {
    send(Array.from({ length: 80 }, (_, index) => index + '\t' + 'BODY_中文 '.repeat(45)).join('\n') + '\n');
  }
  send(token === 'ACCEPT_HOLD_TRANSCRIPT'
    ? 'EARLY_FROZEN_MARKER\n' + 'x'.repeat(10000) + `\nBEGIN_${token}` : `BEGIN_${token}`);
  if (token === 'ACCEPT_HOLD_TRANSCRIPT') {
    state.pending.set('grow', () => send('\nLATE_AFTER_FREEZE_MARKER'));
  }
  if (token.includes('HOLD') || token === 'ACCEPT_BOUNDARY_NEXT') state.pending.set(token, finish);
  else setTimeout(finish, 350);
}

async function setupProvider(state) {
  state.server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/__acceptance_health') {
      response.writeHead(204);
      response.end();
      return;
    }
    respondToModelRequest(state, request, response).catch(error => {
      state.providerErrors.push(String(error));
      process.stderr.write(`Fixture provider failed: ${String(error)}\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  for (;;) {
    state.server.listen(0, '127.0.0.1');
    await once(state.server, 'listening');
    try {
      const health = await fetch(`http://127.0.0.1:${state.server.address().port}/__acceptance_health`);
      if (health.status !== 204) throw new Error(`Fixture provider health check failed (${health.status}).`);
      break;
    } catch (error) {
      await new Promise((resolve, reject) => state.server.close(closeError => closeError ? reject(closeError) : resolve()));
      // Windows may allocate a port that Fetch blocks before sending HTTP.
      if (error.cause?.message !== 'bad port') throw error;
    }
  }
  await mkdir(path.join(state.homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(state.homeDir, '.kodax', 'config.json'), JSON.stringify({
    provider: 'acceptance-local', planModeEffort: 'high', customProviders: [{
      name: 'acceptance-local', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${state.server.address().port}/v1`,
      apiKeyEnv: 'KODAX_ACCEPTANCE_KEY', model: 'acceptance-model',
      reasoning: { efforts: ['low', 'medium', 'high'], default: 'medium' },
      contextWindow: longHistoryOnly ? 262144 : 65536, maxOutputTokens: 1024,
    }],
  }));
}

async function setupHostCommands(state) {
  const configHome = path.join(state.homeDir, '.kodax');
  const extensionPath = path.join(configHome, 'acceptance-commands.mjs');
  state.commandEffectsPath = path.join(state.homeDir, 'command-effects.jsonl');
  // The Host extension alias must keep precedence over a same-name project Skill.
  const conflictingSkillDir = path.join(configHome, 'skills', 'ah-run');
  await mkdir(conflictingSkillDir, { recursive: true });
  await writeFile(path.join(conflictingSkillDir, 'SKILL.md'), [
    '---', 'name: ah-run', 'description: Same-name Skill for command precedence acceptance',
    '---', 'SKILL_ALIAS_MUST_NOT_REPLACE_HOST_COMMAND',
  ].join('\n'));
  await writeFile(extensionPath, `import { appendFile } from 'node:fs/promises';
const effectsPath = ${JSON.stringify(state.commandEffectsPath)};
export default function(api) {
  // The fixture deliberately has no registration in the client process.
  if (process.env.KODAX_DAEMON_SERVE !== '1') return;
  const record = (name, args, context) => appendFile(effectsPath, JSON.stringify({
    name, args, sessionId: context.sessionId, pid: process.pid,
    daemon: process.env.KODAX_DAEMON_SERVE,
  }) + '\\n');
  api.registerCommand({ name: 'acceptance-host-note', aliases: ['ah-note'],
    description: 'Record an acceptance note without a model call',
    handler: async (args, context) => { await record('note', args, context); },
  });
  api.registerCommand({ name: 'acceptance-host-run', aliases: ['ah-run'],
    description: 'Run the acceptance review on the Host',
    handler: async (args, context) => {
      await record('run', args, context);
      return { invocation: { source: 'extension', displayName: 'acceptance-host-run',
        prompt: 'Follow the original acceptance input and retain its exact marker.' } };
    },
  });
}`);
  await mkdir(path.join(configHome, 'integrations'), { recursive: true });
  await writeFile(path.join(configHome, 'integrations', 'extensions.json'),
    JSON.stringify({ version: 1, paths: [extensionPath] }));
}

async function commandEffects(state) {
  try {
    return (await readFile(state.commandEffectsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function assertHostCommandEffects(state, effects) {
  for (const effect of effects) {
    assert.equal(effect.sessionId, state.sessionId);
    assert.equal(effect.daemon, '1', 'Only the independent Host may execute the extension');
    assert.notEqual(effect.pid, state.terminal.child.pid, 'The terminal process must not execute a local extension fallback');
  }
}

async function checkHostCommandNoOutput(state) {
  const beforeRequests = state.requests.length;
  const beforeRuns = state.view.runs.map(run => run.runId);
  const catalog = await state.client.catalog.commands();
  assert.ok(catalog.some(command => command.name === 'acceptance-host-note'), 'Host must advertise its configured extension');
  await state.client.sessions.updateSettings(state.sessionId, { permissionMode: 'full-access' });
  await state.terminal.submit('/ah-note silent');
  const effects = await waitFor('Host-only no-output extension effect', async () => {
    const entries = await commandEffects(state);
    return entries.length === 1 ? entries : undefined;
  });
  assert.deepEqual(effects.map(({ name, args }) => ({ name, args })), [{ name: 'note', args: ['silent'] }]);
  assertHostCommandEffects(state, effects);
  await delay(500);
  assert.equal((await commandEffects(state)).length, 1, 'No-output commands must execute exactly once');
  assert.equal(state.requests.length, beforeRequests, 'No-output commands must not issue provider requests');
  const run = await waitFor('managed no-output command completes', () =>
    state.view.runs.find(run => !beforeRuns.includes(run.runId) && run.phase === 'completed'));
  assert.ok(run, 'FEATURE_299 effectful commands require an owned tool Run, even without a model request');
  const history = await state.client.sessions.readHistory(state.sessionId);
  assert.equal(history.items.filter(item => item.type === 'user' && item.text === '/ah-note silent').length, 1);
}

async function checkHostDiagnosticsAndShell(state) {
  const beforeRequests = state.requests.length;
  await state.terminal.submit('/mcp');
  await waitFor('Host MCP status is visible', () => state.terminal.screen().includes('MCP Status')
    && state.terminal.screen().includes('Servers: 0'));
  await state.terminal.submit('/extensions');
  await waitFor('Host extension diagnostics are visible', () => state.terminal.screen().includes('Extension Runtime:')
    && state.terminal.screen().includes('acceptance-host-note'));
  await state.terminal.submit('!echo MANUAL_TOOL_ACCEPTED');
  await waitFor('manual Shell result comes from the Host', () => state.view.items.some(item =>
    item.type === 'tool' && item.tool?.name === 'bash' && item.tool.status === 'success' && item.text.includes('MANUAL_TOOL_ACCEPTED')));
  await waitFor('manual Shell is shown in the terminal', () => state.terminal.screen().includes('bash')
    && state.terminal.screen().includes('MANUAL_TOOL_ACCEPTED'));
  assert.equal(state.requests.length, beforeRequests, 'Diagnostics and explicit Shell must not request the model');
  assert.equal(state.view.items.filter(item => item.type === 'user' && item.text === '!echo MANUAL_TOOL_ACCEPTED').length, 1);
  await waitFor('manual Shell Run settles', () => !state.view.runs.some(run => ['running', 'waiting_permission', 'queued'].includes(run.phase)));
  await state.client.sessions.updateSettings(state.sessionId, { permissionMode: 'accept-edits' });
}

async function checkHostCommandHelp(state) {
  const beforeRequests = state.requests.length;
  const beforeEffects = await commandEffects(state);
  await state.terminal.submit('/ah-note --help');
  await waitFor('Host-only command help', () => state.terminal.screen().includes('Record an acceptance note'));
  assert.deepEqual(await commandEffects(state), beforeEffects, 'Help must not call the registered handler');
  assert.equal(state.requests.length, beforeRequests, 'Help must not call a provider');
}

async function checkHostCommandRun(state) {
  const commandText = '/ah-run ACCEPT_HOLD_COMMAND';
  await state.terminal.submit(commandText);
  await waitFor('Host command streaming through CLI', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_COMMAND'));
  const commandRunId = await waitFor('existing Host command Run identity', () =>
    state.view.items.some(item => item.type === 'user' && item.text === commandText)
      && state.view.activity?.runId);
  const effects = await commandEffects(state);
  assert.equal(effects.filter(effect => effect.name === 'run').length, 1, 'The invocation handler must execute once');
  assertHostCommandEffects(state, effects);
  assert.equal(state.requests.filter(request => lastUserText(request.messages) === commandText).length, 1,
    'The CLI must follow the admitted Run rather than resubmit its prompt');
  const commandRequest = state.requests.find(request => lastUserText(request.messages) === commandText);
  assert.ok(!JSON.stringify(commandRequest.messages).includes('SKILL_ALIAS_MUST_NOT_REPLACE_HOST_COMMAND'),
    'A same-name project Skill must not replace the registered Host extension alias');
  assert.equal(state.view.items.filter(item => item.type === 'user' && item.text === commandText).length, 1);
  if (state.mode === 'ink') {
    await state.terminal.submit('ACCEPT_HOLD_COMMAND_NEXT');
    const queued = await waitFor('follow-up queued while the command runs', () =>
      state.view.queue.find(input => input.text === 'ACCEPT_HOLD_COMMAND_NEXT'));
    assert.equal(received(state, 'ACCEPT_HOLD_COMMAND_NEXT').length, 0);
    state.pending.get('ACCEPT_HOLD_COMMAND')();
    await waitFor('queued follow-up streams in the command Run', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_COMMAND_NEXT'));
    const delivered = await waitFor('queued input is submitted to the original command Run', async () => {
      const receipt = await state.client.inputs.read(state.sessionId, queued.inputId);
      return receipt?.state === 'submitted' ? receipt : undefined;
    });
    assert.equal(delivered.runId, commandRunId, 'The queued follow-up must remain in the original command Run');
    assert.equal((await state.client.runs.read(commandRunId)).phase, 'running');
    assert.equal(state.view.runs.find(run => run.phase === 'running')?.runId, commandRunId);
    await waitFor('delivered follow-up leaves the queue', () => !state.view.queue.some(input => input.inputId === queued.inputId));
    await state.terminal.type('\x1b\x1b');
    await waitFor('double Esc stops the original command Run during its follow-up', async () =>
      (await state.client.runs.read(commandRunId)).phase === 'interrupted');
    await waitFor('Ink prompt after command follow-up stop', () => /^>\s+Type a message/m.test(state.terminal.screen()));
    await delay(300);
  } else {
    state.pending.get('ACCEPT_HOLD_COMMAND')();
    await waitFor('classic command completes', () => state.terminal.screen().includes('END_ACCEPT_HOLD_COMMAND'));
    await waitFor('classic prompt after Host command', () => /^kodax:.*>\s*$/.test(state.terminal.cursorLine()));
  }
  await state.terminal.submit('ACCEPT_COMMAND_AFTER');
  await waitFor('normal input after Host command', () => state.terminal.screen().includes('END_ACCEPT_COMMAND_AFTER'));
  assert.equal(received(state, 'ACCEPT_COMMAND_AFTER').length, 1);
  assert.equal((await commandEffects(state)).filter(effect => effect.name === 'run').length, 1);
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
  assert.ok(['none', 'off'].includes(settings.effort), 'Explicit effort off reaches Host');
  assert.equal(settings.permissionMode ?? 'accept-edits', 'accept-edits');
  assert.equal(settings.maxIter, 7);
}

async function checkProviderCapabilities(state) {
  const selection = { provider: 'acceptance-local', model: 'acceptance-model' };
  const initialRequests = state.requests.length;
  assert.ok((await state.client.catalog.reasoningEfforts(selection)).includes('high'));
  assert.equal(state.requests.length, initialRequests, 'Capability discovery does not probe');
  await state.terminal.submit('/provider probe');
  await waitFor('Host learns the rejected effort', async () =>
    !(await state.client.catalog.reasoningEfforts(selection)).includes('high'));
  await waitFor('probe result presented', () => state.terminal.screen().includes('rejections recorded'));
  const rejectedRequests = state.requests.filter(request => request.reasoning_effort === 'high').length;
  const beforeSecondProbe = state.requests.length;
  await state.terminal.submit('/provider probe');
  await waitFor('second probe accepts the remaining efforts', () => state.requests.length >= beforeSecondProbe + 2);
  await waitFor('second probe has finished rendering', () =>
    (state.terminal.screen().match(/rejections recorded/g) ?? []).length === 2);
  assert.equal(state.requests.filter(request => request.reasoning_effort === 'high').length, rejectedRequests,
    'The next probe must use Host-filtered candidates');
  await state.terminal.submit('/provider forget-capability acceptance-local/acceptance-model');
  await waitFor('Host clear receipt presented', () => state.terminal.screen().includes('Cleared Host learned capability'));
  assert.ok((await state.client.catalog.reasoningEfforts(selection)).includes('high'));
  const savedEffort = (await state.client.config.read()).effort;
  await state.client.sessions.updateSettings(state.sessionId, { effort: 'high', thinking: true, reasoningMode: 'deep' });
  await waitFor('explicit Host effort reaches the terminal view', () => state.view.settings.effort === 'high');
  await state.terminal.submit('ACCEPT_CAPABILITY');
  await waitFor('real execution recovers from effort rejection', () => state.terminal.screen().includes('END_ACCEPT_CAPABILITY'));
  assert.ok(received(state, 'ACCEPT_CAPABILITY').some(request => request.reasoning_effort === 'high'));
  assert.ok(received(state, 'ACCEPT_CAPABILITY').some(request => request.reasoning_effort !== 'high'));
  assert.equal((await state.client.config.read()).effort, savedEffort, 'Observed rejection must not overwrite user defaults');
  await state.client.sessions.updateSettings(state.sessionId, { effort: 'off', thinking: false, reasoningMode: 'off' });
}

async function checkHostSettingCommands(state) {
  const savedBefore = await state.client.config.read();
  const settingsBefore = await state.client.sessions.getSettings(state.sessionId);
  for (const [command, expected] of [
    ['/model acceptance-local/acceptance-model', { provider: 'acceptance-local', model: 'acceptance-model' }],
    ['/effort low', { effort: 'low', reasoningMode: 'auto', thinking: true }],
    ['/reasoning auto', { reasoningMode: 'auto', thinking: true }],
    ['/agent-mode sa', { agentMode: 'sa' }],
    ['/repo-intel mode off', { repoIntelligenceMode: 'off' }],
    ['/repo-intel trace on', { repoIntelligenceTrace: true }],
  ]) {
    await state.terminal.submit(command);
    await waitFor(`Host saved ${command}`, async () => {
      const saved = await state.client.config.read();
      const settings = await state.client.sessions.getSettings(state.sessionId);
      return Object.entries(expected).every(([key, value]) => saved[key] === value && settings[key] === value);
    });
    await delay(400);
  }
  assert.equal((await state.client.config.read()).effort, undefined);
  assert.equal((await state.client.sessions.getSettings(state.sessionId)).effort, undefined);
  if (state.mode === 'ink') {
    state.terminal.child.write('\x14');
    await waitFor('Ctrl+T saved through Host', async () => (await state.client.config.read()).effort !== undefined);
    const saved = await state.client.config.read();
    assert.equal((await state.client.sessions.getSettings(state.sessionId)).effort, saved.effort);
  }
  await delay(400);
  await state.terminal.submit('/thinking auto');
  await waitFor('effort reset settled', async () => (await state.client.config.read()).effort === undefined);
  await delay(400);
  await state.terminal.submit('/repo-intel trace off');
  await waitFor('trace off settled', async () => (await state.client.config.read()).repoIntelligenceTrace === false);
  await state.client.sessions.updateSettings(state.sessionId, { permissionMode: 'plan', effort: 'low' });
  await waitFor('plan mode selection observed', () => state.view.settings.permissionMode === 'plan' && state.view.settings.effort === 'low');
  await delay(400);
  await state.terminal.submit('/effort auto');
  await waitFor('plan effort override cleared', async () => (await state.client.sessions.getSettings(state.sessionId)).effort === undefined);
  const keys = ['provider', 'model', 'effort', 'reasoningMode', 'thinking', 'agentMode', 'permissionMode', 'repoIntelligenceMode', 'repoIntelligenceTrace'];
  await state.client.config.patch(Object.fromEntries(keys.map(key => [key, savedBefore[key] ?? null])));
  await state.client.sessions.updateSettings(state.sessionId, Object.fromEntries(keys.map(key => [key, settingsBefore[key] ?? null])));
}

async function checkHostExecutionControls(state) {
  for (const [command, field, value] of [
    ['/verifier-log on', 'verifierLog', true], ['/verifier-log off', 'verifierLog', false],
    ['/stall-log on', 'stallLog', true], ['/stall-log off', 'stallLog', false],
    ['/fallback acceptance-local', 'fallbackProviders', ['acceptance-local']], ['/fallback off', 'fallbackProviders', []],
  ]) {
    await state.terminal.submit(command);
    await waitFor(`Host applied ${command}`, async () => {
      const effective = (await state.client.config.readEffective())[field];
      return effective.applied && JSON.stringify(effective.value) === JSON.stringify(value);
    });
    await delay(400);
  }
}

async function checkHostSessionList(state) {
  const listed = await state.client.sessions.create({ projectPath: state.homeDir, title: 'HOST_LIST_ONLY' });
  const other = await state.client.sessions.create({ projectPath: artifacts, title: 'OTHER_PROJECT_HIDDEN' });
  try {
    await state.terminal.submit('/sessions');
    await waitFor('Host session list rendered', () => state.terminal.screen().includes('HOST_LIST_ONLY'));
    assert.ok(!state.terminal.screen().includes('OTHER_PROJECT_HIDDEN'));
  } finally { await state.client.sessions.delete(listed.id); await state.client.sessions.delete(other.id); }
}

async function checkHostSessionTransitions(state) {
  const target = await state.client.sessions.create({ projectPath: state.homeDir, title: 'HOST_LOAD_TARGET' });
  await state.client.sessions.updateSettings(target.id, {
    provider: 'acceptance-local', model: 'acceptance-model', agentMode: 'sa', effort: 'none', maxIter: 13,
  });
  const settings = await state.client.sessions.getSettings(target.id);
  await state.terminal.submit(`/load ${target.id}`);
  await waitFor('target loaded', () => state.terminal.screen().includes(target.id));
  await delay(400);
  assert.deepEqual(await state.client.sessions.getSettings(target.id), settings);
  await observeSession(state, target.id);
  await state.terminal.submit('ACCEPT_LOADED_HISTORY');
  await waitFor('loaded response', () => state.terminal.screen().includes('END_ACCEPT_LOADED_HISTORY'));
  await waitFor('loaded run settled', () => state.view.runs.every(run => !['accepted', 'queued', 'running', 'waiting_user', 'waiting_agent'].includes(run.phase)));
  await waitFor('loaded prompt ready', () => state.mode === 'ink'
    ? /^>\s+Type a message/m.test(state.terminal.screen()) : /^kodax:.*>\s*$/.test(state.terminal.cursorLine()));
  await delay(400);
  const lineage = await state.client.sessions.readLineage(target.id);
  const first = lineage.entries.find(entry => entry.role === 'user');
  await state.terminal.submit(`/rewind ${first.id}`);
  await waitFor('rewind head', async () => (await state.client.sessions.readLineage(target.id)).activeEntryId === first.id);
  if (state.mode === 'ink') await waitFor('rewound history remains visible', () => state.terminal.screen().includes('ACCEPT_LOADED_HISTORY'));
  await delay(400);
  await state.terminal.submit('/tree');
  await waitFor('Host tree rendered', () => state.terminal.screen().includes(first.id.slice(0, 12)));
  state.terminal.dispose();
  await state.terminal.exit;
  state.terminal = openTerminal(state.homeDir, state.mode, ['--resume', target.id, '--repo-intelligence', 'full', '--repo-intelligence-trace']);
  await waitFor('resumed target ready', () => state.terminal.screen().includes(target.id), 45_000);
  await waitFor('explicit flags applied to existing Host', async () => {
    const updated = await state.client.sessions.getSettings(target.id);
    return updated.maxIter === 7 && updated.repoIntelligenceMode === 'full' && updated.repoIntelligenceTrace === true;
  });
}

async function checkSettings(state) {
  // Read complete labels here; narrow/resize rendering is exercised separately.
  if (state.mode === 'ink') await state.terminal.resize(220, 32);
  for (const [command, field, expected] of [
    ['/agent-mode ama', 'agentMode', 'ama'], ['/agent-mode sa', 'agentMode', 'sa'],
    ['/mode plan', 'permissionMode', 'plan'], ['/mode accept-edits', 'permissionMode', 'accept-edits'],
  ]) {
    await state.terminal.submit(command);
    await waitFor(`${command} updates Host`, async () =>
      (await state.client.sessions.getSettings(state.sessionId))[field] === expected);
  }
  await state.client.sessions.updateSettings(state.sessionId, { model: 'peer-model', permissionMode: 'plan' });
  if (state.mode === 'ink') {
    await waitFor('other client settings reach the REPL footer', () => {
      const footer = state.terminal.screen().split('\n').slice(-2).join('\n');
      return footer.includes('peer-model') && /plan/i.test(footer);
    });
  } else {
    await state.terminal.submit('/status');
    await waitFor('other client settings reach classic status', () => {
      const screen = state.terminal.screen();
      return screen.includes('peer-model') && /Permission:\s+plan/.test(screen);
    });
  }
  await delay(500);
  const peerSettings = await state.client.sessions.getSettings(state.sessionId);
  assert.equal(peerSettings.model, 'peer-model', 'Rendering must not write stale model settings back');
  assert.equal(peerSettings.permissionMode, 'plan', 'Rendering must not write stale permission settings back');
  // /mode also saves the user's default; remove that fixture default to exercise unset policy.
  const configPath = path.join(state.homeDir, '.kodax', 'config.json');
  const profileConfig = JSON.parse(await readFile(configPath, 'utf8'));
  delete profileConfig.permissionMode;
  await writeFile(configPath, JSON.stringify(profileConfig));
  await state.client.config.reload();
  await state.client.sessions.updateSettings(state.sessionId, { permissionMode: null });
  await waitFor('Host view resolves the built-in permission default', () => state.view.settings.permissionMode === 'accept-edits');
  if (state.mode === 'classic') await state.terminal.submit('/status');
  await waitFor('cleared permission displays the effective Host default', () => {
    const screen = state.terminal.screen();
    return state.mode === 'ink' ? screen.split('\n').slice(-2).join('\n').includes('Edits')
      : /Permission:\s+accept-edits/.test(screen);
  });
  assert.equal((await state.client.sessions.getSettings(state.sessionId)).permissionMode, undefined);
  await state.client.config.patch({ permissionMode: 'accept-edits' });
  await waitFor('Host view resolves the profile permission', () => state.view.settings.permissionMode === 'accept-edits');
  if (state.mode === 'classic') await state.terminal.submit('/status');
  await waitFor('profile permission becomes the effective Host selection', () => {
    const screen = state.terminal.screen();
    return state.mode === 'ink' ? /Edits/.test(screen.split('\n').slice(-2).join('\n'))
      : /Permission:\s+accept-edits/.test(screen);
  });
  assert.equal((await state.client.sessions.getSettings(state.sessionId)).permissionMode, undefined,
    'Displaying profile defaults must not persist a Session override');
  await state.terminal.submit('/model /acceptance-model');
  await waitFor('explicit old model selection reaches Host', async () =>
    (await state.client.sessions.getSettings(state.sessionId)).model === 'acceptance-model');
  await state.terminal.submit('/mode accept-edits');
  await waitFor('explicit permission selection reaches Host', async () =>
    (await state.client.sessions.getSettings(state.sessionId)).permissionMode === 'accept-edits');
  await assertSelectedSettings(state);
  if (state.mode === 'ink') await state.terminal.resize(110, 32);
}

async function checkPrompt(state) {
  await state.terminal.submit('ACCEPT_HELLO');
  await waitFor('model received prompt', () => received(state, 'ACCEPT_HELLO').length === 1);
  await waitFor('terminal final reply', () => state.terminal.screen().includes('END_ACCEPT_HELLO'));
  assert.equal((await state.client.sessions.list()).length, 1);
  await waitFor('Host saved assistant', () => state.view.items.some(item => item.text.includes('END_ACCEPT_HELLO')));
  if (state.mode === 'ink') {
    for (let sample = 0; sample < 30; sample += 1) {
      assert.ok(state.terminal.screen().split('\n')
        .filter(line => line.trim() === 'BEGIN_ACCEPT_HELLO END_ACCEPT_HELLO').length <= 1,
      'The completed reply must not be appended again by the local UI');
      await delay(50);
    }
    const lines = state.terminal.screen().split('\n').map(line => line.trim());
    assert.equal(lines.filter(line => line === 'ACCEPT_HELLO').length, 1, 'One input must render once');
    assert.equal(lines.filter(line => line === 'BEGIN_ACCEPT_HELLO END_ACCEPT_HELLO').length, 1,
      'One assistant reply must render once after persistence');
    const screen = state.terminal.screen();
    assert.ok(screen.includes('60/65.5k'), 'Status must show API context usage against the configured window');
    assert.ok(screen.includes('50→10') && screen.includes('(60)'), 'Status must show actual API input/output usage');
    assert.ok(screen.includes('1/7'), 'Status must preserve the selected iteration limit');
  }
}

async function checkAmaPresentation(state) {
  await state.terminal.submit('/agent-mode ama');
  await waitFor('AMA setting', async () => (await state.client.sessions.getSettings(state.sessionId)).agentMode === 'ama');
  await delay(300);
  await state.terminal.submit('ACCEPT_HOLD_AMA');
  await waitFor('AMA streaming reply', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_AMA'));
  await delay(300);
  assert.equal(state.terminal.screen().split('\n').filter(line => line.trim() === 'ACCEPT_HOLD_AMA').length, 1,
    'AMA must display the submitted user query exactly once');
  assert.equal(received(state, 'ACCEPT_HOLD_AMA')[0].messages
    .filter(message => message.role === 'user' && message.content === 'ACCEPT_HOLD_AMA').length, 1,
  'The provider must receive one canonical AMA query');
  assert.ok(!state.terminal.screen().includes('AMA Worker - Worker analyzing task'),
    'Transient AMA status must not be an extra transcript row');
  state.pending.get('ACCEPT_HOLD_AMA')();
  await waitFor('AMA completed', () => state.view.runs.every(run => run.phase === 'completed'));
  await waitFor('AMA input ready', () => /^>\s+Type a message/m.test(state.terminal.screen()));
  const screen = state.terminal.screen();
  assert.ok(screen.indexOf('BEGIN_ACCEPT_HELLO END_ACCEPT_HELLO') < screen.indexOf('ACCEPT_HOLD_AMA'),
    'The previous answer must remain before the next user query');
  await state.terminal.submit('/agent-mode sa');
  await waitFor('restore SA setting', async () => (await state.client.sessions.getSettings(state.sessionId)).agentMode === 'sa');
}

async function checkToolPresentation(state) {
  await state.terminal.submit('/agent-mode ama');
  await waitFor('AMA tool setting', async () => (await state.client.sessions.getSettings(state.sessionId)).agentMode === 'ama');
  await delay(300);
  await state.terminal.submit('ACCEPT_TOOL');
  await waitFor('tool round completed', () => state.terminal.screen().includes('END_ACCEPT_TOOL'));
  await waitFor('tool summary preserves command', () => state.terminal.screen().includes('cmd=echo ACCEPT_TOOL_RESULT'));
  const tool = state.view.items.find(item => item.tool?.callId === 'acceptance-bash');
  assert.equal(tool?.tool.status, 'success');
  assert.ok(tool.text.includes('ACCEPT_TOOL_RESULT'), 'The real tool output must reach the Host view');
  await waitFor('AMA tool round settled', () => state.view.runs.every(run => run.phase === 'completed'));
  assert.equal(state.view.items.filter(item => item.type === 'user' && item.text === 'ACCEPT_TOOL').length, 1);
  assert.equal(state.view.items.filter(item => item.type === 'assistant' && item.text.includes('END_ACCEPT_TOOL')).length, 1);
  await waitFor('AMA tool input ready', () => /^>\s+Type a message/m.test(state.terminal.screen()));
  await state.terminal.submit('/agent-mode sa');
  await waitFor('restore SA after tool', async () => (await state.client.sessions.getSettings(state.sessionId)).agentMode === 'sa');
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
  await state.client.config.patch({ permissionMode: null });
  await state.client.sessions.updateSettings(state.sessionId, { permissionMode: null });
  await waitFor('question uses the effective Host default', () => state.view.settings.permissionMode === 'accept-edits');
  await state.terminal.submit('ACCEPT_QUESTION');
  await waitFor('Host interaction', () => state.view.interactions.length === 1);
  assert.equal(state.view.interactions[0].kind, 'question', 'Unset product permissions must not add an approval before AskUser');
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
  const stoppedInput = state.view.items.findIndex(item => item.type === 'user' && item.text === 'ACCEPT_HOLD_STOP');
  const stoppedOutput = state.view.items.findIndex(item => item.type === 'assistant' && item.text === 'BEGIN_ACCEPT_HOLD_STOP');
  assert.ok(stoppedInput >= 0 && stoppedOutput > stoppedInput,
    'The interrupted reply must remain after its user input in the shared Host view');
  if (state.mode === 'ink') assert.ok(state.terminal.screen().split('\n')
    .filter(line => line.trim() === 'ACCEPT_HOLD_STOP').length <= 1,
  'Stopping must not leave duplicate query rows in the terminal');
}

async function checkQueueModelBoundary(state) {
  assert.equal(state.mode, 'ink', 'Busy keyboard queue admission is an Ink interaction');
  // The standalone entry has not run the wide settings check used by the full suite.
  await state.terminal.resize(160, 32);
  const originalAgentMode = (await state.client.sessions.getSettings(state.sessionId)).agentMode;
  await state.client.sessions.updateSettings(state.sessionId, { agentMode: 'ama' });
  try {
    await waitFor('AMA selection reaches the Host and terminal', () => state.view.settings.agentMode === 'ama'
      && state.terminal.screen().split('\n').slice(-2).join(' ').includes('AMA'));
    await writeFile(path.join(state.homeDir, 'boundary.txt'), 'BOUNDARY_TOOL_COMPLETED\n');
    const beforeRequests = state.requests.length;
    await state.terminal.submit('ACCEPT_BOUNDARY_HOLD');
    await waitFor('initial boundary response remains streaming', () => state.terminal.screen().includes('BEGIN_ACCEPT_BOUNDARY_HOLD'));
    const runId = await waitFor('initial boundary Run identity', () => state.view.runs.find(run => run.phase === 'running')?.runId);
    await state.terminal.submit('ACCEPT_BOUNDARY_NEXT');
    const queued = await waitFor('busy keyboard input reaches the Host queue', () =>
      state.view.queue.find(input => input.text === 'ACCEPT_BOUNDARY_NEXT'));
    await waitFor('the terminal displays the queued input', () => state.terminal.screen().includes('[1/1] ACCEPT_BOUNDARY_NEXT'));
    assert.equal(state.requests.length, beforeRequests + 1, 'The first provider response must still be held');
    state.pending.get('boundary-tool')();
    const secondRequest = await waitFor('same Run reaches the provider again after its tool', () => state.requests[beforeRequests + 1]);
    await state.terminal.save('queue-model-boundary');
    await saveFacts(state, 'queue-model-boundary');
    const userMessages = secondRequest.messages.filter(message => message.role === 'user');
    assert.equal((JSON.stringify(userMessages).match(/ACCEPT_BOUNDARY_NEXT/g) ?? []).length, 1,
      'Queued keyboard input must reach the next provider call, before the current Run ends');
    await waitFor('consumed input leaves the Host queue while the response is held', () =>
      !state.view.queue.some(input => input.inputId === queued.inputId));
    assert.equal((await state.client.runs.read(runId)).phase, 'running', 'The original Run must still own the held response');
    assert.equal(state.view.runs.find(run => run.phase === 'running')?.runId, runId,
      'Consuming the queued input must not require starting a continuation Run');
    await waitFor('next provider response streams through the same terminal', () =>
      state.terminal.screen().includes('BEGIN_ACCEPT_BOUNDARY_NEXT'));
    await waitFor('the terminal removes its consumed queue row', () =>
      !state.terminal.screen().includes('[1/1] ACCEPT_BOUNDARY_NEXT')
        && !state.terminal.screen().includes('↑ pull all into editor'));
    await waitFor('AMA keeps the consumed query body in ordinary history', () =>
      state.terminal.screen().split('\n').some(line => line.trim() === 'ACCEPT_BOUNDARY_NEXT'));
    await state.terminal.save('queue-model-boundary-consumed');
    await saveFacts(state, 'queue-model-boundary-consumed');
    state.pending.get('ACCEPT_BOUNDARY_NEXT')();
    await waitFor('original boundary Run completes', async () => (await state.client.runs.read(runId)).phase === 'completed');
  } finally {
    await state.client.sessions.updateSettings(state.sessionId, { agentMode: originalAgentMode ?? null });
  }
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

async function checkTranscriptKeys(state) {
  await state.terminal.submit('ACCEPT_HOLD_TRANSCRIPT');
  await waitFor('live reply', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_TRANSCRIPT'));
  await state.terminal.type('UNSUBMITTED_DRAFT');
  await state.terminal.type('\x0f');
  await waitFor('transcript mode', () => state.terminal.screen().includes('Ctrl+E show all'));
  state.pending.get('grow')();
  await waitFor('Host grows after snapshot', () => state.view.items.some(item => item.text.includes('LATE_AFTER_FREEZE_MARKER')));
  await state.terminal.type('\x1b[D');
  await state.terminal.type('v');
  await delay(600);
  await state.terminal.type('G');
  assert.ok(!state.terminal.screen().includes('LATE_AFTER_FREEZE_MARKER'),
    'Expanding a single item must preserve the captured content boundary');
  await state.terminal.type('\x05');
  await waitFor('Ctrl+E expands complete history', () => state.terminal.screen().includes('Ctrl+E collapse'), 5000);
  await waitFor('complete saved history loaded', () => state.terminal.screen().includes('Showing complete saved history'), 5000);
  await state.terminal.save('ctrl-e-expanded');
  assert.ok(state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_TRANSCRIPT'), 'Ctrl+E must retain the frozen in-flight reply');
  await state.terminal.type('q');
  await waitFor('draft restored', () => /^>.*UNSUBMITTED_DRAFT/m.test(state.terminal.screen()));
  await state.terminal.type('\x0f');
  await state.terminal.type('/');
  await waitFor('slash opens search', () => state.terminal.screen().includes('Type to search transcript'), 5000);
  await state.terminal.type('EARLY_FROZEN_MARKER');
  await waitFor('frozen reply searchable', () => state.terminal.screen().includes('1/1'), 5000);
  await state.terminal.type('\r');
  await waitFor('search submits selected match', () => !state.terminal.screen().includes('Type to search transcript'));
  await state.terminal.type('q');
  await waitFor('draft restored after search', () => /^>.*UNSUBMITTED_DRAFT/m.test(state.terminal.screen()));
  await state.terminal.type('\x05'); // Prompt Ctrl+E moves to the end of the restored draft.
  await state.terminal.type('\x15');
  state.pending.get('ACCEPT_HOLD_TRANSCRIPT')();
}

async function checkTranscriptPaint(state) {
  await state.terminal.resize(240, 64);
  await state.terminal.submit('/agent-mode ama');
  await waitFor('AMA paint setting', async () => (await state.client.sessions.getSettings(state.sessionId)).agentMode === 'ama');
  await delay(300);
  await state.terminal.submit('ACCEPT_HOLD_PAINT');
  await waitFor('long tabbed reply', () => state.terminal.screen().includes('BEGIN_ACCEPT_HOLD_PAINT'));
  await state.terminal.type('\x0f');
  await waitFor('paint transcript', () => state.terminal.screen().includes('Ctrl+E show all'));
  for (const key of ['\x05', 'g', '/', '\x1b', 'G', '\x05']) {
    await state.terminal.type(key);
    if (key === '/') continue;
    await delay(400);
    const footer = state.terminal.screen().split('\n').slice(-3).map(row => row.trimEnd());
    assert.match(footer[0], /^ Transcript \| PgUp\/PgDn page \| j\/k scroll .* Ctrl\+O\/q\/Esc back$/, 'Transcript help row must be intact after each repaint');
    assert.match(footer[1], /^ ←\/→ enter select mode \| Ctrl\+E (show all|collapse) \| Mouse drag selects text$/, 'Selection help must not contain old transcript text');
    assert.match(footer[2], /^ KodaX - AMA \| Edits \| off \|/, 'Status must remain on the final row');
    await state.terminal.save('paint-' + key.charCodeAt(0));
  }
  await state.terminal.resize(110, 32);
  await state.terminal.type('q');
  state.pending.get('ACCEPT_HOLD_PAINT')();
  await waitFor('paint round settled', () => state.view.runs.every(run => run.phase === 'completed'));
  await waitFor('paint prompt ready', () => /^>\s+Type a message/m.test(state.terminal.screen()));
  await state.terminal.submit('/agent-mode sa');
  await waitFor('restore SA after paint', async () => (await state.client.sessions.getSettings(state.sessionId)).agentMode === 'sa');
}

async function checkExit(state) {
  await state.terminal.submit('/exit');
  await waitFor('CLI exit', () => state.terminal.exited);
  assert.equal(state.terminal.exited.exitCode, 0);
}

async function checkLongHistoryPreviews(state) {
  assert.equal(state.mode, 'ink', 'The long-history screen regression exercises Ink');
  // This fixture exercises display budgets; authorize its controlled local tools explicitly.
  await state.client.sessions.updateSettings(state.sessionId, { permissionMode: 'full-access' });
  await Promise.all(Array.from({ length: 24 }, (_, index) => writeFile(path.join(state.homeDir, `archive-${index}.txt`),
    Array.from({ length: 100 }, (_, line) => `ARCHIVE_${index}_${line} ${'payload '.repeat(16)}`).join('\n'))));
  for (const token of ['ACCEPT_ARCHIVE_EARLY', ...'ABCDEFGH'.split('').map(letter => `ACCEPT_ARCHIVE_FILL_${letter}`)]) {
    await state.terminal.submit(token);
    await waitFor(`${token} completes`, () => state.view.items.some(item => item.text.includes(`END_${token}`)), 45000);
    await waitFor(`${token} settles`, () => state.view.runs.every(run => run.phase === 'completed'));
    await waitFor(`${token} input ready`, () => /^>\s+Type a message/m.test(state.terminal.screen()));
    await delay(300);
  }
  const tools = state.view.items.filter(item => item.tool?.name === 'read');
  assert.equal(tools.length, 24, 'Twenty-four real tool results must reach the Host');
  assert.ok(tools.reduce((sum, item) => sum + Math.min(8192, item.totalTextLength ?? item.text.length), 0) > 128 * 1024,
    'The fixture must exceed the shared preview budget across distinct items');
  assert.ok(state.view.items.reduce((sum, item) => sum + item.text.length + (item.tool?.inputText?.length ?? 0), 0) <= 128 * 1024,
    'The preview replacement budget must remain bounded at 128 KiB');
  const earlyTool = state.view.items.find(item => item.tool?.callId === 'ACCEPT_ARCHIVE_EARLY-0');
  assert.ok(earlyTool, 'The early Bash item must remain in the 150-item window');
  const fullInput = await state.client.sessions.readItem(state.sessionId, earlyTool.id, { part: 'input', offset: 0 });
  assert.ok(fullInput.text.includes('ACCEPT_OLD_BASH_1'), 'The full reader proves the old Bash input was retained');
  // Resize the normal live surface to force a complete repaint, without Ctrl+O
  // or readItem hydration that could hide blank previews in the ordinary UI.
  await state.terminal.resize(180, 250);
  await state.terminal.save('long-history-live');
  await saveFacts(state, 'long-history-live');
  const screen = state.terminal.screen();
  assert.ok(screen.split('\n').some(line => line.trim() === 'ACCEPT_ARCHIVE_EARLY'),
    'Normal live history must retain the early query body after preview budget saturation');
  for (const text of ['END_ACCEPT_ARCHIVE_EARLY',
    'THINKING_ACCEPT_ARCHIVE_EARLY', 'cmd=echo ACCEPT_OLD_BASH_1']) {
    assert.ok(screen.includes(text), `Normal live history must retain visible ${text} after preview budget saturation`);
  }
  assert.ok(earlyTool.tool.inputText?.includes('ACCEPT_OLD_BASH_1'), 'The old Bash input preview must remain nonempty');
  assert.equal(screen.split('\n').filter(line => /^Tools \[/.test(line.trim())).length, 9,
    'Each contiguous tool batch must share one Tools heading, preserving the nine round boundaries');
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
        if (['accepted', 'queued', 'running', 'waiting_user', 'waiting_agent', 'recovering'].includes(run.phase)) {
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
  if (state.terminal && !state.terminal.exited) {
    const promptReady = state.mode === 'ink'
      ? /^>\s+Type a message/m.test(state.terminal.screen())
      : /^kodax:.*>\s*$/.test(state.terminal.cursorLine());
    if (promptReady) {
      await state.terminal.submit('/exit');
      await Promise.race([state.terminal.exit, delay(3000)]);
    }
  }
  state.terminal?.dispose();
  if (state.terminal) await state.terminal.exit;
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
    // The source Host launcher resolves its --import tsx from the project cwd.
    if (sourceEntry) await symlink(path.join(repo, 'node_modules'), path.join(state.homeDir, 'node_modules'), 'junction');
    await setupHostCommands(state);
    state.terminal = openTerminal(state.homeDir, mode);
    await check(state, 'startup', checkStartup);
    await check(state, 'host-provider-capabilities', checkProviderCapabilities);
    await check(state, 'host-setting-commands', checkHostSettingCommands);
    await check(state, 'host-execution-controls', checkHostExecutionControls);
    await check(state, 'host-session-list', checkHostSessionList);
    if (consumerOnly) {
      await check(state, 'host-session-transitions', checkHostSessionTransitions);
      await check(state, 'exit', checkExit);
      return;
    }
    if (longHistoryOnly) {
      await check(state, 'long-history-preview-budget', checkLongHistoryPreviews);
      await check(state, 'exit', checkExit);
      return;
    }
    if (queueBoundaryOnly) {
      await check(state, 'busy-queue-next-model-boundary', checkQueueModelBoundary);
      await check(state, 'exit', checkExit);
      return;
    }
    await check(state, 'registered-extension-no-output', checkHostCommandNoOutput);
    await check(state, 'registered-extension-help', checkHostCommandHelp);
    await check(state, 'host-diagnostics-and-manual-shell', checkHostDiagnosticsAndShell);
    await check(state, 'prompt-stream-complete', checkPrompt);
    await check(state, 'session-settings-roundtrip', checkSettings);
    if (mode === 'ink') await check(state, 'ama-presentation', checkAmaPresentation);
    if (mode === 'ink') await check(state, 'tool-presentation', checkToolPresentation);
    await check(state, 'multiline-long-input', checkLongInput);
    await check(state, 'question-dialog-roundtrip', checkQuestion);
    if (mode === 'ink') await check(state, 'busy-queue-withdraw-edit', checkQueue);
    if (mode === 'ink') await check(state, 'busy-queue-next-model-boundary', checkQueueModelBoundary);
    if (mode === 'ink') await check(state, 'history-search-frozen-live-view', checkFrozenHistory);
    if (mode === 'ink') await check(state, 'transcript-keyboard-frozen-content-and-draft', checkTranscriptKeys);
    if (mode === 'ink') await check(state, 'transcript-control-character-paint', checkTranscriptPaint);
    await check(state, 'stop-and-next-input', checkStop);
    await check(state, 'registered-extension-run-and-follow-up', checkHostCommandRun);
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
  const requestedModes = process.argv.slice(2).filter(argument => !['--source', '--long-history-only', '--queue-boundary-only', '--consumer-only'].includes(argument));
  const modes = requestedModes.length ? requestedModes : longHistoryOnly || queueBoundaryOnly ? ['ink'] : ['ink', 'classic'];
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
