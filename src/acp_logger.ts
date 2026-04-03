import process from 'node:process';
import type { AcpEventSink, AcpRuntimeEvent } from './acp_events.js';

export const ACP_LOG_LEVELS = ['off', 'error', 'info', 'debug'] as const;
export type AcpLogLevel = (typeof ACP_LOG_LEVELS)[number];

const ACP_LOG_LEVEL_RANK: Record<AcpLogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};

export function resolveAcpLogLevel(
  value: string | undefined,
  fallback: AcpLogLevel = 'info',
): AcpLogLevel {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (ACP_LOG_LEVELS.includes(normalized as AcpLogLevel)) {
    return normalized as AcpLogLevel;
  }

  return fallback;
}

export interface AcpLoggerOptions {
  level?: AcpLogLevel;
  sink?: (line: string) => void;
}

type AcpLogFields = Record<string, string | number | boolean | null | undefined>;

export class AcpLogger implements AcpEventSink {
  private readonly level: AcpLogLevel;
  private readonly sink: (line: string) => void;

  constructor(options: AcpLoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? ((line) => {
      process.stderr.write(`${line}\n`);
    });
  }

  handleEvent(event: AcpRuntimeEvent): void {
    const entry = mapEventToLogEntry(event);
    if (!entry) {
      return;
    }
    this.log(entry.level, entry.message, entry.fields);
  }

  error(message: string, fields?: AcpLogFields): void {
    this.log('error', message, fields);
  }

  info(message: string, fields?: AcpLogFields): void {
    this.log('info', message, fields);
  }

  debug(message: string, fields?: AcpLogFields): void {
    this.log('debug', message, fields);
  }

  private log(level: Exclude<AcpLogLevel, 'off'>, message: string, fields?: AcpLogFields): void {
    if (ACP_LOG_LEVEL_RANK[this.level] < ACP_LOG_LEVEL_RANK[level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const renderedFields = fields ? formatFields(fields) : '';
    const suffix = renderedFields ? ` ${renderedFields}` : '';
    this.sink(`[ACP][${level.toUpperCase()}][${timestamp}] ${message}${suffix}`);
  }
}

interface AcpLogEntry {
  level: Exclude<AcpLogLevel, 'off'>;
  message: string;
  fields?: AcpLogFields;
}

function mapEventToLogEntry(event: AcpRuntimeEvent): AcpLogEntry | null {
  switch (event.type) {
    case 'server_attached':
      return {
        level: 'info',
        message: 'ACP server attached',
        fields: toLogFields(event),
      };
    case 'connection_closed':
      return {
        level: 'info',
        message: 'ACP connection closed',
        fields: toLogFields(event),
      };
    case 'initialize_completed':
      return {
        level: 'info',
        message: 'ACP initialize completed',
        fields: toLogFields(event),
      };
    case 'session_created':
      return {
        level: 'info',
        message: 'ACP session created',
        fields: toLogFields(event),
      };
    case 'session_mode_changed':
      return {
        level: 'info',
        message: 'ACP session mode changed',
        fields: toLogFields(event),
      };
    case 'prompt_skipped':
      return {
        level: 'info',
        message: 'ACP prompt skipped because session was already aborted',
        fields: toLogFields(event),
      };
    case 'prompt_started':
      return {
        level: 'info',
        message: 'ACP prompt started',
        fields: toLogFields(event),
      };
    case 'prompt_preview':
      return {
        level: 'debug',
        message: 'ACP prompt preview',
        fields: toLogFields(event),
      };
    case 'prompt_finished':
      return {
        level: 'info',
        message: 'ACP prompt finished',
        fields: toLogFields(event),
      };
    case 'prompt_cancelled':
      return {
        level: 'info',
        message: 'ACP prompt cancelled during execution',
        fields: toLogFields(event),
      };
    case 'prompt_failed':
      return {
        level: 'error',
        message: 'ACP prompt failed',
        fields: toLogFields(event),
      };
    case 'cancel_requested':
      return {
        level: 'info',
        message: 'ACP cancel requested',
        fields: toLogFields(event),
      };
    case 'tool_permission_evaluated':
      return {
        level: 'debug',
        message: 'ACP evaluating tool permission',
        fields: toLogFields(event),
      };
    case 'tool_permission_resolved':
      return mapPermissionOutcomeToLogEntry(event);
    case 'permission_requested':
      return {
        level: 'info',
        message: 'ACP permission requested',
        fields: toLogFields(event),
      };
    case 'notification_failed':
      return {
        level: 'error',
        message: `Failed to send ${event.label}`,
        fields: {
          sessionId: event.sessionId,
          error: event.error,
        },
      };
    case 'repo_intelligence_trace':
      return {
        level: 'debug',
        message: 'ACP repo intelligence trace',
        fields: toLogFields(event),
      };
    default:
      return null;
  }
}

function toLogFields(event: AcpRuntimeEvent): AcpLogFields {
  const { type, ...fields } = event;
  return fields;
}

function mapPermissionOutcomeToLogEntry(
  event: Extract<AcpRuntimeEvent, { type: 'tool_permission_resolved' }>,
): AcpLogEntry {
  const baseFields: AcpLogFields = {
    sessionId: event.sessionId,
    tool: event.tool,
    toolId: event.toolId,
  };

  switch (event.outcome) {
    case 'auto_allowed_read_only_bash':
      return {
        level: 'debug',
        message: 'ACP tool permission auto-allowed for read-only bash',
        fields: baseFields,
      };
    case 'auto_allowed_remembered':
      return {
        level: 'info',
        message: 'ACP tool permission reused remembered allowance',
        fields: baseFields,
      };
    case 'blocked_plan_mode':
      return {
        level: 'info',
        message: 'ACP tool blocked by plan mode',
        fields: baseFields,
      };
    case 'auto_allowed_plan_mode':
      return {
        level: 'debug',
        message: 'ACP tool auto-allowed in plan mode',
        fields: baseFields,
      };
    case 'auto_allowed_policy':
      return {
        level: 'debug',
        message: 'ACP tool auto-allowed by permission policy',
        fields: baseFields,
      };
    case 'request_failed_disconnected':
      return {
        level: 'error',
        message: 'ACP permission request failed because client is disconnected',
        fields: baseFields,
      };
    case 'request_failed_incomplete':
      return {
        level: 'error',
        message: 'ACP permission request did not complete',
        fields: baseFields,
      };
    case 'request_dismissed':
      return {
        level: 'info',
        message: 'ACP permission request dismissed',
        fields: baseFields,
      };
    case 'request_rejected':
      return {
        level: 'info',
        message: 'ACP permission rejected',
        fields: baseFields,
      };
    case 'request_granted':
      return {
        level: 'info',
        message: 'ACP permission granted',
        fields: {
          ...baseFields,
          remember: event.remember ?? false,
        },
      };
  }
}

function formatFields(fields: AcpLogFields): string {
  return Object.entries(fields)
    .flatMap(([key, value]) => {
      if (value === undefined) {
        return [];
      }
      return `${key}=${formatFieldValue(value)}`;
    })
    .join(' ');
}

function formatFieldValue(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value.length > 160 ? `${value.slice(0, 157)}...` : value);
  }

  return String(value);
}
