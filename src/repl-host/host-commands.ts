/**
 * The REPL's commands over a v2 Host: slash commands the Host carries out,
 * reviews, and what the Host reports about its extensions and MCP servers.
 *
 * A command, a review and `/agents lean` are inputs of the Session, so each is
 * sent under its input id: sent again, the Host answers with what it did the
 * first time.
 */
import type { ClientCommandResult, ClientMcpServerStatus, ClientMcpTool } from '@kodax-ai/coding/client-contract';
import type { CommandCallbacks } from '@kodax-ai/repl';

import { createRequestId, type HostCallResult, type KodaXHostClient } from '../host-protocol/host-client.js';
import type { ReplLeases } from './leases.js';

type CommandAnswer = HostCallResult<'command.execute', 'local'>;
type ServerTools = HostCallResult<'mcp.tool.list', 'local'>['items'][number];

export interface ReplHostCommands {
  readonly commandClient: NonNullable<CommandCallbacks['commandClient']>;
  readonly listHostCommands: NonNullable<CommandCallbacks['listHostCommands']>;
  readonly inspectExtensions: NonNullable<CommandCallbacks['inspectExtensions']>;
  readonly mcp: NonNullable<CommandCallbacks['mcp']>;
  readonly startReview: NonNullable<CommandCallbacks['startReview']>;
  readonly reviewAgentsLean: NonNullable<CommandCallbacks['reviewAgentsLean']>;
}

function toCommandResult({ run, success, message }: CommandAnswer): ClientCommandResult {
  const said = message !== undefined ? { message } : {};
  return run !== undefined
    ? { kind: 'started', runId: run.id, ...said }
    : { kind: 'completed', success: success ?? false, ...said };
}

const argsOf = (args: readonly string[] | undefined) => (args !== undefined ? { args: [...args] } : {});

/** One server's tools as the REPL reads them. A server the Host could not read fails the whole read. */
function toServerTools({ server, tools = [], cachedAt }: ServerTools) {
  return {
    serverId: server,
    tools: tools.map(tool => ({ ...tool, serverId: server, cachedAt: cachedAt ?? '' }) as ClientMcpTool),
    ...(cachedAt !== undefined ? { cachedAt } : {}),
  };
}

export function createReplHostCommands(client: KodaXHostClient<'local'>, leases: ReplLeases): ReplHostCommands {
  const leasesOf = (leased: Awaited<ReturnType<ReplLeases>>) => (leased !== undefined ? { leases: leased } : {});
  return {
    commandClient: {
      readPrompt: async ({ sessionId, name, args }) =>
        (await client.call('command.readPrompt', { sessionId, name, ...argsOf(args) })).prompt ?? null,
      async execute(input) {
        const leased = await leases({ kind: 'command', input });
        return toCommandResult(await client.call('command.execute', {
          requestId: input.inputId, sessionId: input.sessionId, name: input.name, ...argsOf(input.args), ...leasesOf(leased),
        }));
      },
    },
    listHostCommands: async projectRoot => (await client.call('command.list', { projectRoot })).items,
    inspectExtensions: async () => {
      const { active, extensions, failures } = await client.call('extension.list', {});
      return { active, extensions, failures };
    },
    mcp: {
      status: async () => (await client.call('mcp.server.list', {})).items.map(({ name, transport, stale, ...server }) => ({
        ...server, serverId: name, dirty: stale, ...(transport !== undefined ? { resolvedTransport: transport } : {}),
      }) as ClientMcpServerStatus),
      async listTools(filter) {
        const scope = filter?.server !== undefined ? { server: filter.server } : {};
        const { items } = filter?.forceRefresh === true
          ? await client.call('mcp.tool.refresh', { requestId: createRequestId(), ...scope })
          : await client.call('mcp.tool.list', scope);
        const failed = items.filter(item => item.error !== undefined);
        if (failed.length > 0) throw new Error(failed.map(item => `${item.server}: ${item.error}`).join('; '));
        return items.map(toServerTools);
      },
    },
    async startReview(input) {
      const leased = await leases({ kind: 'review', input });
      return toCommandResult(await client.call('review.start', {
        requestId: input.inputId, sessionId: input.sessionId, ...argsOf(input.args), ...leasesOf(leased),
      }));
    },
    async reviewAgentsLean(input) {
      const leased = await leases({ kind: 'agents_lean', input });
      return toCommandResult(await client.call('agent.reviewLean', {
        requestId: input.inputId, sessionId: input.sessionId, ...leasesOf(leased),
      }));
    },
  };
}
