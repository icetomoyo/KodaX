import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerCustomProviders } from '@kodax-ai/llm';
import { runManagedTaskViaRunner } from '../../runner-driven.js';
import { buildFallbackRoutingDecision } from '../../../reasoning.js';
import type { KodaXOptions } from '../../../types.js';

interface WireRequest {
  readonly tools: unknown;
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}

// Exercise real runner retention and provider serialization, without measuring API cache hits.
it('preserves the serialized provider prefix and appends changed facts across actual Runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-run-boundary-wire-'));
  const requests: WireRequest[] = [];
  vi.stubEnv('KODAX_RUN_BOUNDARY_KEY', 'offline-fixture');
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(url instanceof Request ? url.url : String(url)).hostname).toBe('run-boundary.invalid');
    requests.push(JSON.parse(String(init?.body)) as WireRequest);
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
  registerCustomProviders([{ name: 'run-boundary-wire', protocol: 'openai', model: 'fixture',
    baseUrl: 'https://run-boundary.invalid', apiKeyEnv: 'KODAX_RUN_BOUNDARY_KEY', maxOutputTokens: 2048 }]);
  try {
    const managedContextRetention = {};
    const options: KodaXOptions = {
      provider: 'run-boundary-wire', reasoningMode: 'off', effort: 'none', lsp: false, maxIter: 2,
      session: { id: 'run-boundary-wire', managedContextRetention },
      context: { gitRoot: root, executionCwd: root, managedTaskWorkspaceDir: root, configHome: root,
        repoIntelligenceMode: 'off', skillsPrompt: '## Available Skills\n- alpha-before-boundary' },
    };
    const run = (settings: KodaXOptions, prompt: string) => runManagedTaskViaRunner(settings, prompt, undefined,
      { effort: 'medium', decision: buildFallbackRoutingDecision(prompt), promptOverlay: '' });
    const first = await run(options, 'Inspect the current behavior.');
    expect(first.success, first.lastText).toBe(true);
    const second = await run({ ...options,
      session: { ...options.session, initialMessages: first.messages },
      context: { ...options.context, skillsPrompt: '## Available Skills\n- beta-after-boundary' },
    }, 'Now inspect the updated behavior.');
    expect(second.success, second.lastText).toBe(true);
    expect(requests).toHaveLength(2);
    const [before, after] = requests as [WireRequest, WireRequest];
    expect(after.tools).toEqual(before.tools);
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(JSON.stringify(before.messages)).toContain('alpha-before-boundary');
    expect(JSON.stringify(before.messages)).not.toContain('beta-after-boundary');
    const appended = JSON.stringify(after.messages.slice(before.messages.length));
    expect(appended).toContain('Checked.');
    expect(appended).toContain('Context update for this task.');
    expect(appended).toContain('beta-after-boundary');
    expect(appended).not.toContain('alpha-before-boundary');
    expect(appended).toContain('Now inspect the updated behavior.');
  } finally {
    registerCustomProviders([]); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
