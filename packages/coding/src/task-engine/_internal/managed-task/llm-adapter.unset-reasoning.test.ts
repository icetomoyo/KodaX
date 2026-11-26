import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runManagedTaskViaRunner } from '../../runner-driven.js';
import { buildFallbackRoutingDecision } from '../../../reasoning.js';
import type { KodaXOptions } from '../../../types.js';

interface WireRequest {
  readonly thinking?: { readonly type: string };
  readonly output_config?: { readonly effort?: string };
}

const SSE = [
  ['message_start', { type: 'message_start', message: { id: 'offline', type: 'message', role: 'assistant',
    content: [], model: 'k3.1-pro', usage: { input_tokens: 1, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`).join('');

function captureRequests(): WireRequest[] {
  const requests: WireRequest[] = [];
  vi.stubEnv('KIMI_CODE_API_KEY', 'offline-fixture');
  vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as WireRequest);
    return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

// k3.1-pro always thinks; it cannot turn thinking off. k3-256k can.
async function runWith(reasoning: Partial<KodaXOptions>, model = 'k3.1-pro'): Promise<{ success: boolean; text: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-unset-reasoning-'));
  try {
    const prompt = 'Say done.';
    const result = await runManagedTaskViaRunner({
      provider: 'kimi-code', model, lsp: false, maxIter: 2, ...reasoning,
      context: { gitRoot: root, executionCwd: root, managedTaskWorkspaceDir: root, configHome: root,
        repoIntelligenceMode: 'off' },
    }, prompt, undefined, { decision: buildFallbackRoutingDecision(prompt), promptOverlay: '' });
    return { success: result.success, text: result.lastText };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

it('runs an always-thinking model at its default effort when the caller sets no reasoning', async () => {
  const requests = captureRequests();
  const result = await runWith({});
  expect(result.success, result.text).toBe(true);
  expect(requests[0]?.thinking?.type).toBe('enabled');
  expect(requests[0]?.output_config?.effort).toBe('max');
});

it('still refuses an explicit request to turn thinking off on an always-thinking model', async () => {
  const requests = captureRequests();
  await expect(runWith({ reasoningMode: 'off' })).rejects.toThrow('does not support reasoning effort "none"');
  expect(requests).toHaveLength(0);
});

it('keeps thinking off by default on a model that can turn it off', async () => {
  const requests = captureRequests();
  const result = await runWith({}, 'k3-256k');
  expect(result.success, result.text).toBe(true);
  expect(requests[0]?.thinking?.type).toBe('disabled');
});
