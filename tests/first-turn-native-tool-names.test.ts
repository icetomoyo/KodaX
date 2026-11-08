import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getProvider, registerModelProvider, clearRuntimeModelProviders } from '@kodax-ai/llm';
import { runManagedTask } from '@kodax-ai/coding';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import type { ExtensionRuntimeContract } from '../packages/coding/src/extensions/runtime-contract.js';

interface WireBlock { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }
interface WireRequest {
  stream?: boolean;
  tools?: { name: string; input_schema: { properties?: Record<string, unknown> } }[];
  messages: { role: string; content: string | WireBlock[] }[];
}

it.each([false, true])('preserves original Host identity and permission through the real Ark wire adapter (denied: %s)', async denied => {
  const root = await mkdtemp(join(tmpdir(), 'kodax-native-tool-names-'));
  const storage = new FileSessionStorage({ sessionsDir: join(root, 'sessions'), configHome: root, cwd: root });
  const name = 'measurements.sample-grid';
  const input = { recordTag: 'native-42', literalToolName: name };
  const warning = 'WARNING: original Host evidence remains provisional';
  const sent: WireRequest[] = [];
  const permissions: { name: string; input: Record<string, unknown> }[] = [];
  const results: unknown[] = [];
  let providerFailure: unknown;
  const hostCall = vi.fn(async (provider: string, capability: string, actual: Record<string, unknown>) => {
    expect(provider).toBe('mcp');
    expect(capability).toBe('fixture:native-measurements');
    expect(actual).toEqual(input);
    return { kind: 'tool' as const, content: warning, structuredContent: { accepted: true } };
  });
  const extensionRuntime: ExtensionRuntimeContract = {
    listRunTools: () => [{ name, description: 'Read a tagged Host sample.', capabilityId: 'fixture:native-measurements',
      inputSchema: { type: 'object', properties: { recordTag: { type: 'string' }, literalToolName: { type: 'string' } },
        required: ['recordTag', 'literalToolName'] }, sideEffect: 'readonly', planModeAllowed: true }],
    searchCapabilities: async () => [], describeCapability: async () => undefined, executeCapability: hostCall,
    readCapability: async () => ({ kind: 'resource', content: '' }), getCapabilityPrompt: async () => undefined,
    getCapabilityPromptContext: async () => undefined,
  };
  const nativeFetch = vi.fn(() => { throw new Error('Real network is forbidden in native wire acceptance'); });
  vi.stubGlobal('fetch', nativeFetch);
  vi.stubEnv('ARK_CODING_API_KEY', 'offline-fixture');
  vi.stubEnv('KODAX_HOME', root);
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as WireRequest;
    if (body.tools?.some(tool => tool.name === 'commit_episode_learning_review')) {
      return Response.json({ content: [{ type: 'text', text: 'No learning candidates.' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 } });
    }
    sent.push(body);
    if (sent.length > 2) throw new Error('Unexpected extra native acceptance request');
    if (body.tools?.some(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name))) {
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'function name is invalid' } }, { status: 400 });
    }
    const definition = body.tools?.find(tool => tool.input_schema.properties?.recordTag !== undefined);
    if (!definition) throw new Error('Host tool is absent from the native wire menu');
    const block = sent.length === 1
      ? { type: 'tool_use', id: 'native-call', name: definition.name, input }
      : { type: 'text', text: 'Native Host request inspected.' };
    const stop_reason = sent.length === 1 ? 'tool_use' : 'end_turn';
    if (!body.stream) return Response.json({ content: [block], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: sent.length === 1 ? { ...block, input: {} } : block },
      ...(sent.length === 1 ? [{ type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }] : []),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const actual = getProvider('ark-coding');
  const observed = new Proxy(actual, { get(target, key) {
    if (key === 'stream') return async (...args: Parameters<typeof actual.stream>) => {
      try { return await target.stream(args[0], args[1], args[2], args[3], { ...args[4], fetch: fakeFetch, singleAttempt: true }, args[5]); }
      catch (error) { providerFailure = error; throw error; }
    };
    if (key === 'complete') return (...args: Parameters<typeof actual.complete>) => target.complete(args[0], args[1], args[2], args[3],
      { ...args[4], fetch: fakeFetch, singleAttempt: true }, args[5]);
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  registerModelProvider('native-tool-names-offline', () => observed);
  try {
    let result: Awaited<ReturnType<typeof runManagedTask>> | undefined;
    let failure: unknown;
    try { result = await runManagedTask({ provider: 'native-tool-names-offline', model: 'kimi-k2.7-code', workMode: 'coding',
      agentMode: 'ama', effort: 'high', maxIter: 2, lsp: false, extensionRuntime,
      session: { id: 'native-session', storage }, context: { executionCwd: root, gitRoot: root, repoIntelligenceMode: 'off' },
      events: { beforeToolExecute: async (tool, parameters) => {
        permissions.push({ name: tool, input: structuredClone(parameters) });
        return denied ? '[Tool Error] Host permission denied' : true;
      }, onToolResult: result => { results.push(result); }, onProviderRecovery: () => {
        throw new Error(`Unexpected native wire recovery: ${String(providerFailure)}`);
      } },
    }, 'Read the tagged sample using the available Host tool.'); } catch (error) { failure = error; }
    expect(sent[0]?.tools?.filter(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)).map(tool => tool.name),
      'Every Anthropic wire tool name must satisfy the public name grammar').toEqual([]);
    expect(failure).toBeUndefined();
    expect(result?.success).toBe(true);
    expect(sent).toHaveLength(2);
    const wireName = sent[0]!.tools!.find(tool => tool.input_schema.properties?.recordTag !== undefined)!.name;
    expect(wireName).toContain('measurements');
    expect(wireName).not.toBe(name);
    expect(permissions).toEqual([{ name, input }]);
    expect(hostCall).toHaveBeenCalledTimes(denied ? 0 : 1);
    expect(results).toEqual([expect.objectContaining({ name, toolResult: expect.objectContaining({ is_error: denied }) })]);
    const sentBlocks = sent[1]!.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    expect(sentBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', id: 'native-call', name: wireName, input }),
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'native-call' }),
    ]));
    expect(sentBlocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'native-call')?.is_error === true).toBe(denied);
    const saved = await storage.load('native-session');
    const canonical = saved?.messages.flatMap(message => Array.isArray(message.content) ? message.content : []) ?? [];
    expect(canonical).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', id: 'native-call', name, input }),
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'native-call' }),
    ]));
    expect(canonical.some(block => block.type === 'tool_result' && block.tool_use_id === 'native-call'
      && (block.is_error === true) === denied)).toBe(true);
    expect(JSON.stringify(canonical)).toContain(denied ? 'Host permission denied' : warning);
    expect(saved?.extensionRecords?.filter(record => record.extensionId === 'kodax.script') ?? []).toEqual([]);
    expect(nativeFetch).not.toHaveBeenCalled();
  } finally {
    clearRuntimeModelProviders(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (dirname(root) !== resolve(tmpdir()) || !root.includes('kodax-native-tool-names-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
