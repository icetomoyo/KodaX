/**
 * The REPL on the Host of this home, over v2: one connection, the provider
 * keys the CLI lends its Runs, and every Host face the REPL reads.
 */
import type { ClientStartupProgress } from '@kodax-ai/coding/client-contract';
import type {
  CommandCallbacks,
  InkClientPlane,
  LearningBinding,
  SessionCommandBinding,
  SessionCompactBinding,
  SessionGoalBinding,
} from '@kodax-ai/repl';

import type { KodaXClientHostAuthorization } from '../client-host-authorization.js';
import type { KodaXHostClient } from '../host-protocol/host-client.js';
import { ensureKodaXHostClient } from '../local-host-client.js';
import { createReplHostCommands, type ReplHostCommands } from './host-commands.js';
import { createReplLearning } from './learning.js';
import { createReplLeases, type ReplLeases } from './leases.js';
import { createReplClientPlane } from './plane.js';
import { createReplSessionBindings } from './sessions.js';
import { createReplCatalog, createReplConfig } from './settings.js';
import { createReplWorkflows } from './workflows.js';

export interface ConnectReplHostOptions {
  readonly version: string;
  readonly authorize: KodaXClientHostAuthorization;
  readonly onStartupProgress?: (progress: ClientStartupProgress) => void;
  /** What no caller is otherwise told, such as a failed reconnect or a Run that could not be picked up again. */
  readonly onError: (error: unknown) => void;
}

/**
 * Connects to the Host, starting it when none runs. A Host the REPL starts
 * stops soon after the last client leaves. When a new Host takes over, a Run
 * the old one left is picked up again on the key the CLI lends it.
 */
export async function connectReplHost(options: ConnectReplHostOptions): Promise<{
  readonly client: KodaXHostClient<'local'>;
  readonly leases: ReplLeases;
}> {
  let leases: ReplLeases | undefined;
  const client = await ensureKodaXHostClient({
    client: { name: 'kodax-cli', version: options.version },
    exitWhenIdle: true,
    ...(options.onStartupProgress !== undefined ? { onStartupProgress: options.onStartupProgress } : {}),
    onError: options.onError,
    async recoveryLeases(runId) {
      // Recovery runs only after a reconnect, so the leases are set by then.
      const { run } = await client.call('run.get', { runId });
      return leases!({ kind: 'recovery', input: { sessionId: run.sessionId, runId } });
    },
  });
  leases = createReplLeases(client, options.authorize);
  return { client, leases };
}

/** The Host faces the REPL options take. */
export interface ReplHostBindings extends ReplHostCommands {
  readonly clientPlane: InkClientPlane;
  readonly sessionCommands: SessionCommandBinding;
  readonly goal: SessionGoalBinding;
  readonly compactSession: SessionCompactBinding;
  readonly learning: LearningBinding;
  readonly workflows: NonNullable<CommandCallbacks['workflows']>;
  readonly config: NonNullable<CommandCallbacks['config']>;
  readonly catalog: NonNullable<CommandCallbacks['catalog']>;
  readonly providerCapabilities: NonNullable<CommandCallbacks['providerCapabilities']>;
}

export function createReplHostBindings(client: KodaXHostClient<'local'>, leases: ReplLeases): ReplHostBindings {
  const { sessions, goal, compact } = createReplSessionBindings(client, leases);
  const catalog = createReplCatalog(client, leases);
  return {
    ...createReplHostCommands(client, leases),
    clientPlane: createReplClientPlane(client, leases),
    sessionCommands: sessions,
    goal,
    compactSession: compact,
    learning: createReplLearning(client),
    workflows: createReplWorkflows(client, leases),
    config: createReplConfig(client),
    catalog,
    providerCapabilities: catalog,
  };
}
