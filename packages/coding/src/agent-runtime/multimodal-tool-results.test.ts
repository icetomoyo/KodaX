import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardrailContext, ToolGuardrail } from '@kodax-ai/agent';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { executeChildAgents } from '../child-executor.js';
import { executeTool } from '../tools/index.js';
import { applyPostToolProcessing, runToolDispatch } from './tool-dispatch.js';
import { buildRuntimeSessionState } from './runtime-session-state.js';

describe('multimodal tool delivery', () => {
  let directory: string;
  let imagePath: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-image-result-'));
    imagePath = path.join(directory, 'pixel.png');
    await fs.writeFile(imagePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64'));
  });
  afterEach(async () => {
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('delivers a child PNG read to the next provider request without network access', async () => {
    vi.stubEnv('KODAX_IMAGE_TEST_KEY', 'test-only');
    const expected = await executeTool('read', { path: imagePath }, { executionCwd: directory, backups: new Map() });
    let delivered = false;
    class ImageProvider extends KodaXBaseProvider {
      readonly name = 'image-test-provider';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'KODAX_IMAGE_TEST_KEY', model: 'image-test-model', supportsThinking: false,
      };
      async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
        const results = messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content)
          .filter((block) => block.type === 'tool_result');
        if (results.length === 0) return { textBlocks: [], thinkingBlocks: [], toolBlocks: [
          { type: 'tool_use', id: 'child-image', name: 'read', input: { path: imagePath } },
        ] };
        expect(results.at(-1)?.content).toEqual(expected);
        delivered = true;
        return { textBlocks: [{ type: 'text', text: 'Image inspected.' }], toolBlocks: [], thinkingBlocks: [] };
      }
    }
    registerModelProvider('image-test-provider', () => new ImageProvider());
    const result = await executeChildAgents([{
      id: 'image-child', fanoutClass: 'evidence-scan', objective: 'Read the image.',
      evidenceRefs: [], constraints: [], readOnly: true,
    }], { executionCwd: directory, backups: new Map() }, {
      maxParallel: 1, maxIterationsPerChild: 2, parentRole: 'worker', parentHarness: 'tool-dispatch',
      parentOptions: { provider: 'image-test-provider', model: 'image-test-model', repoIntelligenceMode: 'off' },
    });
    expect(delivered).toBe(true);
    expect(result.results[0]).toMatchObject({ status: 'completed', summary: 'Image inspected.' });
  });

  it.each(['read', 'tool_call'])('delivers real PNG blocks through %s, allowing guardrails and post-processing', async (name) => {
    const ctx = { executionCwd: directory, backups: new Map() };
    const expected = await executeTool('read', { path: imagePath }, ctx);
    expect(expected).toEqual([expect.objectContaining({ type: 'text' }), { type: 'image', path: imagePath, mediaType: 'image/png' }]);
    const toolBlocks: KodaXToolUseBlock[] = [{ type: 'tool_use', id: 'image-read', name,
      input: name === 'read' ? { path: imagePath } : { name: 'read', input: { path: imagePath } } }];
    const runtimeSessionState = buildRuntimeSessionState({ activeTools: ['read', 'tool_call'], modelSelection: {} });
    const afterTool = vi.fn<NonNullable<ToolGuardrail['afterTool']>>().mockResolvedValue({ action: 'allow' });
    const onToolResult = vi.fn();
    const events = { onToolResult };
    const resultMap = await runToolDispatch({ toolBlocks, events, ctx, runtimeSessionState,
      activeToolNames: ['read', 'tool_call'], abortSignal: undefined,
      toolGuardrails: [{ kind: 'tool', name: 'allow', afterTool }], guardrailContext: {} as GuardrailContext });
    expect(resultMap.get('image-read')).toEqual(expected);
    expect(afterTool.mock.calls[0]?.[1].content).toEqual(expected);
    const processed = await applyPostToolProcessing({ toolBlocks, resultMap, events, ctx,
      runtimeSessionState, emitActiveExtensionEvent: vi.fn() });
    expect(processed.toolResults[0]?.content).toEqual(expected);
    expect(processed.toolResults[0]?.is_error).toBeUndefined();
    expect(runtimeSessionState.lastToolErrorCode).toBeUndefined();
    expect(runtimeSessionState.lastToolResultBytes).toBeGreaterThan(0);
    expect(onToolResult).toHaveBeenCalled();
    expect(onToolResult.mock.calls[0]?.[0].content).not.toContain('[object Object]');
  });
});
