import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { runKodaX } from './agent.js';
import { runManagedTaskViaRunner } from './task-engine/runner-driven.js';
import { buildFallbackRoutingDecision } from './reasoning.js';
import type { KodaXOptions } from './types.js';

// Real run entries + real provider serialization: every request of a conversation names it.
let root: string;
let sessionHeaders: (string | null)[];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kodax-session-header-'));
  sessionHeaders = [];
  vi.stubEnv('KODAX_SESSION_HEADER_KEY', 'offline-fixture');
  vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    sessionHeaders.push(new Headers(init?.headers).get('x-session-id'));
    const chunks = [
      { id: 'offline', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Checked.' }, finish_reason: null }] },
      { id: 'offline', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  registerCustomProviders([{ name: 'session-header-wire', protocol: 'openai', model: 'fixture',
    baseUrl: 'https://session-header.invalid', apiKeyEnv: 'KODAX_SESSION_HEADER_KEY', maxOutputTokens: 2048 }]);
});

afterEach(async () => {
  registerCustomProviders([]); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function options(overrides: Partial<KodaXOptions> = {}): KodaXOptions {
  return {
    provider: 'session-header-wire', reasoningMode: 'off', effort: 'none', lsp: false, maxIter: 2,
    ...overrides,
    context: { gitRoot: root, executionCwd: root, managedTaskWorkspaceDir: root, configHome: root,
      repoIntelligenceMode: 'off', ...overrides.context },
  };
}

it('sends the session id on every request of a direct run', async () => {
  const result = await runKodaX(options({ session: { id: 'root-conversation-1' } }), 'Inspect the behavior.');
  expect(result.success, result.lastText).toBe(true);
  expect(sessionHeaders.length).toBeGreaterThan(0);
  expect(new Set(sessionHeaders)).toEqual(new Set(['root-conversation-1']));
});

it('sends the generated id of a new conversation', async () => {
  const result = await runKodaX(options(), 'Inspect the behavior.');
  expect(result.success, result.lastText).toBe(true);
  expect(new Set(sessionHeaders)).toEqual(new Set([result.sessionId]));
});

it('sends the root conversation id from a child agent run', async () => {
  const result = await runKodaX(options({ session: { id: 'worker-child-1' },
    context: { contextIdentitySessionId: 'root-conversation-1' } }), 'Inspect the behavior.');
  expect(result.success, result.lastText).toBe(true);
  expect(new Set(sessionHeaders)).toEqual(new Set(['root-conversation-1']));
});

it('sends the session id on every request of a managed run', async () => {
  const prompt = 'Inspect the behavior.';
  const result = await runManagedTaskViaRunner(options({ session: { id: 'root-conversation-2' } }), prompt, undefined,
    { effort: 'medium', decision: buildFallbackRoutingDecision(prompt), promptOverlay: '' });
  expect(result.success, result.lastText).toBe(true);
  expect(sessionHeaders.length).toBeGreaterThan(0);
  expect(new Set(sessionHeaders)).toEqual(new Set(['root-conversation-2']));
});
