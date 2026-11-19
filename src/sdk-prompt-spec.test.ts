import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXStreamResult } from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain, type KodaXPromptSpec } from '@kodax-ai/coding';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { createRuntimeDaemonClient } from './runtime-daemon/client.js';
import { ensureKodaXClient } from './sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from './sdk-runtime.js';

const directories: string[] = [];
const spec: KodaXPromptSpec = { kodaxGuidance: 'omit', context: [
  { key: 'house-style', kind: 'rule', text: 'APP_RULE_SENTINEL' },
  { key: 'faq', kind: 'reference', text: 'APP_REFERENCE_SENTINEL' },
] };

afterEach(async () => {
  await awaitLatestCodingMemoryReviewDrain(5_000);
  clearRuntimeModelProviders(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

it('applies an authorized profile prompt to the product Run envelope', async () => {
  const homeDir = await mkdtemp(join(await realpath(tmpdir()), 'kodax-prompt-spec-')); directories.push(homeDir);
  const configHome = join(homeDir, '.kodax');
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const wire = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body) as { messages: { role: string; content: unknown }[] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0,
      delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port.');
  await mkdir(configHome, { recursive: true });
  await writeFile(join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: 'prompt-spec-loopback',
    protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_PROMPT_SPEC_UNUSED_KEY', model: 'fixture' }] }));
  const client = await ensureKodaXClient({ homeDir, async authorizeExecution(_request, services) {
    const credential = await services.credentials.registerScoped({ providers: ['prompt-spec-loopback'] }, async () => 'fixture-only');
    return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['prompt-spec-loopback'] },
      profile: await services.createExecutionProfile({ agentProfile: { id: 'partner', instructions: 'PERSONA_SENTINEL' }, prompt: spec }) };
  } });
  try {
    const session = await client.sessions.create({ surface: 'partner', projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { provider: 'prompt-spec-loopback', model: 'fixture', workMode: 'agent',
      permissionMode: 'full-access', reasoningMode: 'off' });
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'first', text: 'Answer the customer.' });
    expect((await client.runs.await(accepted.runId!)).phase).toBe('completed');
    const [system, ...rest] = requests[0]!.messages;
    expect(system!.role).toBe('system');
    const systemText = JSON.stringify(system!.content);
    const conversation = JSON.stringify(rest);
    expect(systemText.startsWith('"PERSONA_SENTINEL')).toBe(true);
    expect(systemText).not.toContain('Assigned native agent identity');
    expect(systemText).not.toContain('APP_RULE_SENTINEL');
    expect(conversation).toContain('## Application rule: house-style');
    expect(conversation).toContain('APP_RULE_SENTINEL');
    expect(conversation).toContain('APP_REFERENCE_SENTINEL');
  } finally {
    const owner = getKodaXRuntimeOwnerState({ homeDir }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome, owner })).toMatchObject({ status: 'succeeded' });
    await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
  }
}, 120_000);

it('rejects a prompt spec on a direct coding Run and a malformed spec at admission', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-prompt-spec-direct-')); directories.push(homeDir);
  const requests: string[] = [];
  vi.stubEnv('KODAX_PROMPT_SPEC_KEY', 'fixture');
  class Provider extends KodaXBaseProvider {
    readonly name = 'prompt-spec-fixture'; readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_PROMPT_SPEC_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
      requests.push(JSON.stringify(messages));
      return { textBlocks: [{ type: 'text', text: 'Done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('prompt-spec-fixture', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'prompt-spec-fixture' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    await expect(runtime.runs.start({ sessionId: session.id, prompt: 'Reply.', mode: 'coding', options: { context: { prompt: spec } } }))
      .rejects.toMatchObject({ code: 'prompt_spec_requires_managed_run' });
    await expect(runtime.runs.start({ sessionId: session.id, prompt: 'Reply.', mode: 'managed_task',
      options: { context: { prompt: { kodaxGuidance: 'replace' } as never } } }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect(requests).toEqual([]);
  } finally { await runtime.close(); }
});

it('rejects a profile prompt before sending work to an older Host', async () => {
  const sent: string[] = [];
  const runtime = createRuntimeDaemonClient({ identity: { runtimeId: 'old-host', mode: 'daemon', profile: 'default',
    startedAt: new Date().toISOString(), version: '0.7.97-beta.11' },
    capabilities: { productExecutionProfile: { version: 2 } },
    transport: { request: async method => { sent.push(method); return {}; }, subscribe: () => ({ close() {} }) },
  });
  try {
    const bound = toKodaXProductClient(runtime, async () => ({ profile: { prompt: spec } }));
    await expect(bound.inputs.submit({ sessionId: 's', inputId: 'stable', text: 'Answer' }))
      .rejects.toMatchObject({ code: 'daemon_upgrade_required', message: expect.stringContaining('Prompt customization') });
    expect(sent).toEqual([]);
  } finally { await runtime.close(); }
});
