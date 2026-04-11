import type { KodaXMcpServerConfig } from '../../../types.js';
import {
  buildCatalogSearchText,
  createMcpCapabilityId,
  deriveMcpCapabilityRisk,
  readMcpServerCatalog,
  summarizeMcpCatalogEntry,
  type McpCapabilityDescriptor,
  type McpCapabilityKind,
  type McpCatalogItem,
  type McpServerCatalogSnapshot,
  writeMcpServerCatalog,
} from './catalog.js';
import { createMcpTransport, type McpTransport } from './transport.js';

interface JsonRpcRequestRecord {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface JsonRpcResponseError {
  code?: number;
  message?: string;
}

export interface McpServerRuntimeDiagnostics {
  serverId: string;
  connect: 'lazy' | 'prewarm' | 'disabled';
  status: 'idle' | 'connecting' | 'ready' | 'error' | 'disabled';
  dirty: boolean;
  lastError?: string;
  cachedAt?: string;
  tools: number;
  resources: number;
  prompts: number;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => readString(item))
    .filter((item): item is string => item !== undefined);
  return items.length > 0 ? items : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringifyStructuredValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function flattenMcpContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        const record = asRecord(entry);
        if (!record) {
          return stringifyStructuredValue(entry);
        }
        return readString(record.text)
          ?? readString(record.content)
          ?? readString(record.uri)
          ?? stringifyStructuredValue(record);
      })
      .filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return stringifyStructuredValue(value);
  }

  return readString(record.text)
    ?? readString(record.content)
    ?? stringifyStructuredValue(record);
}

function jsonRpcString(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function buildToolDescriptor(
  serverId: string,
  raw: Record<string, unknown>,
  cachedAt: string,
): McpCapabilityDescriptor {
  const name = readString(raw.name) ?? 'unnamed_tool';
  const annotations = asRecord(raw.annotations);
  const summary = summarizeMcpCatalogEntry(raw, `MCP tool ${name}`);
  return {
    id: createMcpCapabilityId(serverId, 'tool', name),
    serverId,
    kind: 'tool',
    name,
    title: readString(raw.title),
    summary,
    tags: toStringArray(raw.tags),
    risk: deriveMcpCapabilityRisk('tool', name, annotations),
    annotations,
    inputSchema: raw.inputSchema ?? raw.input_schema,
    outputSchema: raw.outputSchema ?? raw.output_schema,
    cachedAt,
  };
}
function buildResourceDescriptor(
  serverId: string,
  raw: Record<string, unknown>,
  cachedAt: string,
): McpCapabilityDescriptor {
  const uri = readString(raw.uri) ?? readString(raw.name) ?? 'resource';
  const annotations = asRecord(raw.annotations);
  const summary = summarizeMcpCatalogEntry(raw, `MCP resource ${uri}`);
  return {
    id: createMcpCapabilityId(serverId, 'resource', uri),
    serverId,
    kind: 'resource',
    name: uri,
    title: readString(raw.title),
    summary,
    tags: toStringArray(raw.tags),
    risk: deriveMcpCapabilityRisk('resource', uri, annotations),
    annotations,
    uri,
    mimeType: readString(raw.mimeType) ?? readString(raw.mime_type),
    cachedAt,
  };
}
function buildPromptDescriptor(
  serverId: string,
  raw: Record<string, unknown>,
  cachedAt: string,
): McpCapabilityDescriptor {
  const name = readString(raw.name) ?? 'prompt';
  const annotations = asRecord(raw.annotations);
  const summary = summarizeMcpCatalogEntry(raw, `MCP prompt ${name}`);
  return {
    id: createMcpCapabilityId(serverId, 'prompt', name),
    serverId,
    kind: 'prompt',
    name,
    title: readString(raw.title),
    summary,
    tags: toStringArray(raw.tags),
    risk: deriveMcpCapabilityRisk('prompt', name, annotations),
    annotations,
    promptArgsSchema: raw.arguments ?? raw.argsSchema ?? raw.args_schema,
    cachedAt,
  };
}
function toCatalogItem(
  descriptor: McpCapabilityDescriptor,
): McpCatalogItem {
  const {
    inputSchema: _inputSchema,
    outputSchema: _outputSchema,
    promptArgsSchema: _promptArgsSchema,
    uri: _uri,
    mimeType: _mimeType,
    ...item
  } = descriptor;
  return item;
}

function extractListEntries(
  result: unknown,
  key: 'tools' | 'resources' | 'prompts',
): { entries: Record<string, unknown>[]; nextCursor?: string } {
  const record = asRecord(result);
  if (!record) {
    return { entries: [] };
  }

  const entries = Array.isArray(record[key])
    ? record[key]
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    : [];

  return {
    entries,
    nextCursor: readString(record.nextCursor) ?? readString(record.next_cursor),
  };
}

export class McpServerRuntime {
  private transport?: McpTransport;
  private readonly pending = new Map<number, JsonRpcRequestRecord>();
  private nextRequestId = 0;
  private initialized = false;
  private connectPromise?: Promise<void>;
  private catalog?: McpServerCatalogSnapshot;
  private diagnostics: McpServerRuntimeDiagnostics;

  constructor(
    private readonly serverId: string,
    private readonly config: KodaXMcpServerConfig,
    private readonly cacheDir: string,
  ) {
    this.diagnostics = {
      serverId,
      connect: config.connect ?? 'lazy',
      status: (config.connect ?? 'lazy') === 'disabled' ? 'disabled' : 'idle',
      dirty: true,
      tools: 0,
      resources: 0,
      prompts: 0,
    };
  }

  getDiagnostics(): McpServerRuntimeDiagnostics {
    return { ...this.diagnostics };
  }
  async prewarmIfNeeded(): Promise<void> {
    if ((this.config.connect ?? 'lazy') !== 'prewarm') {
      return;
    }
    await this.refreshCatalog(true);
  }

  /** Load catalog from memory or disk only — never triggers a lazy connection. */
  async getCachedCatalog(): Promise<McpServerCatalogSnapshot | undefined> {
    if (!this.catalog) {
      this.catalog = await readMcpServerCatalog(this.cacheDir, this.serverId);
      if (this.catalog) {
        this.applyCatalogSnapshot(this.catalog);
      }
    }
    return this.catalog;
  }

  async getCatalog(forceRefresh = false): Promise<McpServerCatalogSnapshot> {
    if (!this.catalog) {
      this.catalog = await readMcpServerCatalog(this.cacheDir, this.serverId);
      if (this.catalog) {
        this.applyCatalogSnapshot(this.catalog);
      }
    }

    if (forceRefresh || this.diagnostics.dirty || !this.catalog) {
      try {
        await this.refreshCatalog(forceRefresh);
      } catch (error) {
        if (!this.catalog) {
          throw error;
        }
      }
    }

    return this.catalog ?? {
      serverId: this.serverId,
      items: [],
      descriptors: [],
      updatedAt: new Date(0).toISOString(),
    };
  }

  async describeCapability(capabilityId: string): Promise<McpCapabilityDescriptor | undefined> {
    const catalog = await this.getCatalog();
    return catalog.descriptors.find((descriptor) => descriptor.id === capabilityId);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{
    content?: string;
    structuredContent?: unknown;
    metadata?: Record<string, unknown>;
  }> {
    await this.connect();
    const response = await this.request('tools/call', { name, arguments: args });
    const record = asRecord(response);
    return {
      content: flattenMcpContent(record?.content),
      structuredContent: record?.structuredContent ?? record?.structured_content,
      metadata: {
        serverId: this.serverId,
        isError: readBoolean(record?.isError) ?? readBoolean(record?.is_error) ?? false,
        raw: record,
      },
    };
  }

  async readResource(name: string, options: Record<string, unknown>): Promise<{
    content?: string;
    structuredContent?: unknown;
    metadata?: Record<string, unknown>;
  }> {
    await this.connect();
    const response = await this.request('resources/read', {
      uri: name,
      ...options,
    });
    const record = asRecord(response);
    const contents = Array.isArray(record?.contents) ? record.contents : [];
    return {
      content: flattenMcpContent(contents),
      structuredContent: contents,
      metadata: {
        serverId: this.serverId,
        raw: record,
      },
    };
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.request('prompts/get', {
      name,
      arguments: args,
    });
  }

  async refreshCatalog(forceReconnect = false): Promise<void> {
    if ((this.config.connect ?? 'lazy') === 'disabled') {
      this.diagnostics.status = 'disabled';
      this.diagnostics.dirty = false;
      return;
    }

    if (forceReconnect) {
      await this.dispose();
    }

    try {
      await this.connect();
      const cachedAt = new Date().toISOString();
      const tools = await this.listDescriptors('tools/list', 'tools', cachedAt);
      const resources = await this.listDescriptors('resources/list', 'resources', cachedAt);
      const prompts = await this.listDescriptors('prompts/list', 'prompts', cachedAt);
      const descriptors = [...tools, ...resources, ...prompts];
      const snapshot: McpServerCatalogSnapshot = {
        serverId: this.serverId,
        descriptors,
        items: descriptors.map(toCatalogItem),
        updatedAt: cachedAt,
      };
      this.catalog = snapshot;
      this.applyCatalogSnapshot(snapshot);
      await writeMcpServerCatalog(this.cacheDir, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics.status = 'error';
      this.diagnostics.lastError = message;
      this.diagnostics.dirty = true;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.connectPromise = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`MCP server "${this.serverId}" disposed during request ${id}.`));
      this.pending.delete(id);
    }
    this.initialized = false;
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
    if ((this.config.connect ?? 'lazy') !== 'disabled') {
      this.diagnostics.status = 'idle';
      this.diagnostics.dirty = true;
    }
  }

  private async connect(): Promise<void> {
    if ((this.config.connect ?? 'lazy') === 'disabled') {
      throw new Error(`MCP server "${this.serverId}" is disabled.`);
    }
    if (this.transport?.connected && this.initialized) {
      return;
    }
    // Serialize concurrent connect() calls so only one runs the retry loop.
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.diagnostics.status = 'connecting';

    // For stdio, try Content-Length framing first (MCP spec). If it fails,
    // retry with NDJSON (Python MCP SDK default).
    const isStdio = (this.config.type ?? 'stdio') === 'stdio';
    const framings = isStdio ? ['content-length', 'ndjson'] as const : [undefined] as const;

    for (const framing of framings) {
      await this.dispose();
      const transport = createMcpTransport(
        this.config,
        framing ? { stdioFraming: framing } : {},
      );
      this.transport = transport;

      await transport.open({
        onMessage: (raw) => this.handleMessage(raw),
        onError: (error) => {
          this.diagnostics.lastError = error.message;
        },
        onClose: (reason) => {
          this.failPending(`MCP server "${this.serverId}" closed: ${reason}`);
          this.transport = undefined;
          this.initialized = false;
          this.diagnostics.status = 'error';
          this.diagnostics.lastError = reason;
          this.diagnostics.dirty = true;
        },
      });

      try {
        // Empty capabilities: KodaX does not support optional client features
        // (roots, sampling) — server requests for these get a -32601 error reply.
        const timeoutMs = framing === 'content-length'
          ? Math.min(this.config.startupTimeoutMs ?? 8_000, 5_000) // shorter for first attempt
          : (this.config.startupTimeoutMs ?? 8_000);
        const initializeResult = await this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'KodaX',
            version: '0.7',
          },
        }, timeoutMs);
        await this.notify('notifications/initialized', {});
        const initialized = asRecord(initializeResult);
        this.initialized = true;
        this.diagnostics.status = 'ready';
        this.diagnostics.lastError = undefined;
        this.diagnostics.dirty = this.diagnostics.dirty || initialized?.capabilities !== undefined;
        return; // Success — stop trying other framings.
      } catch (error) {
        // If this is the last framing option, propagate the error.
        if (framing === framings[framings.length - 1]) {
          throw error;
        }
        // Otherwise, try next framing mode.
      }
    }
  }

  private async listDescriptors(
    method: 'tools/list' | 'resources/list' | 'prompts/list',
    kind: 'tools' | 'resources' | 'prompts',
    cachedAt: string,
  ): Promise<McpCapabilityDescriptor[]> {
    const descriptors: McpCapabilityDescriptor[] = [];
    let cursor: string | undefined;

    while (true) {
      let result: unknown;
      try {
        result = await this.request(method, cursor ? { cursor } : {});
      } catch (error) {
        if (descriptors.length > 0) {
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes('method not found')) {
          return [];
        }
        throw error;
      }

      const { entries, nextCursor } = extractListEntries(result, kind);
      for (const entry of entries) {
        if (kind === 'tools') {
          descriptors.push(buildToolDescriptor(this.serverId, entry, cachedAt));
          continue;
        }
        if (kind === 'resources') {
          descriptors.push(buildResourceDescriptor(this.serverId, entry, cachedAt));
          continue;
        }
        descriptors.push(buildPromptDescriptor(this.serverId, entry, cachedAt));
      }
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }

    return descriptors;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.config.requestTimeoutMs ?? 12_000,
  ): Promise<unknown> {
    if (!this.transport?.connected) {
      throw new Error(`MCP server "${this.serverId}" is not connected.`);
    }

    const requestId = ++this.nextRequestId;
    const json = jsonRpcString({
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    });

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`MCP request timed out for ${this.serverId}:${method}`));
      }, timeoutMs);
      timeout.unref?.();

      this.pending.set(requestId, { resolve, reject, timeout });

      this.transport!.send(json).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.transport?.connected) {
      return;
    }
    await this.transport.send(jsonRpcString({
      jsonrpc: '2.0',
      method,
      params,
    })).catch(() => {});
  }

  private handleMessage(raw: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.diagnostics.status = 'error';
      this.diagnostics.lastError = `Malformed MCP JSON payload from "${this.serverId}".`;
      return;
    }

    const method = readString(payload.method);

    // Response to a pending client→server request.
    const numericId = typeof payload.id === 'number' ? payload.id : undefined;
    if (numericId !== undefined && !method) {
      const pending = this.pending.get(numericId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(numericId);
      const error = asRecord(payload.error) as JsonRpcResponseError | undefined;
      if (error?.message) {
        pending.reject(new Error(error.message));
        return;
      }
      pending.resolve(payload.result);
      return;
    }

    if (!method) {
      return;
    }

    // Server notification (no id).
    if (method.endsWith('/list_changed')) {
      this.diagnostics.dirty = true;
    }

    // Server→client request (has both method and id): respond with
    // "method not found" so the server does not hang.
    const requestId = payload.id;
    if (requestId !== undefined && requestId !== null) {
      this.transport?.send(jsonRpcString({
        jsonrpc: '2.0',
        id: requestId as string | number,
        error: { code: -32601, message: `Method not supported by client: ${method}` },
      })).catch(() => {
        // Best-effort; if the transport is closed the server will time out on its own.
      });
    }
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private applyCatalogSnapshot(snapshot: McpServerCatalogSnapshot): void {
    this.diagnostics.cachedAt = snapshot.updatedAt;
    this.diagnostics.tools = snapshot.items.filter((item) => item.kind === 'tool').length;
    this.diagnostics.resources = snapshot.items.filter((item) => item.kind === 'resource').length;
    this.diagnostics.prompts = snapshot.items.filter((item) => item.kind === 'prompt').length;
    this.diagnostics.dirty = false;
    if (this.diagnostics.status !== 'disabled') {
      this.diagnostics.status = this.transport?.connected ? 'ready' : 'idle';
    }
  }
}
