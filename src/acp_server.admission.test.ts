import { afterEach, expect, it, vi } from 'vitest';

import type { KodaXHostClient } from './host-protocol/host-client.js';
import { disposeReplHosts, MODEL, replHost } from '../tests/repl-v2-host.js';

const launcher = vi.hoisted(() => ({ ensure: vi.fn<() => Promise<KodaXHostClient<'local'>>>() }));
vi.mock('./local-host-client.js', () => ({ ensureKodaXHostClient: launcher.ensure }));
import { KodaXAcpServer } from './acp_server.js';

afterEach(async () => {
  vi.restoreAllMocks();
  launcher.ensure.mockReset();
  await disposeReplHosts();
});

it('leaves an omitted ACP homeDir to the shared launcher resolver', async () => {
  const { client } = await replHost('answer');
  launcher.ensure.mockResolvedValue(client);
  const server = new KodaXAcpServer({ logLevel: 'off' });
  try {
    expect(launcher.ensure).toHaveBeenCalledWith(expect.objectContaining({ homeDir: undefined }));
  } finally {
    await server.dispose();
  }
});

it.each(['session', 'settings', 'observe', 'submit'] as const)('honors cancellation while %s admission is awaiting its Host reply', async stage => {
  const { client, homeDir } = await replHost('hold');
  launcher.ensure.mockResolvedValue(client);
  let release: () => void = () => {};
  let reportReached!: () => void;
  const reached = new Promise<void>(resolve => { reportReached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wait = async () => { reportReached(); await gate; };
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((async (method: string, params: Record<string, unknown>) => {
    const result = await (call as (method: string, params: Record<string, unknown>) => Promise<unknown>)(method, params);
    const held = stage === 'session' ? method === 'session.create'
      : stage === 'settings' ? method === 'session.settings.update' && 'provider' in (params.patch as object)
        : stage === 'submit' && method === 'input.submit';
    if (held) await wait();
    return result;
  }) as typeof client.call);
  if (stage === 'observe') {
    const observe = client.observeSession.bind(client);
    vi.spyOn(client, 'observeSession').mockImplementation(async (id, handlers) => {
      const result = await observe(id, handlers);
      await wait();
      return result;
    });
  }
  const server = new KodaXAcpServer({ homeDir, provider: MODEL, permissionMode: 'full-access', logLevel: 'off' });
  const session = await server.newSession({ cwd: homeDir, mcpServers: [] });
  const prompt = server.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Wait for cancellation' }] });
  try {
    await Promise.race([reached, prompt.then(() => { throw new Error('Prompt completed before its admission gate.'); })]);
    await server.cancel({ sessionId: session.sessionId });
    release();
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    const { items: sessions } = await call('session.list', {});
    const created = sessions.find(item => item.title === 'Wait for cancellation');
    expect(created).toBeDefined();
    const { items: runs } = await call('run.list', { sessionId: created!.id });
    if (stage === 'submit') expect(runs.every(run => ['cancelled', 'interrupted'].includes(run.phase))).toBe(true);
    else expect(runs).toHaveLength(0);
  } finally {
    try { await server.cancel({ sessionId: session.sessionId }); }
    finally {
      release();
      try { await prompt; }
      finally { await server.dispose(); }
    }
  }
}, 60_000);
