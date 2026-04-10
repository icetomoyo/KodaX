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
  type KodaXContextTokenSnapshot,
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
  prepareRuntimeConfig,
} from '@kodax/repl';
import {
  AcpLogger,
  resolveAcpLogLevel,
  type AcpLogLevel,
} from './acp_logger.js';
import {
  AcpEventEmitter,
  type AcpEventSink,
} from './acp_events.js';

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
  logLevel?: AcpLogLevel;
  /** Additional sinks that receive structured ACP runtime events. */
  eventSinks?: AcpEventSink[];
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
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
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

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'AbortError' ||
    error.message.includes('aborted') ||
    error.message.includes('ABORTED')
  );
}

function toAcpUsage(snapshot: KodaXContextTokenSnapshot | undefined): PromptResponse['usage'] | undefined {
  const usage = snapshot?.usage;
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedReadTokens !== undefined ? { cachedReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens !== undefined ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(usage.thoughtTokens !== undefined ? { thoughtTokens: usage.thoughtTokens } : {}),
  };
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
  private readonly events: AcpEventEmitter;

  private connection: AgentSideConnection | null = null;
  private readonly sessions = new Map<string, KodaXAcpSessionState>();
  private promptQueue: Promise<unknown> = Promise.resolve();

  constructor(options: KodaXAcpServerOptions = {}) {
    const config = prepareRuntimeConfig();
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
    this.events = new AcpEventEmitter({
      sinks: [
        ...(options.eventSinks ?? []),
        new AcpLogger({
          level: resolveAcpLogLevel(options.logLevel ?? process.env.KODAX_ACP_LOG, 'info'),
        }),
      ],
    });
  }

  attach(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
  ): AgentSideConnection {
    const stream = ndJsonStream(output, input);
    const connection = new AgentSideConnection(() => this, stream);
    this.connection = connection;
    this.events.emit({
      type: 'server_attached',
      agent: this.agentName,
      version: this.agentVersion,
      provider: this.provider,
      model: this.model ?? '(default)',
      cwd: this.defaultCwd,
      permissionMode: this.defaultPermissionMode,
      reasoningMode: this.reasoningMode,
      thinking: this.thinking,
      fixedCwd: this.hasFixedCwd,
    });
    connection.signal.addEventListener('abort', () => {
      this.sessions.forEach((session) => session.activeController?.abort());
      this.events.emit({
        type: 'connection_closed',
        activeSessions: this.sessions.size,
      });
      this.sessions.clear();
      this.connection = null;
    });
    return connection;
  }

  async waitForClose(): Promise<void> {
    await this.connection?.closed;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.events.emit({
      type: 'initialize_completed',
      protocolVersion: PROTOCOL_VERSION,
    });
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
    this.events.emit({
      type: 'session_created',
      sessionId,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      mcpServers: session.mcpServers.length,
    });

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
    const previousMode = session.permissionMode;
    const nextMode = parseSessionMode(params.modeId);
    session.permissionMode = nextMode;
    this.events.emit({
      type: 'session_mode_changed',
      sessionId: session.sessionId,
      from: previousMode,
      to: nextMode,
    });
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
    const promptQueuedAt = Date.now();

    const task = async (): Promise<PromptResponse> => {
      if (abortController.signal.aborted) {
        this.events.emit({
          type: 'prompt_skipped',
          sessionId: session.sessionId,
        });
        return {
          stopReason: 'cancelled',
          userMessageId: params.messageId ?? undefined,
        };
      }

      const promptStartedAt = Date.now();
      this.events.emit({
        type: 'prompt_started',
        sessionId: session.sessionId,
        messageId: params.messageId ?? null,
        chars: promptText.length,
        cwd: session.cwd,
        queueDelayMs: promptStartedAt - promptQueuedAt,
      });
      this.events.emit({
        type: 'prompt_preview',
        sessionId: session.sessionId,
        prompt: promptText,
      });

      try {
        const result = await runKodaX(
          this.buildKodaXOptions(session, abortController.signal),
          promptText,
        );
        session.contextTokenSnapshot = result.contextTokenSnapshot;
        const interrupted = !!result.interrupted;
        const stopReason = abortController.signal.aborted || interrupted ? 'cancelled' : 'end_turn';
        this.events.emit({
          type: 'prompt_finished',
          sessionId: session.sessionId,
          stopReason,
          interrupted,
          durationMs: Date.now() - promptStartedAt,
        });

        return {
          stopReason,
          userMessageId: params.messageId ?? undefined,
          ...(toAcpUsage(result.contextTokenSnapshot) ? { usage: toAcpUsage(result.contextTokenSnapshot) } : {}),
        };
      } catch (error) {
        if (abortController.signal.aborted || isAbortLikeError(error)) {
          this.events.emit({
            type: 'prompt_cancelled',
            sessionId: session.sessionId,
            durationMs: Date.now() - promptStartedAt,
          });
          return {
            stopReason: 'cancelled',
            userMessageId: params.messageId ?? undefined,
          };
        }

        const message = error instanceof Error ? error.message : String(error);
        this.events.emit({
          type: 'prompt_failed',
          sessionId: session.sessionId,
          durationMs: Date.now() - promptStartedAt,
          error: message,
        });
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
    this.events.emit({
      type: 'cancel_requested',
      sessionId: params.sessionId,
      active: !!session?.activeController,
    });
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
        contextTokenSnapshot: session.contextTokenSnapshot,
      },
      events: {
        onTextDelta: (text) => {
          this.dispatchNotification(
            'assistant text chunk',
            session.sessionId,
            this.sendTextChunk(session.sessionId, text),
          );
        },
        onThinkingDelta: (text) => {
          this.dispatchNotification(
            'thinking chunk',
            session.sessionId,
            this.sendSessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text },
              },
            }),
          );
        },
        onToolUseStart: (tool) => {
          this.dispatchNotification(
            'tool call start',
            session.sessionId,
            this.sendSessionUpdate({
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
            }),
          );
        },
        onToolResult: (result) => {
          this.dispatchNotification(
            'tool call update',
            session.sessionId,
            this.sendSessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: result.id,
                title: result.name,
                status: isToolResultFailure(result.content) ? 'failed' : 'completed',
                rawOutput: result.content,
              },
            }),
          );
        },
        onRepoIntelligenceTrace: (event) => {
          this.events.emit({
            type: 'repo_intelligence_trace',
            sessionId: session.sessionId,
            stage: event.stage,
            summary: event.summary,
            mode: event.capability?.mode,
            engine: event.capability?.engine,
            bridge: event.capability?.bridge,
            status: event.capability?.status,
            daemonLatencyMs: event.trace?.daemonLatencyMs,
            cliLatencyMs: event.trace?.cliLatencyMs,
            cacheHit: event.trace?.cacheHit,
            capsuleEstimatedTokens: event.trace?.capsuleEstimatedTokens,
          });
        },
        onError: (error) => {
          this.dispatchNotification(
            'error text chunk',
            session.sessionId,
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
    this.events.emit({
      type: 'tool_permission_evaluated',
      sessionId: session.sessionId,
      tool: toolName,
      toolId: toolId ?? null,
      permissionMode: session.permissionMode,
    });
    if (toolName === 'bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (isBashReadCommand(command)) {
        this.events.emit({
          type: 'tool_permission_resolved',
          sessionId: session.sessionId,
          tool: toolName,
          toolId: toolId ?? null,
          outcome: 'auto_allowed_read_only_bash',
        });
        return { allowed: true };
      }

      if (isToolCallAllowed(toolName, input, session.alwaysAllowTools)) {
        this.events.emit({
          type: 'tool_permission_resolved',
          sessionId: session.sessionId,
          tool: toolName,
          toolId: toolId ?? null,
          outcome: 'auto_allowed_remembered',
        });
        return { allowed: true };
      }
    }

    if (session.permissionMode === 'plan') {
      const blockReason = getPlanModeBlockReason(toolName, input, session.cwd);
      if (blockReason) {
        this.events.emit({
          type: 'tool_permission_resolved',
          sessionId: session.sessionId,
          tool: toolName,
          toolId: toolId ?? null,
          outcome: 'blocked_plan_mode',
        });
        return {
          allowed: false,
          override: `${blockReason} Do not try to modify files while planning. Finish the plan first, then hand off to a writable mode.`,
        };
      }
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolId ?? null,
        outcome: 'auto_allowed_plan_mode',
      });
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
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolId ?? null,
        outcome: 'auto_allowed_policy',
      });
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
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolId ?? null,
        outcome: 'request_failed_disconnected',
      });
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
    this.events.emit({
      type: 'permission_requested',
      sessionId: session.sessionId,
      tool: toolName,
      toolId: toolCall.toolCallId,
    });
    try {
      response = await this.connection.requestPermission({
        sessionId: session.sessionId,
        toolCall,
        options: permissionOptions,
      });
    } catch {
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolCall.toolCallId,
        outcome: 'request_failed_incomplete',
      });
      return {
        allowed: false,
        override: '[Cancelled] ACP client did not complete the permission request. Operation failed closed.',
      };
    }

    if (response.outcome.outcome !== 'selected') {
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolCall.toolCallId,
        outcome: 'request_dismissed',
      });
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
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolCall.toolCallId,
        outcome: 'request_rejected',
      });
      return {
        allowed: false,
        override: '[Cancelled] Operation cancelled by user',
      };
    }

    this.events.emit({
      type: 'tool_permission_resolved',
      sessionId: session.sessionId,
      tool: toolName,
      toolId: toolCall.toolCallId,
      outcome: 'request_granted',
      remember: response.outcome.optionId === 'allow_always',
    });
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

  private dispatchNotification(label: string, sessionId: string, operation: Promise<void>): void {
    void operation.catch((error) => {
      if (!this.connection || this.connection.signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.events.emit({
        type: 'notification_failed',
        sessionId,
        label,
        error: message,
      });
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
