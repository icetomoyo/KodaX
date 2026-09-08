import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import type {
  RuntimeAgentBindingService,
  RuntimeBoundDefaultAgent,
  RuntimeBoundLocalAgent,
  RuntimeEvent,
  RuntimeInput,
  RuntimeRunHandle,
  RuntimeRunPhase,
  RuntimeRunResult,
} from '../sdk-runtime.js';
import { A2AError, errorMessage } from './errors.js';
import { A2A_PRINCIPAL_KEY_SCHEME, realmA2APrincipalKey } from './principal-key.js';
import { isJsonMediaType, isRecord, parseA2AMessage, parseJsonRpcRequest } from './schemas.js';
import { parseA2ASecurity } from './security.js';
import { A2AFileTaskStore, type A2AServerTaskRecord } from './task-store.js';
import {
  A2A_PROTOCOL_VERSION,
  type A2AAuthentication,
  type A2AAgentCard,
  type A2AArtifact,
  type A2AJsonRpcRequest,
  type A2AMessage,
  type A2AOperation,
  type A2APart,
  type A2APrincipal,
  type A2AServerEvent,
  type A2AServerHotOptions,
  type A2AServerOptions,
  type A2AServerExecution,
  type A2ATask,
  type A2ATaskState,
  type KodaXA2AServer,
} from './types.js';

type RequestInitWithDuplex = RequestInit & { readonly duplex: 'half' };

interface PreparedA2AExecution {
  readonly service: RuntimeAgentBindingService;
  readonly ownerSessionId: string;
  readonly binding: RuntimeBoundDefaultAgent | RuntimeBoundLocalAgent;
  readonly declaration: A2AServerExecution;
  prepareWorkspace(contextKey: string): Promise<string>;
  start(input: {
    readonly sessionId: string;
    readonly inputs: readonly RuntimeInput[];
    readonly principalKey: string;
  }): Promise<RuntimeRunHandle>;
  close(): Promise<void>;
}

interface PreparedA2AServerOptions extends A2AServerOptions {
  readonly preparedExecution?: PreparedA2AExecution;
}

const TERMINAL_STATES = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
const TASK_STATES = new Set<A2ATaskState>([
  'TASK_STATE_UNSPECIFIED', 'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED',
]);
const PUSH_METHODS = new Set([
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]);

// These are protocol-edge safety ceilings, not operator-tuning knobs. A 24 MiB
// queue admits one default-limit (16 MiB raw, base64-encoded) artifact frame;
// the stream ceilings keep aggregate queued SSE bytes below roughly 192 MiB.
const MAX_SSE_STREAMS_PER_TASK = 4;
const MAX_SSE_STREAMS_PER_SERVER = 8;
const MAX_SSE_QUEUE_BYTES = 24 * 1024 * 1024;
// WHATWG Fetch blocks these ports before any request reaches the listener.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);
const MAX_EPHEMERAL_PORT_ATTEMPTS = 16;

function listenNodeServer(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, hostname);
  });
}

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function securityRealm(authentication: A2AAuthentication): string {
  const value: unknown = authentication.securityRealm;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('A2A authentication.securityRealm must be a non-empty stable string.');
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function validateBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('Published A2A base URL must use HTTPS, except on loopback.');
  }
  if (url.username || url.password) throw new Error('Published A2A base URL must not contain credentials.');
  return url;
}

function operationForMethod(method: string): A2AOperation {
  const operations: Readonly<Record<string, A2AOperation>> = {
    SendMessage: 'send-message',
    SendStreamingMessage: 'send-streaming-message',
    GetTask: 'get-task',
    ListTasks: 'list-tasks',
    CancelTask: 'cancel-task',
    SubscribeToTask: 'subscribe-to-task',
    GetExtendedAgentCard: 'get-extended-agent-card',
  };
  const operation = operations[method];
  if (!operation) throw new A2AError(-32601, 'Method not found.');
  return operation;
}

function statusState(phase: RuntimeRunPhase): A2ATaskState {
  const states: Record<RuntimeRunPhase, A2ATaskState> = {
    queued: 'TASK_STATE_SUBMITTED',
    unknown: 'TASK_STATE_UNSPECIFIED',
    waiting_agent: 'TASK_STATE_WORKING',
    recovering: 'TASK_STATE_WORKING',
    running: 'TASK_STATE_WORKING',
    waiting_permission: 'TASK_STATE_WORKING',
    waiting_user_input: 'TASK_STATE_INPUT_REQUIRED',
    completed: 'TASK_STATE_COMPLETED',
    failed: 'TASK_STATE_FAILED',
    cancelled: 'TASK_STATE_CANCELED',
    interrupted: 'TASK_STATE_FAILED',
  };
  return states[phase];
}

function agentMessage(taskId: string, contextId: string, text: string): A2AMessage {
  return {
    messageId: randomUUID(),
    taskId,
    contextId,
    role: 'ROLE_AGENT',
    parts: [{ text, mediaType: 'text/plain' }],
  };
}

function interfaceUrl(baseUrl: string): string {
  const url = validateBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/a2a`;
  url.search = '';
  url.hash = '';
  return url.href;
}

function parseHistoryLength(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new A2AError(-32602, `${label} must be a non-negative integer.`);
  }
  return value as number;
}

function requiredTaskId(params: Readonly<Record<string, unknown>> | undefined): string {
  if (typeof params?.id !== 'string' || params.id.length === 0) {
    throw new A2AError(-32602, 'Task id is required.');
  }
  return params.id;
}

function publicInputOption(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.value !== 'string') return undefined;
  return {
    label: value.label,
    value: value.value,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

function publicInputQuestion(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || typeof value.question !== 'string') return undefined;
  const options = Array.isArray(value.options)
    ? value.options.flatMap((item) => {
        const option = publicInputOption(item);
        return option ? [option] : [];
      })
    : undefined;
  return {
    question: value.question,
    ...(typeof value.header === 'string' ? { header: value.header } : {}),
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(options ? { options } : {}),
    ...(typeof value.multiSelect === 'boolean' ? { multiSelect: value.multiSelect } : {}),
    ...(Number.isSafeInteger(value.minSelections) ? { minSelections: value.minSelections } : {}),
    ...(Number.isSafeInteger(value.maxSelections) ? { maxSelections: value.maxSelections } : {}),
    ...(typeof value.allowCustomInput === 'boolean' ? { allowCustomInput: value.allowCustomInput } : {}),
    ...(typeof value.customInputLabel === 'string' ? { customInputLabel: value.customInputLabel } : {}),
    ...(typeof value.customInputPrompt === 'string' ? { customInputPrompt: value.customInputPrompt } : {}),
  };
}

function publicInputOptions(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  if (Array.isArray(value.questions)) {
    const questions = value.questions.flatMap((item) => {
      const question = publicInputQuestion(item);
      return question ? [question] : [];
    });
    return { questions };
  }
  return publicInputQuestion(value) ?? {};
}

function pendingInputMessage(taskId: string, contextId: string, event: RuntimeEvent): A2AMessage | undefined {
  if (!isRecord(event.payload) || typeof event.payload.kind !== 'string') return undefined;
  const publicOptions = publicInputOptions(event.payload.options);
  let rendered = '';
  try { rendered = JSON.stringify(publicOptions); }
  catch { rendered = '{}'; }
  const bounded = rendered.length > 4_096 ? `${rendered.slice(0, 4_093)}...` : rendered;
  return {
    ...agentMessage(taskId, contextId, `Input required (${event.payload.kind}): ${bounded}`),
    metadata: { 'kodax.ai/user-input': { kind: event.payload.kind, options: publicOptions } },
  };
}

function continuationAnswer(message: A2AMessage, kind: string): unknown {
  const data = message.parts.find((part) => part.data !== undefined)?.data;
  if (data !== undefined) return data;
  const text = message.parts.flatMap((part) => part.text === undefined ? [] : [part.text]).join('\n');
  if (kind === 'askUserMulti' || text.startsWith('[') || text.startsWith('{')) {
    try { return JSON.parse(text) as unknown; } catch { /* plain text remains valid below */ }
  }
  return text;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function artifactMediaType(file: string): string {
  const mediaTypes: Readonly<Record<string, string>> = {
    '.csv': 'text/csv', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.json': 'application/json', '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mediaTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function stagedArtifacts(
  record: A2AServerTaskRecord,
  result: RuntimeRunResult,
  options: PreparedA2AServerOptions,
): readonly A2AArtifact[] {
  const root = record.workspaceRoot ?? options.agent.projectPath;
  if (!root || !result.result?.artifactLedger) return [];
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); }
  catch { return []; }
  const seen = new Set<string>();
  const artifacts: A2AArtifact[] = [];
  for (const entry of result.result.artifactLedger) {
    if ((entry.kind !== 'file_created' && entry.kind !== 'file_modified') || typeof entry.target !== 'string') continue;
    const candidate = path.isAbsolute(entry.target) ? entry.target : path.resolve(root, entry.target);
    const relative = path.relative(root, candidate);
    const explicitlyStaged = relative.split(path.sep).includes('.kodax-a2a-staging');
    const admittedSkillOutput = entry.sourceTool === 'run_skill_script' && entry.action === 'promote_output';
    if (!isInside(root, candidate) || (!explicitlyStaged && !admittedSkillOutput)) continue;
    let stats: fs.Stats;
    let real: string;
    let content: Buffer;
    try {
      stats = fs.lstatSync(candidate);
      real = fs.realpathSync(candidate);
      if (!stats.isFile() || stats.isSymbolicLink() || !isInside(realRoot, real) || seen.has(real)) continue;
      if (stats.size > options.limits.maxPartBytes) continue;
      content = fs.readFileSync(real);
    } catch { continue; }
    if (content.byteLength > options.limits.maxPartBytes) continue;
    const mediaType = artifactMediaType(candidate);
    if (!(record.acceptedOutputModes ?? options.agent.outputModes).includes(mediaType)) continue;
    seen.add(real);
    artifacts.push({
      artifactId: `file-${sha256(`${record.taskId}\0${relative}\0${content.byteLength}\0${stats.mtimeMs}`).slice(0, 24)}`,
      name: path.basename(candidate),
      description: admittedSkillOutput ? 'KodaX Skill task output' : 'KodaX staged task output',
      parts: [{
        raw: content.toString('base64'),
        filename: path.basename(candidate),
        mediaType,
      }],
    });
  }
  return artifacts;
}

function safeTaskText(text: string, record: A2AServerTaskRecord, options: PreparedA2AServerOptions): string {
  let safe = text;
  for (const root of [record.workspaceRoot, options.agent.projectPath, path.resolve(options.dataDir)]) {
    if (!root) continue;
    safe = safe.split(root).join('[redacted-path]');
    safe = safe.split(root.replaceAll('\\', '/')).join('[redacted-path]');
  }
  return safe;
}

function buildCard(options: A2AServerOptions, baseUrl = options.agent.publicBaseUrl): A2AAgentCard {
  const url = interfaceUrl(baseUrl);
  const card: A2AAgentCard = {
    name: options.agent.name,
    description: options.agent.description,
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    version: options.agent.version,
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: options.extendedAgentCard !== undefined },
    securitySchemes: options.authentication.securitySchemes,
    securityRequirements: options.authentication.securityRequirements,
    defaultInputModes: options.agent.inputModes,
    defaultOutputModes: options.agent.outputModes,
    skills: options.agent.skills,
  };
  parseA2ASecurity(card.securitySchemes, card.securityRequirements);
  for (const skill of card.skills) {
    parseA2ASecurity(card.securitySchemes, skill.securityRequirements);
  }
  return card;
}

function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  if (value === null) return false;
  const normalizedEtag = etag.replace(/^W\//iu, '');
  return value.split(',').some((candidate) => {
    const normalized = candidate.trim();
    return normalized === '*' || normalized.replace(/^W\//iu, '') === normalizedEtag;
  });
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new A2AError(-32600, 'A2A request exceeds the configured limit.', 413);
  }
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('A2A request size limit exceeded.');
      throw new A2AError(-32600, 'A2A request exceeds the configured limit.', 413);
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function rpcResult(id: A2AJsonRpcRequest['id'], result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, error: A2AError): Response {
  const reasons: Readonly<Record<number, string>> = {
    [-32001]: 'TASK_NOT_FOUND',
    [-32002]: 'TASK_NOT_CANCELABLE',
    [-32003]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
    [-32004]: 'UNSUPPORTED_OPERATION',
    [-32005]: 'CONTENT_TYPE_NOT_SUPPORTED',
    [-32006]: 'INVALID_AGENT_RESPONSE',
    [-32007]: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
    [-32008]: 'EXTENSION_SUPPORT_REQUIRED',
    [-32009]: 'VERSION_NOT_SUPPORTED',
  };
  const reason = reasons[error.code];
  const data = error.data ?? (reason ? [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: 'a2a-protocol.org',
  }] : undefined);
  return jsonResponse({
    jsonrpc: '2.0',
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(data !== undefined ? { data } : {}),
    },
  }, error.httpStatus, error.headers);
}

function messageDigest(message: A2AMessage): string {
  return sha256(JSON.stringify(message));
}

function partBytes(part: A2APart): number {
  if (part.text !== undefined) return Buffer.byteLength(part.text);
  if (part.raw !== undefined) return Buffer.byteLength(part.raw, 'base64');
  if (part.url !== undefined) return Buffer.byteLength(part.url);
  return Buffer.byteLength(JSON.stringify(part.data));
}

function partMediaType(part: A2APart): string {
  return part.mediaType ?? (part.text !== undefined ? 'text/plain'
    : part.data !== undefined ? 'application/json' : 'application/octet-stream');
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += directoryBytes(item);
    else if (entry.isFile()) total += fs.statSync(item).size;
  }
  return total;
}

function validateInput(message: A2AMessage, maxPartBytes: number, inputModes: readonly string[]): void {
  if (message.role !== 'ROLE_USER') throw new A2AError(-32602, 'Inbound message role must be ROLE_USER.');
  for (const part of message.parts) {
    if (partBytes(part) > maxPartBytes) throw new A2AError(-32602, 'Message Part exceeds the configured limit.');
    if (part.url !== undefined) throw new A2AError(-32602, 'Remote file URLs are not accepted by this server.');
    if (part.raw !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.raw)) {
      throw new A2AError(-32602, 'Message Part raw content is not valid base64.');
    }
    const mediaType = partMediaType(part);
    if (!inputModes.includes(mediaType)) throw new A2AError(-32005, `Media type ${mediaType} is not supported.`);
  }
}

function withHistory(task: A2ATask, history: readonly A2AMessage[], historyLength?: number): A2ATask {
  if (historyLength === 0) {
    const { history: _ignored, ...withoutHistory } = task;
    return withoutHistory;
  }
  const selected = historyLength === undefined ? history : history.slice(-historyLength);
  return { ...task, history: selected };
}

interface TaskListCursor {
  readonly updatedAt: string;
  readonly taskId: string;
}

interface MessageAdmissionResult {
  readonly record: A2AServerTaskRecord;
  readonly duplicate: boolean;
  readonly runtimeEventsAttached?: Promise<void>;
}

interface StartedRun {
  readonly record: A2AServerTaskRecord;
  readonly runtimeEventsAttached: Promise<void>;
}

function parseTaskListCursor(value: string | undefined): TaskListCursor | undefined {
  if (!value) return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown; }
  catch { throw new A2AError(-32602, 'Invalid page token.'); }
  if (!isRecord(decoded)
    || typeof decoded.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(decoded.updatedAt))
    || typeof decoded.taskId !== 'string'
    || decoded.taskId.length === 0) {
    throw new A2AError(-32602, 'Invalid page token.');
  }
  return { updatedAt: decoded.updatedAt, taskId: decoded.taskId };
}

function encodeTaskListCursor(record: A2AServerTaskRecord): string {
  return Buffer.from(JSON.stringify({
    updatedAt: record.updatedAt,
    taskId: record.taskId,
  })).toString('base64url');
}

function followsTaskListCursor(record: A2AServerTaskRecord, cursor: TaskListCursor): boolean {
  const timeOrder = record.updatedAt.localeCompare(cursor.updatedAt);
  return timeOrder < 0 || (timeOrder === 0 && record.taskId.localeCompare(cursor.taskId) < 0);
}

class KodaXA2AServerRuntime implements KodaXA2AServer {
  readonly #store: A2AFileTaskStore;
  readonly #now: () => Date;
  readonly #runtimeSubscriptions = new Map<string, { close(): void }>();
  readonly #runtimeProjectionFailures = new Set<string>();
  readonly #streamClosers = new Set<() => void>();
  readonly #taskStreamCounts = new Map<string, number>();
  readonly #messageTails = new Map<string, Promise<void>>();
  readonly #requestTails = new Set<Promise<void>>();
  readonly #ready: Promise<void>;
  #pendingNewTaskAdmissions = 0;
  #nodeServer: Server | undefined;
  #activeStreamCount = 0;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #card: A2AAgentCard;
  #listeningBaseUrl: string | undefined;

  constructor(private options: PreparedA2AServerOptions) {
    securityRealm(options.authentication);
    this.#now = options.now ?? (() => new Date());
    this.#store = new A2AFileTaskStore(options.dataDir);
    this.#card = buildCard(options);
    this.#ready = this.recover();
  }

  get agentCard(): A2AAgentCard {
    return structuredClone(this.#card);
  }

  async whenReady(): Promise<void> {
    await this.#ready;
  }

  updateHot(options: A2AServerHotOptions): void {
    if (this.#closing || this.#closed) throw new Error('A2A server is closed.');
    securityRealm(options.authentication);
    const next = { ...this.options, ...options };
    const nextCard = buildCard(next, options.agent.publicBaseUrl);
    this.options = next;
    this.#card = nextCard;
  }

  handle(request: Request): Promise<Response> {
    if (this.#closing || this.#closed) {
      return Promise.resolve(jsonResponse({ error: 'A2A server is closed.' }, 503));
    }
    let release = (): void => undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#requestTails.add(tail);
    return this.handleAdmitted(request).finally(() => {
      this.#requestTails.delete(tail);
      release();
    });
  }

  private async handleAdmitted(request: Request): Promise<Response> {
    await this.#ready;
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      const body = JSON.stringify(this.#card);
      const etag = `"${sha256(body)}"`;
      const headers = { etag, 'cache-control': 'no-cache' };
      return matchesIfNoneMatch(request.headers.get('if-none-match'), etag)
        ? new Response(null, { status: 304, headers })
        : jsonResponse(this.#card, 200, headers);
    }
    if (request.method !== 'POST' || (url.pathname !== '/' && url.pathname !== '/a2a')) {
      return jsonResponse({ error: 'Not found.' }, 404);
    }
    return this.handleRpc(request);
  }

  async listen(input: { readonly hostname: string; readonly port: number; readonly publicBaseUrl?: string }): Promise<string> {
    if (this.#closing || this.#closed) throw new Error('A2A server is closed.');
    if (this.#nodeServer) throw new Error('A2A server is already listening.');
    if (!isLoopbackHostname(input.hostname)) {
      throw new Error('The built-in A2A HTTP listener is loopback-only; use handle() behind TLS for public service.');
    }
    if (input.port !== 0 && FETCH_BLOCKED_PORTS.has(input.port)) {
      throw new Error(`Fetch-compatible clients block port ${input.port}; choose another A2A listener port.`);
    }
    const server = createServer((request, response) => {
      void this.handleNodeRequest(request).then((result) => {
        response.statusCode = result.status;
        result.headers.forEach((value, key) => response.setHeader(key, value));
        if (!result.body) {
          response.end();
          return;
        }
        const body = Readable.fromWeb(result.body);
        const closeBody = (): void => {
          body.destroy();
        };
        response.once('close', closeBody);
        body.once('close', () => response.off('close', closeBody));
        body.once('error', () => {
          if (!response.destroyed) response.destroy();
        });
        body.pipe(response);
      }).catch((error: unknown) => {
        const diagnosticId = sha256(errorMessage(error)).slice(0, 16);
        this.emit({ type: 'server.request_failed', time: nowIso(this.#now), outcome: 'failed', diagnosticId });
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Internal server error.', diagnosticId }));
      });
    });
    const attempts = input.port === 0 ? MAX_EPHEMERAL_PORT_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await listenNodeServer(server, input.port, input.hostname);
      const address = server.address();
      if (!address || typeof address === 'string') {
        await closeNodeServer(server);
        throw new Error('A2A server did not expose a TCP address.');
      }
      if (FETCH_BLOCKED_PORTS.has(address.port)) {
        await closeNodeServer(server);
        continue;
      }
      const baseUrl = `http://${input.hostname}:${address.port}`;
      this.#nodeServer = server;
      this.#listeningBaseUrl = input.publicBaseUrl ?? baseUrl;
      this.#card = buildCard(this.options, this.#listeningBaseUrl);
      return baseUrl;
    }
    throw new Error('A2A server could not allocate a Fetch-compatible listener port.');
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const server = this.#nodeServer;
    this.#nodeServer = undefined;
    const serverClosed = server
      ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      : Promise.resolve();
    this.#closePromise = this.closeAdmittedWork(serverClosed);
    return this.#closePromise;
  }

  private async closeAdmittedWork(serverClosed: Promise<void>): Promise<void> {
    const errors: unknown[] = [];
    try { await this.#ready; } catch (error: unknown) { errors.push(error); }
    await Promise.all([...this.#requestTails]);
    this.#closed = true;
    for (const close of [...this.#streamClosers]) {
      try { close(); } catch (error: unknown) { errors.push(error); }
    }
    this.#streamClosers.clear();
    for (const subscription of this.#runtimeSubscriptions.values()) {
      try { subscription.close(); } catch (error: unknown) { errors.push(error); }
    }
    this.#runtimeSubscriptions.clear();
    this.#runtimeProjectionFailures.clear();
    try { await serverClosed; } catch (error: unknown) { errors.push(error); }
    try { this.#store.close(); } catch (error: unknown) { errors.push(error); }
    try { await this.options.preparedExecution?.close(); } catch (error: unknown) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'A2A server close failed.');
  }

  private async handleNodeRequest(request: import('node:http').IncomingMessage): Promise<Response> {
    const host = request.headers.host ?? '127.0.0.1';
    const url = `http://${host}${request.url ?? '/'}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else for (const item of value ?? []) headers.append(key, item);
    }
    const init: RequestInitWithDuplex = {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD'
        ? {} : { body: Readable.toWeb(request) as ReadableStream<Uint8Array> }),
      duplex: 'half',
    };
    return this.handle(new Request(url, init));
  }

  private async handleRpc(request: Request): Promise<Response> {
    const options = this.options;
    let id: string | number | null = null;
    try {
      const requestedVersion = request.headers.get('a2a-version')
        ?? new URL(request.url).searchParams.get('A2A-Version');
      if (requestedVersion !== A2A_PROTOCOL_VERSION) {
        throw new A2AError(-32009, 'A2A version is not supported.');
      }
      if (!isJsonMediaType(request.headers.get('content-type'))) {
        throw new A2AError(-32600, 'A2A JSON-RPC requests require application/json.', 415);
      }
      const principal = await options.authentication.authenticate(request);
      if (!principal) {
        throw new A2AError(-32600, 'Authentication required.', 401, undefined, {
          'www-authenticate': 'Bearer',
        });
      }
      const body = await readBoundedBody(request, options.limits.maxRequestBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
      } catch {
        throw new A2AError(-32700, 'Invalid JSON payload.');
      }
      const rpc = parseJsonRpcRequest(parsed);
      id = rpc.id;
      if (PUSH_METHODS.has(rpc.method)) throw new A2AError(-32003, 'Push notifications are not supported.');
      const operation = operationForMethod(rpc.method);
      const scopedMessage = rpc.method === 'SendMessage' || rpc.method === 'SendStreamingMessage'
        ? parseA2AMessage(rpc.params?.message)
        : undefined;
      const taskId = typeof rpc.params?.id === 'string' ? rpc.params.id : scopedMessage?.taskId;
      const contextId = scopedMessage?.contextId;
      const inputModes = scopedMessage
        ? [...new Set(scopedMessage.parts.map(partMediaType))]
        : undefined;
      const allowed = await options.authorize({
        principal,
        operation,
        ...(taskId ? { taskId } : {}),
        ...(contextId ? { contextId } : {}),
        ...(inputModes ? { inputModes } : {}),
      });
      if (!allowed) throw new A2AError(-32001, 'Task not found.');
      return await this.dispatch(rpc, principal, options);
    } catch (error: unknown) {
      const diagnosticId = sha256(errorMessage(error)).slice(0, 16);
      const normalized = error instanceof A2AError
        ? error
        : new A2AError(-32603, 'Internal error.', 500, [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'INTERNAL',
            domain: 'kodax.ai',
            metadata: { diagnosticId },
          }]);
      this.emit({ type: 'rpc.failed', time: nowIso(this.#now), outcome: 'failed', diagnosticId });
      return rpcError(id, normalized);
    }
  }

  private async dispatch(
    rpc: A2AJsonRpcRequest,
    principal: A2APrincipal,
    options: PreparedA2AServerOptions,
  ): Promise<Response> {
    const key = realmA2APrincipalKey({
      securityRealm: securityRealm(options.authentication),
      subject: principal.subject,
      ...(principal.tenant !== undefined ? { tenant: principal.tenant } : {}),
    });
    switch (rpc.method) {
      case 'SendMessage': return rpcResult(rpc.id, {
        task: await this.sendMessage(rpc.params, key, false, options),
      });
      case 'SendStreamingMessage': {
        const task = await this.sendMessage(rpc.params, key, true, options);
        return this.streamTask(rpc.id, task.id, key);
      }
      case 'GetTask': return rpcResult(rpc.id, await this.getTask(rpc.params, key));
      case 'ListTasks': return rpcResult(rpc.id, this.listTasks(rpc.params, key));
      case 'CancelTask': return rpcResult(rpc.id, await this.cancelTask(rpc.params, key, options));
      case 'SubscribeToTask': return this.subscribeTask(rpc.id, rpc.params, key);
      case 'GetExtendedAgentCard': {
        if (!options.extendedAgentCard) throw new A2AError(-32004, 'Extended Agent Card is not supported.');
        return rpcResult(rpc.id, options.extendedAgentCard);
      }
      default: throw new A2AError(-32601, 'Method not found.');
    }
  }

  private async sendMessage(
    params: Readonly<Record<string, unknown>> | undefined,
    key: string,
    streaming: boolean,
    options: PreparedA2AServerOptions,
  ): Promise<A2ATask> {
    const previous = this.#messageTails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#messageTails.set(key, tail);
    await previous;
    try {
      return await this.sendMessageUnserialized(params, key, streaming, options);
    } finally {
      release();
      if (this.#messageTails.get(key) === tail) this.#messageTails.delete(key);
    }
  }

  private async sendMessageUnserialized(
    params: Readonly<Record<string, unknown>> | undefined,
    key: string,
    streaming: boolean,
    options: PreparedA2AServerOptions,
  ): Promise<A2ATask> {
    const message = parseA2AMessage(params?.message);
    validateInput(message, options.limits.maxPartBytes, options.agent.inputModes);
    if (params?.configuration !== undefined && !isRecord(params.configuration)) {
      throw new A2AError(-32602, 'SendMessage configuration must be an object.');
    }
    const configuration = isRecord(params?.configuration) ? params.configuration : {};
    const historyLength = parseHistoryLength(configuration.historyLength, 'SendMessage historyLength');
    if (configuration.returnImmediately !== undefined && typeof configuration.returnImmediately !== 'boolean') {
      throw new A2AError(-32602, 'SendMessage returnImmediately must be a boolean.');
    }
    if (configuration.taskPushNotificationConfig !== undefined) {
      throw new A2AError(-32003, 'Push notifications are not supported.');
    }
    if (configuration.acceptedOutputModes !== undefined) {
      if (!Array.isArray(configuration.acceptedOutputModes)
        || !configuration.acceptedOutputModes.every((mode) => typeof mode === 'string')) {
        throw new A2AError(-32602, 'SendMessage acceptedOutputModes must be a string array.');
      }
      if (!configuration.acceptedOutputModes.some((mode) => options.agent.outputModes.includes(mode))) {
        throw new A2AError(-32005, 'No requested output media type is supported.');
      }
    }
    const admission = await this.admitMessage(
      message,
      key,
      options,
      configuration.acceptedOutputModes as readonly string[] | undefined,
    );
    if (admission.runtimeEventsAttached) {
      try {
        await admission.runtimeEventsAttached;
      } catch (error: unknown) {
        this.failTask(admission.record.taskId, 'Task could not be started.', options);
        throw error;
      }
    }
    const current = this.#store.get(admission.record.taskId) ?? admission.record;
    const immediate = admission.duplicate || streaming || configuration.returnImmediately === true;
    const result = immediate
      ? current
      : await this.waitForTask(current.taskId, options.limits.maxTaskWaitMs ?? 30_000);
    return withHistory(result.task, result.history, historyLength);
  }

  private async admitMessage(
    message: A2AMessage,
    key: string,
    options: PreparedA2AServerOptions,
    acceptedOutputModes?: readonly string[],
  ): Promise<MessageAdmissionResult> {
    const digest = messageDigest(message);
    const duplicate = this.#store.findByMessage(key, message.messageId);
    if (duplicate) {
      if (duplicate.messageDigests[message.messageId] !== digest) {
        throw new A2AError(-32602, 'Message ID was reused with different content.');
      }
      this.emit({ type: 'task.deduplicated', time: nowIso(this.#now), taskId: duplicate.taskId, contextId: duplicate.contextId });
      return { record: duplicate, duplicate: true };
    }
    const existing = message.taskId ? this.requireOwnedTask(message.taskId, key) : undefined;
    if (existing && message.contextId !== undefined && message.contextId !== existing.contextId) {
      throw new A2AError(-32602, 'Message contextId does not match the task.');
    }
    if (existing && existing.task.status.state !== 'TASK_STATE_INPUT_REQUIRED' && existing.task.status.state !== 'TASK_STATE_AUTH_REQUIRED') {
      throw new A2AError(-32004, 'Task is not waiting for input.');
    }
    const retainedLimit = options.limits.maxRetainedTasksPerPrincipal
      ?? options.limits.maxTasksPerPrincipal
      ?? 100;
    if (!existing) this.#store.pruneTerminal(key, Math.max(0, retainedLimit - 1));
    const records = this.#store.list(key);
    if (!existing && records.length >= retainedLimit) {
      throw new A2AError(-32004, 'Principal task limit reached.');
    }
    const activeForPrincipal = records.filter((record) => !TERMINAL_STATES.has(record.task.status.state)).length;
    if (!existing && activeForPrincipal >= (options.limits.maxActiveTasksPerPrincipal ?? 4)) {
      throw new A2AError(-32004, 'Principal active task limit reached.');
    }
    let reservationHeld = false;
    if (!existing) {
      const active = this.#store.all()
        .filter((record) => !TERMINAL_STATES.has(record.task.status.state)).length;
      if (active + this.#pendingNewTaskAdmissions >= options.limits.maxConcurrentTasks) {
        throw new A2AError(-32004, 'Server task concurrency limit reached.');
      }
      // No await may be introduced between the capacity check and increment. The
      // JavaScript turn is the admission critical section; slow preparation stays outside it.
      this.#pendingNewTaskAdmissions += 1;
      reservationHeld = true;
    }
    try {
      let started: A2AServerTaskRecord;
      let runtimeEventsAttached: Promise<void> | undefined;
      if (existing?.task.status.state === 'TASK_STATE_INPUT_REQUIRED') {
        started = await this.resumeUserInput(existing, message, digest, options);
      } else {
        const record = existing ?? await this.createRecord(
          message,
          key,
          options,
          acceptedOutputModes,
        );
        if (!existing) {
          this.#pendingNewTaskAdmissions -= 1;
          reservationHeld = false;
        }
        const next = existing ? this.appendMessage(record, message, digest) : record;
        try {
          const run = await this.startRun(next, message, options);
          started = run.record;
          runtimeEventsAttached = run.runtimeEventsAttached;
        } catch (error: unknown) {
          this.failTask(next.taskId, 'Task could not be started.', options);
          throw error;
        }
      }
      return {
        record: started,
        duplicate: false,
        ...(runtimeEventsAttached ? { runtimeEventsAttached } : {}),
      };
    } finally {
      if (reservationHeld) this.#pendingNewTaskAdmissions -= 1;
    }
  }

  private async resumeUserInput(
    record: A2AServerTaskRecord,
    message: A2AMessage,
    digest: string,
    options: PreparedA2AServerOptions,
  ): Promise<A2AServerTaskRecord> {
    const pending = record.pendingUserInput;
    if (!pending) throw new A2AError(-32004, 'Task has no pending Runtime input request.');
    const resolution = await options.runtime.userInputs.respond(
      pending.requestId,
      continuationAnswer(message, pending.kind),
      { expectedRevision: pending.revision, runId: pending.runId },
    );
    if (!resolution.accepted) throw new A2AError(-32004, 'Pending Runtime input request is no longer active.');
    const current = this.#store.get(record.taskId) ?? record;
    const appended = this.appendMessage(current, message, digest);
    const { pendingUserInput: _pending, ...withoutPending } = appended;
    if (TERMINAL_STATES.has(appended.task.status.state)) return this.#store.save(withoutPending);
    return this.#store.save({
      ...withoutPending,
      task: {
        ...appended.task,
        status: { state: 'TASK_STATE_WORKING', timestamp: nowIso(this.#now) },
      },
      updatedAt: nowIso(this.#now),
      eventSeq: appended.eventSeq + 1,
    });
  }

  private async createRecord(
    message: A2AMessage,
    key: string,
    options: PreparedA2AServerOptions,
    acceptedOutputModes?: readonly string[],
  ): Promise<A2AServerTaskRecord> {
    const contextId = message.contextId ?? randomUUID();
    const related = this.#store.list(key).find((record) => record.contextId === contextId);
    const contextKey = sha256(`${key}\0${contextId}`);
    const workspaceRoot = related?.workspaceRoot
      ?? await options.preparedExecution?.prepareWorkspace(contextKey);
    const session = await options.runtime.sessions.create({
          title: `A2A: ${options.agent.name}`,
          surface: 'a2a',
          ...(options.execution?.profileId || options.agent.profileId
            ? { profileId: options.execution?.profileId ?? options.agent.profileId }
            : {}),
          ...(workspaceRoot
            ? { projectPath: workspaceRoot, gitRoot: workspaceRoot }
            : options.agent.projectPath
              ? { projectPath: options.agent.projectPath }
              : {}),
        });
    const taskId = randomUUID();
    const timestamp = nowIso(this.#now);
    return this.#store.save({
      taskId,
      contextId,
      principalKey: key,
      principalKeyScheme: A2A_PRINCIPAL_KEY_SCHEME,
      runtimeIdentity: options.runtime.identity.runtimeId,
      sessionId: session.id,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(options.preparedExecution ? {
        executionPolicyRevision: options.preparedExecution.binding.executionPolicyRevision,
      } : {}),
      messageDigests: { [message.messageId]: messageDigest(message) },
      runIds: [],
      task: {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp },
        history: [{ ...message, taskId, contextId }],
      },
      history: [{ ...message, taskId, contextId }],
      createdAt: timestamp,
      updatedAt: timestamp,
      eventSeq: 1,
      runtimeEventCount: 0,
      runtimeEventBytes: 0,
      ...(acceptedOutputModes ? { acceptedOutputModes } : {}),
    });
  }

  private appendMessage(record: A2AServerTaskRecord, message: A2AMessage, digest: string): A2AServerTaskRecord {
    const normalized = { ...message, taskId: record.taskId, contextId: record.contextId };
    return this.#store.save({
      ...record,
      messageDigests: { ...record.messageDigests, [message.messageId]: digest },
      history: [...record.history, normalized],
      task: { ...record.task, history: [...record.history, normalized] },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
  }

  private async startRun(
    record: A2AServerTaskRecord,
    message: A2AMessage,
    options: PreparedA2AServerOptions,
  ): Promise<StartedRun> {
    const input = await this.inputsForMessage(record.taskId, message, options);
    const prepared = options.preparedExecution;
    if (prepared && record.executionPolicyRevision !== prepared.binding.executionPolicyRevision) {
      throw new A2AError(-32004, 'A2A task execution binding revision changed.');
    }
    const handle = prepared
      ? await prepared.start({
          sessionId: record.sessionId,
          inputs: input,
          principalKey: record.principalKey,
        })
      : await options.runtime.runs.start({
          sessionId: record.sessionId,
          input,
          mode: 'managed_task',
          permissionBroker: 'runtime',
          ...(options.agent.runOptions ? { options: options.agent.runOptions } : {}),
          agentContext: { actorId: `a2a:${record.principalKey.slice(0, 16)}` },
        });
    const working = this.#store.save({
      ...record,
      runIds: [...record.runIds, handle.runId],
      task: { ...record.task, status: { state: 'TASK_STATE_WORKING', timestamp: nowIso(this.#now) } },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
    void handle.result.then((result) => this.finishRun(working.taskId, result, options)).catch(() => {
      this.failTask(working.taskId, 'Task execution failed.', options);
    });
    const runtimeEventsAttached = this.attachRuntimeEvents(working, handle.runId, options);
    this.emit({ type: 'task.started', time: nowIso(this.#now), taskId: working.taskId, contextId: working.contextId, runId: handle.runId, outcome: 'accepted' });
    return { record: working, runtimeEventsAttached };
  }

  private async inputsForMessage(
    taskId: string,
    message: A2AMessage,
    options: PreparedA2AServerOptions,
  ): Promise<readonly RuntimeInput[]> {
    const inputs: RuntimeInput[] = [];
    for (const part of message.parts) {
      if (part.text !== undefined) {
        inputs.push({ type: 'text', text: part.text });
        continue;
      }
      inputs.push(await this.materializePart(taskId, part, options));
    }
    return inputs;
  }

  private async materializePart(
    taskId: string,
    part: A2APart,
    options: PreparedA2AServerOptions,
  ): Promise<RuntimeInput> {
    const mediaType = part.mediaType ?? (part.data !== undefined ? 'application/json' : 'application/octet-stream');
    const extension = part.data !== undefined ? '.json' : '.bin';
    const record = this.#store.get(taskId);
    const directory = record?.workspaceRoot
      ? path.join(record.workspaceRoot, 'inbox', sha256(taskId))
      : path.join(path.resolve(options.dataDir), 'attachments', sha256(taskId));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const content = part.data !== undefined
      ? Buffer.from(JSON.stringify(part.data), 'utf8')
      : Buffer.from(part.raw ?? '', 'base64');
    const workspaceLimit = options.limits.maxWorkspaceBytesPerContext ?? 1_073_741_824;
    if (record?.workspaceRoot && directoryBytes(record.workspaceRoot) + content.byteLength > workspaceLimit) {
      throw new A2AError(-32004, 'A2A context workspace size limit reached.');
    }
    const safeName = part.filename
      ? path.basename(part.filename).replace(/[^A-Za-z0-9._-]/g, '_')
      : `${randomUUID()}${extension}`;
    const file = path.join(directory, `${randomUUID()}-${safeName}`);
    fs.writeFileSync(file, content, { mode: 0o600 });
    const kind = mediaType.startsWith('image/') ? 'image'
      : mediaType.startsWith('video/') ? 'video' : 'file';
    const artifact = await options.runtime.artifacts.create({
      kind,
      path: file,
      mediaType,
      mimeType: mediaType,
      ...(part.filename ? { name: path.basename(part.filename) } : {}),
      source: 'user-inline',
      description: 'Inbound A2A message part',
    });
    return { type: 'artifact_ref', artifactId: artifact.id, description: 'Inbound A2A attachment' };
  }

  private async attachRuntimeEvents(
    record: A2AServerTaskRecord,
    runId: string,
    options: PreparedA2AServerOptions,
  ): Promise<void> {
    this.#runtimeSubscriptions.get(record.taskId)?.close();
    this.#runtimeSubscriptions.delete(record.taskId);
    const buffered: RuntimeEvent[] = [];
    let replaying = true;
    const subscription = options.runtime.events.subscribe(
      { sessionId: record.sessionId, runId },
      (event) => {
        if (replaying) buffered.push(event);
        else this.onRuntimeEvent(record.taskId, event, options);
      },
    );
    this.#runtimeSubscriptions.set(record.taskId, subscription);
    try {
      const replayed = await options.runtime.events.replay({
        sessionId: record.sessionId,
        runId,
        ...(record.runtimeSessionCursor !== undefined
          ? { after: record.runtimeSessionCursor }
          : {}),
      });
      const ordered = [...replayed, ...buffered].sort((left, right) => (
        left.seq - right.seq
        || left.time.localeCompare(right.time)
        || left.id.localeCompare(right.id)
      ));
      for (const event of ordered) this.onRuntimeEvent(record.taskId, event, options);
      replaying = false;
    } catch (error: unknown) {
      replaying = false;
      if (this.#runtimeSubscriptions.get(record.taskId) === subscription) {
        subscription.close();
        this.#runtimeSubscriptions.delete(record.taskId);
      }
      throw error;
    }
  }

  private onRuntimeEvent(
    taskId: string,
    event: RuntimeEvent,
    options: PreparedA2AServerOptions,
  ): void {
    if (this.#runtimeProjectionFailures.has(taskId)) return;
    try {
      this.consumeRuntimeEvent(taskId, event, options);
    } catch (error: unknown) {
      this.#runtimeProjectionFailures.add(taskId);
      this.#runtimeSubscriptions.get(taskId)?.close();
      this.#runtimeSubscriptions.delete(taskId);
      throw error;
    }
  }

  private consumeRuntimeEvent(
    taskId: string,
    event: RuntimeEvent,
    options: PreparedA2AServerOptions,
  ): void {
    if (this.#closed) return;
    const record = this.#store.get(taskId);
    if (!record || TERMINAL_STATES.has(record.task.status.state)) return;
    const eventCursor = event.cursor;
    if (
      eventCursor.sessionId !== record.sessionId
      || (
        record.runtimeSessionCursor !== undefined
        && eventCursor.journalEpoch !== record.runtimeSessionCursor.journalEpoch
      )
    ) {
      this.failTask(taskId, 'Runtime Session event journal changed; task resync is required.', options);
      return;
    }
    if (
      record.runtimeSessionCursor !== undefined
      && eventCursor.seq <= record.runtimeSessionCursor.seq
    ) return;
    if (
      event.type !== 'user_input.requested'
      && event.type !== 'user_input.resolved'
      && event.type !== 'run.started'
    ) {
      this.#store.checkpointRuntimeCursor(taskId, eventCursor);
      return;
    }
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    const runtimeEventCount = record.runtimeEventCount + 1;
    const runtimeEventBytes = record.runtimeEventBytes + eventBytes;
    if (runtimeEventCount > (options.limits.maxEventsPerTask ?? 1_000)
      || runtimeEventBytes > (options.limits.maxEventBytesPerTask ?? 16_777_216)) {
      const runId = record.runIds.at(-1);
      if (runId) void options.runtime.runs.abort(runId);
      this.failTask(taskId, 'A2A task event quota exceeded.', options);
      return;
    }
    const state = event.type === 'user_input.requested'
      ? 'TASK_STATE_INPUT_REQUIRED'
      : 'TASK_STATE_WORKING';
    const interactionMessage = event.type === 'user_input.requested'
      ? pendingInputMessage(taskId, record.contextId, event)
      : undefined;
    const pending = event.type === 'user_input.requested' && isRecord(event.payload)
      && typeof event.payload.id === 'string'
      && Number.isSafeInteger(event.payload.revision)
      && typeof event.payload.runId === 'string'
      && typeof event.payload.kind === 'string'
      ? {
          requestId: event.payload.id,
          revision: event.payload.revision as number,
          runId: event.payload.runId,
          kind: event.payload.kind,
        }
      : undefined;
    this.#store.save({
      ...record,
      task: {
        ...record.task,
        status: {
          state,
          ...(interactionMessage ? { message: interactionMessage } : {}),
          timestamp: event.time,
        },
      },
      ...(pending ? { pendingUserInput: pending } : {}),
      ...(event.type === 'user_input.resolved' ? { pendingUserInput: undefined } : {}),
      updatedAt: event.time,
      eventSeq: record.eventSeq + 1,
      runtimeSessionCursor: eventCursor,
      runtimeEventCount,
      runtimeEventBytes,
    });
  }

  private finishRun(taskId: string, result: RuntimeRunResult, options = this.options): void {
    if (this.#closed) return;
    if (this.#runtimeProjectionFailures.has(taskId)) return;
    const record = this.#store.get(taskId);
    if (!record || TERMINAL_STATES.has(record.task.status.state)) return;
    const state = statusState(result.phase);
    const diagnosticId = result.error ? sha256(errorMessage(result.error)).slice(0, 16) : undefined;
    const output = result.error
      ? `Task failed. Diagnostic ID: ${diagnosticId}`
      : safeTaskText(result.result?.lastText ?? '', record, options);
    const message = output ? agentMessage(taskId, record.contextId, output) : undefined;
    const history = message ? [...record.history, message] : record.history;
    const textArtifacts: A2AArtifact[] = output
      && (record.acceptedOutputModes ?? options.agent.outputModes).includes('text/plain') ? [{
      artifactId: `final-${taskId}`,
      name: 'final-output',
      parts: [{ text: output, mediaType: 'text/plain' }],
    }] : [];
    const artifacts = [...textArtifacts, ...stagedArtifacts(record, result, options)];
    const { pendingUserInput: _pending, ...withoutPending } = record;
    this.#store.save({
      ...withoutPending,
      history,
      task: {
        ...record.task,
        status: { state, ...(message ? { message } : {}), timestamp: nowIso(this.#now) },
        ...(artifacts.length > 0 ? { artifacts } : {}),
        history,
      },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
    this.#runtimeSubscriptions.get(taskId)?.close();
    this.#runtimeSubscriptions.delete(taskId);
    this.pruneRetained(record.principalKey, options);
    this.emit({ type: 'task.finished', time: nowIso(this.#now), taskId, contextId: record.contextId, outcome: state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed' });
  }

  private failTask(taskId: string, message: string, options = this.options): void {
    if (this.#closed) return;
    const record = this.#store.get(taskId);
    if (!record || TERMINAL_STATES.has(record.task.status.state)) return;
    const statusMessage = agentMessage(taskId, record.contextId, message);
    const { pendingUserInput: _pending, ...withoutPending } = record;
    this.#store.save({
      ...withoutPending,
      task: { ...record.task, status: { state: 'TASK_STATE_FAILED', message: statusMessage, timestamp: nowIso(this.#now) } },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
    this.#runtimeSubscriptions.get(taskId)?.close();
    this.#runtimeSubscriptions.delete(taskId);
    this.pruneRetained(record.principalKey, options);
  }

  private pruneRetained(principal: string, options: PreparedA2AServerOptions): void {
    const limit = options.limits.maxRetainedTasksPerPrincipal
      ?? options.limits.maxTasksPerPrincipal
      ?? 100;
    this.#store.pruneTerminal(principal, limit);
  }

  private async getTask(params: Readonly<Record<string, unknown>> | undefined, key: string): Promise<A2ATask> {
    const id = requiredTaskId(params);
    const record = this.requireOwnedTask(id, key);
    const historyLength = parseHistoryLength(params?.historyLength, 'GetTask historyLength');
    return withHistory(record.task, record.history, historyLength);
  }

  private listTasks(params: Readonly<Record<string, unknown>> | undefined, key: string): unknown {
    const historyLength = parseHistoryLength(params?.historyLength, 'ListTasks historyLength');
    if (params?.includeArtifacts !== undefined && typeof params.includeArtifacts !== 'boolean') {
      throw new A2AError(-32602, 'ListTasks includeArtifacts must be a boolean.');
    }
    if (params?.contextId !== undefined && typeof params.contextId !== 'string') {
      throw new A2AError(-32602, 'ListTasks contextId must be a string.');
    }
    if (params?.pageToken !== undefined && typeof params.pageToken !== 'string') {
      throw new A2AError(-32602, 'ListTasks pageToken must be a string.');
    }
    if (params?.status !== undefined && (
      typeof params.status !== 'string' || !TASK_STATES.has(params.status as A2ATaskState)
    )) throw new A2AError(-32602, 'ListTasks status is invalid.');
    const timestampAfter = typeof params?.statusTimestampAfter === 'string'
      ? Date.parse(params.statusTimestampAfter)
      : undefined;
    if (params?.statusTimestampAfter !== undefined && !Number.isFinite(timestampAfter)) {
      throw new A2AError(-32602, 'ListTasks statusTimestampAfter is invalid.');
    }
    const records = this.#store.list(key).filter((record) => {
      if (typeof params?.contextId === 'string' && record.contextId !== params.contextId) return false;
      if (typeof params?.status === 'string' && record.task.status.state !== params.status) return false;
      if (timestampAfter !== undefined
        && Date.parse(record.task.status.timestamp ?? record.updatedAt) < timestampAfter) return false;
      return true;
    });
    if (params?.pageSize !== undefined && (
      !Number.isSafeInteger(params.pageSize) || (params.pageSize as number) < 1 || (params.pageSize as number) > 100
    )) throw new A2AError(-32602, 'ListTasks pageSize must be an integer from 1 to 100.');
    const pageSize = typeof params?.pageSize === 'number' ? params.pageSize : 50;
    const cursor = parseTaskListCursor(typeof params?.pageToken === 'string' ? params.pageToken : undefined);
    const remaining = cursor ? records.filter((record) => followsTaskListCursor(record, cursor)) : records;
    const page = remaining.slice(0, pageSize);
    const last = page.at(-1);
    return {
      tasks: page.map((record) => {
        const task = withHistory(record.task, record.history, historyLength);
        return params?.includeArtifacts === true ? task : { ...task, artifacts: undefined };
      }),
      nextPageToken: last && page.length < remaining.length ? encodeTaskListCursor(last) : '',
      pageSize,
      totalSize: records.length,
    };
  }

  private async cancelTask(
    params: Readonly<Record<string, unknown>> | undefined,
    key: string,
    options: PreparedA2AServerOptions,
  ): Promise<A2ATask> {
    const id = requiredTaskId(params);
    const record = this.requireOwnedTask(id, key);
    if (TERMINAL_STATES.has(record.task.status.state)) throw new A2AError(-32002, 'Task is not cancelable.');
    const runId = record.runIds.at(-1);
    if (runId) await options.runtime.runs.abort(runId);
    const canceled = this.#store.save({
      ...record,
      task: { ...record.task, status: { state: 'TASK_STATE_CANCELED', timestamp: nowIso(this.#now) } },
      updatedAt: nowIso(this.#now),
      eventSeq: record.eventSeq + 1,
    });
    this.#runtimeSubscriptions.get(id)?.close();
    this.#runtimeSubscriptions.delete(id);
    this.pruneRetained(record.principalKey, options);
    return canceled.task;
  }

  private subscribeTask(
    id: A2AJsonRpcRequest['id'],
    params: Readonly<Record<string, unknown>> | undefined,
    key: string,
  ): Response {
    const taskId = requiredTaskId(params);
    const record = this.requireOwnedTask(taskId, key);
    if (TERMINAL_STATES.has(record.task.status.state)) throw new A2AError(-32004, 'Cannot subscribe to a terminal task.');
    return this.streamTask(id, taskId, record.principalKey);
  }

  private streamTask(id: A2AJsonRpcRequest['id'], taskId: string, key: string): Response {
    const initial = this.requireOwnedTask(taskId, key);
    const emittedArtifacts = new Map(
      (initial.task.artifacts ?? []).map((artifact) => [artifact.artifactId, sha256(JSON.stringify(artifact))]),
    );
    const releaseStream = this.reserveStream(taskId);
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let cleanup = releaseStream;
    let closed = false;
    try {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const close = (error?: Error) => {
            if (closed) return;
            closed = true;
            cleanup();
            if (error) controller.error(error);
            else controller.close();
          };
          cleanup = () => {
            unsubscribe?.();
            unsubscribe = undefined;
            this.#streamClosers.delete(close);
            releaseStream();
          };
          const enqueue = (result: unknown): boolean => {
            const chunk = encoder.encode(this.sse(id, result));
            if (controller.desiredSize === null || controller.desiredSize < chunk.byteLength) {
              close(new Error('A2A SSE subscriber exceeded its buffer budget.'));
              return false;
            }
            controller.enqueue(chunk);
            return true;
          };
          this.#streamClosers.add(close);
          if (!enqueue({ task: initial.task })) return;
          if (TERMINAL_STATES.has(initial.task.status.state)) {
            close();
            return;
          }
          unsubscribe = this.#store.subscribe(taskId, (record) => {
            if (!this.enqueueArtifactUpdates(enqueue, record.task, emittedArtifacts)
              || !enqueue({
                statusUpdate: { taskId, contextId: record.contextId, status: record.task.status },
              })) return;
            if (TERMINAL_STATES.has(record.task.status.state)
              || record.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
              || record.task.status.state === 'TASK_STATE_AUTH_REQUIRED') {
              close();
            }
          });
        },
        cancel: () => {
          if (closed) return;
          closed = true;
          cleanup();
        },
      }, {
        highWaterMark: MAX_SSE_QUEUE_BYTES,
        size: (chunk) => chunk.byteLength,
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    } catch (error: unknown) {
      cleanup();
      throw error;
    }
  }

  private enqueueArtifactUpdates(
    enqueue: (result: unknown) => boolean,
    task: A2ATask,
    emittedArtifacts: Map<string, string>,
  ): boolean {
    for (const artifact of task.artifacts ?? []) {
      const fingerprint = sha256(JSON.stringify(artifact));
      if (emittedArtifacts.get(artifact.artifactId) === fingerprint) continue;
      if (!enqueue({
        artifactUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          artifact,
          append: false,
          lastChunk: true,
        },
      })) return false;
      emittedArtifacts.set(artifact.artifactId, fingerprint);
    }
    return true;
  }

  private reserveStream(taskId: string): () => void {
    const taskCount = this.#taskStreamCounts.get(taskId) ?? 0;
    if (taskCount >= MAX_SSE_STREAMS_PER_TASK) {
      throw new A2AError(-32000, 'Task stream capacity reached.', 429);
    }
    if (this.#activeStreamCount >= MAX_SSE_STREAMS_PER_SERVER) {
      throw new A2AError(-32000, 'Server stream capacity reached.', 429);
    }
    this.#activeStreamCount += 1;
    this.#taskStreamCounts.set(taskId, taskCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeStreamCount -= 1;
      const remaining = (this.#taskStreamCounts.get(taskId) ?? 1) - 1;
      if (remaining === 0) this.#taskStreamCounts.delete(taskId);
      else this.#taskStreamCounts.set(taskId, remaining);
    };
  }

  private sse(id: A2AJsonRpcRequest['id'], result: unknown): string {
    return `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
  }

  private waitForTask(taskId: string, timeoutMs: number): Promise<A2AServerTaskRecord> {
    const current = this.#store.get(taskId);
    if (!current) return Promise.reject(new A2AError(-32001, 'Task not found.'));
    if (TERMINAL_STATES.has(current.task.status.state)
      || current.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
      || current.task.status.state === 'TASK_STATE_AUTH_REQUIRED') return Promise.resolve(current);
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      const finish = (record: A2AServerTaskRecord): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(record);
      };
      const timer = setTimeout(() => finish(this.#store.get(taskId) ?? current), timeoutMs);
      unsubscribe = this.#store.subscribe(taskId, (record) => {
        if (TERMINAL_STATES.has(record.task.status.state)
          || record.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
          || record.task.status.state === 'TASK_STATE_AUTH_REQUIRED') {
          finish(record);
        }
      });
      const latest = this.#store.get(taskId);
      if (latest && (TERMINAL_STATES.has(latest.task.status.state)
        || latest.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
        || latest.task.status.state === 'TASK_STATE_AUTH_REQUIRED')) finish(latest);
    });
  }

  private requireOwnedTask(taskId: string, key: string): A2AServerTaskRecord {
    const record = this.#store.get(taskId);
    if (!record || record.principalKey !== key) throw new A2AError(-32001, 'Task not found.');
    return record;
  }

  private async recover(): Promise<void> {
    const options = this.options;
    for (const record of this.#store.all()) {
      if (TERMINAL_STATES.has(record.task.status.state)) continue;
      const runId = record.runIds.at(-1);
      if (!runId || record.runtimeIdentity !== options.runtime.identity.runtimeId) {
        this.failTask(record.taskId, 'Runtime execution was interrupted before A2A recovery.', options);
        continue;
      }
      try {
        const status = await options.runtime.runs.get(runId);
        if (status.phase === 'running' || status.phase === 'queued' || status.phase === 'waiting_permission' || status.phase === 'waiting_user_input') {
          await this.attachRuntimeEvents(record, runId, options);
          void options.runtime.runs.await(runId).then((result) => this.finishRun(record.taskId, result, options)).catch(() => {
            this.failTask(record.taskId, 'Runtime execution failed during A2A recovery.', options);
          });
        } else {
          await this.attachRuntimeEvents(record, runId, options);
          this.finishRun(record.taskId, { runId, sessionId: record.sessionId, phase: status.phase }, options);
        }
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'a2a.server',
          level: 'warn',
          message: 'A2A task recovery could not reattach to its Runtime run.',
          detail: { taskId: record.taskId, error },
        });
        this.failTask(record.taskId, 'Runtime execution was unavailable during A2A recovery.', options);
      }
    }
  }

  private emit(event: A2AServerEvent): void {
    this.options.onEvent?.(event);
  }
}

export function createKodaXA2AServer(options: A2AServerOptions): KodaXA2AServer {
  return new KodaXA2AServerRuntime(options);
}

async function prepareExecution(options: A2AServerOptions): Promise<PreparedA2AExecution> {
  const declaration = options.execution;
  if (!declaration) throw new Error('A2A execution declaration is required for prepared serving.');
  const service = options.runtime.agents.execution;
  if (!service) throw new Error('local-agent-capability-unavailable: Runtime does not own an embedded execution binding service.');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('A2A preparation aborted.');
  const owner = await service.openOwnerSession();
  try {
    const binding = declaration.kind === 'local-agent'
      ? await service.bindLocal({
          ownerSessionId: owner.ownerSessionId,
          ref: declaration.agentRef,
          profileId: declaration.profileId,
          workspace: declaration.workspace,
          toolPolicy: declaration.toolPolicy,
          workspaceByteLimit: options.limits.maxWorkspaceBytesPerContext,
        })
      : await service.bindDefault({
          ownerSessionId: owner.ownerSessionId,
          profileId: declaration.profileId,
          workspace: declaration.workspace,
          toolPolicy: declaration.toolPolicy,
          workspaceByteLimit: options.limits.maxWorkspaceBytesPerContext,
        });
    let closed = false;
    return {
      service,
      ownerSessionId: owner.ownerSessionId,
      binding,
      declaration,
      prepareWorkspace(contextKey) {
        return service.prepareWorkspace({
          ownerSessionId: owner.ownerSessionId,
          bindingId: binding.bindingId,
          contextKey,
        });
      },
      start(input) {
        const base = {
          ownerSessionId: owner.ownerSessionId,
          bindingId: binding.bindingId,
          expectedExecutionPolicyRevision: binding.executionPolicyRevision,
          sessionId: input.sessionId,
          input: input.inputs,
          permissionBroker: 'runtime' as const,
          agentContext: { actorId: `a2a:${input.principalKey.slice(0, 16)}` },
        };
        if (declaration.kind === 'local-agent') {
          const revision = 'configurationRevision' in binding
            && typeof binding.configurationRevision === 'string'
            ? binding.configurationRevision
            : undefined;
          if (!revision) throw new Error('Prepared local-Agent binding is missing its revision.');
          return service.startLocal({ ...base, expectedConfigurationRevision: revision });
        }
        return service.startDefault(base);
      },
      async close() {
        if (closed) return;
        closed = true;
        await service.closeOwnerSession(owner.ownerSessionId);
      },
    };
  } catch (error: unknown) {
    await service.closeOwnerSession(owner.ownerSessionId);
    throw error;
  }
}

/** Prepare an immutable Runtime execution binding before exposing an A2A handler. */
export async function prepareKodaXA2AServer(options: A2AServerOptions): Promise<KodaXA2AServer> {
  const preparedExecution = await prepareExecution(options);
  try {
    const server = new KodaXA2AServerRuntime({ ...options, preparedExecution });
    await server.whenReady();
    return server;
  } catch (error: unknown) {
    await preparedExecution.close();
    throw error;
  }
}
