import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, createCustomProvider, registerCustomProviders, registerModelProvider } from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it.each((['sa', 'ama'] as const).flatMap(agentMode =>
  (['current', 'other'] as const).map(queueScope => ({ agentMode, queueScope }))))
('$agentMode recovery respects $queueScope Session Product input arriving during diagnosis', async ({ agentMode, queueScope }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-text-recovery-'));
  registerCustomProviders([]);
  vi.stubEnv('KODAX_TEXT_RECOVERY_TEST_KEY', 'test-only');
  const providerConfig = { name: 'client-text-recovery', protocol: 'openai' as const, model: 'vision',
    baseUrl: 'https://unused.invalid', apiKeyEnv: 'KODAX_TEXT_RECOVERY_TEST_KEY', imageInput: true };
  const provider = createCustomProvider(providerConfig);
  registerModelProvider(providerConfig.name, () => provider);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: providerConfig.name });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated text recovery Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-text-recovery-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  registerCustomProviders([providerConfig]);
  let releaseOther = () => {};
  const otherGate = new Promise<void>(resolve => { releaseOther = resolve; });
  let otherStarted = false;
  try {
    const imagePath = path.join(homeDir, 'input.png');
    await writeFile(imagePath, await readFile('tests/fixtures/images/valid-png.png'));
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { agentMode, permissionMode: 'full-access', reasoningMode: 'quick' });
    const queueSession = queueScope === 'current' ? session : await client.sessions.create({ projectPath: homeDir });
    if (queueScope === 'other') {
      await client.sessions.updateSettings(queueSession.id, { agentMode: 'sa', permissionMode: 'full-access' });
    }
    let diagnostics = 0;
    let streams = 0;
    const create = vi.fn(async (request: { stream?: boolean; messages: { content: unknown }[] }) => {
      if (!request.stream) {
        diagnostics++;
        const text = JSON.stringify(request.messages);
        expect(text).not.toContain('data:image/');
        const attachmentId = text.match(/m\d+\/b\d+(?:\/i\d+)?/)?.[0];
        expect(attachmentId).toBeDefined();
        expect(await client.inputs.submit({ sessionId: queueSession.id, inputId: 'followup',
          text: 'New intent supersedes the recovery plan.', delivery: 'after_turn' })).toMatchObject({ state: 'queued' });
        return { choices: [{ message: { content: JSON.stringify({ action: 'omit_attachment', attachmentId,
          reason: 'Provider identified the rejected attachment.' }) }, finish_reason: 'stop' }] };
      }
      if (JSON.stringify(request.messages).includes('Hold the unrelated Session')) {
        otherStarted = true;
        await otherGate;
        return (async function* () {
          yield { choices: [{ delta: { content: 'Unrelated Session finished.' }, finish_reason: 'stop' }] };
        })();
      }
      streams++;
      if (streams === 1) {
        const message = request.messages.findIndex(item => JSON.stringify(item.content).includes('image_url'));
        expect(message).toBeGreaterThanOrEqual(0);
        const content = request.messages[message]!.content as { type: string }[];
        const block = content.findIndex(item => item.type === 'image_url');
        throw Object.assign(new Error(`Invalid image format at messages[${message}].content[${block}].image_url.url`), { status: 400 });
      }
      expect(JSON.stringify(request.messages)).not.toContain('data:image/');
      return (async function* () {
        yield { choices: [{ delta: { content: 'Completed stale recovery.' }, finish_reason: 'stop' }] };
      })();
    });
    Reflect.set(provider, '_client', { chat: { completions: { create } } });
    if (queueScope === 'other') {
      await client.inputs.submit({ sessionId: queueSession.id, inputId: 'other-initial', text: 'Hold the unrelated Session.' });
      await expect.poll(() => otherStarted).toBe(true);
    }
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Describe this image.',
      inputArtifacts: [{ kind: 'image', path: imagePath, mediaType: 'image/png' }] });
    expect(accepted.runId).toBeDefined();
    const settled = await client.runs.await(accepted.runId!);
    expect(diagnostics).toBe(1);
    if (queueScope === 'current') {
      expect(streams).toBe(1);
      expect(settled.phase).toBe('failed');
    } else {
      expect(streams).toBeGreaterThanOrEqual(2);
      expect(settled.phase).toBe('completed');
    }
    expect(await client.inputs.read(queueSession.id, 'followup')).toMatchObject({ state: 'queued' });
    await client.inputs.withdraw(queueSession.id, 'followup');
    const transcript = await runtime.sessions.transcript(session.id);
    expect(JSON.stringify(transcript)).toContain(imagePath.replaceAll('\\', '\\\\'));
  } finally {
    releaseOther();
    await client.disconnect();
    await host.close();
    await runtime.close();
    clearRuntimeModelProviders();
    registerCustomProviders([]);
    vi.unstubAllEnvs();
    expect(path.dirname(homeDir)).toBe(os.tmpdir());
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
