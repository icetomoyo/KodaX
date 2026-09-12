import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { connectKodaXClient } from './sdk-client.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { runOneShotClientTask } from './one-shot-task.js';
import { parseMcpIntegrationDocument, writeIntegrationDocument } from '@kodax-ai/repl';

const ELICIT_SERVER_SOURCE = `let nextServerId = 100;
const pendingElicit = new Map();
const writeMessage = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, elicitation: {} },
      serverInfo: { name: 'kodax-elicit-server', version: '1.0.0' },
    } });
    return;
  }
  if (method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'elicit_tool',
      description: 'Elicits a form, then echoes the outcome.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }] } });
    return;
  }
  if (method === 'tools/call') {
    const elicId = nextServerId++;
    pendingElicit.set(elicId, id);
    writeMessage({ jsonrpc: '2.0', id: elicId, method: 'elicitation/create', params: {
      message: 'Share the draft with the Host?',
      mode: 'form',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    } });
    return;
  }
}
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method) { handleRequest(message); continue; }
    const pending = pendingElicit.get(message.id);
    if (pending !== undefined) {
      pendingElicit.delete(message.id);
      const result = message.result || {};
      const action = result.action || 'missing';
      const name = (result.content && result.content.name) || '';
      writeMessage({ jsonrpc: '2.0', id: pending, result: { content: [{
        type: 'text', text: 'elicit:' + action + ':' + name,
      }] } });
    }
  }
});
`;

const cases = [
  { name: 'askUser', kind: 'question', input: { question: 'Choose?', options: [{ label: 'Ship', value: 'ship' }], default: 'ship' } },
  { name: 'askUserMulti', kind: 'question_multi', input: { question: 'Questions', questions: [{ question: 'Choose?', options: [{ label: 'Ship', value: 'ship' }], default: 'ship' }] } },
  { name: 'askUserInput', kind: 'question_input', input: { question: 'Name?', kind: 'input', default: 'must-not-answer' } },
  { name: 'MCP form', kind: 'question_input', input: { id: 'mcp:shared-elicit:tool:elicit_tool', args: { text: 'please' } } },
] as const;

it.each(cases)('cancels only its own $name without inventing an answer, including a view before the receipt', async (scenario) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-one-shot-question-'));
  if (scenario.name === 'MCP form') {
    const scriptPath = path.join(homeDir, 'elicit-server.cjs');
    await writeFile(scriptPath, ELICIT_SERVER_SOURCE);
    writeIntegrationDocument({ domain: 'mcp', configHome: path.join(homeDir, '.kodax'),
      document: { version: 1, servers: { 'shared-elicit': { type: 'stdio', command: process.execPath, args: [scriptPath], connect: 'prewarm' } } },
      validate: parseMcpIntegrationDocument });
  }

  class Provider extends KodaXBaseProvider {
    readonly name = 'one-shot-question-test';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { model: this.name, apiKeyEnv: 'KODAX_ONE_SHOT_QUESTION_KEY', supportsThinking: false };
    async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
      const ownMcp = scenario.name === 'MCP form'
        && !messages.some(message => message.role === 'user' && message.content === 'Foreign question.');

      return messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))
        ? { textBlocks: [{ type: 'text', text: 'No answer was supplied.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' }
        : { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: randomUUID(),
          name: ownMcp ? 'mcp_call' : 'ask_user_question',
          input: scenario.name === 'MCP form' && !ownMcp ? { question: 'Foreign name?', kind: 'input' } : scenario.input }] };
    }
  }
  vi.stubEnv('KODAX_ONE_SHOT_QUESTION_KEY', 'test-only');
  registerModelProvider('one-shot-question-test', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'one-shot-question-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Could not lock one-shot Host');
  const endpoint = process.platform === 'win32' ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-one-shot-question-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  const controller = new AbortController();
  let foreignRunId: string | undefined;
  let pending: ReturnType<typeof runOneShotClientTask> | undefined;
  const closed = vi.fn();
  const responded = vi.fn(client.interactions.respond);
  let observedBeforeReceipt = false;
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const foreign = await client.sessions.create({ projectPath: homeDir });
    for (const id of [session.id, foreign.id]) await client.sessions.updateSettings(id, { agentMode: 'sa', permissionMode: 'full-access' });
    foreignRunId = (await client.inputs.submit({ sessionId: foreign.id, inputId: 'foreign', text: 'Foreign question.' })).runId;
    const scopedClient = { ...client, interactions: { ...client.interactions, respond: responded },
      sessions: { ...client.sessions, observe: async (...args: Parameters<typeof client.sessions.observe>) => {
        const observation = await client.sessions.observe(args[0], view => {
          if (view.interactions.some(item => item.kind === scenario.kind)) observedBeforeReceipt = true;
          args[1](view);
        }, args[2]);
        return { ...observation, close: () => { closed(); observation.close(); } };
      } },
      inputs: { ...client.inputs, submit: async (...args: Parameters<typeof client.inputs.submit>) => {
        const accepted = await client.inputs.submit(...args);
        await expect.poll(async () => (await client.interactions.list({ sessionId: session.id })).some(item => item.kind === scenario.kind),
          { timeout: 15_000 }).toBe(true);
        // The one-shot observation must receive the pending view before admission returns.
        await expect.poll(() => observedBeforeReceipt, { timeout: 15_000 }).toBe(true);
        return accepted;
      } },
    };
    pending = runOneShotClientTask({ client: scopedClient, runtime, abortSignal: controller.signal,
      options: { provider: 'one-shot-question-test', agentMode: 'sa', session: { id: session.id } }, prompt: 'Own question.' });
    let finished = false;
    let failure: unknown;
    void pending.then(() => { finished = true; }, error => { failure = error; finished = true; });
    await expect.poll(() => observedBeforeReceipt, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => finished, { timeout: 5_000 }).toBe(true);
    expect(failure).toBeUndefined();
    expect(closed).toHaveBeenCalledTimes(1);
    expect((await client.interactions.list({ sessionId: foreign.id })).some(item => item.kind === scenario.kind)).toBe(true);
    expect(await client.sessions.getSettings(session.id)).toMatchObject({ permissionMode: 'full-access' });
    expect(responded).toHaveBeenCalledTimes(1);
    expect(responded.mock.calls[0]?.[1]).toMatchObject({ kind: 'cancel', reason: expect.stringContaining('non-interactive') });
    const result = await pending;
    const toolResults = result.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result') : []);
    expect(JSON.stringify(toolResults)).toContain(scenario.name === 'MCP form' ? 'elicit:cancel:' : 'cancel');
    expect(JSON.stringify(toolResults)).not.toContain('must-not-answer');
    expect(JSON.stringify(toolResults)).not.toContain('"choice":"ship"');
  } finally {
    controller.abort();
    if (foreignRunId) await client.runs.stop(foreignRunId);
    if (pending) await Promise.allSettled([pending]);
    await client.disconnect(); await host.close(); await runtime.close();
    clearRuntimeModelProviders(); vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
