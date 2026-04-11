import type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
} from '../../../extensions/types.js';
import type { KodaXExtensionRuntime } from '../../../extensions/runtime.js';
import type {
  KodaXMcpServerConfig,
  KodaXMcpServersConfig,
} from '../../../types.js';
import {
  defaultMcpCacheDir,
  parseMcpCapabilityId,
  searchMcpCatalog,
  type McpCatalogItem,
} from './catalog.js';
import {
  McpServerRuntime,
  type McpServerRuntimeDiagnostics,
} from './runtime.js';

interface McpProviderOptions {
  cacheDir?: string;
}

function enabledServerEntries(
  servers: KodaXMcpServersConfig | undefined,
): Array<[string, KodaXMcpServerConfig]> {
  return Object.entries(servers ?? {})
    .filter(([, serverConfig]) => (serverConfig.connect ?? 'lazy') !== 'disabled');
}

export class McpCapabilityProvider implements CapabilityProvider {
  readonly id = 'mcp';
  readonly kinds: CapabilityProvider['kinds'] = ['tool', 'resource', 'prompt'];
  private readonly runtimes = new Map<string, McpServerRuntime>();
  private readonly cacheDir: string;

  constructor(
    servers: KodaXMcpServersConfig | undefined,
    options: McpProviderOptions = {},
  ) {
    this.cacheDir = options.cacheDir ?? defaultMcpCacheDir();
    for (const [serverId, serverConfig] of enabledServerEntries(servers)) {
      this.runtimes.set(
        serverId,
        new McpServerRuntime(serverId, serverConfig, this.cacheDir),
      );
    }
  }

  hasActiveServers(): boolean {
    return this.runtimes.size > 0;
  }

  async prewarm(): Promise<void> {
    // Prewarm all servers in parallel so startup latency is bounded by the
    // slowest server rather than their sum.
    await Promise.allSettled(
      Array.from(this.runtimes.values()).map((runtime) => runtime.prewarmIfNeeded()),
    );
    // Individual failures are retained in each server's diagnostics and do
    // not block the provider from starting.
  }

  async search(
    query: string,
    options: { kind?: CapabilityKind; limit?: number; server?: string } = {},
  ): Promise<unknown[]> {
    const items = await this.collectCatalogItems(options.server);
    return searchMcpCatalog(items, query, {
      kind: options.kind,
      limit: options.limit,
    });
  }

  async describe(id: string): Promise<unknown> {
    const { serverId } = parseMcpCapabilityId(id);
    const runtime = this.requireRuntime(serverId);
    return runtime.describeCapability(id);
  }

  async execute(
    id: string,
    input: Record<string, unknown>,
  ): Promise<CapabilityResult> {
    const { serverId, kind, name } = parseMcpCapabilityId(id);
    if (kind !== 'tool') {
      throw new Error(`Capability ${id} is not an MCP tool.`);
    }
    const runtime = this.requireRuntime(serverId);
    const result = await runtime.callTool(name, input);
    return {
      kind: 'tool',
      content: result.content,
      structuredContent: result.structuredContent,
      artifacts: [{
        kind: 'provider',
        label: id,
        value: id,
      }],
      metadata: {
        providerId: this.id,
        capabilityId: id,
        serverId,
        ...(result.metadata ?? {}),
      },
    };
  }

  async read(
    id: string,
    options: Record<string, unknown> = {},
  ): Promise<CapabilityResult> {
    const { serverId, kind, name } = parseMcpCapabilityId(id);
    if (kind !== 'resource') {
      throw new Error(`Capability ${id} is not an MCP resource.`);
    }
    const runtime = this.requireRuntime(serverId);
    const result = await runtime.readResource(name, options);
    return {
      kind: 'resource',
      content: result.content,
      structuredContent: result.structuredContent,
      artifacts: [{
        kind: 'provider',
        label: id,
        value: id,
      }],
      metadata: {
        providerId: this.id,
        capabilityId: id,
        serverId,
        ...(result.metadata ?? {}),
      },
    };
  }

  async getPrompt(
    id: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const { serverId, kind, name } = parseMcpCapabilityId(id);
    if (kind !== 'prompt') {
      throw new Error(`Capability ${id} is not an MCP prompt.`);
    }
    const runtime = this.requireRuntime(serverId);
    return runtime.getPrompt(name, args);
  }

  async getPromptContext(): Promise<string | undefined> {
    if (!this.hasActiveServers()) {
      return undefined;
    }

    const diagnostics = this.listServerDiagnostics();
    const lines = [
      '## MCP Capability Provider',
      'Use `mcp_describe` to inspect input schemas, then `mcp_call` to invoke. Use `mcp_read_resource` for resources.',
      'When a built-in tool fails or is unavailable, check whether an MCP tool below can accomplish the same goal.',
      '',
    ];

    for (const entry of diagnostics) {
      const header = [
        `### ${entry.serverId}`,
        `status=${entry.status}`,
      ];
      if (entry.lastError) {
        header.push(`warning=${entry.lastError}`);
      }
      lines.push(header.join(' | '));

      // List tool names and summaries from cached catalog so the model
      // knows WHAT capabilities each server provides without an extra
      // mcp_search round-trip.  This only reads from memory / disk cache
      // and never triggers a lazy connection.
      const runtime = this.runtimes.get(entry.serverId);
      const catalog = runtime ? await runtime.getCachedCatalog() : undefined;
      if (catalog && catalog.items.length > 0) {
        for (const item of catalog.items) {
          lines.push(`- \`${item.id}\` (${item.kind}) — ${item.summary}`);
        }
      } else if (entry.cachedAt) {
        lines.push(`- ${entry.tools} tools / ${entry.resources} resources / ${entry.prompts} prompts (use \`mcp_search\` to discover)`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  getDiagnostics(): Record<string, unknown> | undefined {
    if (!this.hasActiveServers()) {
      return undefined;
    }

    const servers = this.listServerDiagnostics();
    return {
      cacheDir: this.cacheDir,
      serverCount: servers.length,
      servers,
      toolCount: servers.reduce((total, entry) => total + entry.tools, 0),
      resourceCount: servers.reduce((total, entry) => total + entry.resources, 0),
      promptCount: servers.reduce((total, entry) => total + entry.prompts, 0),
    };
  }

  async refresh(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.refreshCatalog();
    }
  }

  async dispose(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.dispose();
    }
  }

  private async collectCatalogItems(server?: string): Promise<McpCatalogItem[]> {
    const runtimes = server
      ? [this.requireRuntime(server)]
      : Array.from(this.runtimes.values());
    const items: McpCatalogItem[] = [];
    let firstError: Error | undefined;

    for (const runtime of runtimes) {
      try {
        const snapshot = await runtime.getCatalog();
        items.push(...snapshot.items);
      } catch (error) {
        if (server) {
          throw error;
        }
        if (!firstError) {
          firstError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    if (items.length === 0 && firstError) {
      throw firstError;
    }

    return items;
  }

  private listServerDiagnostics(): McpServerRuntimeDiagnostics[] {
    return Array.from(this.runtimes.values()).map((runtime) => runtime.getDiagnostics());
  }

  private requireRuntime(serverId: string): McpServerRuntime {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return runtime;
  }
}

export async function registerConfiguredMcpCapabilityProvider(
  runtime: KodaXExtensionRuntime,
  servers: KodaXMcpServersConfig | undefined,
  options: McpProviderOptions = {},
): Promise<McpCapabilityProvider | undefined> {
  const provider = new McpCapabilityProvider(servers, options);
  if (!provider.hasActiveServers()) {
    return undefined;
  }

  runtime.registerCapabilityProvider(provider, {
    source: {
      kind: 'runtime',
      id: 'runtime:capability:mcp',
      label: 'MCP Capability Provider',
    },
  });
  await provider.prewarm();
  return provider;
}
