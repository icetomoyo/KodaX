import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-concurrent-resume-'));
const installation = path.join(root, 'installation');
const home = path.join(root, 'home');
const configHome = path.join(home, '.kodax');
const baseline = process.env.KODAX_ACCEPTANCE_BASELINE_INSTALLATION ?? repo;
const toolRequire = createRequire(path.join(
  process.env.KODAX_ACCEPTANCE_TOOLS ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json',
));
const pty = toolRequire('node-pty');
const { Terminal } = toolRequire('@xterm/headless');
const { Unicode11Addon } = toolRequire('@xterm/addon-unicode11');
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name, value]) => value !== undefined && name.toUpperCase() !== 'NO_COLOR'));
const env = { ...environment, KODAX_HOME: configHome, KODAX_TRACING: '0',
  DEEPSEEK_API_KEY: 'local-fixture-no-model-requests' };
const bin = path.join(installation, 'scripts/kodax-bin.cjs');
const clients = [];
const result = { root, baseline, clients: [] };
process.stdout.write(`Artifacts: ${root}\n`);

async function daemon(command) {
  const child = spawn(process.execPath, [bin, 'daemon', command, '--home', home, '--timeout-ms', '60000', '--json'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await writeFile(path.join(root, `daemon-${command}.log`), output);
  assert.equal(code, 0, output);
  return JSON.parse(output);
}

function openResume(cwd, index) {
  const terminal = new Terminal({ cols: 110, rows: 35, scrollback: 300, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const startedAt = performance.now();
  const child = pty.spawn(process.execPath, [bin, '-r'], { cwd, name: 'xterm-256color', cols: 110, rows: 35,
    env: { ...env, TERM: 'xterm-256color', KODAX_TUI_RENDERER: 'owned', KODAX_FORCE_CLASSIC_REPL: '0',
      CI: 'false', CONTINUOUS_INTEGRATION: 'false', FORCE_COLOR: '1' } });
  let raw = '';
  let selected = false;
  let readyAt;
  let exited;
  terminal.onData(data => child.write(data));
  child.onData(data => { raw += data; terminal.write(data); });
  const exit = new Promise(resolve => child.onExit(value => { exited = value; resolve(value); }));
  const poll = setInterval(() => {
    const buffer = terminal.buffer.active;
    const screen = Array.from({ length: terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n');
    if (!selected && screen.includes('Resume a session')) { selected = true; child.write('\r'); }
    if (readyAt === undefined && /^>\s+Type a message/m.test(screen)) readyAt = Math.round(performance.now() - startedAt);
  }, 25);
  return {
    get settled() { return readyAt !== undefined || exited !== undefined; },
    async finish() {
      if (readyAt !== undefined && exited === undefined) {
        child.write('/exit');
        await delay(200);
        child.write('\r');
      }
      if (exited === undefined) await Promise.race([exit, delay(15_000)]);
      const forced = exited === undefined;
      if (forced) child.kill();
      await exit;
      clearInterval(poll);
      await writeFile(path.join(root, `client-${index}.ansi`), raw);
      terminal.dispose();
      return { cwd, readyAt, forced, exit: exited,
        errors: raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]/).filter(line => line.includes('[Error]')) };
    },
  };
}

let started = false;
try {
  await mkdir(configHome, { recursive: true });
  await mkdir(installation);
  for (const name of ['dist', 'scripts', 'package.json']) {
    await cp(path.join(baseline, name), path.join(installation, name), { recursive: true });
  }
  await symlink(path.join(repo, 'node_modules'), path.join(installation, 'node_modules'), 'junction');
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ provider: 'deepseek' }));
  const sessions = path.join(configHome, 'sessions');
  await mkdir(sessions);
  const createdAt = '2026-10-15T00:00:00.000Z';
  const projects = ['alpha', 'beta'].map(name => path.join(root, name));
  for (const [index, project] of projects.entries()) {
    await mkdir(project);
    const id = `concurrent-${index}`;
    await writeFile(path.join(sessions, `${id}.jsonl`), [JSON.stringify({ _type: 'meta', id, title: id,
      scope: 'user', gitRoot: project, surface: 'repl', createdAt, lastMessageAt: createdAt, activeMessageCount: 1 }),
    JSON.stringify({ role: 'user', content: 'Saved conversation fixture', timestamp: createdAt }), ''].join('\n'));
  }
  const history = Array.from({ length: 1_000 }, (_, index) => JSON.stringify({
    role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(1_024), timestamp: createdAt,
  })).join('\n') + '\n';
  for (let index = 0; index < 50; index += 1) {
    const id = `large-history-${index}`;
    await writeFile(path.join(sessions, `${id}.jsonl`), JSON.stringify({ _type: 'meta', id, title: id,
      scope: 'user', gitRoot: path.join(root, 'other'), createdAt, activeMessageCount: 1_000 }) + '\n' + history);
  }
  await daemon('start');
  started = true;
  const stateFile = path.join(configHome, 'runtime/daemon/default/daemon.json');
  result.originalRuntimeId = JSON.parse(await readFile(stateFile, 'utf8')).runtimeId;
  // Replace only this private installation while the original Host is loaded.
  await cp(path.join(repo, 'dist'), path.join(installation, 'dist'), { recursive: true });
  const capabilities = path.join(installation, 'dist/provider-capabilities.json');
  await writeFile(capabilities, await readFile(capabilities, 'utf8') + '\n');
  for (const [index, project] of projects.entries()) clients.push(openResume(project, index));
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline && !clients.every(client => client.settled)) await delay(100);
  result.replacementRuntimeId = JSON.parse(await readFile(stateFile, 'utf8')).runtimeId;
  assert.notEqual(result.replacementRuntimeId, result.originalRuntimeId);
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  for (const finished of await Promise.allSettled(clients.map(client => client.finish()))) {
    if (finished.status === 'fulfilled') result.clients.push(finished.value);
    else { (result.clientCleanupErrors ??= []).push(String(finished.reason)); process.exitCode = 1; }
  }
  if (started) {
    try { result.stop = await daemon('stop'); assert.equal(result.stop.stopped, true); }
    catch (error) { result.cleanupError = String(error); process.exitCode = 1; }
  }
  if (result.clients.length !== 2 || result.clients.some(client => client.readyAt === undefined
    || client.forced || client.exit.exitCode !== 0 || client.errors.length > 0)) process.exitCode = 1;
  await writeFile(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + '\n');
}
// ConPTY worker ports can outlive the verified child exits on Windows.
process.exit(process.exitCode ?? 0);
