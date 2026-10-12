import { describe, expect, it, vi } from 'vitest';
import type { KodaXExtensionAPI } from '@kodax-ai/kodax/coding';
import { registerArtifactTools } from './kodax.js';

describe('KodaX artifact managed adapter', () => {
 it('requires admitted scope and uses checked write/process/read for actual raster delivery', async () => {
  const tools: Parameters<KodaXExtensionAPI['registerTool']>[0][] = [];
  let scope: ReturnType<KodaXExtensionAPI['getExecutionScope']>;
  const invokeTool = vi.fn(async (name: string) => name === 'read' ? [{ type: 'image' as const, path: '/work/slide.png' }] : 'ok');
  const execute = vi.fn(async () => 'Command: worker\nExit: 0\nARTIFACT_RESULT:' + JSON.stringify({ status: 'ready', diagnostics: [], evidence: {
   kind: 'paginated', sourceHash: 'a'.repeat(64), scope: { pages: [1] }, diagnostics: [],
   evidence: [{ path: '/work/slide.png', sha256: 'b'.repeat(64), mediaType: 'image/png', locator: { kind: 'paginated', page: 1 } }],
  } }));
  const api = { registerTool: (tool: typeof tools[number]) => { tools.push(tool); return () => undefined; },
   getExecutionScope: () => scope, registerSkillPath: () => () => undefined } as unknown as KodaXExtensionAPI;
  registerArtifactTools(api, { execute, nodeExecutable: process.execPath });
  const render = tools.find(tool => tool.name === 'artifact_render')!;
  expect(render.sideEffect).toBe('mutates-shell'); expect(render.interruptBehavior).toBe('cancel');
  const context = { backups: new Map(), executionCwd: '/work' };
  await expect(render.handler({ path: 'deck.pptx', pages: [1] }, context)).rejects.toThrow(/scope/i);
  expect(execute).not.toHaveBeenCalled();
  scope = { version: 1, sessionId: 's', runId: 'r', invocationId: 'i', extensionId: 'a', signal: new AbortController().signal,
   invokeTool, reportProgress: () => undefined };
  const result = await render.handler({ path: 'deck.pptx', pages: [1] }, context);
  expect(invokeTool.mock.calls.map(call => call[0])).toEqual(['write', 'read']);
  expect(execute).toHaveBeenCalledWith(scope, expect.objectContaining({ executable: process.execPath, args: expect.any(Array) }));
  expect(result).toContainEqual({ type: 'image', path: '/work/slide.png' });
 });
});
