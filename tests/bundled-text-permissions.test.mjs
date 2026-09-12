import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runKodaX, runManagedTask } from '../dist/index.js';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders } from '../dist/sdk-llm.js';

class TextProvider extends KodaXBaseProvider {
  static responses = [];
  name = 'bundled-text-permission';
  supportsThinking = false;
  config = { apiKeyEnv: 'KODAX_BUNDLED_TEXT_TEST_KEY', model: 'test', supportsThinking: false };
  async stream() {
    const response = TextProvider.responses.shift();
    assert.ok(response, 'unexpected model request');
    return response;
  }
}

test('bundled SDK preserves Full Access and exact Auto text approvals', async (t) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.bundled-text-test-'));
  const workspace = path.join(root, 'workspace');
  const previousHome = process.env.KODAX_HOME;
  const previousKey = process.env.KODAX_BUNDLED_TEXT_TEST_KEY;
  await fs.mkdir(workspace);
  process.env.KODAX_HOME = path.join(root, 'home');
  process.env.KODAX_BUNDLED_TEXT_TEST_KEY = 'test';
  registerModelProvider('bundled-text-permission', () => new TextProvider());
  try {
    for (const run of [runKodaX, runManagedTask]) {
      for (const mode of ['full-access', 'auto']) {
        await t.test(`${run.name} ${mode}`, async () => {
          const target = path.join(root, `${run.name}-${mode}.txt`);
          TextProvider.responses = [
            { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
              { type: 'tool_use', id: 'write', name: 'write', input: { path: target, content: 'before' } },
            ] },
            { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
              { type: 'tool_use', id: 'edit', name: 'edit', input: { path: target, old_string: 'before', new_string: 'after' } },
            ] },
            { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
          ];
          const result = await run({ provider: 'bundled-text-permission', agentMode: 'sa', reasoningMode: 'off', lsp: false,
            guardrails: mode === 'auto' ? [{ kind: 'tool', name: 'auto-mode', beforeTool: async () => ({ action: 'allow' }) }] : undefined,
            context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
              systemPromptOverride: 'Use the requested tools.', resolveShellPermissionMode: () => mode },
          }, 'Write and edit the file.');
          assert.equal(result.success, true);
          assert.equal(await fs.readFile(target, 'utf8'), 'after');
        });
      }
    }
  } finally {
    clearRuntimeModelProviders();
    if (previousHome === undefined) delete process.env.KODAX_HOME;
    else process.env.KODAX_HOME = previousHome;
    if (previousKey === undefined) delete process.env.KODAX_BUNDLED_TEXT_TEST_KEY;
    else process.env.KODAX_BUNDLED_TEXT_TEST_KEY = previousKey;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
