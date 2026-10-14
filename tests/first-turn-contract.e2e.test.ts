import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { createCustomProvider, registerModelProvider, clearRuntimeModelProviders } from '@kodax-ai/llm';
import { runKodaX, runManagedTask, type KodaXOptions } from '@kodax-ai/coding';
import { REPO_INTELLIGENCE_WORKING_TOOL_NAMES } from '../packages/coding/src/tools/registry.js';

interface WireTool {
  name?: string;
  input_schema?: { properties: Record<string, unknown>; required?: string[] };
  function?: { name: string; parameters: { properties: Record<string, unknown>; required?: string[] } };
}
interface WireRequest {
  tools: WireTool[];
  messages: unknown[];
  system?: unknown;
}
type FixtureCall = { name: string; input: Record<string, unknown> };

// This fixture implements the HTTP/SSE protocol, rather than mocking the
// provider. The public SDK executes each returned tool and sends its result
// through the real provider serializer on the next request.
function sendResponse(response: ServerResponse, protocol: 'openai' | 'anthropic', turn: number, call?: FixtureCall) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event: object, name?: string) => response.write(
    `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
  );
  const text = '已确认选择，并完成精确修改。';
  if (protocol === 'openai') {
    const delta = call
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
      : { role: 'assistant', content: text };
    emit({ id: `message-${turn}`, choices: [{ index: 0, delta, finish_reason: null }] });
    emit({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] });
    emit({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } });
    response.end('data: [DONE]\n\n');
    return;
  }
  const event = (type: string, fields: object = {}) => emit({ type, ...fields }, type);
  event('message_start', { message: { id: `message-${turn}`, type: 'message', role: 'assistant',
    model: 'fixture-model', content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: call
    ? { type: 'tool_use', id: `call-${turn}`, name: call.name, input: {} }
    : { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: call
    ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
    : { type: 'text_delta', text } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 } });
  event('message_stop');
  response.end();
}

describe('first-turn contracts through public SDK and HTTP providers', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    for (const mode of ['sa', 'ama'] as const) {
      it(`${protocol}/${mode}: projects contracts and executes read, edit and batch input`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'kodax-first-turn-e2e-'));
        const workspace = path.join(root, 'workspace');
        await mkdir(workspace);
        const target = path.join(workspace, 'app.txt');
        await writeFile(target, 'before\n');
        const requests: WireRequest[] = [];
        const errors: unknown[] = [];
        const calls: FixtureCall[] = [
          { name: 'read', input: { path: target } },
          { name: 'edit', input: { path: target, old_string: 'before', new_string: 'after' } },
          { name: 'ask_user_question', input: { questions: [{ question: '选择验收方式',
            header: '验收', options: [{ value: 'test', label: '运行测试' }, { value: 'review', label: '检查修改' }] }] } },
        ];
        const server = createServer(async (request, response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireRequest;
            const turn = requests.push(body) - 1;
            if (turn > calls.length) throw new Error('Unexpected extra provider request');
            sendResponse(response, protocol, turn, calls[turn]);
          } catch (error) {
            errors.push(error);
            response.writeHead(500).end(JSON.stringify({ error: 'Fixture request failed' }));
          }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
        const keyName = 'KODAX_FIRST_TURN_E2E_KEY';
        const previousKey = process.env[keyName];
        process.env[keyName] = 'local-fixture-key';
        setAgentConfigHome(path.join(root, 'home'));
        const providerName = `first-turn-${protocol}-${mode}`;
        registerModelProvider(providerName, () => createCustomProvider({
          name: providerName, protocol, model: 'fixture-model', apiKeyEnv: keyName,
          baseUrl: `http://127.0.0.1:${address.port}`, contextWindow: 128_000, reasoning: 'none',
        }));
        const askUserMulti = vi.fn(async () => ({ '选择验收方式': 'test' }));
        try {
          const options: KodaXOptions = {
            provider: providerName, agentMode: mode, reasoningMode: 'off', maxIter: 6,
            lsp: false, disablePromptCache: true,
            context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '',
              repoIntelligenceMode: 'off', resolveShellPermissionMode: () => 'full-access',
              toolVisibilityPolicy: tool => !(REPO_INTELLIGENCE_WORKING_TOOL_NAMES as readonly string[]).includes(tool.name) },
            events: { askUserMulti },
          };
          const result = await (mode === 'sa' ? runKodaX : runManagedTask)(options,
            '读取 app.txt，将 before 精确改为 after，再询问验收方式。');
          expect(errors).toEqual([]);
          expect(result.success).toBe(true);
          expect(await readFile(target, 'utf8')).toBe('after\n');
          expect(askUserMulti).toHaveBeenCalledOnce();
          expect(requests).toHaveLength(4);
          const first = requests[0]!;
          const tools = first.tools.map(tool => ({ name: tool.name ?? tool.function?.name,
            schema: tool.input_schema ?? tool.function?.parameters }));
          const todo = tools.find(tool => tool.name === 'todo_update');
          expect(todo?.schema?.required).toContain('id');
          expect(todo?.schema?.properties).not.toHaveProperty('op');
          expect(todo?.schema?.properties).not.toHaveProperty('items');
          expect(tools.find(tool => tool.name === 'ask_user_question')?.schema?.properties).not.toHaveProperty('agent_id');
          expect(tools.map(tool => tool.name)).not.toContain('run_skill_script');
          if (mode === 'ama') {
            expect(tools.map(tool => tool.name)).not.toContain('module_context');
            const instructions = JSON.stringify(first.system ?? first.messages.filter(message =>
              typeof message === 'object' && message !== null && 'role' in message && message.role === 'system'));
            expect(instructions).not.toContain('`module_context`');
            expect(instructions).not.toContain('`changed_scope`');
            expect(instructions).not.toContain('`changed_diff_bundle`');
          }
          const resultMessages = requests[3]!.messages.filter(message => {
            if (typeof message !== 'object' || message === null) return false;
            return 'role' in message && message.role !== 'system' && message.role !== 'assistant';
          });
          const finalHistory = JSON.stringify(resultMessages);
          expect(finalHistory).toContain('after');
          expect(finalHistory).toContain('answers');
          expect(finalHistory).not.toContain('Missing required parameter');
        } finally {
          clearRuntimeModelProviders();
          setAgentConfigHome(undefined);
          if (previousKey === undefined) delete process.env[keyName];
          else process.env[keyName] = previousKey;
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('kodax-first-turn-e2e-')) {
            throw new Error('Unsafe fixture cleanup path');
          }
          await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      }, 30_000);
    }
  }
});
