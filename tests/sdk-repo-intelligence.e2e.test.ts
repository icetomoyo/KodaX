import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ensureKodaXClient, connectKodaXClient } from '../src/sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from '../src/sdk-runtime.js';

it('inspects and prewarms the executing Host project shared by two clients without Provider requests', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-project-status-'));
  await writeFile(path.join(homeDir, 'fixture.ts'), 'export const answer = 42;\n');
  const profile = 'project-status';
  const client = await ensureKodaXClient({ homeDir, profile });
  const peer = await connectKodaXClient({ homeDir, profile });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { repoIntelligenceMode: 'off' });
    expect(await client.catalog.inspectRepoIntelligence(session.id)).toMatchObject({ initialized: false, status: 'disabled' });
    expect(await peer.catalog.prewarmRepoIntelligence(session.id)).toMatchObject({ initialized: false, status: 'disabled' });
    await client.sessions.updateSettings(session.id, { repoIntelligenceMode: 'light' });
    expect(await client.catalog.inspectRepoIntelligence(session.id)).toMatchObject({ initialized: false });
    const [first, second] = await Promise.all([client.catalog.prewarmRepoIntelligence(session.id),
      peer.catalog.prewarmRepoIntelligence(session.id)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ initialized: true, sessionId: session.id, workspaceRoot: homeDir });
    expect(first.runtimeId).toBeTruthy();
    expect(await peer.catalog.inspectRepoIntelligence(session.id)).toEqual(first);
    expect((await client.statistics.readRequests(session.id)).items).toEqual([]);
  } finally {
    await peer.disconnect();
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner })).toMatchObject({ status: 'succeeded' });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
