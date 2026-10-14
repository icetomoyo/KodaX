import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createSessionManager } from '@kodax-ai/repl';

class DraftTestProvider extends KodaXBaseProvider {
  readonly name = 'session-draft-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_SESSION_DRAFT_TEST_KEY', model: 'draft-test', supportsThinking: false,
  };
  constructor(private readonly onRequest: () => void = () => undefined) { super(); }
  async stream(): Promise<KodaXStreamResult> {
    this.onRequest();
    return { textBlocks: [{ type: 'text', text: 'Draft saved.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

afterEach(() => {
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
});

it.each(['sa', 'ama'] as const)('does not dispatch a low-level %s Run when draft settings promotion fails', async agentMode => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-draft-run-failure-'));
  vi.stubEnv('KODAX_SESSION_DRAFT_TEST_KEY', 'test-only');
  let requests = 0;
  registerModelProvider('session-draft-test', () => new DraftTestProvider(() => { requests += 1; }));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const settingsDir = path.join(homeDir, '.kodax', 'runtime', 'profiles', 'default', 'session-settings');
  let blockedSettings = false;
  try {
    const draft = await runtime.sessions.create({ draft: true, projectPath: homeDir });
    await runtime.sessions.updateSettings(draft.id, { provider: 'session-draft-test',
      permissionMode: 'full-access', agentMode });
    await fs.mkdir(path.dirname(settingsDir), { recursive: true });
    await fs.writeFile(settingsDir, 'Block the first settings write.');
    blockedSettings = true;
    const result = await runtime.runs.start({ sessionId: draft.id, prompt: 'Save before execution.',
      mode: agentMode === 'sa' ? 'coding' : 'managed_task' })
      .then(run => run.result).catch((error: unknown) => ({ phase: 'failed' as const, error }));
    expect(result.phase).toBe('failed');
    expect(requests).toBe(0);
  } finally {
    if (blockedSettings) await fs.rm(settingsDir);
    await runtime.close(); await fs.rm(homeDir, { recursive: true, force: true });
  }
});

it.each(['sa', 'ama'] as const)('retains draft settings after a low-level %s Run promotes the Session and the Host restarts', async agentMode => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-draft-run-settings-'));
  vi.stubEnv('KODAX_SESSION_DRAFT_TEST_KEY', 'test-only');
  registerModelProvider('session-draft-test', () => new DraftTestProvider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const sessions = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'),
    configHome: path.join(homeDir, '.kodax') });
  try {
    const draft = await runtime.sessions.create({ draft: true, projectPath: homeDir });
    const settings = { provider: 'session-draft-test', permissionMode: 'full-access' as const, agentMode };
    await runtime.sessions.updateSettings(draft.id, settings);
    const run = await runtime.runs.start({ sessionId: draft.id, prompt: 'Save this draft.',
      mode: agentMode === 'sa' ? 'coding' : 'managed_task' });
    expect((await run.result).phase).toBe('completed');
    expect((await runtime.sessions.list()).map(session => session.id)).toContain(draft.id);
    expect((await sessions.loadSession(draft.id))?.messages.filter(message =>
      message.role === 'user' && message.content === 'Save this draft.')).toHaveLength(1);
    await runtime.close();
    const reopened = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
    try {
      expect(await reopened.sessions.getSettings(draft.id)).toMatchObject(settings);
    } finally { await reopened.close(); }
  } finally { await runtime.close(); await fs.rm(homeDir, { recursive: true, force: true }); }
});

it('deletes an unsubmitted draft and permits recreating the same Session ID', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-draft-delete-'));
  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir });
  try {
    await runtime.sessions.create({ sessionId: 'deleted-draft', draft: true, projectPath: homeDir });
    await runtime.sessions.delete('deleted-draft');
    await expect(runtime.sessions.load('deleted-draft')).rejects.toThrow(/not found/i);
    await expect(runtime.sessions.create({ sessionId: 'deleted-draft', draft: true, projectPath: homeDir }))
      .resolves.toMatchObject({ id: 'deleted-draft' });
  } finally { await runtime.close(); await fs.rm(homeDir, { recursive: true, force: true }); }
});

it('keeps a new REPL session and its settings as a draft until input is accepted', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-session-draft-'));
  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir });
  const sessions = createSessionManager({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'),
    configHome: path.join(homeDir, '.kodax') });
  try {
    const draft = await runtime.sessions.create({ draft: true, surface: 'repl', projectPath: homeDir });
    expect(await runtime.sessions.load(draft.id)).toMatchObject({ id: draft.id });
    await runtime.sessions.updateSettings(draft.id, { permissionMode: 'plan', agentMode: 'sa' });
    expect(await runtime.sessions.getSettings(draft.id)).toMatchObject({ permissionMode: 'plan' });
    expect(await sessions.listSessions()).toEqual([]);
    await runtime.close();
    expect(await sessions.loadSession(draft.id)).toBeNull();
    const reopened = await createKodaXRuntime({ mode: 'embedded', homeDir });
    try {
      await reopened.sessions.create({ sessionId: draft.id, title: 'Explicit saved session', projectPath: homeDir });
      expect((await reopened.sessions.getSettingsVersioned(draft.id)).revision).toBe(0);
    } finally { await reopened.close(); }
  } finally {
    await runtime.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
