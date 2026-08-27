import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  KodaXEvents,
  KodaXToolExecutionContext,
} from '../../types.js';
import {
  registerTool,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
} from '../../tools/index.js';
import {
  applyPostToolProcessing,
  executeToolCall,
  runToolDispatch,
} from '../tool-dispatch.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import type { RunnableToolCall } from '../middleware/edit-recovery.js';
import { TOOL_OUTPUT_DIR_ENV } from '../../tools/truncate.js';
import {
  createTransientTextArtifact,
  deleteTransientTextArtifact,
} from '../../transient-text-artifacts.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: [TOOL_DESCRIBE_NAME, TOOL_CALL_NAME],
    modelSelection: {},
  });
}

function makeCtx(): KodaXToolExecutionContext {
  return { backups: new Map() };
}

function makeToolCall(
  name: string,
  input: Record<string, unknown> = {},
): RunnableToolCall {
  return { id: 't1', name, input } as RunnableToolCall;
}

describe('FEATURE_254 portable bridge dispatch', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bridge-dispatch-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  it('tool_describe returns schema only for active tools', async () => {
    const unregister = registerTool({
      name: 'bridge_describe_target',
      description: 'test-only bridge description target',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
      sideEffect: 'readonly',
      handler: async () => 'ok',
    });

    try {
      const result = await executeToolCall(
        {} as KodaXEvents,
        makeToolCall(TOOL_DESCRIBE_NAME, {
          names: ['bridge_describe_target', 'inactive_bridge_target'],
        }),
        makeCtx(),
        freshState(),
        [TOOL_DESCRIBE_NAME, 'bridge_describe_target'],
      );

      expect(result).toContain('<function>');
      expect(result).toContain('"name":"bridge_describe_target"');
      expect(result).toContain('inactive_bridge_target: not active');
      expect(result).not.toContain('"name":"inactive_bridge_target"');
    } finally {
      unregister();
    }
  });

  it('tool_describe preserves every requested active schema without character caps', async () => {
    const unregister = Array.from({ length: 9 }, (_, index) => registerTool({
      name: `bridge_full_schema_${index}`,
      description: index === 8
        ? `large-start-${'detail '.repeat(2_400)}large-end`
        : `schema ${index}`,
      input_schema: { type: 'object', properties: {} },
      sideEffect: 'readonly',
      handler: async () => 'ok',
    }));
    const names = Array.from({ length: 9 }, (_, index) => `bridge_full_schema_${index}`);

    try {
      const result = await executeToolCall(
        {} as KodaXEvents,
        makeToolCall(TOOL_DESCRIBE_NAME, { names }),
        makeCtx(),
        freshState(),
        [TOOL_DESCRIBE_NAME, ...names],
      );

      expect(result).toContain('"name":"bridge_full_schema_8"');
      expect(result).toContain('large-start-');
      expect(result).toContain('large-end');
      expect(result).not.toContain('tool_describe output truncated');
    } finally {
      unregister.reverse().forEach((dispose) => dispose());
    }
  });

  it('tool_call executes an active target through the target permission gate', async () => {
    const unregister = registerTool({
      name: 'bridge_call_target',
      description: 'test-only bridge call target',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
      sideEffect: 'readonly',
      handler: async (input, ctx) => `target:${String(input.value)}:${ctx.toolCallId ?? 'missing'}`,
    });
    const permissionNames: string[] = [];
    const events: KodaXEvents = {
      beforeToolExecute: async (name) => {
        permissionNames.push(name);
        return undefined;
      },
    };

    try {
      const result = await executeToolCall(
        events,
        makeToolCall(TOOL_CALL_NAME, {
          name: 'bridge_call_target',
          input: { value: 'ok' },
        }),
        makeCtx(),
        freshState(),
        [TOOL_CALL_NAME, 'bridge_call_target'],
      );

      expect(result).toContain('target:ok:t1:bridge_call_target');
      expect(permissionNames).toEqual(['bridge_call_target']);
    } finally {
      unregister();
    }
  });

  it('tool_describe stays read-only without opening a permission request', async () => {
    const permissionNames: string[] = [];
    const result = await executeToolCall(
      {
        beforeToolExecute: async (name) => {
          permissionNames.push(name);
          return undefined;
        },
      },
      makeToolCall(TOOL_DESCRIBE_NAME, { name: TOOL_CALL_NAME }),
      makeCtx(),
      freshState(),
      [TOOL_DESCRIBE_NAME, TOOL_CALL_NAME],
    );

    expect(result).toContain(TOOL_CALL_NAME);
    expect(permissionNames).toEqual([]);
  });

  it('tool_call rejects inactive targets without invoking their handler', async () => {
    let invoked = false;
    const unregister = registerTool({
      name: 'bridge_inactive_target',
      description: 'test-only inactive bridge target',
      input_schema: { type: 'object', properties: {} },
      sideEffect: 'readonly',
      handler: async () => {
        invoked = true;
        return 'should-not-run';
      },
    });

    try {
      const result = await executeToolCall(
        {} as KodaXEvents,
        makeToolCall(TOOL_CALL_NAME, {
          name: 'bridge_inactive_target',
          input: {},
        }),
        makeCtx(),
        freshState(),
        [TOOL_CALL_NAME],
      );

      expect(result).toBe('[Tool Error] bridge_inactive_target: Tool is not active in the current runtime.');
      expect(invoked).toBe(false);
    } finally {
      unregister();
    }
  });

  it('tool_call forwards the raw target result to the one batch capacity owner', async () => {
    const raw = Array.from({ length: 5_000 }, (_, index) => `bridge-evidence-${index}`).join('\n');
    const unregister = registerTool({
      name: 'bridge_large_target',
      description: 'test-only large bridge target',
      input_schema: { type: 'object', properties: {} },
      sideEffect: 'readonly',
      handler: async () => raw,
    });

    try {
      const toolBlocks = [{
        id: 'bridge',
        name: TOOL_CALL_NAME,
        type: 'tool_use',
        input: { name: 'bridge_large_target', input: {} },
      } as never];
      const executionContext = makeCtx();
      const runtimeSessionState = freshState();
      const toolResultBudget = {
        aggregateInlineTokens: 1_200,
      };
      const resultMap = await runToolDispatch({
        toolBlocks,
        events: {} as KodaXEvents,
        ctx: executionContext,
        runtimeSessionState,
        activeToolNames: [TOOL_CALL_NAME, 'bridge_large_target'],
        abortSignal: undefined,
      });
      const processed = await applyPostToolProcessing({
        toolBlocks,
        resultMap,
        events: {} as KodaXEvents,
        emitActiveExtensionEvent: async () => undefined,
        ctx: executionContext,
        runtimeSessionState,
        toolResultBudget,
      });

      const result = processed.toolResults[0]?.content ?? '';
      expect((result.match(/Full output saved to:/g) ?? [])).toHaveLength(1);
      expect(await fs.readdir(tempDir)).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  it('mirrors transient read provenance to the visible bridge call without spilling', async () => {
    const capability = createTransientTextArtifact('private input\n'.repeat(4_000));
    const artifactPaths = new Map<string, string>();
    const executionContext: KodaXToolExecutionContext = {
      backups: new Map(),
      recordToolResultArtifact: (toolCallId, outputPath) => {
        artifactPaths.set(toolCallId, outputPath);
      },
    };
    const toolBlocks = [{
      id: 'bridge-read',
      name: TOOL_CALL_NAME,
      type: 'tool_use',
      input: { name: 'read', input: { path: capability, limit: 2_000 } },
    } as never];

    try {
      const runtimeSessionState = freshState();
      const resultMap = await runToolDispatch({
        toolBlocks,
        events: {} as KodaXEvents,
        ctx: executionContext,
        runtimeSessionState,
        activeToolNames: [TOOL_CALL_NAME, 'read'],
        abortSignal: undefined,
      });
      const processed = await applyPostToolProcessing({
        toolBlocks,
        resultMap,
        events: {} as KodaXEvents,
        emitActiveExtensionEvent: async () => undefined,
        ctx: executionContext,
        runtimeSessionState,
        toolResultBudget: { aggregateInlineTokens: 100 },
        toolResultArtifactPaths: artifactPaths,
      });

      expect(artifactPaths.get('bridge-read')).toBe(capability);
      expect(processed.toolResults[0]?.metadata?.outputPath).toBe(capability);
      expect(await fs.readdir(tempDir)).toEqual([]);
    } finally {
      deleteTransientTextArtifact(capability);
    }
  });

  it('executeToolCall does not apply a bridge-local capacity guard', async () => {
    const raw = Array.from({ length: 5_000 }, (_, index) => `raw-bridge-evidence-${index}`).join('\n');
    const unregister = registerTool({
      name: 'bridge_raw_target',
      description: 'test-only raw bridge target',
      input_schema: { type: 'object', properties: {} },
      sideEffect: 'readonly',
      handler: async () => raw,
    });

    try {
      const result = await executeToolCall(
        {} as KodaXEvents,
        makeToolCall(TOOL_CALL_NAME, { name: 'bridge_raw_target', input: {} }),
        makeCtx(),
        freshState(),
        [TOOL_CALL_NAME, 'bridge_raw_target'],
        undefined,
      );

      expect(result).toBe(raw);
      expect(await fs.readdir(tempDir)).toEqual([]);
    } finally {
      unregister();
    }
  });
});
