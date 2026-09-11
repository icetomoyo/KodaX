import type { ToolResult } from '../tools/types.js';

export interface HandlerWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

export type HandlerWorkerRequest =
  | {
      readonly kind: 'invoke';
      readonly invocationId: number;
      readonly input: Record<string, unknown>;
      readonly context: Record<string, unknown>;
    }
  | {
      readonly kind: 'abort';
      readonly invocationId: number;
    }
  | {
      readonly kind: 'tool_result';
      readonly callId: number;
      readonly result?: ToolResult;
      readonly error?: HandlerWorkerError;
    };

export type HandlerWorkerResponse =
  | { readonly kind: 'ready' }
  | { readonly kind: 'bootstrap_error'; readonly error: HandlerWorkerError }
  | { readonly kind: 'result'; readonly invocationId: number; readonly result?: ToolResult; readonly error?: HandlerWorkerError }
  | { readonly kind: 'tool_call'; readonly invocationId: number; readonly callId: number; readonly toolName: string; readonly input: unknown };

export interface HandlerWorkerBootstrap {
  readonly moduleUrl: string;
  readonly label: string;
}

export function serializeHandlerWorkerError(error: unknown): HandlerWorkerError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    name: normalized.name,
    message: normalized.message,
    ...(normalized.stack !== undefined ? { stack: normalized.stack } : {}),
    ...('code' in normalized && typeof normalized.code === 'string' ? { code: normalized.code } : {}),
  };
}

/** Script handlers may also return ordinary JSON; preserve that legacy rendering. */
export function normalizeHandlerWorkerResult(result: unknown): ToolResult | undefined {
  if (typeof result === 'string') return result;
  if (Array.isArray(result) && result.length > 0 && result.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    if ('type' in item && item.type === 'text') return 'text' in item && typeof item.text === 'string';
    return 'type' in item && item.type === 'image' && 'path' in item && typeof item.path === 'string'
      && (!('mediaType' in item) || item.mediaType === undefined || typeof item.mediaType === 'string');
  })) return result;
  return JSON.stringify(result);
}
