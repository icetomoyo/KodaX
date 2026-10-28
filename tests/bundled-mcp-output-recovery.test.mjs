import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connectKodaXClient } from '../dist/sdk-client.js';
import { ensureKodaXRuntime, waitForRuntimeDaemonShutdown } from '../dist/sdk-runtime.js';

const body = JSON.stringify({ prefix: '你😀'.repeat(12_000), middle: 'MCP_MIDDLE_EVIDENCE',
  suffix: 'Ω'.repeat(35_000), tail: 'MCP_TAIL_EVIDENCE' });
const middleOffset = Array.from(body.slice(0, body.indexOf('MCP_MIDDLE_EVIDENCE'))).length - 10;
const provider = 'mcp-output-e2e';

async function readAll(read) {
  let offset = 0;
  let text = '';
  for (;;) {
    const page = await read(offset);
    assert.ok(page, 'Expected a retained tool result');
    assert.equal(page.offset, offset);
    assert.ok(page.text.length <= 65_536);
    text += page.text;
    if (page.nextOffset === undefined) {
      assert.equal(text.length, page.totalLength);
      return text;
    }
    assert.ok(page.nextOffset > offset, 'Original paging must advance');
    offset = page.nextOffset;
  }
}

for (const scenario of ['recoverable', 'without-read', 'storage-failure']) {
  test(`bundled SDK preserves MCP output end to end: ${scenario}`, { timeout: 120_000 }, async (t) => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'kodax-bundle-mcp-output-'));
    const configHome = path.join(homeDir, '.kodax');
    const outputDir = path.join(homeDir, 'tool-results');
    const previousHome = process.env.KODAX_HOME;
    const previousOutputDir = process.env.KODAX_TOOL_OUTPUT_DIR;
    process.env.KODAX_HOME = configHome;
    process.env.KODAX_TOOL_OUTPUT_DIR = outputDir;
    let runtime;
    let client;
    let owner;
    let observedMcp = false;
    let recoveredMiddle = false;
    let primaryRequests = 0;
    const requestErrors = [];
    const server = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const names = payload.tools?.map(tool => tool.function?.name) ?? [];
        let tool;
        let args;
        let answer = 'Auxiliary fixture response.';
        if (names.includes('commit_episode_learning_review')) {
          tool = 'commit_episode_learning_review';
          args = { memoryPlan: { actions: [], warnings: [] },
            capabilityDecision: { disposition: 'discard', reasonCodes: ['fixture-no-reusable-method'] } };
        } else if (names.includes('mcp_call')) {
          primaryRequests++;
          const result = [...payload.messages].reverse().find(message => message.role === 'tool');
          if (result?.tool_call_id === 'mcp-output-call') {
            observedMcp = true;
            const content = String(result.content);
            if (scenario === 'recoverable') {
              assert.match(content, /KODAX_RESULT_INCOMPLETE/);
              assert.ok(!content.includes('MCP_MIDDLE_EVIDENCE'), 'The model preview must omit the middle evidence');
              const output = /Full output saved to: ([\s\S]*?\.txt)\./.exec(content)?.[1];
              assert.ok(output, 'The model must receive its recovery locator');
              tool = 'read';
              args = { path: output, offset: 7, limit: 1, line_offset: middleOffset };
            } else {
              assert.ok(content.includes(body), 'A result without a usable recovery path must remain complete');
              assert.ok(content.includes('STRUCTURED_EVIDENCE'));
              assert.doesNotMatch(content, /KODAX_RESULT_INCOMPLETE/);
              answer = 'MCP-E2E complete without losing content.';
            }
          } else if (result?.tool_call_id === 'mcp-output-read') {
            assert.ok(String(result.content).includes('MCP_MIDDLE_EVIDENCE'), 'The actual read tool must recover omitted evidence');
            recoveredMiddle = true;
            answer = 'MCP-E2E recovered the complete evidence.';
          } else {
            tool = 'mcp_call';
            args = { id: 'mcp:demo:tool:huge', args: {} };
          }
        }
        const delta = tool ? { tool_calls: [{ index: 0,
          id: tool === 'read' ? 'mcp-output-read' : tool === 'mcp_call' ? 'mcp-output-call' : 'learning-review',
          type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: answer };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'mcp-e2e-response', object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
        })}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        requestErrors.push(error);
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    const connection = { homeDir, profile: 'mcp-output', daemonOrphanExitMs: 1000,
      daemonStartupTimeoutMs: 60_000 };
    const stopHost = async () => {
      await client?.disconnect();
      client = undefined;
      try { await runtime?.daemon.shutdown(); }
      finally { await runtime?.close(); runtime = undefined; }
      if (owner) {
        const stopped = await waitForRuntimeDaemonShutdown({ configHome, profile: connection.profile, owner });
        assert.equal(stopped.status, 'succeeded');
        owner = undefined;
      }
    };
    t.after(async () => {
      try { await stopHost(); }
      finally {
        try {
          server.closeAllConnections();
          if (server.listening) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          }
        } finally {
          if (previousHome === undefined) delete process.env.KODAX_HOME;
          else process.env.KODAX_HOME = previousHome;
          if (previousOutputDir === undefined) delete process.env.KODAX_TOOL_OUTPUT_DIR;
          else process.env.KODAX_TOOL_OUTPUT_DIR = previousOutputDir;
          assert.equal(path.dirname(homeDir), path.resolve(tmpdir()));
          await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        }
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    await mkdir(configHome, { recursive: true });
    if (scenario === 'storage-failure') await writeFile(outputDir, 'This file prevents artifact directory creation.');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{
      name: provider, protocol: 'openai', model: 'fixture', contextWindow: 262_144, maxOutputTokens: 1024,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_MCP_E2E_UNUSED_KEY',
    }] }));
    const serverPath = path.join(homeDir, 'mcp-server.cjs');
    const callLog = path.join(homeDir, 'mcp-calls.txt');
    await writeFile(serverPath, `
      const fs = require('node:fs');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line); if (message.id === undefined) return;
        let result = {};
        if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mcp-output-fixture', version: '1' } };
        if (message.method === 'tools/list') result = { tools: [{ name: 'huge', inputSchema: { type: 'object' } }] };
        if (message.method === 'tools/call') {
          fs.appendFileSync(${JSON.stringify(callLog)}, 'called\\n');
          result = { content: [{ type: 'text', text: ${JSON.stringify(body)} }], structuredContent: { evidence: 'STRUCTURED_EVIDENCE' } };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      });
    `);
    runtime = await ensureKodaXRuntime(connection);
    owner = (await runtime.daemon.inspect()).owner;
    assert.ok(owner);
    assert.notEqual(owner.pid, process.pid, 'The published SDK must use a separate daemon process');
    const lease = await runtime.credentials.registerScoped({ providers: [provider] }, async () => 'synthetic-mcp-test-key');
    const session = await runtime.sessions.create({ projectPath: homeDir, mcpServers: {
      demo: { type: 'stdio', command: process.execPath, args: [serverPath] },
    } });
    await runtime.sessions.updateSettings(session.id, { provider, model: 'fixture', agentMode: 'sa', permissionMode: 'full-access' });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: `MCP-E2E ${scenario}`,
      options: { agentMode: 'sa', context: { repoIntelligenceMode: 'off',
        ...(scenario === 'without-read' ? { excludeTools: ['read'] } : {}) } },
      credential: { leaseId: lease.id, mode: 'scoped', providers: [provider] },
    });
    const outcome = await run.result;
    assert.deepEqual(requestErrors, []);
    assert.equal(outcome.phase, 'completed', JSON.stringify(outcome));
    assert.equal(observedMcp, true);
    assert.equal(primaryRequests, scenario === 'recoverable' ? 3 : 2);
    assert.equal(recoveredMiddle, scenario === 'recoverable');
    const requestsBeforeReading = primaryRequests;
    let original;
    const incarnations = scenario === 'recoverable' ? [false, true] : [false];
    for (const restart of incarnations) {
      if (restart) {
        const originalRuntimeId = runtime.identity.runtimeId;
        await stopHost();
        runtime = await ensureKodaXRuntime(connection);
        owner = (await runtime.daemon.inspect()).owner;
        assert.notEqual(runtime.identity.runtimeId, originalRuntimeId);
      }
      client = await connectKodaXClient({ homeDir, profile: connection.profile });
      const history = await client.sessions.readHistory(session.id);
      const item = history.items.find(entry => entry.tool?.callId === 'mcp-output-call');
      assert.ok(item);
      const full = await readAll(offset => client.sessions.readHistoryEntry(session.id, item.id, { offset, part: 'original' }));
      assert.ok(full.includes(body));
      assert.ok(full.includes('STRUCTURED_EVIDENCE'));
      assert.doesNotMatch(full, /KODAX_RESULT_INCOMPLETE/);
      if (original !== undefined) assert.equal(full, original);
      original = full;
      const preview = await readAll(offset => client.sessions.readHistoryEntry(session.id, item.id, { offset }));
      if (scenario === 'recoverable') {
        assert.match(preview, /KODAX_RESULT_INCOMPLETE/);
        assert.ok(!preview.includes('MCP_MIDDLE_EVIDENCE'));
        assert.equal(typeof item.tool.outputPath, 'string');
      } else {
        assert.equal(preview, full);
        assert.equal(item.tool.outputPath, undefined);
      }
      assert.equal(await readFile(callLog, 'utf8'), 'called\n', 'Reading originals must never replay the MCP operation');
      assert.equal(primaryRequests, requestsBeforeReading, 'Reading or restarting must not invoke the model');
      await client.disconnect();
      client = undefined;
    }
  });
}
