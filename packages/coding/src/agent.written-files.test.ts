import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn(actual.compact) };
});
import { compact, type CompactionResult, type ToolGuardrail } from '@kodax-ai/agent';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { runKodaX } from './agent.js';
import { runManagedTaskViaRunner } from './task-engine/runner-driven.js';
import type { KodaXOptions } from './types.js';

type Mode = 'coding' | 'managed';
function toolResponse(name: string, input: Record<string, unknown>, id = name): KodaXStreamResult {
  return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
    { type: 'tool_use', id, name, input },
  ] };
}
const done: KodaXStreamResult = {
  textBlocks: [{ type: 'text', text: 'Report ready.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
};
async function run(mode: Mode, context: KodaXOptions['context'] = {}, overrides: Partial<KodaXOptions> = {}) {
  const options: KodaXOptions = {
    provider: providerName, reasoningMode: 'off', maxIter: 10,
    context: { executionCwd: workspace, gitRoot: workspace, managedTaskWorkspaceDir: workspace, repoIntelligenceMode: 'off', ...context },
    events: { beforeToolExecute: async () => true },
    ...overrides,
  };
  return mode === 'coding'
    ? runKodaX(options, 'Create the requested report.')
    : runManagedTaskViaRunner(options, 'Create the requested report.', async () => new WrittenFilesProvider().stream([]));
}

const providerName = 'written-files-test';
class WrittenFilesProvider extends KodaXBaseProvider {
  static responses: KodaXStreamResult[] = [];
  readonly name = providerName;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_WRITTEN_FILES_TEST_KEY', model: 'test', supportsThinking: false,
  };
  async stream(_messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    const response = WrittenFilesProvider.responses.shift();
    if (!response) throw new Error('Unexpected provider call');
    return response;
  }
}

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'kodax-written-files-'));
  vi.stubEnv('KODAX_WRITTEN_FILES_TEST_KEY', 'test');
  registerModelProvider(providerName, () => new WrittenFilesProvider());
});
afterEach(() => {
  clearRuntimeModelProviders();
  vi.mocked(compact).mockReset();
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});

it.each(['coding', 'managed'] as const)('returns successful file writes from %s without needing an artifact ledger', async (mode) => {
  WrittenFilesProvider.responses = [
    toolResponse('write', { path: 'report.html', content: '<p>report</p>' }), done,
  ];
  const result = await run(mode);
  expect(readFileSync(path.join(workspace, 'report.html'), 'utf8')).toBe('<p>report</p>');
  expect(result).toMatchObject({
    success: true,
    writtenFiles: [{ path: path.join(workspace, 'report.html'), sourceTool: 'write' }],
  });
});

it.each(['coding', 'managed'] as const)('%s preserves Skill promotion through subsequent edits and collects only returned outputs', async (mode) => {
  WrittenFilesProvider.responses = [
    toolResponse('run_skill_script', {
      skill: 'reports', script: 'scripts/report.py', outputs: [
        { path: 'report.html', target: ' report.html ' }, { path: 'missing.html', target: 'missing.html' },
      ],
    }),
    toolResponse('edit', { path: './report.html', old_string: 'draft', new_string: 'final' }), done,
  ];
  const result = await run(mode, { skillScriptRunner: {
    async run() {
      writeFileSync(path.join(workspace, 'report.html'), '<p>draft</p>');
      return JSON.stringify({ outputs: ['report.html', 'undeclared.html'] });
    },
  } });
  expect(readFileSync(path.join(workspace, 'report.html'), 'utf8')).toBe('<p>final</p>');
  expect(result.writtenFiles).toEqual([{ path: path.join(workspace, 'report.html'), sourceTool: 'run_skill_script' }]);
});

it.each(['coding', 'managed'] as const)('%s tracks all native edits but excludes failed writes and previous runs', async (mode) => {
  for (const file of ['edit.txt', 'multi.txt', 'anchor.txt', 'failed.txt']) {
    writeFileSync(path.join(workspace, file), 'original\n');
  }
  WrittenFilesProvider.responses = [
    toolResponse('edit', { path: 'edit.txt', old_string: 'original', new_string: 'changed' }),
    toolResponse('multi_edit', { path: 'multi.txt', edits: [{ old_string: 'original', new_string: 'changed' }] }),
    toolResponse('insert_after_anchor', { path: 'anchor.txt', anchor: 'original', content: 'added\n' }),
    toolResponse('edit', { path: 'failed.txt', old_string: 'not present', new_string: 'changed' }, 'failed-edit'), done,
  ];
  const result = await run(mode);
  expect(result.writtenFiles).toEqual([
    { path: path.join(workspace, 'edit.txt'), sourceTool: 'edit' },
    { path: path.join(workspace, 'multi.txt'), sourceTool: 'multi_edit' },
    { path: path.join(workspace, 'anchor.txt'), sourceTool: 'insert_after_anchor' },
  ]);
  expect(readFileSync(path.join(workspace, 'failed.txt'), 'utf8')).toBe('original\n');
  WrittenFilesProvider.responses = [done];
  expect((await run(mode)).writtenFiles).toEqual([]);
});

it.each(['coding', 'managed'] as const)('%s tracks writes dispatched through tool_call', async (mode) => {
  WrittenFilesProvider.responses = [
    toolResponse('tool_call', { name: 'write', input: { path: 'bridged.html', content: '<p>bridge</p>' } }), done,
  ];
  const result = await run(mode);
  expect(readFileSync(path.join(workspace, 'bridged.html'), 'utf8')).toBe('<p>bridge</p>');
  expect(result.writtenFiles).toEqual([{ path: path.join(workspace, 'bridged.html'), sourceTool: 'write' }]);
});

it.each(['coding', 'managed'] as const)('%s preserves early outputs through 260 later reads and automatic compaction', async (mode) => {
  const readBatch = toolResponse('read', { path: 'early.txt' });
  readBatch.toolBlocks = Array.from({ length: 260 }, (_, index) => ({
    type: 'tool_use', id: `read-${index}`, name: 'read', input: { path: 'early.txt' },
  }));
  readBatch.usage = { inputTokens: 129_900, outputTokens: 100, totalTokens: 130_000 };
  WrittenFilesProvider.responses = [toolResponse('write', { path: 'early.txt', content: 'keep me' }), readBatch, done, done];
  vi.mocked(compact).mockImplementation(async (messages): Promise<CompactionResult> => ({
    compacted: true, messages: [{ role: 'user', content: 'Continue after compacting history.' }],
    summary: 'Earlier work complete.', tokensBefore: 130_000, tokensAfter: 10, entriesRemoved: messages.length,
  }));
  const result = await run(mode, {}, { compaction: { contextWindow: 200_000, triggerPercent: 60 } });
  expect(compact).toHaveBeenCalled();
  expect(result.writtenFiles).toEqual([{ path: path.join(workspace, 'early.txt'), sourceTool: 'write' }]);
  expect(JSON.stringify(result.messages)).not.toContain('read-259');
});

it.each(['coding', 'managed'] as const)('%s records guardrail-rewritten paths and excludes blocked writes', async (mode) => {
  const guardrail: ToolGuardrail = { kind: 'tool', name: 'write-policy', beforeTool: async (call) => (
    call.id === 'blocked' ? { action: 'block', reason: 'Write denied.' }
      : { action: 'rewrite', payload: { ...call, input: { ...call.input, path: 'allowed.txt' } } }
  ) };
  writeFileSync(path.join(workspace, 'blocked.txt'), 'previous run');
  WrittenFilesProvider.responses = [
    toolResponse('write', { path: 'requested.txt', content: 'allowed' }),
    toolResponse('write', { path: 'blocked.txt', content: 'denied' }, 'blocked'), done,
  ];
  const result = await run(mode, {}, { guardrails: [guardrail] });
  expect(result.writtenFiles).toEqual([{ path: path.join(workspace, 'allowed.txt'), sourceTool: 'write' }]);
  expect(readFileSync(path.join(workspace, 'allowed.txt'), 'utf8')).toBe('allowed');
  expect(readFileSync(path.join(workspace, 'blocked.txt'), 'utf8')).toBe('previous run');
});

it.each(['coding', 'managed'] as const)('%s excludes failed, cancelled and malformed Skill receipts', async (mode) => {
  const receipts = ['[Tool Error] failed', '[Cancelled] stopped', '{"outputs":', JSON.stringify({ outputs: [] })];
  writeFileSync(path.join(workspace, 'old.txt'), 'previous run');
  WrittenFilesProvider.responses = [
    ...receipts.map((_, index) => toolResponse('run_skill_script', {
      skill: 'reports', script: 'scripts/report.py', outputs: [{ path: 'old.txt', target: 'old.txt' }],
    }, `skill-${index}`)), done,
  ];
  const result = await run(mode, { skillScriptRunner: { async run() { return receipts.shift()!; } } });
  expect(result.writtenFiles).toEqual([]);
});

it.each(['coding', 'managed'] as const)('%s excludes permission text overrides even when an old target exists', async (mode) => {
  writeFileSync(path.join(workspace, 'old.txt'), 'private old content');
  WrittenFilesProvider.responses = [toolResponse('write', { path: 'old.txt', content: 'new' }), done];
  const result = await run(mode, {}, { events: { beforeToolExecute: async () => '[Plan Mode] Would write this file.' } });
  expect(result.writtenFiles).toEqual([]);
});

it.each(['coding', 'managed'] as const)('%s retains actual Skill outputs when a result guardrail rewrites presentation', async (mode) => {
  WrittenFilesProvider.responses = [toolResponse('run_skill_script', {
    skill: 'reports', script: 'scripts/report.py', outputs: [{ path: 'report.txt', target: 'report.txt' }],
  }), done];
  const result = await run(mode, { skillScriptRunner: { async run() {
    writeFileSync(path.join(workspace, 'report.txt'), 'report');
    return JSON.stringify({ outputs: ['report.txt'], stdout: 'verbose output\n'.repeat(10_000) });
  } } }, { guardrails: [{ kind: 'tool', name: 'hide-stdout', afterTool: async () => ({
    action: 'rewrite', payload: { content: 'Skill completed.' },
  }) }] });
  expect(result.writtenFiles).toEqual([{ path: path.join(workspace, 'report.txt'), sourceTool: 'run_skill_script' }]);
});
