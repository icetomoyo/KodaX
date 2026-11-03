import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

it('loads a policy-bearing Skill through ProductClient startTool and preserves Host authorization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-host-skill-'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const directory = path.join(root, '.kodax', 'skills', 'inspect');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), [
    '---', 'name: inspect', 'description: Inspect fixture evidence', 'allowed-tools: Read', '---', 'Inspect fixture evidence.',
  ].join('\n'));
  const runtime = await createKodaXRuntime({ homeDir: root, sharedDaemonHost: true, defaultProvider: 'unconfigured-provider' });
  try {
    const client = toKodaXProductClient(runtime);
    const session = await client.sessions.create({ surface: 'code', projectPath: root });
    await client.sessions.updateSettings(session.id, { workMode: 'agent', permissionMode: 'full-access' });
    const accepted = await client.runs.startTool({ sessionId: session.id, inputId: 'skill-input',
      rawInput: 'Load inspect', name: 'skill', input: { skill: 'inspect' } });
    const terminal = await client.runs.await(accepted.runId);
    expect(terminal).toMatchObject({ phase: 'completed', result: {
      success: true, lastText: expect.stringContaining('Inspect fixture evidence.'),
    } });
    // Skill policies remain Run scoped; loading Read-only instructions never grants a later mutation.
    await client.sessions.updateSettings(session.id, { permissionMode: 'plan' });
    const denied = await client.runs.startTool({ sessionId: session.id, inputId: 'undo-input',
      rawInput: 'Undo a project edit', name: 'undo', input: {} });
    expect((await client.runs.await(denied.runId)).result).toMatchObject({
      success: false, lastText: expect.stringContaining('[Blocked]'),
    });
  } finally {
    try { await runtime.close(); }
    finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  }
});
