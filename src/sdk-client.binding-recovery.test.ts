import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createSessionLineage } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import type { KodaXOptions } from '@kodax-ai/coding';
import { applyRuntimeSkillInvocationPolicy } from '../packages/coding/src/skill-invocation-policy.js';
import { ensureKodaXClient } from './sdk-client.js';
import { runtimeClientPrincipal } from './runtime-daemon/client-lifecycle.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from './sdk-runtime.js';

it.each([
  { name: 'legacy after-turn explicit', delivery: 'after_turn', text: '/missing-old-method Original legacy question', marker: {}, rejects: true },
  { name: 'legacy redirect explicit', delivery: 'redirect', text: '/missing-old-method Original legacy question', marker: {}, rejects: true },
  { name: 'legacy ambiguous explicit redirect', delivery: 'redirect', text: '/missing-old-method and /other-method Original question', marker: {}, rejects: true },
  { name: 'legacy plain redirect', delivery: 'redirect', text: 'Original plain redirect question', marker: {
    admissionError: { code: 'default_skill_unavailable', message: 'Legacy queued Skill identity requires explicit confirmation.' },
  }, rejects: false },
  { name: 'marked plain redirect with unknown slash', delivery: 'redirect', text: '/unknown-method Original raw question', marker: { plainRunBoundary: true }, rejects: false },
] as const)('cold-recovers original authority and $name', async ({ delivery, text, marker, rejects }) => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-binding-recovery-'));
  const configHome = path.join(homeDir, '.kodax');
  const profile = 'bound-recovery';
  const clientInfo = { name: 'Recovery fixture', instanceId: 'recovery-fixture', instanceSecret: 'r'.repeat(64) };
  const requests: string[] = [];
  const wire = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'Recovered.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  const skillPath = path.join(configHome, 'skills', 'original-method', 'SKILL.md');
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, '---\nname: original-method\ndescription: Original method.\n---\nORIGINAL-METHOD-BODY');
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: 'recovery-fixture', protocol: 'openai',
    model: 'fixture', apiKeyEnv: 'UNUSED_RECOVERY_FIXTURE', baseUrl: `http://127.0.0.1:${address.port}/v1` }] }));
  const sessionId = 'original-session';
  const runId = 'original-run';
  const messages = [{ role: 'user' as const, content: 'Original question' }];
  const lineage = createSessionLineage(messages);
  const binding = { businessBinding: { id: 'original-expert', revision: 'r1', data: { connector: 'original' } },
    defaultSkill: { name: 'original-method' } };
  const options: KodaXOptions = { provider: 'recovery-fixture', agentMode: 'sa', workMode: 'agent', context: {
    gitRoot: homeDir, executionCwd: homeDir, rawUserInput: 'Original question', agentProfile: { instructions: 'ORIGINAL-PERSONA' },
    skillInvocation: { name: 'original-method', path: skillPath, expandedContent: 'ORIGINAL-PREPARED-CONTEXT', runtimePolicy: { enforceAtRuntime: true } },
  } };
  await applyRuntimeSkillInvocationPolicy(options, 'Original question');
  await new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome }).save(sessionId,
    { title: 'Cold recovery', gitRoot: homeDir, messages, lineage, runtimeInfo: { surface: 'partner' } });
  const checkpoint = { version: 1, sessionId, turnId: 'original-turn', activeEntryId: lineage.activeEntryId,
    messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
  const runDir = path.join(configHome, 'runtime', 'profiles', profile, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'status.json'), JSON.stringify({ runId, sessionId, phase: 'recovering', provider: 'recovery-fixture',
    model: 'fixture', startedAt: '2026-11-01T00:00:00Z', origin: { principalId: runtimeClientPrincipal(clientInfo.instanceId, clientInfo.instanceSecret) },
    effectiveConfig: { agentProfile: options.context!.agentProfile }, executionBinding: binding,
    contextRecovery: { waitingSince: '2026-11-01T00:00:00Z', checkpoint },
    _runtime: { revision: 1, owner: { ownerId: 'stopped-owner', runtimeId: 'stopped-runtime', pid: 2147483647, startedAt: '2026-11-01T00:00:00Z' } } }));
  await writeFile(path.join(runDir, 'generation-recovery.json'), JSON.stringify({ version: 2, checkpoint,
    start: { prompt: 'Original question', options: { ...options, executionBinding: binding, executionToolCeiling: { tools: ['read', 'write'] } }, requiredBindings: [] },
    requiresCredential: true, requiresHostTools: false, actorTurnBaseline: [],
    pendingInputs: [{ skill: true, ...(delivery === 'redirect' ? { explicitSkill: null } : {}), ...marker,
      principalId: runtimeClientPrincipal(clientInfo.instanceId, clientInfo.instanceSecret),
      input: { sessionId, inputId: 'legacy-method', text, delivery,
        ...(delivery === 'redirect' ? { targetRunId: runId } : {}) } }] }));
  let mode: 'changed' | 'revoked' | 'fresh' = 'changed';
  let leaseId: string | undefined;
  const seen: string[] = [];
  const client = await ensureKodaXClient({ homeDir, profile, clientInfo, async authorizeExecution(_request, services) {
    leaseId ??= (await services.executionBindings.register(async (request, scoped) => {
      if (request.phase === 'recovery') {
        expect(request.recovery?.snapshot).toEqual(binding);
        seen.push(mode);
      }
      const credential = await scoped.credentials.registerScoped({ providers: ['recovery-fixture'] }, async () => 'fresh-fixture-key');
      if (mode === 'revoked') await scoped.credentials.revoke(credential.id);
      return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['recovery-fixture'] },
        businessBinding: mode === 'changed' ? { id: 'different-expert', revision: 'new' }
          : { data: { connector: 'original' }, revision: 'r1', id: 'original-expert' },
        profile: await scoped.createExecutionProfile({ ...(request.recovery?.profile ?? { defaultSkill: binding.defaultSkill }),
          toolVisibilityPolicy: tool => tool.name === 'read' }) };
    })).id;
    return { binding: { leaseId } };
  } });
  try {
    await expect(client.runs.recover({ sessionId, runId })).rejects.toMatchObject({ code: 'execution_binding_changed' });
    mode = 'revoked';
    await expect(client.runs.recover({ sessionId, runId })).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(requests).toHaveLength(0);
    mode = 'fresh';
    await expect(client.runs.recover({ sessionId, runId })).resolves.toEqual({ sessionId, runId });
    expect((await client.runs.await(runId)).phase).toBe('completed');
    // The original profile without intersect resolves to Coding. Rebinding
    // authority must not turn its requested Agent string into a new selection.
    expect(await client.runs.read(runId)).toMatchObject({ workMode: 'coding' });
    await expect(client.sessions.updateSettings(sessionId, { workMode: 'agent' })).rejects.toMatchObject({ code: 'conflict' });
    await client.sessions.updateSettings(sessionId, { provider: 'recovery-fixture', model: 'fixture', agentMode: 'sa', workMode: 'coding', permissionMode: 'full-access' });
    expect(seen).toEqual(['changed', 'revoked', 'fresh']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.includes('ORIGINAL-PERSONA')).toBe(true);
    expect(requests[0]!.includes('ORIGINAL-PREPARED-CONTEXT')).toBe(true);
    const payload = JSON.parse(requests[0]!) as { tools?: { function: { name: string } }[] };
    expect(payload.tools?.map(tool => tool.function.name)).not.toContain('write');
    expect((await client.sessions.readHistory(sessionId)).items.filter(item => item.type === 'user').map(item => item.text)).toEqual(['Original question']);
    expect(await client.inputs.read(sessionId, 'legacy-method')).toMatchObject({ state: 'queued' });
    expect((await client.inputs.read(sessionId, 'legacy-method'))?.runId).toBeUndefined();
    await client.inputs.submit({ sessionId, inputId: 'legacy-method', text, delivery,
      ...(delivery === 'redirect' ? { targetRunId: runId } : {}) });
    await expect.poll(async () => {
      const input = await client.inputs.read(sessionId, 'legacy-method');
      return input?.state === 'submitted' || input?.admissionError !== undefined;
    }, { timeout: 15_000 }).toBe(true);
    const input = await client.inputs.read(sessionId, 'legacy-method');
    if (rejects) {
      expect(input?.admissionError?.code).toBe('default_skill_unavailable');
      expect(requests).toHaveLength(1);
      expect((await client.inputs.withdraw(sessionId, 'legacy-method')).text).toBe(text);
    } else {
      expect(input).toMatchObject({ state: 'submitted' });
      expect(input?.admissionError).toBeUndefined();
      expect((await client.runs.await(input!.runId!)).phase).toBe('completed');
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain('ORIGINAL-METHOD-BODY');
      expect(requests[1]).toContain(text);
    }
  } finally {
    const status = await client.runs.read(runId);
    if (status.phase === 'recovering' || status.phase === 'running') {
      await client.runs.stop(runId);
    }
    const pending = await client.inputs.read(sessionId, 'legacy-method');
    if (pending?.runId) await client.runs.await(pending.runId);
    else if (pending?.state === 'queued') await client.inputs.withdraw(sessionId, 'legacy-method');
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome, profile, owner })).toMatchObject({ status: 'succeeded' });
    wire.closeAllConnections();
    await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
