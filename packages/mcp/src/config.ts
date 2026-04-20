/**
 * MCP server configuration shapes.
 *
 * FEATURE_082 (v0.7.24): moved from `@kodax/coding/src/types.ts`. Kept as the
 * `Mcp*` names here; the `KodaXMcp*` aliases continue to re-export from
 * `@kodax/coding` for backward compatibility.
 */

export type McpTransportKind = 'stdio' | 'sse' | 'streamable-http';
export type McpConnectMode = 'lazy' | 'prewarm' | 'disabled';

export interface McpServerConfig {
  /** Transport type. Defaults to 'stdio' when omitted. */
  type?: McpTransportKind;
  /** stdio: executable command. */
  command?: string;
  /** stdio: command arguments. */
  args?: string[];
  /** stdio: working directory for the spawned process. */
  cwd?: string;
  /** stdio: extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** sse / streamable-http: server endpoint URL. */
  url?: string;
  /** sse / streamable-http: extra HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
  connect?: McpConnectMode;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** OAuth 2.0 configuration for authenticated MCP servers. */
  auth?: {
    readonly type: 'oauth2';
    readonly clientId: string;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly scopes?: readonly string[];
    readonly redirectPort?: number;
  };
}

/** Flat map of MCP server configs, keyed under `mcpServers` in config.json. */
export type McpServersConfig = Record<string, McpServerConfig>;
