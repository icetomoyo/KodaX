/**
 * The MCP servers the Host connects to, and the tools they offer. Only the
 * owner may see or change them for now; a platform may later open them to the
 * person, item by item.
 *
 * A server's configuration comes back as saved, `env` and `headers`
 * included, so it may hold secrets.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';

const Name = z.string().min(1).max(256);

/**
 * A server's configuration as the Host keeps it: `type` (`stdio`, `sse`,
 * `streamable-http` or `http`), then `command`, `args`, `cwd` and `env` for
 * stdio, or `url` and `headers` for the others, and `connect` (`lazy`,
 * `prewarm` or `disabled`). The Host checks the rest.
 */
const ServerConfig = z.record(z.string(), z.unknown());

const Server = z.object({
  name: z.string(),
  config: ServerConfig,
  connect: z.string(),
  /** `idle`, `connecting`, `ready`, `error` or `disabled`. */
  status: z.string(),
  /** The transport the Host settled on, once connected. */
  transport: z.string().optional(),
  tools: z.int(),
  resources: z.int(),
  prompts: z.int(),
  /** Whether what the server offers changed since the Host last read it; the next read asks the server again. */
  stale: z.boolean(),
  cachedAt: z.string().optional(),
  lastError: z.string().optional(),
});

const Tool = z.object({
  /** `mcp:<server>:tool:<name>`, the name permission rules use. */
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  summary: z.string(),
  /** `read`, `write`, `network` or `exec`, when the Host could tell. */
  risk: z.string().optional(),
  inputSchema: z.unknown().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

/** One server's tools, or why they could not be read. One server failing does not fail the others. */
const ServerTools = z.object({
  server: z.string(),
  tools: z.array(Tool).optional(),
  cachedAt: z.string().optional(),
  error: z.string().optional(),
});

export const MCP_METHODS = {
  'mcp.server.list': { primitive: 'query', plane: 'settings', params: hostParams({}), result: hostList(Server) },
  /** Fails with `not_found` when no server has the name. */
  'mcp.server.get': {
    primitive: 'query', plane: 'settings', params: hostParams({ name: Name }), result: hostResult({ config: ServerConfig }),
  },
  /** Says whether the Host could use the configuration, without saving it. */
  'mcp.server.validate': {
    primitive: 'query',
    plane: 'settings',
    params: hostParams({ name: Name, config: ServerConfig }),
    result: hostResult({ ok: z.boolean(), config: ServerConfig.optional(), error: z.string().optional() }),
  },
  /**
   * Saves a server, or replaces the one of the same name. A running server
   * keeps its old configuration until `mcp.server.reload`. Fails with
   * `invalid_params` when the Host cannot use it.
   */
  'mcp.server.upsert': {
    primitive: 'command',
    resend: 'auto',
    plane: 'settings',
    params: hostCommandParams({ name: Name, config: ServerConfig }),
    result: hostResult({ config: ServerConfig }),
  },
  /** Answers the same whether or not the server was there, so it is safe to send again. */
  'mcp.server.remove': {
    primitive: 'command', resend: 'auto', plane: 'settings', params: hostCommandParams({ name: Name }), result: hostResult({}),
  },
  /**
   * Disconnects every server and connects again with the saved configurations.
   * The SDK does not send it again: that would cut every server off once more.
   */
  'mcp.server.reload': { primitive: 'command', resend: 'never', plane: 'settings', params: hostCommandParams({}), result: hostList(Server) },
  /**
   * The tools of every server, or of `server`. Reading a server the Host has
   * not connected to yet connects to it, which for a stdio server starts its
   * command. Fails with `not_found` when `server` names none.
   */
  'mcp.tool.list': {
    primitive: 'query', plane: 'settings', params: hostParams({ server: Name.optional() }), result: hostList(ServerTools),
  },
  /** Like `mcp.tool.list`, but asks each server again instead of reading what the Host kept. */
  'mcp.tool.refresh': {
    primitive: 'command', resend: 'auto', plane: 'settings', params: hostCommandParams({ server: Name.optional() }), result: hostList(ServerTools),
  },
} as const satisfies HostMethodRegistry;
