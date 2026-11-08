import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { connectKodaXClient } from '../src/sdk-client.js';
import { connectKodaXRuntime } from '../src/sdk-runtime.js';

it('stops a yielded Script on an independent Host and lets two clients immediately read fresh observed history', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-script-host-'));
  let requests = 0;
  let running: Record<string, unknown> | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const wire = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { messages: { role: string; content?: string }[] };
    const step = requests++;
    if (step > 0) {
      const result = input.messages.findLast(message => message.role === 'tool');
      if (result?.content) running = JSON.parse(result.content) as Record<string, unknown>;
      await gate;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = step === 0 ? { tool_calls: [{ index: 0, id: 'host-script', type: 'function', function: { name: 'script_exec',
      arguments: JSON.stringify({ yield_time_ms: 2000, code: "text('started'); yield_control(); await tools.bash({command:'node -e \"setTimeout(() => {}, 30000)\"'});" }) } }] }
      : { content: 'Stopped.' };
    response.end(`data: ${JSON.stringify({ id: 'script-fixture', choices: [{ index: 0, delta, finish_reason: step === 0 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => wire.listen(0, '127.0.0.1', done));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
  await mkdir(join(homeDir, '.kodax'), { recursive: true });
  await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'script-fixture', learning: { enabled: false },
    customProviders: [{ name: 'script-fixture', protocol: 'openai', model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_UNUSED_SCRIPT_FIXTURE_KEY' }] }));
  const host = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  host.stdout!.resume(); host.stderr!.resume();
  const [ready] = await once(host, 'message');
  expect((ready as { pid: number }).pid).not.toBe(process.pid);
  const endpoint = (ready as { endpoint: string }).endpoint;
  const client = await connectKodaXClient({ homeDir, endpoint, async authorizeExecution(_request, services) {
    const credential = await services.credentials.registerScoped({ providers: ['script-fixture'] }, async () => 'fixture-only');
    return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['script-fixture'] }, profile: {} };
  } });
  const peer = await connectKodaXClient({ homeDir, endpoint });
  const runtime = await connectKodaXRuntime({ homeDir, endpoint });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { workMode: 'script', agentMode: 'sa', permissionMode: 'full-access' });
    const active = await client.inputs.submit({ sessionId: session.id, inputId: 'script-stop', text: 'Run the long Script and wait for Stop.' });
    await expect.poll(() => running, { timeout: 20_000 }).toMatchObject({ status: 'running', cleanupComplete: false });
    await client.runs.stop(active.runId!);
    release();
    expect((await client.runs.await(active.runId!)).phase).toBe('interrupted');
    const observation = await runtime.sessions.observeView(session.id, () => undefined);
    try {
      const [a, b] = await Promise.all([client.sessions.readHistory(session.id, { limit: 100 }), peer.sessions.readHistory(session.id, { limit: 100 })]);
      expect(a).toEqual(b);
      expect(a.items.some(item => item.text?.includes('Run the long Script'))).toBe(true);
    } finally { observation.close(); }
    expect(requests).toBe(2);
  } finally {
    release(); await runtime.close(); await client.disconnect(); await peer.disconnect();
    if (host.exitCode === null && host.signalCode === null) { const exited = once(host, 'exit'); host.send('close'); await exited; }
    wire.closeAllConnections(); await new Promise<void>((done, reject) => wire.close(error => error ? reject(error) : done()));
    if (dirname(resolve(homeDir)) !== resolve(tmpdir())) throw new Error('Unsafe fixture cleanup');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
