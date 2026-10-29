/** Historical-version adapter: production Runtime/tools, bounded main response slots. */
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseToolInputWithSalvage, registerCustomProviders, type KodaXMessage } from '@kodax-ai/llm';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createSessionLineage } from '@kodax-ai/agent';
import { createKodaXRuntime, parseRuntimeEvent } from '../../src/sdk-runtime.js';

export interface ProposedMessage {
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
  finishReason?: string;
}
export interface TaskCellInput {
  workspace: string; home: string; prompt: string; images?: string[];
  history?: { text: string; image: string }[];
  respond: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<ProposedMessage>;
}

const GENERATION_ENTRANCES = new Set(['spawn_agent', 'followup_task', 'send_message', 'run_workflow', 'test_agent']);
function requestsChildGeneration(name: string, input: unknown): boolean {
  if (GENERATION_ENTRANCES.has(name)) return true;
  if (name !== 'tool_call' || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const target = input as Record<string, unknown>;
  return typeof target.name === 'string' && requestsChildGeneration(target.name, target.input);
}

export async function runTaskCell(input: TaskCellInput) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.KODAX_TASK_CELL_KEY;
  process.env.KODAX_TASK_CELL_KEY = 'transport-is-owned-by-eval';
  const controller = new AbortController();
  let mainResponses = 0; let stopped: Error | undefined;
  const requestKinds: string[] = [];
  let preparingHistory = false;
  const tools: { id: string; name: string; content: string }[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let answer = '';
  globalThis.fetch = async (source, init) => {
    if (stopped) throw stopped;
    try {
      const url = typeof source === 'string' ? source : source instanceof URL ? source.href : source.url;
      if (!url.startsWith('https://task-cell.invalid/')) throw new Error(`Unregistered task HTTP: ${new URL(url).origin}`);
      const raw = typeof init?.body === 'string' ? init.body : source instanceof Request ? await source.text() : '';
      const request = JSON.parse(raw) as Record<string, unknown>;
      const primary = (JSON.stringify(request.tools) ?? '').includes('todo_update');
      requestKinds.push(primary ? 'main' : preparingHistory ? 'compaction' : 'auxiliary');
      if (primary && mainResponses >= 3) throw new Error('Three main response slots exhausted.');
      if (primary) mainResponses++;
      const message = await input.respond(request, init?.signal ?? undefined);
      if ((message.tool_calls?.length ?? 0) > 2) throw new Error('Two tool calls per response exceeded.');
      if (message.tool_calls?.some(tool => requestsChildGeneration(tool.function.name,
        tool.function.name === 'tool_call' ? parseToolInputWithSalvage(tool.function.arguments) : undefined))) {
        throw new Error('Child/workflow generation is outside the frozen call graph (including capability bridges).');
      }
      const usage = message.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const finishReason = message.finishReason ?? (message.tool_calls?.length ? 'tool_calls' : 'stop');
      const publicMessage = { role: 'assistant', content: message.content, tool_calls: message.tool_calls };
      // JSON transport is also accepted by compaction/review. Streaming clients get
      // a lossless envelope around the same provider message; no tool text is changed.
      if (!request.stream) return Response.json({ id: 'cell', model: request.model,
        choices: [{ index: 0, message: publicMessage, finish_reason: finishReason }], usage });
      const delta = { role: 'assistant', content: message.content, ...(message.tool_calls?.length
        ? { tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) } : {}) };
      const events = [{ id: 'cell', model: request.model, choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } catch (error) {
      stopped = error instanceof Error ? error : new Error(String(error));
      controller.abort(stopped); throw stopped;
    }
  };
  const started = Date.now();
  const budgetMs = input.history ? 360_000 : 300_000;
  const overallTimer = setTimeout(() => controller.abort(new Error('Task wall-clock budget exhausted.')), budgetMs);
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  let subscription: { close(): void } | undefined;
  let activeRunId: string | undefined;
  let stopping: Promise<unknown> | undefined;
  let executionFailure: unknown;
  const abortRun = () => { if (activeRunId && runtime) stopping = runtime.runs.abort(activeRunId).catch(error => { stopped = error instanceof Error ? error : new Error(String(error)); }); };
  controller.signal.addEventListener('abort', abortRun);
  try {
    runtime = await createKodaXRuntime({ homeDir: input.home, sharedDaemonHost: true,
      defaultProvider: 'visual-task', defaultModel: 'kimi-for-coding' });
    await runtime.catalog.upsertCustomProvider({ name: 'visual-task', protocol: 'openai',
      model: 'kimi-for-coding', baseUrl: 'https://task-cell.invalid/v1', apiKeyEnv: 'KODAX_TASK_CELL_KEY',
      contextWindow: 128_000, imageInput: true, reasoning: 'none', maxOutputTokens: 2048, maxOutputTokensField: 'max_tokens' });
    const session = await runtime.sessions.create({ title: 'Visual task value', surface: 'repl', projectPath: input.workspace });
    await runtime.sessions.updateSettings(session.id, { provider: 'visual-task', model: 'kimi-for-coding', agentMode: 'ama',
      workMode: 'coding', executionCwd: input.workspace, permissionMode: 'full-access', reasoningMode: 'off', maxIter: 3 });
    let compaction: Awaited<ReturnType<typeof runtime.sessions.compact>> | undefined;
    if (input.history) {
      // Controlled history import uses each revision's real admission/storage, not
      // a hand-written summary. There were no model-generated warm-up turns.
      const sessionsDir = path.join(input.home, '.kodax', 'sessions');
      const storage = new FileSessionStorage({ sessionsDir, configHome: path.join(input.home, '.kodax') });
      let saved = (await storage.load(session.id))!;
      const helper = fileURLToPath(new URL('../../src/runtime-visual-input.ts', import.meta.url));
      for (const [index, frame] of input.history.entries()) {
        const content: KodaXMessage['content'] = [{ type: 'text', text: frame.text },
          { type: 'image', path: path.join(input.workspace, frame.image), mediaType: 'image/png' }];
        let admitted: KodaXMessage['content'] = content;
        if (existsSync(helper)) {
          const module = await import(/* @vite-ignore */ pathToFileURL(helper).href) as typeof import('../../src/runtime-visual-input.js');
          const prepared = await module.prepareRuntimeVisualInput({ sessionId: session.id, inputId: `history-${index}`,
            sessionsDir, content, session: saved });
          admitted = prepared.content;
          saved.extensionRecords = [...(saved.extensionRecords ?? []), ...prepared.records];
        }
        saved.messages.push({ role: 'user', content: admitted, inputId: `history-${index}` }, { role: 'assistant', content: '截图已接收，保留用于后续排查。' });
        saved.lineage = createSessionLineage(saved.messages);
        await storage.save(session.id, saved); saved = (await storage.load(session.id))!;
      }
      for (let index = 0; index < 8; index++) {
        saved.messages.push({ role: 'user', content: `后台健康检查 ${index}: ` + '队列服务正常，工作节点心跳正常，没有删除作业，存储校验通过。'.repeat(30) },
          { role: 'assistant', content: '已记录健康检查。' });
      }
      saved.lineage = createSessionLineage(saved.messages);
      await storage.save(session.id, saved);
      preparingHistory = true;
      compaction = await runtime.sessions.compact({ sessionId: session.id, provider: 'visual-task', model: 'kimi-for-coding',
        contextWindow: 128_000, triggerTokens: 5000 });
      preparingHistory = false;
      if (!compaction.compacted) throw new Error(`Historical compaction did not run: ${compaction.reason}`);
    }
    subscription = runtime.events.subscribe({ sessionId: session.id }, raw => {
      const parsed = parseRuntimeEvent(raw);
      if (!parsed.ok) { stopped = new Error(parsed.error); controller.abort(stopped); return; }
      const event = parsed.event;
      activeRunId = event.runId;
      if (event.type === 'assistant.delta') answer += event.payload.text;
      if (event.type === 'tool.started') {
        const tool = event.payload.tool;
        timers.set(tool.id, setTimeout(() => controller.abort(new Error('Tool exceeded 10 seconds.')), 10_000));
      }
      if (event.type === 'tool.finished') {
        const result = event.payload.result;
        clearTimeout(timers.get(result.id)); timers.delete(result.id);
        tools.push({ id: result.id, name: result.name, content: result.content });
      }
    });
    const accepted = await runtime.runs.acceptInput({ sessionId: session.id, inputId: 'controlled-task', text: input.prompt,
      inputArtifacts: input.images?.map(file => ({ kind: 'image', path: path.join(input.workspace, file), mediaType: 'image/png' })) });
    if (!accepted.runId) throw new Error('Product input did not start its controlled run.');
    activeRunId = accepted.runId;
    const result = await runtime.runs.await(accepted.runId);
    const runTerminalMs = Date.now() - started;
    const visibleCompletionMs = result.phase === 'completed' ? runTerminalMs : null;
    // preflight exposes actual owned work, unlike the bounded void drain helper.
    while ((await runtime.status.preflight()).pendingBackgroundWork !== 0) {
      if (Date.now() - started > budgetMs) throw new Error('Background settlement deadline exceeded.');
      await pause(20);
    }
    return { answer: result.result?.lastText ?? answer, tools, mainResponses, runTerminalMs, visibleCompletionMs, settledMs: Date.now() - started,
      backgroundSettled: true, compaction, requestKinds, result,
      error: stopped ? { kind: 'controlled-stop', message: stopped.message } : undefined };
  } catch (error) {
    executionFailure = error; throw error;
  } finally {
    controller.signal.removeEventListener('abort', abortRun);
    try {
      await stopping;
      await runtime?.close();
    } catch (cleanupError) {
      if (executionFailure !== undefined) throw new AggregateError([executionFailure, cleanupError], 'Task execution and cleanup both failed.');
      throw cleanupError;
    } finally {
      subscription?.close();
      clearTimeout(overallTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.KODAX_TASK_CELL_KEY;
      else process.env.KODAX_TASK_CELL_KEY = previousKey;
      registerCustomProviders([]);
    }
  }
}
