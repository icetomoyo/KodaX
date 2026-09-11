import type { McpServerConfig as KodaXMcpServerConfig } from './config.js';
import type { CapabilityResult, KodaXToolResultContentItem } from '@kodax-ai/llm';
import { persistImageAsBlock } from '../../media/persist-image.js';
import { getAgentConfigPath } from '../../runtime/agent-home.js';
import {
  buildCatalogSearchText,
  createMcpCapabilityId,
  deriveMcpCapabilityRisk,
  readMcpServerCatalog,
  sanitizeMcpIcons,
  summarizeMcpCatalogEntry,
  type McpCapabilityDescriptor,
  type McpToolTaskSupport,
  type McpCapabilityKind,
  type McpCatalogItem,
  type McpServerCatalogSnapshot,
  writeMcpServerCatalog,
} from './catalog.js';
import {
  McpAuthRequiredError,
  McpExpiredSessionError,
  createMcpTransport,
  type McpTransport,
} from './transport.js';
import { getValidToken, type OAuthToken } from './oauth.js';
import {
  loadValidToken,
  performOAuthLogin,
  type OAuthLoginConsent,
} from './oauth-login.js';
import { emitKodaXDiagnostic } from '../../diagnostics.js';
import { extractInsufficientScope, extractResourceMetadataUrl } from './oauth-discovery.js';
import {
  buildInitializeCapabilities,
  canHandleElicitMode,
  normalizeElicitResult,
  parseElicitRequest,
  parseSamplingRequest,
  type McpReverseCapabilities,
} from './reverse-capabilities.js';

interface JsonRpcRequestRecord {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface JsonRpcResponseError {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface McpServerRuntimeDiagnostics {
  serverId: string;
  connect: 'lazy' | 'prewarm' | 'disabled';
  status: 'idle' | 'connecting' | 'ready' | 'error' | 'disabled';
  resolvedTransport?: string;
  dirty: boolean;
  lastError?: string;
  cachedAt?: string;
  tools: number;
  resources: number;
  prompts: number;
}

export interface McpDiscoveryCatalog {
  snapshot: McpServerCatalogSnapshot;
  freshness: 'live' | 'stale';
  complete: boolean;
  error?: string;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function omitRecordKeys(
  record: Record<string, unknown> | undefined,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!record) {
    return {};
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}

function collectContentMetadata(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const metadata = value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return [];
    }
    const image = mcpImageRecord(record);
    if (image) {
      const remaining = omitRecordKeys(record, new Set(['type', 'data', 'blob', 'resource']));
      if (record.resource) remaining.resource = omitRecordKeys(image, new Set(['data', 'blob']));
      return Object.keys(remaining).length > 0 ? [remaining] : [];
    }
    const selectedKey = readString(record.text) !== undefined
      ? 'text'
      : readString(record.content) !== undefined
        ? 'content'
        : readString(record.uri) !== undefined
          ? 'uri'
          : undefined;
    if (!selectedKey) {
      return [];
    }
    const ignored = new Set([selectedKey]);
    if (record.type === selectedKey || (selectedKey === 'content' && record.type === 'text')) {
      ignored.add('type');
    }
    const remaining = omitRecordKeys(record, ignored);
    return Object.keys(remaining).length > 0 ? [remaining] : [];
  });
  return metadata.length > 0 ? metadata : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readTextContent(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
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
    return readTextContent(value);
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
    return readTextContent(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        const record = asRecord(entry);
        if (!record) {
          return stringifyStructuredValue(entry);
        }
        return readTextContent(record.text)
          ?? readTextContent(record.content)
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

  return readTextContent(record.text)
    ?? readTextContent(record.content)
    ?? stringifyStructuredValue(record);
}

/** Media becomes a durable local attachment, never base64 text in model history. */
async function normalizeMcpContent(value: unknown): Promise<CapabilityResult['content']> {
  if (!Array.isArray(value)) return flattenMcpContent(value);
  const hasImage = value.some((entry) => mcpImageRecord(entry) !== undefined);
  if (!hasImage) return flattenMcpContent(value);
  const items: KodaXToolResultContentItem[] = [];
  for (const entry of value) {
    const record = mcpImageRecord(entry);
    const data = record?.type === 'image' ? record.data : record?.blob;
    if (record) {
      const mediaType = record?.mimeType;
      if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/gif' && mediaType !== 'image/webp') {
        throw new Error(`Unsupported MCP image media type: ${String(mediaType)}`);
      }
      if (typeof data !== 'string' || !data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new Error('MCP image content must contain valid base64 data.');
      }
      items.push(await persistImageAsBlock({ buffer: Buffer.from(data, 'base64'), mediaType }, {
        directory: getAgentConfigPath('media', 'mcp'), fileNamePrefix: 'mcp',
      }));
    } else {
      const text = flattenMcpContent([entry]);
      if (text !== undefined) items.push({ type: 'text', text });
    }
  }
  return items;
}

function mcpImageRecord(entry: unknown): Record<string, unknown> | undefined {
  const record = asRecord(entry);
  if (record?.type === 'image') return record;
  const resource = record?.type === 'resource' ? asRecord(record.resource) : record;
  return typeof resource?.mimeType === 'string' && resource.mimeType.startsWith('image/')
    && typeof resource.blob === 'string' ? resource : undefined;
}

function jsonRpcString(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function buildToolDescriptor(
  serverId: string,
  raw: Record<string, unknown>,
  cachedAt: string,
): McpCapabilityDescriptor {
  const name = readString(raw.name);
  if (!name) {
    throw new Error('Invalid tools/list entry: name must be a non-empty string.');
  }
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
    icons: sanitizeMcpIcons(raw.icons),
    taskSupport: readToolTaskSupport(raw.execution),
    inputSchema: raw.inputSchema ?? raw.input_schema,
    outputSchema: raw.outputSchema ?? raw.output_schema,
    cachedAt,
  };
}
function readToolTaskSupport(execution: unknown): McpToolTaskSupport | undefined {
  const value = readString(asRecord(execution)?.taskSupport);
  return value === 'optional' || value === 'required' || value === 'forbidden'
    ? value
    : undefined;
}
function buildResourceDescriptor(
  serverId: string,
  raw: Record<string, unknown>,
  cachedAt: string,
): McpCapabilityDescriptor {
  const uri = readString(raw.uri);
  if (!uri) {
    throw new Error('Invalid resources/list entry: uri must be a non-empty string.');
  }
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
    icons: sanitizeMcpIcons(raw.icons),
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
  const name = readString(raw.name);
  if (!name) {
    throw new Error('Invalid prompts/list entry: name must be a non-empty string.');
  }
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
    icons: sanitizeMcpIcons(raw.icons),
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
    icons: _icons,
    taskSupport: _taskSupport,
    ...item
  } = descriptor;
  return item;
}

function extractListEntries(
  result: unknown,
  key: 'tools' | 'resources' | 'prompts',
): { entries: Record<string, unknown>[]; nextCursor?: string } {
  const record = asRecord(result);
  if (!record || !Array.isArray(record[key])) {
    throw new Error(`Invalid ${key}/list response: expected an object with a ${key} array.`);
  }
  const entries = record[key].map((entry) => asRecord(entry));
  if (entries.some((entry) => entry === undefined)) {
    throw new Error(`Invalid ${key}/list response: every ${key} entry must be an object.`);
  }
  const rawNextCursor = Object.prototype.hasOwnProperty.call(record, 'nextCursor')
    ? record.nextCursor
    : record.next_cursor;
  if (rawNextCursor !== undefined && readString(rawNextCursor) === undefined) {
    throw new Error(`Invalid ${key}/list response: nextCursor must be a non-empty string.`);
  }

  return {
    entries: entries.filter((entry): entry is Record<string, unknown> => entry !== undefined),
    nextCursor: readString(rawNextCursor),
  };
}

// Default timeouts aligned with Claude Code's MCP client.
// Override per-server via startupTimeoutMs / requestTimeoutMs in config,
// or globally via MCP_TIMEOUT / MCP_REQUEST_TIMEOUT env vars.
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;   // Claude Code: 30s
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;   // Claude Code: 60s

// Requested base protocol version. Optional client features are advertised
// separately via initialize.capabilities; KodaX currently sends {} there.
const MCP_PROTOCOL_VERSION = '2025-11-25';

const JsonRpcErrorCode = {
  MethodNotFound: -32601,
} as const;

/** Sentinel from {@link McpServerRuntime.dispatchServerRequest} = not an advertised capability. */
const UNHANDLED_SERVER_REQUEST = Symbol('mcp.unhandled-server-request');
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

class McpProtocolVersionError extends Error {
  constructor(version: string | undefined) {
    super(version
      ? `Unsupported MCP protocol version from server: ${version}`
      : 'MCP initialize response did not include protocolVersion.');
    this.name = 'McpProtocolVersionError';
  }
}

/**
 * A JSON-RPC error response from the server, preserving `code` + `data` so
 * callers can act on structured errors — notably the url-elicitation tool-retry
 * closure, which keys off code -32042 and reads the elicitation from `data`.
 */
class McpJsonRpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = 'McpJsonRpcError';
  }
}

// FEATURE_222 Slice C — when a tools/call needs the user to complete a url
// elicitation first, the server replies with this code (MCP 2025-11-25). The
// client elicits, waits for completion, then retries the call (bounded).
const URL_ELICITATION_REQUIRED_CODE = -32042;
/** How long to wait for notifications/elicitation/complete before retrying. */
const DEFAULT_URL_ELICITATION_TIMEOUT_MS = 300_000;
/** Max url-elicitation round trips for a single tools/call (avoids loops). */
const MAX_URL_ELICITATIONS = 3;

function mentionsMethod(message: string, method: 'tools/list' | 'resources/list' | 'prompts/list'): boolean {
  return message.includes(method)
    || message.includes(method.replace('/', '.'))
    || message.includes(method.replace('/', '_'));
}

function isMethodNotFoundLikeError(
  error: unknown,
  method: 'tools/list' | 'resources/list' | 'prompts/list',
): boolean {
  if (!(error instanceof McpJsonRpcError)) return false;
  if (error.code === JsonRpcErrorCode.MethodNotFound) return true;
  const message = error.message.toLowerCase();
  return message.includes('method not found')
    || message.includes('unknown method')
    || (
      mentionsMethod(message, method)
      && (
        message.includes('not supported')
        || message.includes('unsupported')
        || message.includes('not found')
        || message.includes('unknown')
      )
    );
}

function readNegotiatedProtocolVersion(result: unknown): string {
  const initialized = asRecord(result);
  const version = readString(initialized?.protocolVersion);
  if (!version || !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)) {
    throw new McpProtocolVersionError(version);
  }
  return version;
}

/**
 * Read a url elicitation out of a -32042 error, or undefined when the error is
 * something else / lacks a usable url. The elicitation may sit directly on
 * `error.data` or nested under `data.elicitation`.
 */
function parseUrlElicitationRequired(
  error: unknown,
): { url: string; message?: string; elicitationId?: string } | undefined {
  if (!(error instanceof McpJsonRpcError) || error.code !== URL_ELICITATION_REQUIRED_CODE) {
    return undefined;
  }
  const data = asRecord(error.data);
  const elicitation = asRecord(data?.elicitation) ?? data;
  const url = readString(elicitation?.url);
  if (!url) {
    return undefined;
  }
  return {
    url,
    message: readString(elicitation?.message),
    elicitationId: readString(elicitation?.elicitationId),
  };
}

function bearerHeader(token: OAuthToken): Record<string, string> {
  return { Authorization: `${token.tokenType ?? 'Bearer'} ${token.accessToken}` };
}

function getStartupTimeoutMs(config: KodaXMcpServerConfig): number {
  return config.startupTimeoutMs
    ?? (parseInt(process.env.MCP_TIMEOUT ?? '', 10) || DEFAULT_STARTUP_TIMEOUT_MS);
}

function getRequestTimeoutMs(config: KodaXMcpServerConfig): number {
  return config.requestTimeoutMs
    ?? (parseInt(process.env.MCP_REQUEST_TIMEOUT ?? '', 10) || DEFAULT_REQUEST_TIMEOUT_MS);
}

function hasServerCapability(
  capabilities: Record<string, unknown> | undefined,
  name: 'tools' | 'resources' | 'prompts',
): boolean {
  // Older or non-standard servers may omit initialize.capabilities. Keep the
  // historical probing behavior for them; otherwise honor capability negotiation.
  if (!capabilities) return true;
  return asRecord(capabilities[name]) !== undefined;
}

export class McpServerRuntime {
  private transport?: McpTransport;
  private readonly pending = new Map<number, JsonRpcRequestRecord>();
  /** FEATURE_222 — resolvers awaiting notifications/elicitation/complete, keyed
   *  by elicitationId (used by the url-elicitation tool-retry closure). */
  private readonly elicitationWaiters = new Map<string, () => void>();
  /** Completion notifications that arrived before the host finished consent. */
  private readonly completedElicitations = new Set<string>();
  private nextRequestId = 0;
  private initialized = false;
  private liveCatalogValidated = false;
  private catalogInvalidationVersion = 0;
  private connectPromise?: Promise<void>;
  private discoveryPromise?: Promise<McpDiscoveryCatalog>;
  private catalog?: McpServerCatalogSnapshot;
  private serverCapabilities?: Record<string, unknown>;
  private cachedHttpTransport?: 'streamable-http' | 'sse';
  private diagnostics: McpServerRuntimeDiagnostics;

  constructor(
    private readonly serverId: string,
    private readonly config: KodaXMcpServerConfig,
    private readonly cacheDir: string,
    /** FEATURE_222 — host-injected server→client reverse capabilities. */
    private readonly reverse?: McpReverseCapabilities,
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

  /** Validate cached capability truth on first model-facing discovery use. */
  async getDiscoveryCatalog(): Promise<McpDiscoveryCatalog> {
    if (this.discoveryPromise) return this.discoveryPromise;
    const discovery = this.resolveDiscoveryCatalog();
    this.discoveryPromise = discovery;
    try {
      return await discovery;
    } finally {
      if (this.discoveryPromise === discovery) this.discoveryPromise = undefined;
    }
  }

  private async resolveDiscoveryCatalog(): Promise<McpDiscoveryCatalog> {
    await this.getCachedCatalog();
    if (this.catalog && this.liveCatalogValidated && !this.diagnostics.dirty) {
      return { snapshot: this.catalog, freshness: 'live', complete: true };
    }

    try {
      await this.refreshCatalog();
      return {
        snapshot: this.catalog ?? this.emptyCatalog(),
        freshness: 'live',
        complete: true,
      };
    } catch (error) {
      if (!this.catalog) throw error;
      return {
        snapshot: this.catalog,
        freshness: 'stale',
        complete: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async describeCapability(capabilityId: string): Promise<McpCapabilityDescriptor | undefined> {
    const catalog = await this.getCatalog();
    return catalog.descriptors.find((descriptor) => descriptor.id === capabilityId);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{
    content?: CapabilityResult['content'];
    isError?: boolean;
    structuredContent?: unknown;
    metadata?: Record<string, unknown>;
  }> {
    await this.connect();
    // A tool marked execution.taskSupport: "required" only runs via task
    // augmentation (2025-11-25). KodaX does not implement tasks yet, so surface
    // a clear error instead of a plain tools/call the server will reject.
    const catalog = this.catalog ?? await this.getCatalog();
    const taskSupport = catalog.descriptors.find(
      (descriptor) => descriptor.kind === 'tool' && descriptor.name === name,
    )?.taskSupport;
    if (taskSupport === 'required') {
      throw new Error(
        `MCP tool "${name}" on "${this.serverId}" only runs as a task `
        + `(execution.taskSupport: "required"), which KodaX does not yet support.`,
      );
    }
    // A tool may require the user to complete a url elicitation first
    // (code -32042). Elicit, wait for completion, then retry — bounded so a
    // server that keeps demanding elicitation cannot loop forever.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.request('tools/call', { name, arguments: args });
        const record = asRecord(response);
        const contentMetadata = collectContentMetadata(record?.content);
        return {
          content: await normalizeMcpContent(record?.content),
          isError: readBoolean(record?.isError) ?? readBoolean(record?.is_error) ?? false,
          structuredContent: record?.structuredContent ?? record?.structured_content,
          metadata: {
            serverId: this.serverId,
            isError: readBoolean(record?.isError) ?? readBoolean(record?.is_error) ?? false,
            ...omitRecordKeys(record, new Set([
              'content',
              'structuredContent',
              'structured_content',
              'isError',
              'is_error',
            ])),
            ...(contentMetadata ? { contentMetadata } : {}),
          },
        };
      } catch (error) {
        const elicitation = attempt < MAX_URL_ELICITATIONS
          ? parseUrlElicitationRequired(error)
          : undefined;
        if (!elicitation || !(await this.satisfyUrlElicitation(elicitation))) {
          throw error;
        }
        // consent + completion done — loop retries the tools/call.
      }
    }
  }

  /**
   * Drive a url elicitation the server asked for before a tools/call can
   * succeed: route it to the host (anti-phishing consent UI) and, on consent,
   * wait for the server's completion notification. Returns false when the host
   * cannot serve url elicitation or the user did not consent.
   */
  private async satisfyUrlElicitation(
    request: { url: string; message?: string; elicitationId?: string },
  ): Promise<boolean> {
    if (!this.reverse?.elicit || !canHandleElicitMode(this.reverse, 'url')) {
      return false;
    }
    const result = await this.reverse.elicit({
      mode: 'url',
      serverId: this.serverId,
      url: request.url,
      message: request.message,
      elicitationId: request.elicitationId,
    });
    if (result.action !== 'accept') {
      return false;
    }
    if (request.elicitationId) {
      await this.waitForElicitationComplete(request.elicitationId, DEFAULT_URL_ELICITATION_TIMEOUT_MS);
    }
    return true;
  }

  /** Resolve when the server signals the url elicitation completed, or on timeout
   *  (a premature retry is harmless — the server re-requests and the loop caps). */
  private waitForElicitationComplete(elicitationId: string, timeoutMs: number): Promise<void> {
    if (this.completedElicitations.delete(elicitationId)) {
      return Promise.resolve();
    }
    this.elicitationWaiters.get(elicitationId)?.();
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.elicitationWaiters.delete(elicitationId);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
      this.elicitationWaiters.set(elicitationId, settle);
    });
  }

  async readResource(name: string, options: Record<string, unknown>): Promise<{
    content?: CapabilityResult['content'];
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
    const contentMetadata = collectContentMetadata(contents);
    return {
      content: await normalizeMcpContent(contents),
      structuredContent: record?.structuredContent,
      metadata: {
        serverId: this.serverId,
        ...omitRecordKeys(record, new Set(['contents', 'structuredContent'])),
        ...(contentMetadata ? { contentMetadata } : {}),
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

    let snapshot: McpServerCatalogSnapshot;
    try {
      await this.connect();
      const invalidationVersion = this.catalogInvalidationVersion;
      const cachedAt = new Date().toISOString();
      const tools = hasServerCapability(this.serverCapabilities, 'tools')
        ? await this.listDescriptors('tools/list', 'tools', cachedAt)
        : [];
      const resources = hasServerCapability(this.serverCapabilities, 'resources')
        ? await this.listDescriptors('resources/list', 'resources', cachedAt)
        : [];
      const prompts = hasServerCapability(this.serverCapabilities, 'prompts')
        ? await this.listDescriptors('prompts/list', 'prompts', cachedAt)
        : [];
      if (
        this.catalogInvalidationVersion !== invalidationVersion
        || !this.transport?.connected
        || !this.initialized
      ) {
        throw new Error(
          `MCP catalog changed during discovery for "${this.serverId}"; retry the refresh.`,
        );
      }
      const descriptors = [...tools, ...resources, ...prompts];
      snapshot = {
        serverId: this.serverId,
        descriptors,
        items: descriptors.map(toCatalogItem),
        updatedAt: cachedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics.status = 'error';
      this.diagnostics.lastError = message;
      this.diagnostics.dirty = true;
      this.liveCatalogValidated = false;
      throw error;
    }

    this.catalog = snapshot;
    this.applyCatalogSnapshot(snapshot);
    this.liveCatalogValidated = true;
    this.diagnostics.lastError = undefined;
    try {
      await writeMcpServerCatalog(this.cacheDir, snapshot);
    } catch (error) {
      const message = `MCP catalog cache write failed for "${this.serverId}": ${error instanceof Error ? error.message : String(error)}`;
      this.diagnostics.lastError = message;
      emitKodaXDiagnostic({ source: 'agent:mcp', level: 'warn', message });
    }
  }

  /** Public teardown — clears everything including the connect lock. */
  async dispose(): Promise<void> {
    this.connectPromise = undefined;
    await this.resetTransport();
  }

  /** Internal transport teardown — does NOT clear connectPromise so the
   *  retry loop inside doConnect() can safely call it between attempts. */
  private async resetTransport(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`MCP server "${this.serverId}" disposed during request ${id}.`));
      this.pending.delete(id);
    }
    const elicitationWaiters = [...this.elicitationWaiters.values()];
    this.completedElicitations.clear();
    this.initialized = false;
    this.liveCatalogValidated = false;
    this.serverCapabilities = undefined;
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
    if ((this.config.connect ?? 'lazy') !== 'disabled') {
      this.diagnostics.status = 'idle';
      this.diagnostics.resolvedTransport = undefined;
      this.diagnostics.dirty = true;
    }
    for (const settle of elicitationWaiters) {
      settle();
    }
  }

  private connect(): Promise<void> {
    if ((this.config.connect ?? 'lazy') === 'disabled') {
      return Promise.reject(new Error(`MCP server "${this.serverId}" is disabled.`));
    }
    if (this.transport?.connected && this.initialized) {
      return Promise.resolve();
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
    let authHeaders = await this.resolveInitialAuthHeaders();
    try {
      await this.handshakeWithFramings(authHeaders);
    } catch (error) {
      // FEATURE_222 — the server demanded auth. Discover + interactively log in
      // (once), then retry the handshake with the issued Bearer token.
      if (!(error instanceof McpAuthRequiredError)) throw error;
      const token = await this.runOAuthLogin(error.wwwAuthenticate);
      if (!token) throw error;
      authHeaders = bearerHeader(token);
      await this.handshakeWithFramings(authHeaders);
    }
  }

  /** Initial Authorization header: a static-config token, or a cached token
   *  from a prior discovery-based login. Absent → connect unauthenticated. */
  private async resolveInitialAuthHeaders(): Promise<Record<string, string> | undefined> {
    const auth = this.config.auth;
    // Static (FEATURE_065) path only when fully pre-configured; otherwise the
    // token is acquired via discovery-based login on the first 401.
    if (auth?.type === 'oauth2' && auth.clientId && auth.authorizationUrl && auth.tokenUrl) {
      const token = await getValidToken(this.serverId, {
        type: 'oauth2',
        clientId: auth.clientId,
        authorizationUrl: auth.authorizationUrl,
        tokenUrl: auth.tokenUrl,
        scopes: auth.scopes,
        redirectPort: auth.redirectPort,
      });
      if (token) {
        if (this.config.headers?.Authorization) {
          emitKodaXDiagnostic({
            source: 'agent:mcp',
            level: 'warn',
            message: `OAuth token will override user-provided Authorization header for "${this.serverId}".`,
          });
        }
        return bearerHeader(token);
      }
      emitKodaXDiagnostic({
        source: 'agent:mcp',
        level: 'warn',
        message: `OAuth token required for "${this.serverId}" but not available. Connecting without auth.`,
      });
      return undefined;
    }
    if (this.config.url) {
      const cached = await loadValidToken(this.serverId);
      if (cached) return bearerHeader(cached);
    }
    return undefined;
  }

  private async handshakeWithFramings(
    authHeaders: Record<string, string> | undefined,
  ): Promise<void> {
    // MCP stdio uses newline-delimited JSON. Keep Content-Length only as a
    // compatibility fallback for legacy/custom servers.
    const isStdio = (this.config.type ?? 'stdio') === 'stdio';
    const framings = isStdio ? ['ndjson', 'content-length'] as const : [undefined] as const;

    for (const framing of framings) {
      await this.resetTransport();
      // Merge OAuth headers with user-configured headers.
      const effectiveConfig = authHeaders
        ? { ...this.config, headers: { ...this.config.headers, ...authHeaders } }
        : this.config;
      const transport = createMcpTransport(
        effectiveConfig,
        {
          ...(framing ? { stdioFraming: framing } : {}),
          httpResolvedTransport: this.cachedHttpTransport,
        },
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
          this.liveCatalogValidated = false;
        },
      });

      try {
        // FEATURE_222 — advertise only the reverse capabilities whose handlers
        // the host injected (capability declaration = implementation promise);
        // unadvertised server→client requests still get a -32601 reply.
        const baseStartup = getStartupTimeoutMs(this.config);
        const initializeResult = await this.request('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: buildInitializeCapabilities(this.reverse),
          clientInfo: {
            name: 'KodaX',
            version: '0.7',
          },
        }, baseStartup, false);
        const initialized = asRecord(initializeResult);
        this.serverCapabilities = asRecord(initialized?.capabilities);
        const protocolVersion = readNegotiatedProtocolVersion(initializeResult);
        transport.setProtocolVersion?.(protocolVersion);
        await this.notify('notifications/initialized', {});
        this.initialized = true;
        this.diagnostics.status = 'ready';
        this.diagnostics.resolvedTransport = transport.resolvedTransport ?? (this.config.type ?? 'stdio');
        if (transport.resolvedTransport === 'http:auto->streamable-http') {
          this.cachedHttpTransport = 'streamable-http';
        } else if (transport.resolvedTransport === 'http:auto->sse') {
          this.cachedHttpTransport = 'sse';
        }
        this.diagnostics.lastError = undefined;
        this.diagnostics.dirty = this.diagnostics.dirty || initialized?.capabilities !== undefined;
        return; // Success — stop trying other framings.
      } catch (error) {
        if (error instanceof McpProtocolVersionError) {
          await this.resetTransport();
          throw error;
        }
        // If this is the last framing option, propagate the error.
        if (framing === framings[framings.length - 1]) {
          throw error;
        }
        // Otherwise, try next framing mode.
      }
    }
  }

  /**
   * FEATURE_222 — discover + interactively log in to an authenticated MCP
   * server. The authorization URL is shown through the host's url-elicitation
   * consent (anti-phishing; never auto-opened). Returns undefined when the host
   * has no url-consent surface, discovery fails, or the user declines.
   */
  private async runOAuthLogin(
    wwwAuthenticate?: string,
    stepUpScope?: string,
  ): Promise<OAuthToken | undefined> {
    const serverUrl = this.config.url;
    if (!serverUrl) return undefined;
    if (!this.reverse?.elicit || !canHandleElicitMode(this.reverse, 'url')) return undefined;
    const elicit = this.reverse.elicit;
    const consent: OAuthLoginConsent = async (authorizationUrl) => {
      const result = await elicit({
        mode: 'url',
        serverId: this.serverId,
        url: authorizationUrl,
        message: `Sign in to MCP server "${this.serverId}" to authorize access.`,
      });
      return result.action === 'accept';
    };
    try {
      return await performOAuthLogin({
        serverId: this.serverId,
        serverUrl,
        resourceMetadataUrl: extractResourceMetadataUrl(wwwAuthenticate),
        configuredClientId: this.config.auth?.clientId,
        configuredScopes: this.config.auth?.scopes,
        stepUpScope,
        consent,
        redirectPort: this.config.auth?.redirectPort,
      });
    } catch (error) {
      this.diagnostics.lastError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  private async listDescriptors(
    method: 'tools/list' | 'resources/list' | 'prompts/list',
    kind: 'tools' | 'resources' | 'prompts',
    cachedAt: string,
  ): Promise<McpCapabilityDescriptor[]> {
    const descriptors: McpCapabilityDescriptor[] = [];
    const descriptorById = new Map<string, McpCapabilityDescriptor>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      let result: unknown;
      try {
        result = await this.request(method, cursor ? { cursor } : {});
      } catch (error) {
        const isOptionalList = method === 'resources/list' || method === 'prompts/list';
        if (cursor === undefined && isOptionalList && isMethodNotFoundLikeError(error, method)) {
          return [];
        }
        throw error;
      }

      const { entries, nextCursor } = extractListEntries(result, kind);
      for (const entry of entries) {
        let descriptor: McpCapabilityDescriptor;
        if (kind === 'tools') {
          descriptor = buildToolDescriptor(this.serverId, entry, cachedAt);
        } else if (kind === 'resources') {
          descriptor = buildResourceDescriptor(this.serverId, entry, cachedAt);
        } else {
          descriptor = buildPromptDescriptor(this.serverId, entry, cachedAt);
        }
        const previous = descriptorById.get(descriptor.id);
        if (previous) {
          continue;
        }
        descriptorById.set(descriptor.id, descriptor);
        descriptors.push(descriptor);
      }
      if (!nextCursor) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`MCP ${method} returned a repeated pagination cursor: ${nextCursor}`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return descriptors;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = getRequestTimeoutMs(this.config),
    retryExpiredSession = true,
  ): Promise<unknown> {
    try {
      return await this.sendRequest(method, params, timeoutMs);
    } catch (error) {
      if (retryExpiredSession && error instanceof McpExpiredSessionError) {
        await this.resetTransport();
        await this.connect();
        return this.request(method, params, timeoutMs, false);
      }
      // FEATURE_222 — mid-session 401 (token expired) or 403 insufficient_scope
      // (step-up): re-authenticate, reconnect, and retry the request once.
      if (retryExpiredSession && error instanceof McpAuthRequiredError) {
        const stepUpScope = extractInsufficientScope(error.wwwAuthenticate);
        const token = await this.runOAuthLogin(error.wwwAuthenticate, stepUpScope);
        if (token) {
          await this.resetTransport();
          await this.connect();
          return this.request(method, params, timeoutMs, false);
        }
      }
      throw error;
    }
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
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
        // Spec (utilities/cancellation): on timeout the client SHOULD notify the
        // server so it can stop processing and release resources. The initialize
        // request MUST NOT be cancelled, so it is exempt.
        if (method !== 'initialize') {
          void this.notify('notifications/cancelled', {
            requestId,
            reason: `Client request timed out after ${timeoutMs}ms`,
          });
        }
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
        pending.reject(new McpJsonRpcError(error.message, error.code, error.data));
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
      this.catalogInvalidationVersion += 1;
      this.diagnostics.dirty = true;
      this.liveCatalogValidated = false;
    }
    // Slice C — the server completed a url elicitation; let the host dismiss
    // its waiting state (correlated by elicitationId).
    if (method === 'notifications/elicitation/complete') {
      const elicitationId = readString(asRecord(payload.params)?.elicitationId);
      if (elicitationId) {
        // Release an in-flight tool-retry waiter first, then let the host
        // dismiss its waiting UI.
        const settle = this.elicitationWaiters.get(elicitationId);
        if (settle) {
          settle();
        } else {
          this.completedElicitations.add(elicitationId);
        }
        this.reverse?.onElicitationComplete?.(elicitationId);
      }
      return;
    }

    // Server→client request (has both method and id).
    const requestId = payload.id;
    if (requestId !== undefined && requestId !== null) {
      // Ping is mandatory in every protocol revision: the receiver MUST answer
      // with an empty result. Replying -32601 would violate the spec and lets a
      // health-checking server treat the connection as stale and drop it.
      if (method === 'ping') {
        this.sendResponse(requestId as string | number, {});
        return;
      }
      // FEATURE_222 — reverse capabilities resolve asynchronously (roots read,
      // user elicitation, LLM sampling). Dispatch off the sync message handler
      // and reply when the handler settles; an unhandled method still gets
      // -32601 so the server does not hang.
      void this.handleServerRequest(method, asRecord(payload.params), requestId as string | number);
    }
  }

  /** Best-effort JSON-RPC response send (server times out on its own if closed). */
  private sendResponse(id: string | number, result: unknown): void {
    this.transport?.send(jsonRpcString({ jsonrpc: '2.0', id, result })).catch(() => {});
  }

  /** Best-effort JSON-RPC error send. */
  private sendError(id: string | number, code: number, message: string): void {
    this.transport?.send(jsonRpcString({ jsonrpc: '2.0', id, error: { code, message } })).catch(() => {});
  }

  /**
   * FEATURE_222 — handle a server→client request for an advertised reverse
   * capability. Each slice adds a case to {@link dispatchServerRequest};
   * anything unhandled replies -32601, and a handler that throws replies
   * -32603 so the server never hangs.
   */
  private async handleServerRequest(
    method: string,
    params: Record<string, unknown> | undefined,
    requestId: string | number,
  ): Promise<void> {
    try {
      const handled = await this.dispatchServerRequest(method, params);
      if (handled === UNHANDLED_SERVER_REQUEST) {
        this.sendError(requestId, JsonRpcErrorCode.MethodNotFound, `Method not supported by client: ${method}`);
        return;
      }
      this.sendResponse(requestId, handled);
    } catch (error) {
      this.sendError(requestId, -32603, error instanceof Error ? error.message : 'internal error');
    }
  }

  /**
   * Route a reverse request to its handler, or return the sentinel when the
   * method is not an advertised capability. Slices add cases here.
   */
  private async dispatchServerRequest(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    switch (method) {
      case 'roots/list': {
        // Slice A — only handled when the host injected workspace roots.
        if (!this.reverse?.listRoots) return UNHANDLED_SERVER_REQUEST;
        const roots = await this.reverse.listRoots();
        return { roots };
      }
      case 'elicitation/create': {
        // Slice B (form) / Slice C (url) — only handled when the host injected
        // an `elicit` callback. The handler routes both modes to the host; which
        // modes are actually advertised is gated by buildInitializeCapabilities.
        if (!this.reverse?.elicit) return UNHANDLED_SERVER_REQUEST;
        // Enrich with the server id so the host can show the user who is asking.
        const request = { ...parseElicitRequest(params), serverId: this.serverId };
        if (!canHandleElicitMode(this.reverse, request.mode)) {
          return UNHANDLED_SERVER_REQUEST;
        }
        const result = await this.reverse.elicit(request);
        return normalizeElicitResult(result);
      }
      case 'sampling/createMessage': {
        if (!this.reverse?.sample) return UNHANDLED_SERVER_REQUEST;
        const request = parseSamplingRequest(params, this.serverId);
        return this.reverse.sample(request);
      }
      default:
        return UNHANDLED_SERVER_REQUEST;
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

  private emptyCatalog(): McpServerCatalogSnapshot {
    return {
      serverId: this.serverId,
      items: [],
      descriptors: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
}
