import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectKodaXClient } from '../src/sdk-client.js';
import { createFetchHttpFixture } from './fetch-http-fixture.js';

it('describes a leased Host output schema on demand through an independent Host without executing it', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-host-output-schema-'));
  const marker = 'schema-disclosed-on-demand';
  const outputSchema = { type: 'object', properties: { payload: { type: 'object',
    description: marker.repeat(40), properties: { samples: { type: 'array', items: { type: 'number' } } } } } };
  const description = `Read a measurement grid. ${'Contract detail. '.repeat(20)}Full contract tail.`;
  let capabilityId = '';
  let requests = 0;
  let deliveredMenu = '';
  let modelReceipt = '';
  const handler = vi.fn(async () => ({ content: 'not executed', structuredContent: { payload: { samples: [2, 5] } } }));
  const { server, url } = await createFetchHttpFixture(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { tools: unknown[]; messages: { role: string; content?: string }[] };
    const step = requests++;
    if (step === 0) deliveredMenu = JSON.stringify(input.tools);
    else modelReceipt = input.messages.findLast(message => message.role === 'tool')?.content ?? '';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = step === 0 ? { tool_calls: [{ index: 0, id: 'describe-schema', type: 'function', function: { name: 'script_exec',
      arguments: JSON.stringify({ yield_time_ms: 10_000,
        code: `return (await tools.mcp_describe({id:${JSON.stringify(capabilityId)}})).content;` }) } }] }
      : { content: 'Contract inspected.' };
    response.end(`data: ${JSON.stringify({ id: 'schema-fixture', choices: [{ index: 0, delta, finish_reason: step === 0 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  let host: ChildProcess | undefined;
  let client: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;
  try {
    await mkdir(join(homeDir, '.kodax'), { recursive: true });
    await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'schema-fixture', learning: { enabled: false },
      customProviders: [{ name: 'schema-fixture', protocol: 'openai', model: 'fixture',
        baseUrl: `${url}/v1`, apiKeyEnv: 'KODAX_UNUSED_SCHEMA_FIXTURE_KEY' }] }));
    host = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
      cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    host.stdout!.resume(); host.stderr!.resume();
    const ready = await Promise.race([
      once(host, 'message').then(([message]) => message as { pid: number; endpoint: string }),
      once(host, 'exit').then(([code]) => { throw new Error(`Schema fixture Host exited before ready: ${String(code)}`); }),
    ]);
    expect(ready.pid).not.toBe(process.pid);
    client = await connectKodaXClient({ homeDir, endpoint: ready.endpoint, async authorizeExecution(_request, services) {
      const credential = await services.credentials.registerScoped({ providers: ['schema-fixture'] }, async () => 'fixture-only');
      const lease = await services.hostTools.register([{ name: 'geometry.read-grid', description,
        inputSchema: { type: 'object', properties: {} }, outputSchema, sideEffect: 'none' }], { 'geometry.read-grid': handler });
      expect(lease.tools[0]?.outputSchema).toEqual(outputSchema);
      capabilityId = `host:${lease.id}:geometry.read-grid`;
      return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['schema-fixture'] }, hostTools: { leaseId: lease.id }, profile: {} };
    } });
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { workMode: 'script', agentMode: 'sa', permissionMode: 'full-access' });
    const active = await client.inputs.submit({ sessionId: session.id, inputId: 'inspect-schema', text: 'Inspect the selected Host contract without executing it.' });
    expect((await client.runs.await(active.runId!)).phase).toBe('completed');
    expect(deliveredMenu).toContain('geometry.read-grid');
    expect(deliveredMenu).not.toContain(marker);
    expect(deliveredMenu).not.toContain('Full contract tail.');
    expect(modelReceipt).toContain(marker);
    expect(modelReceipt).toContain('Output Schema:');
    expect(modelReceipt).toContain('Full contract tail.');
    expect(modelReceipt).toContain('Server: host');
    expect(handler).not.toHaveBeenCalled();
    expect(requests).toBe(2);
  } finally {
    await client?.disconnect();
    if (host && host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit'); host.send('close'); await exited;
    }
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    if (dirname(resolve(homeDir)) !== resolve(tmpdir())) throw new Error('Unsafe schema fixture cleanup');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
