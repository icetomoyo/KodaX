import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent, Runner, type AgentMessage, type RunnerLlmResult } from '@kodax-ai/agent';
import { KodaXBaseProvider, KodaXContextOverflowError } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXProviderConfig, KodaXProviderStreamOptions, KodaXReasoningRequest, KodaXStreamResult, KodaXToolDefinition } from '@kodax-ai/llm';
import { toolRead } from '../packages/coding/src/tools/read.js';
import { KODAX_TOOLS } from '../packages/coding/src/tools/registry.js';
import { TOOL_OUTPUT_DIR_ENV } from '../packages/coding/src/tools/truncate.js';
import { createRunnerToolResultBatchTransform } from '../packages/coding/src/task-engine/runner-tool-result-batch.js';
import { buildManagedTaskCompactionHook, type ContextTokenSnapshotRef } from '../packages/coding/src/task-engine/_internal/managed-task/compaction.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';

class ControlledSummaryProvider extends KodaXBaseProvider {
  readonly name = 'offline-document-summary';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig;
  calls = 0;
  constructor(window: number, private readonly truncated: boolean) {
    super();
    this.config = { model: 'controlled', apiKeyEnv: 'UNUSED', supportsThinking: false,
      contextWindow: window, maxOutputTokens: 1000 };
  }
  async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string,
    _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
    this.calls++;
    expect(options?.maxOutputTokensOverride).toBe(1000);
    return { textBlocks: [{ type: 'text', text: '<summary>## Goal\nReview the large document and preserve EXACT_EXCEPTION.\n## Progress\nThe requested read operations completed. Their exact outputs remain available through saved artifacts and the source document.\n## Next Steps\nContinue from the returned source cursor; do not repeat completed read operations.</summary>' }],
      toolBlocks: [], thinkingBlocks: [], stopReason: this.truncated ? 'max_tokens' : 'end_turn' };
  }
}

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-doc-recovery-')) {
      throw new Error('Unsafe test cleanup');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('offline document read → admission → managed recovery', () => {
  it.each([8, 16, 32, 64, 96].flatMap(k => [
    { k, truncated: false }, { k, truncated: true },
  ]))('$k K context, truncated summary=$truncated, resumes without replay', async ({ k, truncated }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-doc-recovery-'));
    directories.push(directory);
    const artifacts = path.join(directory, 'artifacts');
    await fs.mkdir(artifacts);
    vi.stubEnv(TOOL_OUTPUT_DIR_ENV, artifacts);
    const document = path.join(directory, 'large-document.txt');
    await fs.writeFile(document, Array.from({ length: 2000 }, (_, i) =>
      `ROW_${i + 1} EXACT_EXCEPTION_${i + 1} ${'evidence '.repeat(20)}`).join('\n'));
    const window = k * 1024;
    const provider = new ControlledSummaryProvider(window, truncated);
    const ctx: KodaXToolExecutionContext = { backups: new Map() };
    const snapshot: ContextTokenSnapshotRef = { current: undefined };
    const reads: Array<{ path: string; offset: number; output: string }> = [];
    const readDefinition = KODAX_TOOLS.find(tool => tool.name === 'read')!;
    const agent = createAgent({ name: 'offline-document-reader', instructions: 'Read bounded source pages; preserve exact exceptions.', tools: [{
      ...readDefinition,
      execute: async input => {
        const output = await toolRead(input, ctx);
        expect(typeof output).toBe('string');
        reads.push({ path: String(input.path), offset: Number(input.offset), output: String(output) });
        return { content: output };
      },
    }] });
    const commits: AgentMessage[][] = [];
    const hook = await buildManagedTaskCompactionHook({ provider: 'offline-document-summary', model: 'controlled', events: {
      onCompactedMessages: async messages => {
        // The actual host callback commits the replacement before the runner sees it.
        const copy = structuredClone(messages);
        commits.push(copy);
        await fs.writeFile(path.join(directory, 'committed-context.json'), JSON.stringify(copy));
      },
    } }, { executionContext: ctx, activeToolDefinitions: [readDefinition],
      contextTokenSnapshotRef: snapshot,
      resolvedContextCapacity: { provider, activeModel: 'controlled', contextWindow: window,
        compactionConfig: { enabled: true, triggerPercent: 15 } },
    });
    let turn = 0;
    let resumedContext = '';
    let savedPage = '';
    const step = async (messages: readonly KodaXMessage[]): Promise<RunnerLlmResult> => {
        turn++;
        if (turn === 1) return { text: '', toolCalls: [1, 201, 401].map(offset => ({
          id: `page-${offset}`, name: 'read', input: { path: document, offset, limit: 200 },
        })) };
        if (turn === 2) throw new KodaXContextOverflowError({ contextWindow: window,
          inputTokens: window + 2000, inputTokensKind: 'exact' });
        if (turn === 3) {
          resumedContext = JSON.stringify(messages);
          for (const file of await fs.readdir(artifacts)) {
            const target = path.join(artifacts, file);
            const body = await fs.readFile(target, 'utf8');
            if (reads.some(read => read.output === body)) { savedPage = target; break; }
          }
          expect(savedPage).not.toBe('');
          expect(resumedContext).toContain(JSON.stringify(savedPage).slice(1, -1));
          // A controlled narrow read of the saved page's footer retrieves the
          // source cursor through the same tool the resumed model receives.
          return { text: '', toolCalls: [{ id: 'saved-footer', name: 'read',
            input: { path: savedPage, offset: 202, limit: 1 } }] };
        }
        if (turn === 4) {
          expect(JSON.stringify(messages).includes('Use offset=')).toBe(true);
          const cursor = /Use offset=(\d+) limit=200 to continue/.exec(reads.at(-1)!.output);
          expect(cursor).not.toBeNull();
          return { text: '', toolCalls: [{ id: 'continuation', name: 'read',
            input: { path: document, offset: Number(cursor![1]), limit: 1 } }] };
        }
        return { text: 'continued after durable recovery', toolCalls: [] };
    };
    const adapter = buildRunnerLlmAdapter({ provider: 'offline-document-main', model: 'controlled' }, async messages => {
      const response = await step(messages);
      return { textBlocks: [{ text: response.text }],
        toolBlocks: response.toolCalls.map(call => ({ type: 'tool_use' as const, ...call })) };
    }, undefined, undefined, snapshot);
    const result = await Runner.run(agent, 'Preserve EXACT_EXCEPTION; continue all requested source pages.', {
      tracer: null, maxTurns: 6, compactionHook: hook, llm: adapter,
      toolResultBatchTransform: createRunnerToolResultBatchTransform({ ctx, contextWindow: window,
        reservedResponseTokens: 1000, contextTokenSnapshotRef: snapshot }),
      onContextCapacityBlocked: async () => { throw new Error('Unexpected terminal capacity wait'); },
    });
    expect(result.output).toBe('continued after durable recovery');
    expect(provider.calls).toBeGreaterThan(0);
    expect(provider.calls).toBeLessThanOrEqual(6);
    expect(reads).toHaveLength(5);
    expect(reads.map(read => read.offset).slice(0, 3).sort((a, b) => a - b)).toEqual([1, 201, 401]);
    expect(reads[3]!.path).toBe(savedPage);
    expect(reads[4]!.path).toBe(document);
    expect(reads[4]!.offset).toBeGreaterThan(1);
    expect(reads[4]!.output).toContain(`EXACT_EXCEPTION_${reads[4]!.offset}`);
    expect(resumedContext).toContain('EXACT_EXCEPTION');
    expect(commits.length).toBeGreaterThan(0);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'committed-context.json'), 'utf8'))).toEqual(commits.at(-1));
    const originals = await Promise.all((await fs.readdir(artifacts)).map(file => fs.readFile(path.join(artifacts, file), 'utf8')));
    expect(originals.some(body => reads.slice(0, 3).some(read => body === read.output))).toBe(true);
    expect(originals.join('\n')).toMatch(/Use offset=\d+ limit=200 to continue/);
    if (truncated) expect(commits.every(messages => !messages.some(message => message._source === 'compaction-checkpoint'))).toBe(true);
  });
});
