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
// Keep native terminal drivers outside the product dependency graph.
const toolRequire = createRequire(path.join(process.env.KODAX_ACCEPTANCE_TOOLS ?? path.join(os.tmpdir(), 'kodax-acceptance-tools'), 'package.json'));
const pty = toolRequire('node-pty');
const { Terminal } = toolRequire('@xterm/headless');
let Unicode11Addon;
try {
    ({ Unicode11Addon } = toolRequire('@xterm/addon-unicode11'));
}
catch (error) {
    throw new Error('PTY screen checks require @xterm/addon-unicode11; install the dependencies in FEATURE_298_v0.7.97_TEST_GUIDE.md.', { cause: error });
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'kodax-repl-acceptance-'));
const sourceEntry = process.argv.includes('--source');
const distinct = process.argv.includes('--distinct');
const toolCount = distinct ? 160 : 250;
const fileIndex = index => distinct || index < 100 ? index : 100;
process.stdout.write(`Artifacts: ${artifacts}\n`);
async function waitFor(label, predicate, timeout = 25000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value)
            return value;
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
        get modes() { return terminal.modes; }, get bufferType() { return terminal.buffer.active.type; }, child, exit, get exited() { return exited; },
        cursorLine() {
            const buffer = terminal.buffer.active;
            return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
        },
        screen() {
            const buffer = terminal.buffer.active;
            return Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '').join('\n');
        },
        async save(name) {
            await writeFile(path.join(artifacts, `${mode}-${name}.ansi`), raw);
            await writeFile(path.join(artifacts, `${mode}-${name}.txt`), this.screen());
        },
        async type(text) { child.write(text); await delay(150); },
        async submit(text) { await this.type(text); child.write('\r'); },
        dispose() { if (!exited)
            child.kill(); terminal.dispose(); },
    };
}
const homeDir = path.join(artifacts, 'home');
await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
if (sourceEntry)
    await symlink(path.join(repo, 'node_modules'), path.join(homeDir, 'node_modules'), 'junction');
for (let i = 0; i < toolCount; i++)
    await writeFile(path.join(homeDir, `scroll-${String(fileIndex(i)).padStart(3, '0')}.txt`), `EVIDENCE_${i}`);
let requests = 0;
let finalStarted = false;
let released = false;
const pendingResponses = new Set();
const finishResponse = response => response.end(`data: ${JSON.stringify({ id: 'scroll-ab', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req)
        body += chunk;
    const data = JSON.parse(body);
    requests++;
    const toolDone = data.messages.some(m => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'scroll-ab', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!toolDone) {
        emit({ content: 'SCROLL_PREFACE_RETAIN_ME' });
        emit({ tool_calls: Array.from({ length: toolCount }, (_, i) => ({ index: i, id: `scroll-call-${i}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(homeDir, `scroll-${String(fileIndex(i)).padStart(3, '0')}.txt`) }) } })) }, 'tool_calls');
        res.end('data: [DONE]\n\n');
    }
    else {
        finalStarted = true;
        if (!distinct)
            emit({ reasoning_content: Array.from({ length: 100 }, (_, i) => `THINKING_LINE_${String(i).padStart(3, '0')}`).join('\n') + '\n' });
        emit({ content: 'SCROLL_FINAL_ANSWER_PRESENT\n' + (distinct ? Array.from({ length: 70 }, (_, i) => `FINAL_LINE_${String(i).padStart(3, '0')}`).join('\n') : 'FINAL_LINE_069') + '\n' });
        if (released)
            finishResponse(res);
        else {
            pendingResponses.add(res);
            res.on('close', () => pendingResponses.delete(res));
        }
    }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'acceptance-local', learning: { enabled: false }, customProviders: [{ name: 'acceptance-local', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'KODAX_ACCEPTANCE_KEY', model: 'acceptance-model', contextWindow: 1000000, maxOutputTokens: 8192 }] }));
const term = openTerminal(homeDir, 'ink');
let client;
let observation;
let latestView;
try {
    await term.resize(220, 58);
    await waitFor('prompt ready', () => { if (term.exited)
        throw new Error(term.screen()); return term.screen().includes('Type a message'); }, 40000);
    client = await connectKodaXClient({ homeDir });
    const session = (await client.sessions.list())[0];
    assert.ok(session, 'CLI must create its Session before accepting input');
    observation = await client.sessions.observe(session.id, view => { latestView = view; });
    await delay(2000);
    await term.submit('SCROLL_ORIGINAL_QUERY_RETAIN_ME');
    await delay(400);
    await term.save('submitted');
    if (term.cursorLine().includes('SCROLL_ORIGINAL_QUERY_RETAIN_ME'))
        await term.type('\r');
    await waitFor('tools settled and final text started', () => { if (term.exited)
        throw new Error(term.screen()); return finalStarted && term.screen().includes('FINAL_LINE_069'); }, 120000);
    await term.save('live-bottom');
    const liveBottom = term.screen();
    await term.type('\x1b[<64;20;8M');
    await delay(500);
    const liveWheel = term.screen() !== liveBottom;
    await waitFor('live activity while reading saved history', () =>
        term.screen().includes('Back to live: End')
        && term.screen().split('\n').slice(-7).some(line => /Thinking|Receiving/.test(line)));
    const browseShowsLiveActivity = true;
    await term.save('live-wheel');
    released = true;
    for (const response of pendingResponses)
        finishResponse(response);
    pendingResponses.clear();
    const runId = latestView.runs.at(-1)?.runId;
    assert.ok(runId, 'streamed output must belong to a Host Run');
    await waitFor('actual Run completion', async () => {
        const run = await client.runs.read(runId);
        if (['failed', 'interrupted', 'unknown'].includes(run.phase))
            throw new Error(`Unexpected terminal: ${JSON.stringify(run)}`);
        return run.phase === 'completed';
    }, 60000);
    assert.equal((await client.runs.await(runId)).phase, 'completed');
    await waitFor('completion updates controls without leaving history', () =>
        term.screen().includes('Back to live: End')
        && term.screen().includes('Type a message')
        && !term.screen().split('\n').slice(-7).some(line => /Thinking|Receiving/.test(line)));
    const browseReflectsCompletion = true;
    await term.save('completed-while-browsing');
    await term.type('\x1b[F');
    await delay(500);
    await term.save('settled-bottom');
    const settled = term.screen();
    await term.type('\x1b[<64;20;8M');
    await delay(500);
    const settledWheel = term.screen() !== settled;
    for (let i = 0; i < 80; i++)
        await term.type('\x1b[5~');
    await term.save('settled-top');
    const normalTop = term.screen();
    let downVisitsMiddle = false;
    for (let i = 0; i < 80; i++) {
        await term.type('\x1b[6~');
        downVisitsMiddle ||= term.screen().includes('scroll-080.txt');
    }
    await waitFor('ordinary downward navigation returns to the live edge', () =>
        term.screen().includes('FINAL_LINE_069') && !term.screen().includes('Back to live: End'));
    await term.save('settled-down-latest');
    assert.equal(downVisitsMiddle, true, 'downward navigation must pass through intervening history');
    await term.type('\x0f');
    await delay(700);
    await term.save('transcript-compact-bottom');
    const compactBottom = term.screen();
    await term.type('\x1b[<64;20;8M');
    await delay(500);
    const compactTranscriptWheel = term.screen() !== compactBottom;
    await term.save('transcript-compact-wheel');
    await term.type('\x05');
    await delay(1000);
    for (let i = 0; i < 80; i++)
        await term.type('\x1b[5~');
    await term.save('transcript-top');
    const result = { repo, sourceEntry, distinct, requests, liveWheel, settledWheel, compactTranscriptWheel, browseShowsLiveActivity, browseReflectsCompletion, downVisitsMiddle, normalTopHasQuery: normalTop.includes('SCROLL_ORIGINAL_QUERY_RETAIN_ME'), normalTopHasPreface: normalTop.includes('SCROLL_PREFACE_RETAIN_ME'), normalTopHasFirstTool: normalTop.includes('scroll-000.txt'), settledHasFinal: settled.includes('SCROLL_FINAL_ANSWER_PRESENT') || settled.includes('FINAL_LINE_069'), transcriptHasQuery: term.screen().includes('SCROLL_ORIGINAL_QUERY_RETAIN_ME') };
    await writeFile(path.join(artifacts, 'probe-results.json'), JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result) + '\n');
    assert.equal(result.normalTopHasQuery, true, 'ordinary browsing must retain the original query beyond 150 items');
    assert.equal(result.normalTopHasFirstTool, true, 'ordinary browsing must recover the first tool');
    assert.equal(result.settledWheel, true, 'upward wheel must browse even when the live document fits one screen');
    assert.equal(result.settledHasFinal, true, 'return-to-latest must show the final answer');
    assert.equal(result.transcriptHasQuery, true, 'existing transcript expansion must retain full history');
    // End already leaves transcript mode and returns to the ordinary live edge.
    await term.type('\x1b[F');
    await waitFor('ordinary prompt restored before exit', () => term.screen().includes('Type a message'));
    await term.submit('/exit');
    await waitFor('CLI exit', () => term.exited);
    assert.equal(term.exited.exitCode, 0);
}
finally {
    observation?.close();
    await term.save('before-cleanup');
    if (!term.exited) {
        await term.type('\x03');
        await term.type('\x03');
        await Promise.race([term.exit, delay(3000)]);
    }
    await term.save('last');
    term.dispose();
    await term.exit;
    try {
        if (client) {
            for (const session of await client.sessions.list()) {
                let view;
                const observation = await client.sessions.observe(session.id, next => { view = next; });
                observation.close();
                for (const run of view.runs) {
                    if (!['completed', 'failed', 'interrupted', 'unknown'].includes(run.phase)) {
                        await client.runs.stop(run.runId);
                        await client.runs.await(run.runId);
                    }
                }
            }
            await client.host.shutdown();
        }
    }
    finally {
        await client?.disconnect();
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}
// Match the main PTY harness: node-pty can retain its Windows console helper
// handles after a successful CLI exit. All assertions and Host cleanup finished.
process.stdout.write('PASS: screen assertions, CLI exit and isolated Host cleanup completed.\n');
process.exit(0);
