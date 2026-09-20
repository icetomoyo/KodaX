// One-off E2E: prove the ask_user_question flow still works end-to-end behind
// the Runtime approval gate that T38-T42 introduced for fresh sessions.
// Classic REPL only; answers 'y' at the approval prompt, then picks Beta.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readReplFixtureDaemonOwner, replFixtureEnvironment, stopReplFixtureDaemon } from './repl-fixture-daemon.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolRequire = createRequire(path.join(
  process.env.KODAX_ACCEPTANCE_TOOLS ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json',
));
const pty = toolRequire('node-pty');
const { Terminal } = toolRequire('@xterm/headless');
let Unicode11Addon;
({ Unicode11Addon } = toolRequire('@xterm/addon-unicode11'));

const artifacts = await mkdtemp(path.join(os.tmpdir(), 'kodax-question-gate-'));
const homeDir = artifacts;
const state = { requests: [], providerErrors: [] };
process.stdout.write(`Artifacts: ${artifacts}\n`);

async function respondToModelRequest(request, response) {
  let body = '';
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body);
  state.requests.push(data);
  const isToolAnswer = data.messages.at(-1).role === 'tool';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (!isToolAnswer) {
    response.end(`data: ${JSON.stringify({ id: 'q', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'q1', type: 'function',
        function: { name: 'ask_user_question', arguments: JSON.stringify({
          question: 'Which acceptance option?', options: [
            { label: 'Alpha', value: 'alpha' }, { label: 'Beta', value: 'beta' },
          ], allow_custom_input: false,
        }) },
      }] }, finish_reason: 'tool_calls' }],
    })}\n\ndata: [DONE]\n\n`);
    return;
  }
  response.end(`data: ${JSON.stringify({ id: 'q', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: ' END_ACCEPT_QUESTION' }, finish_reason: null }],
  })}\n\n` + `data: ${JSON.stringify({ id: 'q', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  })}\n\ndata: [DONE]\n\n`);
}

const server = createServer((request, response) => {
  respondToModelRequest(request, response).catch(error => {
    state.providerErrors.push(String(error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
let child;
let terminal;
let exited;
let daemonOwner;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({
    provider: 'parity-local', customProviders: [{
      name: 'parity-local', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKeyEnv: 'KODAX_ACCEPTANCE_KEY', model: 'parity-model',
      contextWindow: 65536, maxOutputTokens: 1024,
    }],
  }));

  terminal = new Terminal({ cols: 110, rows: 32, scrollback: 10000, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const environment = Object.fromEntries(Object.entries(replFixtureEnvironment(homeDir)).filter(([name]) => name.toUpperCase() !== 'NO_COLOR'));
  child = pty.spawn(process.execPath, [path.join(repo, 'scripts/kodax-bin.cjs'),
    '--provider', 'parity-local', '--model', 'parity-model', '--effort', 'off',
    '--agent-mode', 'sa', '--max-iter', '7'], {
    name: 'xterm-256color', cols: 110, rows: 32, cwd: homeDir,
    env: { ...environment, HOME: homeDir, USERPROFILE: homeDir, KODAX_HOME: path.join(homeDir, '.kodax'),
      KODAX_ACCEPTANCE_KEY: 'local-fixture-only', KODAX_TRACING: '0',
      KODAX_FORCE_INK: '0', KODAX_TUI_RENDERER: 'owned', KODAX_FORCE_CLASSIC_REPL: '1',
      TERM: 'xterm-256color', CI: 'false', CONTINUOUS_INTEGRATION: 'false', FORCE_COLOR: '1' },
  });
  let raw = '';
  child.onExit(value => { exited = value; });
  child.onData(data => { raw += data; terminal.write(data); });
  terminal.onData(data => child.write(data));
  const screen = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, i) =>
      buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '').join('\n');
  };
  const type = async (text) => { child.write(text); await delay(150); };
  const submit = async (text) => { await type(text); child.write('\r'); };

  async function waitFor(stamp, predicate, timeout = 25_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(50);
    }
    await writeFile(path.join(artifacts, 'fail.txt'), screen());
    await writeFile(path.join(artifacts, 'fail.ansi'), raw);
    throw new Error(`Timed out: ${stamp}`);
  }

  await waitFor('classic prompt ready', () => /^kodax:.*>\s*$/.test(terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)?.translateToString(true) ?? ''));
  daemonOwner = await readReplFixtureDaemonOwner(homeDir);
  await submit('ACCEPT_QUESTION');
  let approvalSeen = false;
  await waitFor('approval or question dialog', () => {
    const s = screen();
    if (s.includes('Execute ask_user_question?')) approvalSeen = true;
    return s.includes('Execute ask_user_question?') || s.includes('Which acceptance option?');
  });
  if (approvalSeen) {
    process.stdout.write('approval gate present: answering y\n');
    await submit('y');
  }
  await waitFor('question dialog', () => screen().includes('Which acceptance option?'));
  await waitFor('choice prompt', () => screen().toLowerCase().includes('choice'), 8_000)
    .catch(() => process.stdout.write('NOTE: no choice prompt text; answering 2 blindly\n'));
  await submit('2');
  await waitFor('answer response', () => screen().includes('END_ACCEPT_QUESTION'));
  const toolMessages = state.requests
    .filter(request => request.messages.at(-1)?.role === 'tool')
    .flatMap(request => request.messages.at(-1).content);
  const answerText = typeof toolMessages.at(-1) === 'string' ? toolMessages.at(-1)
    : JSON.stringify(toolMessages.at(-1) ?? '');
  assert.ok(answerText.includes('beta'), `tool answer must carry beta, got: ${answerText.slice(0, 200)}`);
  process.stdout.write(`PASS question flow behind gate (approvalSeen=${approvalSeen}, beta returned to model)\n`);
  await writeFile(path.join(artifacts, 'pass.txt'), screen());
} finally {
  const cleanupErrors = [];
  try {
    try {
      if (child && !exited) {
        child.kill();
        const deadline = Date.now() + 5_000;
        while (!exited && Date.now() < deadline) await delay(50);
        assert.ok(exited, 'Fixture terminal must exit before teardown completes');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await stopReplFixtureDaemon({ repo, homeDir, owner: daemonOwner });
    } catch (error) {
      cleanupErrors.push(error);
    }
  } finally {
    terminal?.dispose();
    server.closeAllConnections();
    server.close();
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Question fixture cleanup failed');
}
