import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getProvider } from '../dist/sdk-llm.js';
import { buildAssistantMessageFromLlmResult } from '../dist/sdk-agent.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';
import { runKodaX, awaitLatestCodingMemoryReviewDrain } from '../dist/sdk-coding.js';

test('published native Anthropic history survives SDK/Agent/file restore and a real coding continuation', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-native-history-e2e-'));
  const keys = ['KODAX_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const requests = [];
  const content = [{ type: 'thinking', thinking: '', signature: 'signed-empty-thinking' }, { type: 'text', text: 'Native continuation complete.' }];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
      assert.equal(request.headers['x-api-key'], 'selected-native-fixture');
      assert.equal(request.headers.authorization, undefined);
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: body.model,
          usage: { input_tokens: 10, output_tokens: 0 } } },
        ...content.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
        response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'fixture', role: 'assistant', model: body.model, content,
          stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }));
      }
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let passed = false;
  t.after(async () => {
    await awaitLatestCodingMemoryReviewDrain(5_000);
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (passed) {
      assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('kodax-native-history-e2e-'));
      await rm(directory, { recursive: true, force: true });
    } else {
      await writeFile(path.join(directory, 'requests.json'), JSON.stringify(requests, null, 2));
      t.diagnostic(`Retained native history fixture: ${directory}`);
    }
  });
  Object.assign(process.env, { KODAX_HOME: path.join(directory, '.kodax'), ANTHROPIC_API_KEY: 'selected-native-fixture',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: wrong-account\nauthorization: Bearer wrong-account' });
  const image = path.join(directory, 'first.png');
  const bytes = await readFile(new URL('./fixtures/images/valid-png.png', import.meta.url));
  await writeFile(image, bytes);
  let messages = [{ role: 'user', content: [{ type: 'text', text: 'Inspect this image.' }, { type: 'image', path: image }] }];
  const first = await getProvider('anthropic').complete(messages, [], 'Original base', { effort: 'high' },
    { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096, cacheRetention: 'long' });
  assert.ok(JSON.stringify(requests[0].messages).includes(bytes.toString('base64')), 'Fixture must admit actual image bytes before testing restore.');
  const assistant = buildAssistantMessageFromLlmResult({ text: first.textBlocks.map(block => block.text).join(''),
    thinkingBlocks: first.thinkingBlocks, contentBlocks: first.contentBlocks, nativeHistory: first.nativeHistory });
  assert.ok(assistant.nativeHistory); messages.push(assistant);
  const sessionsDir = path.join(process.env.KODAX_HOME, 'sessions');
  await new FileSessionStorage({ sessionsDir, configHome: process.env.KODAX_HOME }).save('native-restored-session', {
    title: 'Retain original title', gitRoot: directory, messages,
  });
  await rm(image);
  const storage = new FileSessionStorage({ sessionsDir, configHome: process.env.KODAX_HOME });
  messages = JSON.parse(JSON.stringify((await storage.load('native-restored-session')).messages));
  assert.equal(messages[1].nativeHistory.id, first.nativeHistory.id);
  const result = await runKodaX({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low',
    maxIter: 2, lsp: false, context: { executionCwd: directory, gitRoot: directory, configHome: process.env.KODAX_HOME, repoIntelligenceMode: 'off' },
    session: { id: 'native-restored-session', resume: true, storage },
  }, 'Continue from the saved image without reopening the original file.');
  assert.equal(result.success, true); assert.match(result.lastText, /Native continuation complete/);
  const continued = requests.find((body, index) => index > 0 && JSON.stringify(body.messages).includes('Continue from the saved image'));
  assert.ok(continued); assert.ok(JSON.stringify(continued.messages).includes(bytes.toString('base64')));
  assert.ok(JSON.stringify(continued.messages).includes('signed-empty-thinking'));
  assert.ok(JSON.stringify(continued.messages).includes('tool_addition'));
  const restored = await storage.load('native-restored-session');
  assert.equal(restored.title, 'Retain original title');
  assert.ok(restored.messages.filter(message => message.role === 'assistant').every(message => message.nativeHistory));
  passed = true;
});
