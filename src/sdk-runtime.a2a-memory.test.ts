import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { LEARNING_REVIEW_TOOL } from '@kodax-ai/coding';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

// Issue 423: a Run in an A2A Session is driven by a remote principal, so it
// must not read the Host owner's memory or queue reviews that write into it.

const providerName = 'a2a-memory-isolation-test';
const turnTools: string[][] = [];
let learningReviews = 0;
class RecordingProvider extends KodaXBaseProvider {
  readonly name = providerName;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_A2A_MEMORY_TEST_KEY', model: 'test', supportsThinking: false,
  };
  async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
    if (tools.some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) learningReviews += 1;
    else turnTools.push(tools.map(tool => tool.name));
    return { thinkingBlocks: [], stopReason: 'end_turn', toolBlocks: [], textBlocks: [{ type: 'text', text: 'done' }] };
  }
}

const roots: string[] = [];
afterEach(async () => {
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  turnTools.length = 0;
  learningReviews = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Files the Host memory review inbox holds after the Runs; reviews persist there before they run. */
async function runTwice(surface: string): Promise<number> {
  const root = mkdtempSync(path.join(tmpdir(), 'kodax-a2a-memory-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  vi.stubEnv('KODAX_A2A_MEMORY_TEST_KEY', 'test');
  registerModelProvider(providerName, () => new RecordingProvider());
  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: root,
    defaultProvider: providerName, defaultModel: 'test', permissionTimeoutMs: 1_000 });
  try {
    const session = await runtime.sessions.create({ title: 'memory', surface, projectPath: workspace });
    // A finished Run queues its learning review; the next Run's start drains it.
    for (const text of ['Reply briefly.', 'Reply again.']) {
      const run = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task',
        input: { type: 'text', text } });
      await run.result;
    }
  } finally {
    // Closing waits for Host-owned memory work, including the review drain.
    await runtime.close();
  }
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(entry => entry.split(path.sep).includes('memory-review-inbox') && entry.endsWith('.json')).length;
}

it('keeps memory intent and learning review for an ordinary Session', async () => {
  const inboxFiles = await runTwice('cli');
  expect(turnTools[0]).toEqual(expect.arrayContaining(['memory_recall', 'memory_intent']));
  expect(inboxFiles).toBeGreaterThan(0);
});

// As for child Agents, memory_recall stays listed but has no memory binding,
// so it only answers that no claim applies.
it('runs an A2A Session without memory intent or learning review', async () => {
  const inboxFiles = await runTwice('a2a');
  expect(turnTools.length).toBeGreaterThan(0);
  for (const tools of turnTools) expect(tools).not.toContain('memory_intent');
  expect(inboxFiles).toBe(0);
  expect(learningReviews).toBe(0);
});
