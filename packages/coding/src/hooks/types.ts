/**
 * KodaX Hook System Types
 *
 * Configurable automation hooks for tool and session lifecycle events.
 */

export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Compact'
  | 'PromptSubmit'
  | 'Stop';

export type HookAction = 'allow' | 'deny' | 'pass';

export interface HookResult {
  readonly action: HookAction;
  readonly reason?: string;
  readonly modifiedInput?: Readonly<Record<string, unknown>>;
}

export interface CommandHook {
  readonly type: 'command';
  readonly matcher?: string;
  readonly command: string;
  readonly timeout?: number;
  readonly shell?: 'bash' | 'powershell';
}

export interface HttpHook {
  readonly type: 'http';
  readonly url: string;
  readonly method?: 'POST' | 'PUT';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeout?: number;
}

export interface PromptHook {
  readonly type: 'prompt';
  readonly prompt: string;
  readonly model?: string;
  readonly timeout?: number;
}

export type HookDefinition = CommandHook | HttpHook | PromptHook;

export interface HookConfig {
  readonly hooks: Readonly<Partial<Record<HookEventType, readonly HookDefinition[]>>>;
}

export interface HookEventContext {
  readonly eventType: HookEventType;
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly toolOutput?: string;
  readonly sessionId?: string;
  readonly workingDir?: string;
}
