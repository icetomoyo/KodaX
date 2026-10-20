import type { RunnerToolCall } from '@kodax-ai/agent';
import type { LocalToolDefinition, ToolHandlerSync } from './types.js';

export const TOOL_DESCRIBE_NAME = 'tool_describe';
export const TOOL_CALL_NAME = 'tool_call';

export type ToolBridgeTargetResolution =
  | { readonly ok: true; readonly call: RunnerToolCall }
  | { readonly ok: false; readonly error: string };

/** Resolve the exact concrete call that a portable tool_call will dispatch. */
export function resolveToolBridgeTarget(
  call: {
    readonly id: string;
    readonly name: string;
    readonly input?: Record<string, unknown>;
  },
): ToolBridgeTargetResolution | undefined {
  if (call.name !== TOOL_CALL_NAME) return undefined;
  const input = call.input ?? {};
  const name = typeof input.name === 'string'
    ? input.name.trim()
    : typeof input.tool_name === 'string'
      ? input.tool_name.trim()
      : '';
  if (name.length === 0) return { ok: false, error: '`name` is required.' };
  const targetInput = input.input ?? input.arguments;
  if (!targetInput || typeof targetInput !== 'object' || Array.isArray(targetInput)) {
    return { ok: false, error: '`input` must be a JSON object.' };
  }
  return {
    ok: true,
    call: {
      id: `${call.id}:${name}`,
      name,
      input: targetInput as Record<string, unknown>,
    },
  };
}

const bridgeDispatchUnavailable: ToolHandlerSync = async (_input, _context) => (
  '[Tool Error] tool bridge dispatch is unavailable outside the agent runtime.'
);

export const TOOL_DESCRIBE_DEFINITION: LocalToolDefinition = {
  name: TOOL_DESCRIBE_NAME,
  description:
    'Return the full description and input schema for active tools. Compatibility entry; tool_search query="select:NAME[,NAME...]" also returns full contracts without a second lookup.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the active tool to describe.',
      },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of active tool names to describe. Capped by the runtime.',
      },
    },
  },
  handler: bridgeDispatchUnavailable,
  sideEffect: 'readonly',
  planModeAllowed: true,
  toClassifierInput: () => '',
};

export const TOOL_CALL_DEFINITION: LocalToolDefinition = {
  name: TOOL_CALL_NAME,
  description:
    'Call one active tool through the portable bridge after discovering or describing it. The runtime re-applies the target tool policy, permission checks, and result guardrails.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the active target tool to call.',
      },
      input: {
        type: 'object',
        description: 'JSON object passed as the target tool input.',
      },
    },
    required: ['name', 'input'],
  },
  handler: bridgeDispatchUnavailable,
  sideEffect: 'mutates-state',
  planModeAllowed: true,
  toClassifierInput: (input) => {
    const record = input && typeof input === 'object'
      ? input as { name?: unknown }
      : {};
    return `ToolBridgeCall: ${typeof record.name === 'string' ? record.name : '<missing-name>'}`;
  },
};
