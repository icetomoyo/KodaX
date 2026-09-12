import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectKodaXClient } from '../dist/sdk-client.js';

const requireTools = createRequire(path.join(process.env.KODAX_ACCEPTANCE_TOOLS
  ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json'));
const pty = requireTools('node-pty');
const { Terminal } = requireTools('@xterm/headless');
const { Unicode11Addon } = requireTools('@xterm/addon-unicode11');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-legacy-search-'));
const terminal = new Terminal({ cols: 110, rows: 32, scrollback: 10000, allowProposedApi: true });
terminal.loadAddon(new Unicode11Addon());
terminal.unicode.activeVersion = '11';
let raw = '';
let child;
let exit;
let exited = false;
let client;
const requestTexts = [];
const screen = () => Array.from({ length: terminal.rows }, (_, index) =>
  terminal.buffer.active.getLine(terminal.buffer.active.viewportY + index)?.translateToString(true) ?? '').join('\n');
async function waitFor(label, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function type(text) { child.write(text); await delay(180); }
async function submit(text) { await type(text); await type('\r'); }
async function save(name) {
  await writeFile(path.join(homeDir, `${name}.txt`), screen());
  await writeFile(path.join(homeDir, `${name}.ansi`), raw);
}
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body);
  const lastUser = data.messages.filter(message => message.role === 'user').at(-1)?.content;
  requestTexts.push(lastUser);
  const early = JSON.stringify(lastUser).includes('LEGACY_EARLY_QUERY');
  const content = early ? 'UNIQUE_LEGACY_EARLY_RESPONSE'
    : Array.from({ length: 100 }, (_, index) => `FILLER_LINE_${index} ${'body '.repeat(12)}`).join('\n') + '\nLEGACY_LATEST_RESPONSE';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'legacy-local', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({
      id: 'legacy-local', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 500, total_tokens: 550 },
    })}\n\ndata: [DONE]\n\n`);
});
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await mkdir(path.join(homeDir, '.kodax'));
  await symlink(path.join(repo, 'node_modules'), path.join(homeDir, 'node_modules'), 'junction');
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({
    provider: 'legacy-local', customProviders: [{ name: 'legacy-local', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'KODAX_ACCEPTANCE_KEY',
      model: 'acceptance-model', contextWindow: 65536, maxOutputTokens: 4096 }],
  }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'NO_COLOR'));
  child = pty.spawn(process.execPath, ['--require', path.join(repo, 'scripts/production-env.cjs'),
    '--import', pathToFileURL(path.join(repo, 'node_modules/tsx/dist/loader.mjs')).href,
    path.join(repo, 'src/kodax_bootstrap.ts'), '--provider', 'legacy-local', '--model', 'acceptance-model',
    '--agent-mode', 'sa', '--effort', 'off'], { name: 'xterm-256color', cols: 110, rows: 32, cwd: homeDir,
    env: { ...environment, HOME: homeDir, USERPROFILE: homeDir, KODAX_HOME: path.join(homeDir, '.kodax'),
      KODAX_ACCEPTANCE_KEY: 'local-fixture-only', KODAX_TRACING: '0', KODAX_FORCE_INK: '1',
      KODAX_TUI_RENDERER: 'legacy', KODAX_FORCE_CLASSIC_REPL: '0', TERM: 'xterm-256color',
      CI: 'false', CONTINUOUS_INTEGRATION: 'false', FORCE_COLOR: '1' },
  });
  exit = new Promise(resolve => child.onExit(event => { exited = true; resolve(event); }));
  child.onData(data => { raw += data; terminal.write(data); });
  terminal.onData(data => child.write(data));
  await waitFor('legacy CLI prompt', () => screen().includes('Type a message'), 50_000);
  client = await connectKodaXClient({ homeDir });
  await submit('LEGACY_EARLY_QUERY');
  await waitFor('early response', () => screen().includes('UNIQUE_LEGACY_EARLY_RESPONSE'));
  await waitFor('first prompt ready', () => /^>.*Type a message/m.test(screen()));
  await submit('LEGACY_FILLER_QUERY');
  await waitFor('latest response', () => screen().includes('LEGACY_LATEST_RESPONSE'));
  await waitFor('second prompt ready', () => /^>.*Type a message/m.test(screen()));
  await type('KEEP_UNSENT_DRAFT');
  await type('\x0f');
  await waitFor('transcript mode', () => screen().includes('Ctrl+E show all'));
  await type('/');
  await waitFor('search editor', () => screen().includes('Enter jump'));
  await type('UNIQUE_LEGACY_EARLY_RESPONSE');
  await waitFor('search match', () => screen().includes('1/1'));
  await type('\r');
  await waitFor('search closed', () => !screen().includes('Enter jump'));
  await save('after-search');
  await waitFor('target visible after Enter', () => screen().includes('UNIQUE_LEGACY_EARLY_RESPONSE'), 3000);
  await type('\x05');
  await waitFor('Ctrl+E collapses expanded search history', () => screen().includes('Ctrl+E show all'));
  await type('\x05');
  await waitFor('Ctrl+E expands saved history', () => screen().includes('Ctrl+E collapse'));
  await save('expanded-history');
  await type('q');
  await waitFor('draft restored after leaving transcript', () => /^>.*KEEP_UNSENT_DRAFT/m.test(screen()));
  await type('\x15');
  await submit('/exit');
  await waitFor('CLI exits', async () => Promise.race([exit.then(() => true), delay(25).then(() => false)]));
  const userRequests = requestTexts.filter(text => text === 'LEGACY_EARLY_QUERY' || text === 'LEGACY_FILLER_QUERY');
  assert.deepEqual(userRequests, ['LEGACY_EARLY_QUERY', 'LEGACY_FILLER_QUERY'], 'Transcript controls must not replay user requests');
  const auxiliary = requestTexts.filter(text => !userRequests.includes(text));
  assert.ok(auxiliary.every(text => JSON.parse(text).cacheDomain === 'learning-review'), 'Only existing episode Learning reviews may run in the background');
  process.stdout.write(`PASS legacy search, Ctrl+E, draft restoration, exit; artifacts: ${homeDir}\n`);
} catch (error) {
  await save('failure');
  await writeFile(path.join(homeDir, 'request-texts.json'), JSON.stringify(requestTexts, null, 2));
  process.stderr.write(`${String(error)}\nArtifacts: ${homeDir}\n`);
  process.exitCode = 1;
} finally {
  if (child) { if (!exited) child.kill(); await exit; }
  terminal.dispose();
  if (client) { try { await client.host.shutdown(); } finally { await client.disconnect(); } }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// node-pty retains ConPTY worker ports after natural child exit. Product exit
// and Host shutdown have settled above; explicitly finish only this driver.
process.exit(process.exitCode ?? 0);
