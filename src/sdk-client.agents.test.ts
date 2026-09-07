import { describe, expect, it, vi } from 'vitest';
import { toKodaXProductClient } from './sdk-client.js';
import type { KodaXRuntime } from './sdk-runtime.js';

describe('product client agents and registrations face (T30)', () => {
  it('projects registration mutations with their domain CAS options', async () => {
    const registrations = {
      list: vi.fn(async () => []),
      upsert: vi.fn(async (registration: unknown) => registration),
      setEnabled: vi.fn(async () => undefined),
      remove: vi.fn(async () => true),
    };
    const runtime = {
      admin: { agentRegistrations: registrations },
    } as unknown as KodaXRuntime;
    const client = toKodaXProductClient(runtime);

    await client.registrations.list();
    const registration = {
      agentId: 'external:partner',
      displayName: 'Partner Agent',
      enabled: true,
      executorId: 'partner-executor',
      protocol: 'http' as const,
      configurationRevision: 'rev-1',
      endpointIdentityHash: 'sha256:partner',
      capabilities: {
        streaming: 'supported' as const,
        durableTasks: 'supported' as const,
        inputRequired: 'supported' as const,
        cancellation: 'supported' as const,
        artifacts: 'supported' as const,
      },
      effects: { remote: 'read' as const, workspace: 'proposal' as const },
    };
    await client.registrations.upsert(registration, {
      expectedConfigurationRevision: null,
      expectedManagementOwner: null,
    });
    await client.registrations.setEnabled('external:partner', false, {
      expectedConfigurationRevision: 'rev-1',
      claimOwner: 'admin-cli',
    });
    await client.registrations.remove('external:partner', {
      expectedManagementOwner: 'admin-cli',
    });

    expect(registrations.list).toHaveBeenCalledOnce();
    expect(registrations.upsert).toHaveBeenCalledWith(registration, {
      expectedConfigurationRevision: null,
      expectedManagementOwner: null,
    });
    expect(registrations.setEnabled).toHaveBeenCalledWith('external:partner', false, {
      expectedConfigurationRevision: 'rev-1',
      claimOwner: 'admin-cli',
    });
    expect(registrations.remove).toHaveBeenCalledWith('external:partner', {
      expectedManagementOwner: 'admin-cli',
    });
  });

  it('projects Actor collaboration reads and controls onto the Host service', async () => {
    const spawnRef = { actorPath: '/root/reviewer', turnId: 'turn-1', state: 'accepted' as const };
    const agents = {
      tree: vi.fn(async () => ({ actors: [] })),
      detail: vi.fn(async () => ({ actorPath: '/root/reviewer' })),
      spawn: vi.fn(async () => spawnRef),
      send: vi.fn(async () => undefined),
      followup: vi.fn(async () => ({ delivery: 'started_turn', turn: spawnRef })),
      interrupt: vi.fn(async () => undefined),
      output: vi.fn(async () => ({ segments: [] })),
      wait: vi.fn(async () => undefined),
    };
    const runtime = { agents } as unknown as KodaXRuntime;
    const client = toKodaXProductClient(runtime);

    await client.agents.tree('session-1');
    await client.agents.detail('session-1', '/root/reviewer');
    await client.agents.spawn('session-1', { taskName: 'reviewer', objective: 'Review.' });
    await client.agents.send('session-1', '/root/reviewer', 'continue', 'internal');
    await client.agents.followup('session-1', '/root/reviewer', 'Keep going.', {
      expectedRevision: 4,
    });
    await client.agents.interrupt('session-1', '/root/reviewer', 'user cancel');
    await client.agents.output('session-1', '/root/reviewer', 'turn-1');
    const signal = new AbortController().signal;
    await client.agents.wait('session-1', 7, 250, { signal });

    expect(agents.tree).toHaveBeenCalledWith('session-1');
    expect(agents.detail).toHaveBeenCalledWith('session-1', '/root/reviewer');
    expect(agents.spawn).toHaveBeenCalledWith('session-1', {
      taskName: 'reviewer',
      objective: 'Review.',
    });
    expect(agents.send).toHaveBeenCalledWith('session-1', '/root/reviewer', 'continue', 'internal');
    // Only the domain identity crosses; credential bindings stay Host-internal.
    expect(agents.followup).toHaveBeenCalledWith('session-1', '/root/reviewer', 'Keep going.', {
      expectedRevision: 4,
    });
    expect(agents.interrupt).toHaveBeenCalledWith('session-1', '/root/reviewer', 'user cancel');
    expect(agents.output).toHaveBeenCalledWith('session-1', '/root/reviewer', 'turn-1');
    expect(agents.wait).toHaveBeenCalledWith('session-1', 7, 250, { signal });
  });
});
