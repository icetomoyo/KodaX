import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionMode,
  type SessionModeState,
  type SessionNotification,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ToolCallUpdate,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import {
  KODAX_DEFAULT_PROVIDER,
  type KodaXOptions,
  type KodaXReasoningMode,
  runKodaX,
} from '@kodax/coding';
import {
  computeConfirmTools,
  FileSessionStorage,
  collectBashWriteTargets,
  generateSavePattern,
  getBashOutsideProjectWriteRisk,
  getPlanModeBlockReason,
  isAlwaysConfirmPath,
  isBashReadCommand,
  isPathInsideProject,
  isToolCallAllowed,
  loadConfig,
} from '@kodax/repl';

export const ACP_PERMISSION_MODE_IDS = ['plan', 'accept-edits', 'auto-in-project'] as const;
type AcpPermissionMode = (typeof ACP_PERMISSION_MODE_IDS)[number];

const ACP_TOOL_FILE_MODIFICATION_TOOLS = new Set(['write', 'edit']);
const ACP_TOOL_KIND_MAP: Record<string, ToolKind> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  undo: 'edit',
  bash: 'execute',
  grep: 'search',
  glob: 'search',
  think: 'think',
  fetch: 'fetch',
};

const ACP_PERMISSION_MODE_DEFINITIONS: SessionMode[] = [
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only planning mode. File modifications are blocked except the plan-mode whitelist.',
  },
  {
    id: 'accept-edits',
    name: 'Accept Edits',
    description: 'File edits are auto-approved. Shell commands still require confirmation unless explicitly remembered.',
  },
  {
    id: 'auto-in-project',
    name: 'Auto In Project',
    description: 'Project-scoped changes are auto-approved. Protected paths and risky out-of-project operations still require confirmation.',
  },
];

export interface KodaXAcpServerOptions {
  /** Provider name forwarded to the coding runtime. */
  provider?: string;
  /** Optional model override forwarded to the coding runtime. */
  model?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  /**
   * Default session working directory. When explicitly set on the server, it
   * becomes the fixed execution cwd for all ACP sessions and overrides any
   * client-provided session cwd.
   */
  cwd?: string;
  permissionMode?: AcpPermissionMode;
  agentName?: string;
  agentVersion?: string;
  storage?: FileSessionStorage;
}

interface KodaXAcpSessionState {
  sessionId: string;
  cwd: string;
  permissionMode: AcpPermissionMode;
  mcpServers: McpServer[];
  alwaysAllowTools: string[];
  activeController: AbortController | null;
}

interface ToolPermissionDecision {
  allowed: boolean;
  override?: string;
}

function normalizeAcpPermissionMode(
  mode: string | undefined,
  fallback: AcpPermissionMode = 'accept-edits',
): AcpPermissionMode {
  if (mode && ACP_PERMISSION_MODE_IDS.includes(mode as AcpPermissionMode)) {
    return mode as AcpPermissionMode;
  }

  return fallback;
}

function parseSessionMode(mode: string | undefined): AcpPermissionMode {
  if (mode && ACP_PERMISSION_MODE_IDS.includes(mode as AcpPermissionMode)) {
    return mode as AcpPermissionMode;
  }

  throw RequestError.invalidParams(
    { modeId: mode },
    'Invalid session mode. Expected one of: plan, accept-edits, auto-in-project.',
  );
}

function buildModeState(currentModeId: AcpPermissionMode): SessionModeState {
  return {
    availableModes: ACP_PERMISSION_MODE_DEFINITIONS,
    currentModeId,
  };
}

function inferToolKind(toolName: string): ToolKind {
  return ACP_TOOL_KIND_MAP[toolName] ?? 'other';
}

function inferToolLocations(toolName: string, input: Record<string, unknown>): Array<{ path: string }> | undefined {
  if (ACP_TOOL_FILE_MODIFICATION_TOOLS.has(toolName)) {
    const targetPath = typeof input.path === 'string' ? input.path : undefined;
    return targetPath ? [{ path: targetPath }] : undefined;
  }

  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const targets = collectBashWriteTargets(command);
    if (targets.length > 0) {
      return targets.map((targetPath: string) => ({ path: targetPath }));
    }
  }

  return undefined;
}

function extractPromptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    const anyBlock = block as Record<string, unknown>;
    const type = typeof anyBlock.type === 'string' ? anyBlock.type : '';

    if (type === 'text' && typeof anyBlock.text === 'string') {
      parts.push(anyBlock.text);
      continue;
    }

    if (type === 'resource_link' && typeof anyBlock.uri === 'string') {
      parts.push(`[Resource] ${anyBlock.uri}`);
      continue;
    }

    if (type === 'resource' && anyBlock.resource && typeof anyBlock.resource === 'object') {
      const resource = anyBlock.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') {
        parts.push(resource.text);
        continue;
      }
      if (typeof resource.uri === 'string') {
        parts.push(`[Resource] ${resource.uri}`);
      }
    }
  }

  return parts.join('\n\n').trim();
}

function isToolResultFailure(content: string): boolean {
  return /^\[(?:Tool Error|Cancelled|Blocked|Error)\]/.test(content);
}

export class KodaXAcpServer implements Agent {
  private readonly provider: string;
  private readonly model?: string;
  private readonly thinking: boolean;
  private readonly reasoningMode: KodaXReasoningMode;
  private readonly defaultPermissionMode: AcpPermissionMode;
  private readonly defaultCwd: string;
  private readonly hasFixedCwd: boolean;
  private readonly agentName: string;
  private readonly agentVersion: string;
  private readonly storage: FileSessionStorage;

  private connection: AgentSideConnection | null = null;
  private readonly sessions = new Map<string, KodaXAcpSessionState>();
  private promptQueue: Promise<unknown> = Promise.resolve();

  constructor(options: KodaXAcpServerOptions = {}) {
    const config = loadConfig();
    this.provider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
    this.model = options.model;
    this.thinking = options.thinking ?? config.thinking ?? false;
    this.reasoningMode = options.reasoningMode ?? config.reasoningMode ?? 'auto';
    this.defaultPermissionMode = normalizeAcpPermissionMode(
      options.permissionMode ?? config.permissionMode,
      'accept-edits',
    );
    this.defaultCwd = path.resolve(options.cwd ?? process.cwd());
    this.hasFixedCwd = options.cwd !== undefined;
    this.agentName = options.agentName ?? 'kodax-acp-server';
    this.agentVersion = options.agentVersion ?? '0.0.0';
    this.storage = options.storage ?? new FileSessionStorage();
  }

  attach(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
  ): AgentSideConnection {
    const stream = ndJsonStream(output, input);
    const connection = new AgentSideConnection(() => this, stream);
    this.connection = connection;
    connection.signal.addEventListener('abort', () => {
      this.sessions.forEach((session) => session.activeController?.abort());
      this.sessions.clear();
      this.connection = null;
    });
    return connection;
  }

  async waitForClose(): Promise<void> {
    await this.connection?.closed;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: this.agentName,
        version: this.agentVersion,
      },
      agentCapabilities: {
        promptCapabilities: {
          embeddedContext: true,
          image: false,
          audio: false,
        },
        sessionCapabilities: {},
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const requestedCwd = this.hasFixedCwd
      ? this.defaultCwd
      : (params.cwd ?? this.defaultCwd);
    if (!path.isAbsolute(requestedCwd)) {
      throw RequestError.invalidParams({ cwd: requestedCwd }, 'Session cwd must be an absolute path.');
    }

    const sessionId = randomUUID();
    const session: KodaXAcpSessionState = {
      sessionId,
      cwd: path.resolve(requestedCwd),
      permissionMode: this.defaultPermissionMode,
      mcpServers: params.mcpServers ?? [],
      alwaysAllowTools: [],
      activeController: null,
    };
    this.sessions.set(sessionId, session);

    return {
      sessionId,
      modes: buildModeState(session.permissionMode),
    };
  }

  async authenticate(): Promise<void> {
    return undefined;
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    const nextMode = parseSessionMode(params.modeId);
    session.permissionMode = nextMode;
    await this.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: nextMode,
      },
    });
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    const promptText = extractPromptText(params.prompt);
    if (!promptText) {
      throw RequestError.invalidParams(
        { prompt: params.prompt },
        'Prompt must include at least one text or resource block with content.',
      );
    }
    const abortController = new AbortController();
    session.activeController = abortController;

    const task = async (): Promise<PromptResponse> => {
      if (abortController.signal.aborted) {
        return {
          stopReason: 'cancelled',
          userMessageId: params.messageId ?? undefined,
        };
      }

      try {
        const result = await runKodaX(
          this.buildKodaXOptions(session, abortController.signal),
          promptText,
        );

        return {
          stopReason: abortController.signal.aborted || result.interrupted ? 'cancelled' : 'end_turn',
          userMessageId: params.messageId ?? undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendTextChunk(session.sessionId, `\n[ACP Server Error] ${message}\n`);
        return {
          stopReason: abortController.signal.aborted ? 'cancelled' : 'end_turn',
          userMessageId: params.messageId ?? undefined,
        };
      } finally {
        session.activeController = null;
      }
    };

    const queued = this.promptQueue.then(task, task);
    this.promptQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session?.activeController?.abort();
  }

  private requireSession(sessionId: string): KodaXAcpSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private buildKodaXOptions(session: KodaXAcpSessionState, abortSignal: AbortSignal): KodaXOptions {
    return {
      provider: this.provider,
      model: this.model,
      thinking: this.thinking,
      reasoningMode: this.reasoningMode,
      parallel: false,
      abortSignal,
      session: {
        id: session.sessionId,
        storage: this.storage,
      },
      context: {
        gitRoot: session.cwd,
        executionCwd: session.cwd,
      },
      events: {
        onTextDelta: (text) => {
          this.dispatchNotification('assistant text chunk', this.sendTextChunk(session.sessionId, text));
        },
        onThinkingDelta: (text) => {
          this.dispatchNotification('thinking chunk', this.sendSessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text },
            },
          }));
        },
        onToolUseStart: (tool) => {
          this.dispatchNotification('tool call start', this.sendSessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: tool.id,
              title: tool.name,
              kind: inferToolKind(tool.name),
              rawInput: tool.input,
              locations: inferToolLocations(tool.name, tool.input ?? {}),
              status: 'pending',
            },
          }));
        },
        onToolResult: (result) => {
          this.dispatchNotification('tool call update', this.sendSessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: result.id,
              title: result.name,
              status: isToolResultFailure(result.content) ? 'failed' : 'completed',
              rawOutput: result.content,
            },
          }));
        },
        onError: (error) => {
          this.dispatchNotification(
            'error text chunk',
            this.sendTextChunk(session.sessionId, `\n[Error] ${error.message}\n`),
          );
        },
        beforeToolExecute: async (toolName, input, meta) => {
          const decision = await this.evaluateToolPermission(session, toolName, input, meta?.toolId);
          if (!decision.allowed) {
            return decision.override ?? false;
          }
          return true;
        },
      },
    };
  }

  private async evaluateToolPermission(
    session: KodaXAcpSessionState,
    toolName: string,
    input: Record<string, unknown>,
    toolId?: string,
  ): Promise<ToolPermissionDecision> {
    if (toolName === 'bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (isBashReadCommand(command)) {
        return { allowed: true };
      }

      if (isToolCallAllowed(toolName, input, session.alwaysAllowTools)) {
        return { allowed: true };
      }
    }

    if (session.permissionMode === 'plan') {
      const blockReason = getPlanModeBlockReason(toolName, input, session.cwd);
      if (blockReason) {
        return {
          allowed: false,
          override: `${blockReason} Do not try to modify files while planning. Finish the plan first, then hand off to a writable mode.`,
        };
      }
      return { allowed: true };
    }

    const needsProtectedPathConfirmation =
      ACP_TOOL_FILE_MODIFICATION_TOOLS.has(toolName) &&
      typeof input.path === 'string' &&
      isAlwaysConfirmPath(path.resolve(session.cwd, input.path), session.cwd);

    const needsModeConfirmation = computeConfirmTools(session.permissionMode).has(toolName);
    const needsAutoOutsideProjectConfirmation =
      session.permissionMode === 'auto-in-project' &&
      (
        (ACP_TOOL_FILE_MODIFICATION_TOOLS.has(toolName) &&
          typeof input.path === 'string' &&
          !isPathInsideProject(input.path, session.cwd)) ||
        (toolName === 'bash' &&
          typeof input.command === 'string' &&
          getBashOutsideProjectWriteRisk(input.command, session.cwd).dangerous)
      );

    if (
      !needsProtectedPathConfirmation &&
      !needsModeConfirmation &&
      !needsAutoOutsideProjectConfirmation
    ) {
      return { allowed: true };
    }

    const permissionResult = await this.requestPermissionFromClient(session, toolName, input, toolId);
    return permissionResult;
  }

  private async requestPermissionFromClient(
    session: KodaXAcpSessionState,
    toolName: string,
    input: Record<string, unknown>,
    toolId?: string,
  ): Promise<ToolPermissionDecision> {
    if (!this.connection) {
      return {
        allowed: false,
        override: '[Cancelled] ACP client is disconnected, so the permission request could not be completed.',
      };
    }

    const permissionOptions: PermissionOption[] = [
      {
        optionId: 'allow_once',
        kind: 'allow_once',
        name: 'Allow once',
      },
      {
        optionId: 'allow_always',
        kind: 'allow_always',
        name: 'Always allow',
      },
      {
        optionId: 'reject_once',
        kind: 'reject_once',
        name: 'Reject',
      },
    ];

    const toolCall: ToolCallUpdate = {
      toolCallId: toolId ?? randomUUID(),
      title: toolName,
      kind: inferToolKind(toolName),
      rawInput: input,
      locations: inferToolLocations(toolName, input),
      status: 'pending',
    };

    let response: RequestPermissionResponse;
    try {
      response = await this.connection.requestPermission({
        sessionId: session.sessionId,
        toolCall,
        options: permissionOptions,
      });
    } catch {
      return {
        allowed: false,
        override: '[Cancelled] ACP client did not complete the permission request. Operation failed closed.',
      };
    }

    if (response.outcome.outcome !== 'selected') {
      return {
        allowed: false,
        override: '[Cancelled] Operation cancelled by user',
      };
    }

    if (response.outcome.optionId === 'allow_always') {
      if (toolName === 'bash') {
        session.alwaysAllowTools = Array.from(
          new Set([
            ...session.alwaysAllowTools,
            generateSavePattern(toolName, input, false),
          ]),
        ).filter(Boolean);
      }
    }

    if (response.outcome.optionId === 'reject_once') {
      return {
        allowed: false,
        override: '[Cancelled] Operation cancelled by user',
      };
    }

    return { allowed: true };
  }

  private async sendTextChunk(sessionId: string, text: string): Promise<void> {
    await this.sendSessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }

  private async sendSessionUpdate(notification: SessionNotification): Promise<void> {
    if (!this.connection || this.connection.signal.aborted) {
      return;
    }
    await this.connection.sessionUpdate(notification);
  }

  private dispatchNotification(label: string, operation: Promise<void>): void {
    void operation.catch((error) => {
      if (!this.connection || this.connection.signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ACP] Failed to send ${label}: ${message}`);
    });
  }
}

export async function runAcpServer(options: KodaXAcpServerOptions = {}): Promise<void> {
  const server = new KodaXAcpServer(options);
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  server.attach(input, output);
  await server.waitForClose();
}
