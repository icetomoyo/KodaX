import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { runNativeTaskCell } from './native-task-cell.js';
import { createNativeTaskTransport } from './native-task-transport.js';

afterEach(() => { vi.unstubAllEnvs(); });

it('rejects replaying historical rounds while resuming a persisted session', async () => {
  let calls = 0;
  await expect(runNativeTaskCell({ workspace: os.tmpdir(), home: os.tmpdir(), provider: 'kimi-code', model: 'kimi-for-coding',
    resumeSessionId: 'existing-session', prompt: '继续完成上一条任务。',
    history: [{ text: 'first', images: [] }, { text: 'second', images: [] }],
    transportFetch: async () => { calls++; return Response.json({}); },
  })).rejects.toThrow('no history replay');
  expect(calls).toBe(0);
});

function nativeResponse(content: Record<string, unknown>[], streaming: boolean): Response {
  const message = { id: 'offline-message', type: 'message', role: 'assistant', model: 'kimi-for-coding', content,
    stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 } };
  if (!streaming) return Response.json(message);
  const events: Record<string, unknown>[] = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } }];
  content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
    events.push({ type: 'content_block_delta', index, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage }, { type: 'message_stop' });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

it('continues an interrupted persisted session without replaying its real history or compaction', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-continuation-'));
  const home = path.join(directory, 'home');
  let primaryCalls = 0;
  try {
    await writeFile(path.join(directory, 'evidence.txt'), 'PERSISTED-TOOL-EVIDENCE');
    const first = await runNativeTaskCell({ workspace: directory, home, provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'ORIGINAL-FINAL-QUESTION', history: [{ text: 'FIRST-REAL-HISTORY', images: [] }, { text: 'SECOND-REAL-HISTORY', images: [] }],
      transportFetch: async (source, init) => {
        const wire = JSON.parse(await new Request(source, init).text()) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text: '## Goal\nCOMPACTED-HISTORY-MARKER\n## Progress\nBoth historical rounds completed.\n## Next steps\nAnswer the original final task.' }], wire.stream === true);
        primaryCalls++;
        if (primaryCalls <= 2) return nativeResponse([{ type: 'text', text: `REAL-HISTORY-ANSWER-${primaryCalls}` }], wire.stream === true);
        if (primaryCalls === 3) return nativeResponse([{ type: 'tool_use', id: 'persisted-read', name: 'read', input: { path: 'evidence.txt' } }], wire.stream === true);
        throw new Error('Offline accounted budget interruption before the next response.');
      } });
    expect(first.compaction?.compacted).toBe(true);
    expect(first.result?.phase).toBe('interrupted');
    expect(first.tools.some(tool => tool.content.includes('PERSISTED-TOOL-EVIDENCE'))).toBe(true);
    const resumeSessionId = first.result!.sessionId;
    const requests: string[] = [];
    const continuation = { resumeSessionId };
    const resumed = await runNativeTaskCell({ workspace: directory, home, provider: 'kimi-code', model: 'kimi-for-coding',
      ...continuation, prompt: '继续完成上一条任务。', transportFetch: async (source, init) => {
        const raw = await new Request(source, init).text(); requests.push(raw);
        const wire = JSON.parse(raw) as Record<string, unknown>;
        return nativeResponse([{ type: 'text', text: 'Completed using retained evidence.' }], wire.stream === true);
      } });
    expect(resumed.result?.sessionId).toBe(resumeSessionId);
    expect(resumed.result?.runId).not.toBe(first.result?.runId);
    expect(resumed.error).toBeUndefined();
    expect(resumed.answer).toBe('Completed using retained evidence.');
    expect(resumed.historyResponses).toEqual([0, 0]);
    expect(resumed.compaction).toBeUndefined();
    expect(resumed.responses.filter(response => response.kind !== 'auxiliary').map(response => response.kind)).toEqual(['main']);
    expect(requests[0]).toContain('COMPACTED-HISTORY-MARKER');
    expect(requests[0]).toContain('ORIGINAL-FINAL-QUESTION');
    expect(requests[0]).toContain('PERSISTED-TOOL-EVIDENCE');
    expect(requests[0]).toContain('继续完成上一条任务。');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('records an accounted truncated optional review after history and still completes the remaining real history and main task', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-history-review-integration-'));
  const workspace = path.join(directory, 'workspace');
  const ledgerDirectory = path.join(directory, 'ledger');
  let primaryCalls = 0;
  let physicalCalls = 0;
  let reviewCalls = 0;
  let stops = 0;
  let transport: Awaited<ReturnType<typeof createNativeTaskTransport>> | undefined;
  const abort = new AbortController();
  try {
    await mkdir(workspace); await mkdir(ledgerDirectory);
    const png = await new Jimp({ width: 32, height: 32, color: 0xffffffff }).getBuffer('image/png');
    await writeFile(path.join(workspace, 'preview.png'), png);
    transport = await createNativeTaskTransport({ directory: ledgerDirectory, cell: 'history-review-integration', provider: 'kimi-code', model: 'kimi-for-coding',
      maxCallsPerCell: 15, maxTotalCalls: 15, maxCellTokens: 250000, maxTotalTokens: 1500000,
      maxOutputTokens: 4096, timeoutMs: 180000, maxSpendUsd: 6, failurePolicy: 'r5-cell-isolated',
      spendControl: { preflightEvidence: 'offline integration fixture without external calls', maxAdditionalSpendUsd: 0 },
      onStop: error => { stops++; abort.abort(error); }, fetcher: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const raw = await request.text();
        const wire = JSON.parse(raw) as Record<string, unknown>;
        physicalCalls++;
        const definitions = wire.tools as { name: string }[] | undefined;
        if (definitions?.length === 1 && definitions[0]?.name === 'commit_episode_learning_review') {
          reviewCalls++;
          expect(wire.max_tokens).toBe(1200);
          if (reviewCalls > 1) return nativeResponse([{ type: 'tool_use', id: `review-${reviewCalls}`, name: 'commit_episode_learning_review',
            input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['no-durable-learning'] } } }], wire.stream === true);
          expect(primaryCalls).toBe(2);
          const response = nativeResponse([{ type: 'text', text: 'Optional review was truncated.' }], wire.stream === true);
          const body = (await response.text()).replaceAll('"output_tokens":20', '"output_tokens":1200')
            .replaceAll('"stop_reason":"end_turn"', '"stop_reason":"max_tokens"');
          return new Response(body, { headers: response.headers });
        }
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text:
          '## Goal\nRetain the two historical previews.\n## Progress\nThe first batch included a real check that optional.txt is absent; the second batch was received.\n## Next steps\nCompare the original evidence for the final question.' }], wire.stream === true);
        primaryCalls++;
        if (primaryCalls <= 3) expect(raw).not.toContain('FINAL-HISTORY-REVIEW-QUESTION');
        if (primaryCalls === 1) return nativeResponse([{ type: 'tool_use', id: 'optional-history-check', name: 'read', input: { path: 'optional.txt' } }], wire.stream === true);
        if (primaryCalls === 2) expect(raw).toContain('File not found');
        return nativeResponse([{ type: 'text', text: primaryCalls === 2 ? 'The first historical preview is recorded; optional.txt is absent.'
          : primaryCalls === 3 ? 'The second historical preview is recorded.' : 'The final historical comparison is complete.' }], wire.stream === true);
      } });
    const result = await runNativeTaskCell({ workspace, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'FINAL-HISTORY-REVIEW-QUESTION', historyResponsesPerRound: 2,
      history: [{ text: 'Inspect this first historical preview and check whether optional.txt exists.', images: ['preview.png'] },
        { text: 'Retain this second historical preview for later comparison.', images: ['preview.png'] }],
      transportFetch: transport.fetch, signal: abort.signal });
    await transport.settle();
    const ledger = transport.getLedger();
    expect(reviewCalls).toBeGreaterThanOrEqual(1);
    expect(result.answer).toBe('The final historical comparison is complete.');
    expect(result.result?.phase).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.historyResponses).toEqual([2, 1]);
    expect(result.compaction?.compacted).toBe(true);
    expect(result.backgroundSettled).toBe(true);
    expect(result.backgroundError).toMatchObject({ phase: 'history-0', message: expect.stringContaining('Truncated') });
    expect(result.auxiliaryFailures).toEqual([expect.objectContaining({ phase: 'history-0', toolName: 'commit_episode_learning_review', message: expect.stringContaining('Truncated') })]);
    expect(result.visibleCompletionMs).toEqual(expect.any(Number));
    expect(stops).toBe(0);
    expect(ledger.stopped).toBe(false);
    expect(ledger.cells['history-review-integration']?.stopped).not.toBe(true);
    expect(ledger.calls).toBe(physicalCalls);
    expect(ledger.accountedCalls).toBe(physicalCalls);
    expect(ledger.tokens).toBe((physicalCalls - 1) * 120 + 1300);
    expect(ledger.reservedTokens ?? 0).toBe(0);
    expect(ledger.cells['history-review-integration']?.auxiliaryFailures).toHaveLength(1);
  } finally { await transport?.settle(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('finishes a historical round beyond four responses before the second round, real compaction, and the main task', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-history-twenty-four-'));
  let primaryCalls = 0;
  try {
    for (let index = 1; index <= 6; index++) await writeFile(path.join(directory, `history-${index}.txt`), `actual historical fact ${index}`);
    const png = await new Jimp({ width: 32, height: 32, color: 0xffffffff }).getBuffer('image/png');
    await writeFile(path.join(directory, 'preview.png'), png);
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'FINAL-HISTORY-QUESTION', limits: { mainResponses: 24, historyResponsesPerRound: 24, maxTools: 64,
        toolTimeoutMs: 90_000, cellTimeoutMs: 1_500_000, maxOutputTokens: 8192 },
      history: [{ text: 'Inspect the first historical batch.', images: ['preview.png'] }, { text: 'Inspect the second historical batch.', images: ['preview.png'] }],
      transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const raw = await request.text();
        const wire = JSON.parse(raw) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text:
          '## Goal\nRetain both historical batches.\n## Progress\nThe first batch was checked through five real reads, then the assistant reported its observed facts.\n## Next steps\nCompare retained evidence after the final question.' }], wire.stream === true);
        primaryCalls++;
        if (primaryCalls <= 8) expect(raw).not.toContain('FINAL-HISTORY-QUESTION');
        if (primaryCalls <= 5 || primaryCalls === 7) {
          const index = primaryCalls === 7 ? 6 : primaryCalls;
          return nativeResponse([{ type: 'tool_use', id: `historical-read-${index}`, name: 'read', input: { path: `history-${index}.txt` } }], wire.stream === true);
        }
        if (primaryCalls === 6) expect(raw).toContain('actual historical fact 5');
        if (primaryCalls === 8) expect(raw).toContain('actual historical fact 6');
        return nativeResponse([{ type: 'text', text: primaryCalls === 6 ? 'The first historical batch is fully inspected.'
          : primaryCalls === 8 ? 'The second historical batch is fully inspected.' : 'The final comparison is complete.' }], wire.stream === true);
      } });
    expect(result.error).toBeUndefined();
    expect(result.historyResponses).toEqual([6, 2]);
    expect(result.historyResults.map(round => round.result.phase)).toEqual(['completed', 'completed']);
    expect(result.tools).toHaveLength(6);
    expect(result.compaction?.compacted).toBe(true);
    expect(result.responses.some(response => response.kind === 'compaction' && response.request.includes('The first historical batch is fully inspected.'))).toBe(true);
    expect(result.mainResponses).toBe(1);
    expect(result.answer).toBe('The final comparison is complete.');
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('continues the real Runtime after its production stall sidequery times out without losing call or reserve accounting', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-stall-integration-'));
  const workspace = path.join(directory, 'workspace');
  const ledgerDirectory = path.join(directory, 'ledger');
  const abort = new AbortController();
  let primaryCalls = 0;
  let physicalCalls = 0;
  let stallCalls = 0;
  let stops = 0;
  let transport: Awaited<ReturnType<typeof createNativeTaskTransport>> | undefined;
  try {
    await mkdir(workspace); await mkdir(ledgerDirectory);
    await writeFile(path.join(workspace, 'value.txt'), 'verified value 42');
    transport = await createNativeTaskTransport({ directory: ledgerDirectory, cell: 'stall-integration', provider: 'kimi-code', model: 'kimi-for-coding',
      maxCallsPerCell: 20, maxTotalCalls: 20, maxCellTokens: 250000, maxTotalTokens: 1500000,
      maxOutputTokens: 4096, timeoutMs: 180000, maxSpendUsd: 6, failurePolicy: 'r5-cell-isolated',
      spendControl: { preflightEvidence: 'offline integration fixture, no network or charges', maxAdditionalSpendUsd: 0 },
      onStop: error => { stops++; abort.abort(error); }, fetcher: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const wire = JSON.parse(await request.text()) as Record<string, unknown>;
        physicalCalls++;
        const definitions = wire.tools as { name: string }[] | undefined;
        if (definitions?.length === 1 && definitions[0]?.name === 'report_stall_judgment') {
          stallCalls++;
          expect(wire.max_tokens).toBe(1024);
          const start = { type: 'message_start', message: { id: 'stall-partial', model: 'kimi-for-coding',
            usage: { input_tokens: 77, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
          // The real sidequery owns its deadline; the response never finishes.
          return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`));
          } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text: '{"candidates":[]}' }], wire.stream === true);
        primaryCalls++;
        return nativeResponse(primaryCalls <= 3
          ? [{ type: 'tool_use', id: `repeat-read-${primaryCalls}`, name: 'read', input: { path: 'value.txt' } }]
          : [{ type: 'text', text: 'Verified value 42; the task is complete.' }], wire.stream === true);
      } });
    const result = await runNativeTaskCell({ workspace, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Inspect the local value and report it.', transportFetch: transport.fetch, signal: abort.signal });
    await transport.settle();
    const ledger = transport.getLedger();
    expect(stallCalls).toBe(1);
    expect(result.answer).toBe('Verified value 42; the task is complete.');
    expect(result.result?.phase).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.backgroundSettled).toBe(true);
    expect(stops).toBe(0);
    expect(primaryCalls).toBe(4);
    expect(ledger.stopped).toBe(false);
    expect(ledger.cells['stall-integration']?.stopped).not.toBe(true);
    expect(ledger.calls).toBe(physicalCalls);
    expect(ledger.accountedCalls).toBe(physicalCalls - 1);
    expect(ledger.tokens).toBe((physicalCalls - 1) * 120);
    expect(ledger.reservedTokens).toBe(1101);
    expect(ledger.cells['stall-integration']?.auxiliaryFailures).toHaveLength(1);
    expect(result.auxiliaryFailures).toEqual([expect.objectContaining({ phase: 'main', toolName: 'report_stall_judgment' })]);
    expect(result.backgroundError).toBeUndefined();
  } finally { await transport?.settle(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('preserves successful foreground output and timing when default background work fails', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-background-failure-'));
  let primaryCalls = 0;
  let backgroundCalls = 0;
  try {
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Check whether optional.txt exists and report the result.', transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const wire = JSON.parse(await request.text()) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) {
          backgroundCalls++;
          throw new Error('controlled background transport failure');
        }
        primaryCalls++;
        return nativeResponse(primaryCalls === 1
          ? [{ type: 'tool_use', id: 'check-optional', name: 'read', input: { path: 'optional.txt' } }]
          : [{ type: 'text', text: 'The optional file is absent; the requested check is complete.' }], wire.stream === true);
      } });
    expect(backgroundCalls).toBe(1);
    expect(result.result?.phase).toBe('completed');
    expect(result.answer).toBe('The optional file is absent; the requested check is complete.');
    expect(result.visibleCompletionMs).toEqual(expect.any(Number));
    expect(result.visibleCompletionMs).toBe(result.runTerminalMs);
    expect(result.backgroundSettled).toBe(true);
    expect(result.backgroundError?.message).toContain('controlled background transport failure');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('returns captured historical evidence and a phase error when history fails before the main task', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-history-failure-'));
  let primaryCalls = 0;
  try {
    await writeFile(path.join(directory, 'history.txt'), 'genuine historical evidence');
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'THE-FINAL-QUESTION-MUST-NOT-RUN', historyResponsesPerRound: 2,
      history: [{ text: 'Inspect the first historical batch.', images: [] }, { text: 'Inspect the second historical batch.', images: [] }],
      transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const raw = await request.text();
        const wire = JSON.parse(raw) as Record<string, unknown>;
        expect(raw).not.toContain('THE-FINAL-QUESTION-MUST-NOT-RUN');
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text: '{"candidates":[]}' }], wire.stream === true);
        primaryCalls++;
        if (primaryCalls === 2) throw new Error('historical transport failed');
        return nativeResponse([{ type: 'tool_use', id: 'history-read', name: 'read', input: { path: 'history.txt' } }], wire.stream === true);
      } });
    expect(result.error?.message).toContain('historical transport failed');
    expect(result.phase).toBe('history-0');
    expect(result.result).toBeUndefined();
    expect(result.mainResponses).toBe(0);
    expect(result.historyResults).toHaveLength(1);
    expect(result.tools[0]?.content).toContain('genuine historical evidence');
    expect(result.responses).toHaveLength(1);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.backgroundError).toBeUndefined();
    expect(result.visibleCompletionMs).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('runs four-response history rounds and more than twelve main responses under the explicit r5 limits', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-r5-limits-'));
  const limits = { mainResponses: 24 as const, historyResponsesPerRound: 4 as const, maxTools: 64 as const,
    toolTimeoutMs: 90_000 as const, cellTimeoutMs: 1_500_000 as const, maxOutputTokens: 8192 as const };
  let primaryCalls = 0;
  let nextEvidence = 0;
  try {
    for (let index = 1; index <= 58; index++) await writeFile(path.join(directory, `evidence-${index}.txt`), `real evidence ${index}`);
    const png = await new Jimp({ width: 32, height: 32, color: 0xffffffff }).getBuffer('image/png');
    await writeFile(path.join(directory, 'preview.png'), png);
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'FINAL-R5-QUESTION', limits, history: [{ text: 'First historical evidence batch.', images: ['preview.png'] },
        { text: 'Second historical evidence batch.', images: ['preview.png'] }], transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const raw = await request.text();
        const wire = JSON.parse(raw) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text:
          '## Goal\nKeep the real historical evidence batches available.\n## Progress\nThe first batch was inspected using three successful file reads and the generated response confirmed the observed content.\n## Next steps\nCompare the retained evidence for the final task.' }], wire.stream === true);
        primaryCalls++;
        const historyTurn = ((primaryCalls - 1) % 4) + 1;
        const mainTurn = primaryCalls - 8;
        if (primaryCalls <= 8) expect(raw).not.toContain('FINAL-R5-QUESTION');
        if (primaryCalls <= 8 && historyTurn === 4) return nativeResponse([{ type: 'text', text: `Historical batch ${primaryCalls / 4} inspected from real files.` }], wire.stream === true);
        if (mainTurn === 14) {
          expect(raw).toContain('real evidence 58');
          return nativeResponse([{ type: 'text', text: 'All required evidence has been inspected and the task is complete.' }], wire.stream === true);
        }
        return nativeResponse(Array.from({ length: primaryCalls <= 8 ? 1 : 4 }, () => {
          nextEvidence++;
          return { type: 'tool_use', id: `r5-read-${nextEvidence}`, name: 'read', input: { path: `evidence-${nextEvidence}.txt` } };
        }), wire.stream === true);
      } });
    expect(result.error).toBeUndefined();
    expect(result.limits).toEqual(limits);
    expect(result.historyResponses).toEqual([4, 4]);
    expect(result.compaction?.compacted).toBe(true);
    expect(result.mainResponses).toBe(14);
    expect(result.toolCount).toBe(58);
    expect(result.tools).toHaveLength(58);
    expect(result.answer).toBe('All required evidence has been inspected and the task is complete.');
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('completes nine real evidence reads and a final answer within the frozen twelve-response allowance', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-twelve-responses-'));
  let primaryCalls = 0;
  try {
    for (let index = 1; index <= 9; index++) await writeFile(path.join(directory, `evidence-${index}.txt`), `confirmed fact ${index}`);
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Read the nine independent evidence files, then report completion.', mainResponses: 12,
      transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const raw = await request.text();
        const wire = JSON.parse(raw) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text: '{"candidates":[]}' }], wire.stream === true);
        primaryCalls++;
        if (primaryCalls <= 9) return nativeResponse([{ type: 'tool_use', id: `evidence-read-${primaryCalls}`, name: 'read', input: { path: `evidence-${primaryCalls}.txt` } }], wire.stream === true);
        expect(raw).toContain('confirmed fact 9');
        return nativeResponse([{ type: 'text', text: 'All nine independent facts are verified.' }], wire.stream === true);
      } });
    expect(result.error).toBeUndefined();
    expect(result.result?.phase).toBe('completed');
    expect(result.mainResponses).toBe(10);
    expect(result.toolCount).toBe(9);
    expect(result.tools).toHaveLength(9);
    expect(result.answer).toBe('All nine independent facts are verified.');
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('uses the native provider and real Runtime tools, preserving requests, responses and settlement', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-cell-'));
  const originalFetch = globalThis.fetch;
  let main = 0;
  const wires: string[] = [];
  try {
    await writeFile(path.join(directory, 'value.txt'), 'verified value 42');
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Read value.txt and report its value.', transportFetch: async (source, init) => {
        const request = new Request(source, init); expect(request.url).toContain('api.kimi.com/coding/');
        const raw = await request.text(); wires.push(raw); const wire = JSON.parse(raw) as Record<string, unknown>;
        const primary = JSON.stringify(wire.tools).includes('todo_update');
        if (!primary) return nativeResponse([{ type: 'text', text: '{"candidates":[]}' }], wire.stream === true);
        expect(wire.max_tokens).toBe(4096);
        const thinking = wire.thinking as { budget_tokens?: number } | undefined;
        if (thinking?.budget_tokens !== undefined) expect(thinking.budget_tokens).toBeLessThan(4096);
        main++;
        return nativeResponse(main === 1
          ? [{ type: 'tool_use', id: 'read-value', name: 'read', input: { path: 'value.txt' } }]
          : [{ type: 'text', text: 'verified value 42' }], wire.stream === true);
      } });
    expect(result.mainResponses, JSON.stringify({ result: result.result, tools: result.tools, responses: result.responses.map(value => JSON.parse(value.request).messages.at(-1)) })).toBe(2);
    expect(result.answer).toContain('verified value 42');
    expect(result.tools.some(tool => tool.content.includes('verified value 42'))).toBe(true);
    expect(wires.some(wire => wire.includes('verified value 42'))).toBe(true);
    expect(result.backgroundSettled).toBe(true);
    expect(result.responses.length).toBe(wires.length);
    expect(result.events.length).toBeGreaterThan(0);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(await readFile(path.join(directory, 'value.txt'), 'utf8')).toBe('verified value 42');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('sends the explicitly frozen 8192 output cap through the native provider request', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-output-cap-'));
  let wire: Record<string, unknown> | undefined;
  try {
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Acknowledge the fixture.', maxOutputTokens: 8192, transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        if ((JSON.stringify(body.tools) ?? '').includes('todo_update')) wire = body;
        return nativeResponse([{ type: 'text', text: 'acknowledged' }], body.stream === true);
      } });
    expect(result.answer).toBe('acknowledged');
    expect(wire?.max_tokens).toBe(8192);
    const thinking = wire?.thinking as { budget_tokens?: number } | undefined;
    if (thinking?.budget_tokens !== undefined) expect(thinking.budget_tokens).toBeLessThan(8192);
    expect(result.error).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('accepts legal multi-line native SSE data without changing the response bytes', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-multiline-'));
  let original = '';
  try {
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Acknowledge the fixture.', transportFetch: async () => {
        const response = nativeResponse([{ type: 'text', text: 'acknowledged' }], true);
        original = (await response.text()).replace(/data: (\{"type":"[^"]+",)/g, 'data: $1\ndata: ');
        return new Response(original, { headers: { 'content-type': 'text/event-stream' } });
      } });
    expect(result.answer).toBe('acknowledged');
    expect(result.responses[0]?.response).toBe(original);
    expect(result.error).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('caps executed tools across responses while preserving the 32 completed results', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-tool-limit-'));
  let calls = 0;
  try {
    for (let round = 1; round <= 4; round++) for (let index = 0; index < 8; index++) {
      await writeFile(path.join(directory, `safe-${round}-${index}.txt`), 'real evidence');
    }
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Inspect local evidence.', transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const wire = JSON.parse(await request.text()) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text: '{"candidates":[]}' }], wire.stream === true);
        calls++;
        return nativeResponse(Array.from({ length: 8 }, (_, index) => ({ type: 'tool_use', id: `read-${calls}-${index}`, name: 'read', input: { path: `safe-${calls}-${index}.txt` } })), wire.stream === true);
      } });
    expect(result.error?.message).toContain('Thirty-two total tool calls');
    expect(result.toolCount).toBe(32);
    expect(result.tools.filter(tool => tool.content.includes('real evidence')), JSON.stringify(result.tools)).toHaveLength(32);
    expect(calls).toBe(5);
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('blocks host-file reads but allows recovery using a workspace file', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-scope-'));
  let calls = 0;
  try {
    await writeFile(path.join(directory, 'safe.txt'), 'public fixture');
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Inspect the fixture.', transportFetch: async (source, init) => {
        const wire = JSON.parse(await new Request(source, init).text()) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) return nativeResponse([{ type: 'text', text: '{"candidates":[]}' }], wire.stream === true);
        calls++;
        return nativeResponse(calls < 3 ? [{ type: 'tool_use', id: `read-${calls}`, name: 'read', input: { path: calls === 1 ? '../host/oracle.json' : 'safe.txt' } }]
          : [{ type: 'text', text: 'public fixture verified' }], wire.stream === true);
      } });
    expect(result.tools[0]?.content).toContain('outside the fixture');
    expect(result.tools[1]?.content).toContain('public fixture');
    expect(result.answer).toBe('public fixture verified');
    expect(result.error).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('rejects an oversized native streamed tool batch before it writes any files', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-budget-'));
  let calls = 0;
  try {
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Work on local files.', transportFetch: async (source, init) => {
        calls++; const wire = JSON.parse(await new Request(source, init).text()) as Record<string, unknown>;
        return nativeResponse(Array.from({ length: 9 }, (_, index) => ({ type: 'tool_use', id: `write-${index}`, name: 'write',
          input: { path: `blocked-${index}.txt`, content: 'must not exist' } })), wire.stream === true);
      } });
    expect(result.error?.message).toContain('Eight tool calls per response');
    expect(result.tools).toEqual([]);
    expect(calls).toBe(1);
    await expect(readFile(path.join(directory, 'blocked-0.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('establishes both history rounds through real image admission and generated replies before real compaction', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-history-'));
  let main = 0;
  const wires: string[] = [];
  try {
    const png = await new Jimp({ width: 32, height: 32, color: 0xffffffff }).getBuffer('image/png');
    for (const file of ['before.png', 'after.png', 'latest.png']) await writeFile(path.join(directory, file), png);
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'FINAL-QUESTION', history: [{ text: 'FIRST-HISTORY', images: ['before.png'] }, { text: 'SECOND-HISTORY', images: ['after.png', 'latest.png'] }],
      transportFetch: async (source, init) => {
        const raw = await new Request(source, init).text(); wires.push(raw);
        const wire = JSON.parse(raw) as Record<string, unknown>;
        const primary = (JSON.stringify(wire.tools) ?? '').includes('todo_update');
        if (primary) main++;
        return nativeResponse([{ type: 'text', text: primary ? `GENUINE-REPLY-${main}` : '## Goal\nRetain the supplied screenshot chronology.\n## Progress\nTwo genuine history rounds completed.\n## Next steps\nRead originals to answer the final question.' }], wire.stream === true);
      } });
    expect(result.compaction?.compacted).toBe(true);
    expect(result.historyResponses).toEqual([1, 1]);
    expect(result.mainResponses).toBe(1);
    expect(wires[0]).toContain('FIRST-HISTORY');
    expect(wires[0]).not.toContain('FINAL-QUESTION');
    const second = wires.find(wire => wire.includes('SECOND-HISTORY'))!;
    expect(second).toContain('GENUINE-REPLY-1');
    expect(second).toContain('base64');
    expect(result.responses.some(value => value.kind === 'compaction' && value.request.includes('GENUINE-REPLY-1'))).toBe(true);
    expect(result.answer).toBe('GENUINE-REPLY-3');
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it.each([
  { name: 'spawn_agent', input: { task: 'make another call' } },
  { name: 'tool_call', input: { tool_name: 'spawn_agent', arguments: { task: 'make another call' } } },
])('blocks child generation at execution, including bridge aliases: $name', async tool => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-child-'));
  let calls = 0;
  try {
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'Inspect the fixture.', transportFetch: async (source, init) => {
        calls++; const wire = JSON.parse(await new Request(source, init).text()) as Record<string, unknown>;
        return nativeResponse([{ type: 'tool_use', id: 'child', ...tool }], wire.stream === true);
      } });
    expect(result.error?.message).toContain('Child/workflow generation');
    expect(calls).toBe(1);
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('allows each historical round to read real evidence and answer before compaction and the final task', async () => {
  vi.stubEnv('KIMI_API_KEY', 'offline-test-key');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-history-tools-'));
  let primaryCalls = 0;
  try {
    const png = await new Jimp({ width: 32, height: 32, color: 0xffffffff }).getBuffer('image/png');
    await writeFile(path.join(directory, 'preview.png'), png);
    await writeFile(path.join(directory, 'round-1.txt'), 'Build r205 on release/sep-export');
    await writeFile(path.join(directory, 'round-2.txt'), 'Build r206 on release/sep-export');
    const result = await runNativeTaskCell({ workspace: directory, home: path.join(directory, 'home'), provider: 'kimi-code', model: 'kimi-for-coding',
      prompt: 'FINAL-HISTORY-QUESTION', historyResponsesPerRound: 2,
      history: [{ text: 'FIRST-HISTORY: inspect round-1.txt and retain this preview.', images: ['preview.png'] },
        { text: 'SECOND-HISTORY: inspect round-2.txt and retain this preview.', images: ['preview.png'] }],
      transportFetch: async (source, init) => {
        const request = new Request(source, init);
        if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 });
        const raw = await request.text();
        const wire = JSON.parse(raw) as Record<string, unknown>;
        if (!(JSON.stringify(wire.tools) ?? '').includes('todo_update')) {
          return nativeResponse([{ type: 'text', text: '## Goal\nRetain the supplied previews and actual build identities.\n## Progress\nThe first historical round read its manifest and identified build r205 on release/sep-export.\n## Next steps\nCompare original evidence when the final question arrives.' }], wire.stream === true);
        }
        primaryCalls++;
        if (primaryCalls <= 4) expect(raw).not.toContain('FINAL-HISTORY-QUESTION');
        if (primaryCalls === 1 || primaryCalls === 3) return nativeResponse([{ type: 'tool_use', id: `history-read-${primaryCalls}`,
          name: 'read', input: { path: primaryCalls === 1 ? 'round-1.txt' : 'round-2.txt' } }], wire.stream === true);
        if (primaryCalls === 2) expect(raw).toContain('Build r205 on release/sep-export');
        if (primaryCalls === 4) expect(raw).toContain('Build r206 on release/sep-export');
        return nativeResponse([{ type: 'text', text: primaryCalls === 2 ? 'The first preview belongs to build r205 on release/sep-export.'
          : primaryCalls === 4 ? 'The second preview belongs to build r206 on release/sep-export.' : 'The retained build evidence is ready for comparison.' }], wire.stream === true);
      } });
    expect(result.historyResponses).toEqual([2, 2]);
    expect(result.historyResults.map(round => round.result.phase)).toEqual(['completed', 'completed']);
    expect(result.tools.map(tool => tool.content).join('\n')).toContain('Build r205');
    expect(result.tools.map(tool => tool.content).join('\n')).toContain('Build r206');
    expect(result.compaction?.compacted).toBe(true);
    expect(result.responses.some(response => response.kind === 'compaction' && response.request.includes('The first preview belongs to build r205'))).toBe(true);
    expect(result.mainResponses).toBe(1);
    expect(result.answer).toBe('The retained build evidence is ready for comparison.');
    expect(result.backgroundSettled).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
