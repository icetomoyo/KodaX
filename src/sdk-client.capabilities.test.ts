import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { BUILTIN_COMMANDS, type CommandCallbacks, type CurrentConfig } from '../packages/repl/src/interactive/commands.js';
import { createInteractiveContext } from '../packages/repl/src/interactive/context.js';

it('probes and forgets capabilities in the actual Host used by subsequent SA and AMA requests', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-capabilities-'));
  const requestedEfforts: (string | undefined)[] = [];
  const requests: unknown[] = [];
  const providerServer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { reasoning_effort?: string; max_completion_tokens?: number };
    requests.push(input);
    if (input.max_completion_tokens === 1 && input.reasoning_effort === 'high') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: "Unsupported value: reasoning_effort 'high'.", type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_value' } }));
      return;
    }
    if (input.max_completion_tokens !== 1) requestedEfforts.push(input.reasoning_effort);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local Provider port.');
  await mkdir(path.join(homeDir, '.kodax'));
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ customProviders: [{
    name: 'product-capability-test', protocol: 'openai', model: 'test-model',
    apiKeyEnv: 'KODAX_PRODUCT_CAPABILITY_TEST_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: { efforts: ['low', 'medium', 'high'], default: 'medium' },
  }] }));
  vi.stubEnv('KODAX_PRODUCT_CAPABILITY_TEST_KEY', 'test-only');
  const profile = 'capabilities-contract';
  const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
  try {
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire isolated test Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-capabilities-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        const selection = { provider: 'product-capability-test', model: 'test-model' };
        expect(await client.catalog.providers()).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: selection.provider, model: selection.model, source: 'config', configured: true }),
        ]));
        expect(await client.catalog.models({ provider: selection.provider })).toEqual([
          { provider: selection.provider, models: [selection.model] },
        ]);
        expect(await client.catalog.reasoningEfforts(selection)).toContain('high');
        expect(await client.catalog.probeReasoningEfforts({ ...selection, efforts: ['high'] }), JSON.stringify(requests))
          .toEqual([{ effort: 'high', status: 'rejected' }]);
        expect(await client.catalog.reasoningEfforts(selection)).not.toContain('high');
        const providerCommand = BUILTIN_COMMANDS.find(command => command.name === 'provider')!;
        const context = await createInteractiveContext({ gitRoot: homeDir });
        const callbacks: CommandCallbacks = {
          providerCapabilities: client.catalog,
          exit() {}, async saveSession() {}, async loadSession() { return 'missing'; },
          async listSessions() {}, clearHistory() {}, printHistory() {},
          ui: {
            async select() { throw new Error('Unexpected selection'); },
            async confirm() { throw new Error('Unexpected confirmation'); },
            async input() { throw new Error('Unexpected input'); },
          },
        };
        const config: CurrentConfig = {
          ...selection, thinking: true, reasoningMode: 'balanced', agentMode: 'sa', permissionMode: 'accept-edits',
        };
        const beforeProbe = requests.length;
        await providerCommand.handler(['probe'], context, callbacks, config);
        expect(requests.slice(beforeProbe)).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ reasoning_effort: 'high' }),
        ]));
        expect(requests.length).toBeGreaterThan(beforeProbe);
        for (const agentMode of ['sa', 'ama'] as const) {
          const session = await client.sessions.create({ projectPath: homeDir });
          await client.sessions.updateSettings(session.id, {
            ...selection, agentMode, permissionMode: 'full-access', effort: 'high',
          });
          requestedEfforts.length = 0;
          const accepted = await client.inputs.submit({ sessionId: session.id, inputId: `narrow-${agentMode}`, text: 'Reply briefly.' });
          if (!accepted.runId) throw new Error('Expected an immediate Run.');
          expect((await runtime.runs.get(accepted.runId)).mode).toBe(agentMode === 'ama' ? 'managed_task' : 'coding');
          await runtime.runs.await(accepted.runId);
          await awaitLatestCodingMemoryReviewDrain(5_000);
          expect(requestedEfforts.length).toBeGreaterThan(0);
          expect(requestedEfforts).not.toContain('high');
        }
        const forget = runtime.catalog.forgetCapabilities;
        let releaseForget!: () => void;
        let forgetEntered = false;
        const forgetGate = new Promise<void>(resolve => { releaseForget = resolve; });
        runtime.catalog.forgetCapabilities = async input => {
          forgetEntered = true;
          await forgetGate;
          await forget(input);
        };
        let forgetSettled = false;
        const forgetting = providerCommand.handler(['forget-capability', `${selection.provider}/${selection.model}`], context, callbacks, config)
          .then(result => { forgetSettled = true; return result; });
        try {
          await expect.poll(() => forgetEntered).toBe(true);
          expect(forgetSettled).toBe(false);
        } finally { releaseForget(); }
        expect(await forgetting).toMatchObject({ success: true });
        runtime.catalog.forgetCapabilities = forget;
        expect(await client.catalog.reasoningEfforts(selection)).toContain('high');
        const restored = await client.sessions.create({ projectPath: homeDir });
        await client.sessions.updateSettings(restored.id, { ...selection, agentMode: 'sa', effort: 'high', permissionMode: 'full-access' });
        requestedEfforts.length = 0;
        const accepted = await client.inputs.submit({ sessionId: restored.id, inputId: 'restored', text: 'Reply briefly.' });
        if (!accepted.runId) throw new Error('Expected an immediate Run.');
        await runtime.runs.await(accepted.runId);
        await awaitLatestCodingMemoryReviewDrain(5_000);
        expect(requestedEfforts).toContain('high');
        await client.disconnect();
        const beforeDisconnectedCommands = requests.length;
        expect(await providerCommand.handler(['probe'], context, callbacks, config)).toMatchObject({ success: false });
        expect(await providerCommand.handler(['forget-capability'], context, callbacks, config)).toMatchObject({ success: false });
        expect(requests.length).toBe(beforeDisconnectedCommands);
      } finally { await client.disconnect(); }
    } finally { await host.close(); }
  } finally {
    await runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    registerCustomProviders([]);
    await new Promise<void>((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  }
});
