import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKodaXRuntime, connectKodaXRuntime, ensureKodaXRuntime, type RuntimeEvent } from "./runtime-fixture.js";
import { readRuntimeDaemonLockOwner, resolveRuntimeDaemonPaths } from '../src/runtime-daemon/state.js';
import { waitForRuntimeDaemonOwnerExit } from '../src/runtime-daemon/process.js';
import { connectKodaXClient } from '../src/sdk-client.js';

it('keeps local Skill failures across an independent daemon and IPC, then executes after trusted registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-daemon-failure-'));
  const project = path.join(root, 'project');
  const privateSkills = path.join(root, 'main', '.kodax', 'skills');
  const name = 'draft-response';
  const skill = '---\nname: draft-response\ndescription: Draft a response\nallowed-tools: Read\n---\nDraft a short response.\n';
  const requests: string[] = [];
  let providerOutcome: 'success' | 'network' | 401 | 429 = 'success';
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    request.resume();
    request.on('end', () => {
      if (providerOutcome === 'network') { response.destroy(); return; }
      if (providerOutcome !== 'success') {
        response.writeHead(providerOutcome, { 'content-type': 'application/json', 'retry-after': '0' });
        response.end(JSON.stringify({ error: { code: 'skill_not_found',
          message: 'Upstream Skill text must not be classified as a local Skill failure.' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = [{ role: 'assistant', content: 'Draft complete.' }, {}].map((delta, index) => ({
        id: 'skill-test', object: 'chat.completion.chunk', created: 1, model: 'skill-model',
        choices: [{ index: 0, delta, finish_reason: index === 0 ? null : 'stop' }],
      }));
      response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind fixture Provider.');
  vi.stubEnv('KODAX_SKILL_FAILURE_TEST_KEY', 'test-only');
  let daemon: Awaited<ReturnType<typeof ensureKodaXRuntime>> | undefined;
  let main: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    await mkdir(project, { recursive: true });
    await mkdir(path.join(privateSkills, name), { recursive: true });
    await writeFile(path.join(privateSkills, name, 'SKILL.md'), skill);
    await mkdir(path.join(root, '.kodax'), { recursive: true });
    await writeFile(path.join(root, '.kodax', 'config.json'), JSON.stringify({
      provider: 'skill-fixture', model: 'skill-model',
      customProviders: [{ name: 'skill-fixture', protocol: 'openai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_SKILL_FAILURE_TEST_KEY', model: 'skill-model' }],
    }));
    main = await createKodaXRuntime({ homeDir: path.join(root, 'main'), sharedDaemonHost: true });
    const prepared = await main.invocations.prepareSkill({ projectRoot: project, name });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('Main did not discover fixture Skill.');
    expect(prepared.invocation.skillInvocation.runtimePolicy.enforceAtRuntime).toBe(true);

    const profile = 'skill-failure';
    daemon = await ensureKodaXRuntime({ homeDir: root, profile, daemonStartupTimeoutMs: 60_000 });
    const owner = readRuntimeDaemonLockOwner(resolveRuntimeDaemonPaths(root, profile).lockFile);
    expect(owner?.pid).toBeDefined();
    expect(owner?.pid).not.toBe(process.pid);
    const session = await daemon.sessions.create({ projectPath: project });
    await daemon.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
    const input = { sessionId: session.id, prompt: prepared.invocation.prompt,
      options: { context: { skillInvocation: prepared.invocation.skillInvocation },
        timeouts: { llm: { maxRetryDelaySec: 0.01 } } } };
    const failures: RuntimeEvent[] = [];
    const subscription = daemon.events.subscribe({ sessionId: session.id, type: ['run.failed'] }, event => failures.push(event));
    try {
      const run = await daemon.runs.start(input);
      const result = await run.result;
      expect(requests).toHaveLength(0);
      const detail = { failureKind: 'local_execution', stage: 'skill_load',
        providerErrorCode: 'skill_not_found', skillName: name };
      expect(result).toMatchObject({ phase: 'failed', failureDetail: detail,
        terminal: { kind: 'failed', failureKind: 'local_execution' } });
      expect(result.error?.message).toContain(name);
      expect(result.error?.message).toContain('trusted discovery sources');
      expect(result.error?.message).not.toContain('Provider');
      expect(JSON.stringify(result.failureDetail)).not.toContain(root);
      expect(JSON.stringify(result.failureDetail)).not.toContain('private-main-registration');
      await expect(daemon.runs.get(run.runId)).resolves.toMatchObject({ failureDetail: detail });
      await expect.poll(() => failures.length, { timeout: 15_000 }).toBe(1);
      expect(JSON.stringify(failures)).toContain('skill_not_found');
      const reconnected = await connectKodaXRuntime({ homeDir: root, profile });
      try {
        await expect(reconnected.runs.await(run.runId)).resolves.toMatchObject({ failureDetail: result.failureDetail });
        expect(JSON.stringify(await reconnected.sessions.diagnostics({ sessionId: session.id }))).toContain('skill_not_found');
      } finally { await reconnected.close(); }
      const product = await connectKodaXClient({ homeDir: root, profile });
      try {
        await expect(product.runs.await(run.runId)).resolves.toMatchObject({ failureDetail: result.failureDetail });
        await expect(product.runs.read(run.runId)).resolves.toMatchObject({ failureDetail: result.failureDetail });
      } finally { await product.disconnect(); }

      await mkdir(path.join(project, '.kodax', 'skills', name), { recursive: true });
      await writeFile(path.join(project, '.kodax', 'skills', name, 'SKILL.md'), skill);
      const next = await daemon.runs.start(input);
      await expect(next.result).resolves.toMatchObject({ phase: 'completed' });
      expect(requests.length).toBeGreaterThan(0);

      for (const [outcome, failureKind, providerErrorCode] of [
        [401, 'auth', 'authentication_failed'],
        [429, 'rate_limit', 'rate_limited'],
        ['network', 'network', 'network_error'],
      ] as const) {
        providerOutcome = outcome;
        const before = requests.length;
        const failed = await daemon.runs.start(input);
        const providerFailure = await failed.result;
        expect(requests.length).toBeGreaterThan(before);
        expect(providerFailure).toMatchObject({ phase: 'failed',
          failureDetail: { failureKind, stage: outcome === 401 ? 'credential' : 'transport', providerErrorCode } });
        expect(providerFailure.failureDetail).not.toHaveProperty('skillName');
        expect(providerFailure.failureDetail?.safeMessage).not.toContain('Upstream Skill');
      }
    } finally { await subscription.close(); }
  } finally {
    if (daemon) {
      const owner = readRuntimeDaemonLockOwner(resolveRuntimeDaemonPaths(root, 'skill-failure').lockFile);
      try { await daemon.daemon.shutdown(); }
      finally { await daemon.close(); }
      if (owner) await waitForRuntimeDaemonOwnerExit(owner, 30_000);
    }
    await main?.close();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
