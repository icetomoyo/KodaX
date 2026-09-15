import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it('binds artifact references to their actual file state at run admission', async () => {
  const PNG_BYTES = await readFile('tests/fixtures/images/valid-png.png');
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-artifacts-'));
  const requestBodies: string[] = [];
  const providerServer = createServer((request, response) => {
    response.socket?.on('error', () => undefined);
    if (!request.url?.includes('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString('utf-8'));
      const chunk = (delta: unknown, finishReason: string | null): string => JSON.stringify({
        id: 'chatcmpl-artifact', object: 'chat.completion.chunk', created: 1, model: 'artifact-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      const frames = [chunk({ role: 'assistant', content: 'Artifact inspected.' }, null), chunk({}, 'stop')]
        .map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames);
    });
  });
  await new Promise<void>((resolve) => { providerServer.listen(0, '127.0.0.1', resolve); });
  const address = providerServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not bind the artifact provider server.');
  }
  vi.stubEnv('KODAX_ARTIFACT_MOCK_KEY', 'test-only');

  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>> | undefined;
  let client: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;
  try {
    await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
    await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({
      provider: 'artifact-mock',
      model: 'artifact-model',
      customProviders: [{
        name: 'artifact-mock',
        protocol: 'openai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'KODAX_ARTIFACT_MOCK_KEY',
        model: 'artifact-model',
        imageInput: true,
      }],
    }), 'utf8');

    const profile = 'artifacts';
    runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire the artifact Host.');
    const endpointPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\kodax-artifacts-${randomUUID()}`
      : path.join(homeDir, 'host.sock');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: endpointPath }
      : { kind: 'unix' as const, path: endpointPath };
    host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    client = await connectKodaXClient({ homeDir, profile, endpoint: endpointPath });

    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, {
      provider: 'artifact-mock', permissionMode: 'full-access', agentMode: 'sa',
    });

    // Intact reference: the registered file's bytes reach the provider wire
    // call as base64 image content.
    const intactPath = path.join(homeDir, 'intact.png');
    await writeFile(intactPath, PNG_BYTES);
    const intact = await runtime.artifacts.create({
      kind: 'image', path: intactPath, mediaType: 'image/png', name: 'intact.png',
    });
    const handle = await runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: 'text', text: 'Inspect the attached image.' },
        { type: 'artifact_ref', artifactId: intact.id },
      ],
    });
    const result = await handle.result;
    expect(result.phase).toBe('completed');
    expect(requestBodies.length).toBeGreaterThan(0);
    expect(requestBodies.at(-1)!).toContain(PNG_BYTES.toString('base64'));

    // Missing reference: deleting the file fails admission with the actual
    // state instead of failing deep inside the executing Run.
    const missingPath = path.join(homeDir, 'missing.png');
    await writeFile(missingPath, PNG_BYTES);
    const missing = await runtime.artifacts.create({ kind: 'image', path: missingPath });
    await rm(missingPath);
    await expect(runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: 'text', text: 'Inspect a deleted attachment.' },
        { type: 'artifact_ref', artifactId: missing.id },
      ],
    })).rejects.toThrow(/no longer readable/i);

    // Changed reference: rewriting the file after registration fails
    // admission; the Run never silently consumes the drifted content.
    const changedPath = path.join(homeDir, 'changed.png');
    await writeFile(changedPath, PNG_BYTES);
    const changed = await runtime.artifacts.create({ kind: 'image', path: changedPath });
    await writeFile(changedPath, Buffer.concat([PNG_BYTES, PNG_BYTES]));
    await expect(runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: 'text', text: 'Inspect a modified attachment.' },
        { type: 'artifact_ref', artifactId: changed.id },
      ],
    })).rejects.toThrow(/changed since registration/i);
  } finally {
    await client?.disconnect();
    await host?.close();
    await runtime?.close();
    registerCustomProviders([]);
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      providerServer.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
