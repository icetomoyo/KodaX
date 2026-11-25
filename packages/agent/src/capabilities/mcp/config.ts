/**
 * MCP server configuration shapes.
 *
 * FEATURE_082 (v0.7.24): moved from `@kodax-ai/coding/src/types.ts`. Kept as the
 * `Mcp*` names here; the `KodaXMcp*` aliases continue to re-export from
 * `@kodax-ai/coding` for backward compatibility.
 */

/**
 * Transport config kind. `http` is a compatibility alias used by other MCP
 * clients' config files; KodaX auto-detects Streamable HTTP first, then falls
 * back to the legacy HTTP+SSE transport. It is not a distinct wire protocol.
 */
export type McpTransportKind = 'stdio' | 'sse' | 'streamable-http' | 'http';
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
  /** sse / streamable-http / http(auto): server endpoint URL. */
  url?: string;
  /** sse / streamable-http / http(auto): extra HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
  connect?: McpConnectMode;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Exact tool names to expose; omitted means every tool the server lists. */
  enabledTools?: string[];
  /** Exact tool names to hide and refuse; applied after enabledTools. */
  disabledTools?: string[];
  /**
   * OAuth 2.0 for authenticated MCP servers. All endpoint fields are optional:
   * when omitted, KodaX discovers them at runtime (RFC 9728 → RFC 8414) and
   * dynamically registers a client (RFC 7591). Provide them only to pin a
   * pre-registered client / static endpoints.
   */
  auth?: {
    readonly type: 'oauth2';
    readonly clientId?: string;
    readonly authorizationUrl?: string;
    readonly tokenUrl?: string;
    readonly scopes?: readonly string[];
    readonly redirectPort?: number;
  };
}

/** Flat map of MCP server configs, keyed under `mcpServers` in config.json. */
export type McpServersConfig = Record<string, McpServerConfig>;
