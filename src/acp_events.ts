export type AcpRuntimeEvent =
  | {
    type: 'server_attached';
    agent: string;
    version: string;
    provider: string;
    model: string;
    cwd: string;
    permissionMode: string;
    reasoningMode: string;
    thinking: boolean;
    fixedCwd: boolean;
  }
  | {
    type: 'connection_closed';
    activeSessions: number;
  }
  | {
    type: 'initialize_completed';
    protocolVersion: number;
  }
  | {
    type: 'session_created';
    sessionId: string;
    cwd: string;
    permissionMode: string;
    mcpServers: number;
  }
  | {
    type: 'session_mode_changed';
    sessionId: string;
    from: string;
    to: string;
  }
  | {
    type: 'prompt_skipped';
    sessionId: string;
  }
  | {
    type: 'prompt_started';
    sessionId: string;
    messageId: string | null;
    chars: number;
    cwd: string;
    queueDelayMs: number;
  }
  | {
    type: 'prompt_preview';
    sessionId: string;
    prompt: string;
  }
  | {
    type: 'prompt_finished';
    sessionId: string;
    stopReason: 'cancelled' | 'end_turn';
    interrupted: boolean;
    durationMs: number;
  }
  | {
    type: 'prompt_cancelled';
    sessionId: string;
    durationMs: number;
  }
  | {
    type: 'prompt_failed';
    sessionId: string;
    durationMs: number;
    error: string;
  }
  | {
    type: 'cancel_requested';
    sessionId: string;
    active: boolean;
  }
  | {
    type: 'tool_permission_evaluated';
    sessionId: string;
    tool: string;
    toolId: string | null;
    permissionMode: string;
  }
  | {
    type: 'tool_permission_resolved';
    sessionId: string;
    tool: string;
    toolId: string | null;
    outcome:
      | 'auto_allowed_read_only_bash'
      | 'auto_allowed_remembered'
      | 'blocked_plan_mode'
      | 'auto_allowed_plan_mode'
      | 'auto_allowed_policy'
      | 'request_failed_disconnected'
      | 'request_failed_incomplete'
      | 'request_dismissed'
      | 'request_rejected'
      | 'request_granted';
    remember?: boolean;
  }
  | {
    type: 'permission_requested';
    sessionId: string;
    tool: string;
    toolId: string;
  }
  | {
    type: 'notification_failed';
    sessionId: string;
    label: string;
    error: string;
  }
  | {
    type: 'repo_intelligence_trace';
    sessionId: string;
    stage: 'routing' | 'preturn' | 'module' | 'impact' | 'task-snapshot';
    summary: string;
    mode?: string;
    engine?: string;
    bridge?: string;
    status?: string;
    daemonLatencyMs?: number;
    cliLatencyMs?: number;
    cacheHit?: boolean;
    capsuleEstimatedTokens?: number;
  };

export interface AcpEventSink {
  handleEvent(event: AcpRuntimeEvent): void;
}

export interface AcpEventEmitterOptions {
  sinks?: AcpEventSink[];
}

export class AcpEventEmitter {
  private readonly sinks: AcpEventSink[];

  constructor(options: AcpEventEmitterOptions = {}) {
    this.sinks = [...(options.sinks ?? [])];
  }

  emit(event: AcpRuntimeEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.handleEvent(event);
      } catch {
        // Observability sinks must never break the ACP protocol flow.
      }
    }
  }
}
