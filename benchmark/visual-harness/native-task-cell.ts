/** Benchmark adapter for an unmodified native provider and each frozen Runtime. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import type { ToolGuardrail } from '@kodax-ai/agent';
import { createKodaXRuntime, parseRuntimeEvent, type RuntimeCompactSessionResult, type RuntimeRunResult, type RuntimeStartRunInput } from '../../tests/runtime-fixture.js';
import { resolveToolBridgeTarget } from '../../packages/coding/src/tools/tool-bridge.js';
import { isNullDevice, parseBashCommand } from '../../packages/coding/src/permissions/bash-ast.js';
import { NativeRecoverableAuxiliaryError, parseNativeResponseEvents } from './native-task-transport.js';

export interface NativeTaskCellLimits {
  mainResponses: 8 | 12 | 24;
  historyResponsesPerRound: 1 | 2 | 4 | 24;
  maxTools: 32 | 64;
  toolTimeoutMs: 60_000 | 90_000;
  cellTimeoutMs: 720_000 | 1_500_000;
  maxOutputTokens: 4096 | 8192;
}

export interface NativeTaskCellInput {
  workspace: string;
  home: string;
  provider: 'deepseek' | 'kimi-code';
  model: string;
  prompt: string;
  /** Append a new input to an existing persisted session; never replay history. */
  resumeSessionId?: string;
  images?: string[];
  limits?: NativeTaskCellLimits;
  /** Legacy revision parameters; new revisions use the complete limits object. */
  mainResponses?: 8 | 12;
  maxOutputTokens?: 4096 | 8192;
  history?: readonly [{ text: string; images: string[] }, { text: string; images: string[] }];
  historyResponsesPerRound?: 1 | 2;
  /** Owns endpoint, call/token/spend limits, raw persistence and actual usage. */
  transportFetch: typeof fetch;
  signal?: AbortSignal;
}

let running = false;
const GENERATION_ENTRANCES = new Set(['spawn_agent', 'followup_task', 'send_message', 'run_workflow', 'test_agent']);

function responseToolCount(raw: string): number {
  return parseNativeResponseEvents(raw, !raw.trimStart().startsWith('{')).reduce((count, value) => {
    const block = value.content_block as { type?: string } | undefined;
    const content = Array.isArray(value.content) ? value.content as { type?: string }[] : [];
    return count + (value.type === 'content_block_start' && block?.type === 'tool_use' ? 1 : 0)
      + content.filter(item => item.type === 'tool_use').length;
  }, 0);
}

/** An auditable scope gate, not an OS sandbox for arbitrary generated scripts. */
function scopeDenial(workspace: string, readable: readonly string[], name: string, args: Record<string, unknown>): string | undefined {
  const inside = (root: string, value: string) => {
    const relative = path.relative(root, path.resolve(workspace, value));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  const readablePath = (value: string) => value.startsWith('kodax-transient://text/') || [workspace, ...readable].some(root => inside(root, value));
  if (['web_search', 'web_fetch'].includes(name)) return 'Network retrieval is outside the fixture scope.';
  const mutating = ['write', 'edit', 'multi_edit', 'insert_after_anchor'].includes(name);
  for (const field of ['path', 'file_path', 'input_path', 'output_path', 'target_path', 'cwd']) {
    const value = args[field];
    if (typeof value === 'string' && !(mutating || field === 'output_path' ? inside(workspace, value) : readablePath(value))) {
      return 'Path is outside the fixture and its permitted read-only resources.';
    }
  }
  if (name !== 'bash' || typeof args.command !== 'string') return undefined;
  const command = args.command;
  if (/https?:\/\/|\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|printenv)\b|\$env:|process\.env|os\.environ|GetEnvironmentVariables|\bEnv:|%[A-Za-z_][A-Za-z_0-9]*%/i.test(command)) {
    return 'Network and environment inspection are outside the fixture scope.';
  }
  const tree = parseBashCommand(command.replaceAll('\\', '/'));
  if (tree.unparseable) return 'Unsupported shell syntax at the fixture scope boundary; use a local script file.';
  for (const statement of tree.statements) for (const stage of statement.stages) {
    const executable = path.basename(stage.argv[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    if (['env', 'set', 'export', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet'].includes(executable)) return 'Environment or network command is outside the fixture scope.';
    for (const arg of stage.argv.slice(1)) {
      if ((/^[A-Za-z]:\/|^\/|(?:^|\/)\.\.(?:\/|$)/.test(arg)) && !readablePath(arg)) return 'Shell argument is outside the fixture scope.';
    }
    for (const redirect of stage.redirections) {
      if (redirect.descriptorDuplication || isNullDevice(redirect.target)) continue;
      if (!(redirect.input ? readablePath(redirect.target) : inside(workspace, redirect.target))) return 'Shell redirection is outside the fixture scope.';
    }
  }
  return undefined;
}

export async function runNativeTaskCell(input: NativeTaskCellInput) {
  if (input.resumeSessionId !== undefined && (!input.resumeSessionId.trim() || input.history !== undefined)) {
    throw new Error('A resumed native cell requires a nonempty session ID and no history replay.');
  }
  const limits: NativeTaskCellLimits = input.limits ? { ...input.limits } : {
    mainResponses: input.mainResponses ?? 8, historyResponsesPerRound: input.historyResponsesPerRound ?? 1,
    maxTools: 32, toolTimeoutMs: 60_000, cellTimeoutMs: 720_000, maxOutputTokens: input.maxOutputTokens ?? 4096,
  };
  if (![8, 12, 24].includes(limits.mainResponses) || ![1, 2, 4, 24].includes(limits.historyResponsesPerRound)
    || ![32, 64].includes(limits.maxTools) || ![60_000, 90_000].includes(limits.toolTimeoutMs)
    || ![720_000, 1_500_000].includes(limits.cellTimeoutMs) || ![4096, 8192].includes(limits.maxOutputTokens)) {
    throw new Error('Unregistered native cell limits.');
  }
  if (input.limits && ['mainResponses', 'historyResponsesPerRound', 'maxOutputTokens'].some(field => {
    const key = field as 'mainResponses' | 'historyResponsesPerRound' | 'maxOutputTokens';
    return input[key] !== undefined && input[key] !== limits[key];
  })) throw new Error('Conflicting legacy and explicit native cell limits.');
  const { mainResponses: maxMainResponses, maxOutputTokens, historyResponsesPerRound } = limits;
  if (running) throw new Error('Native cells require separate processes or serial execution.');
  running = true;
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  const started = Date.now();
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  let subscription: { close(): void } | undefined;
  let activeRunId: string | undefined;
  let stopping: Promise<unknown> | undefined;
  let stopped: Error | undefined;
  let mainResponses = 0;
  let toolCount = 0;
  let primarySequence = 0;
  const countedTools = new Set<string>();
  const historyResponses = [0, 0];
  let phase: 'history-0' | 'history-1' | 'compaction' | 'main' = 'main';
  let mainResult: { result: RuntimeRunResult; terminalMs: number } | undefined;
  const historyResults: { result: RuntimeRunResult; terminalMs: number }[] = [];
  let compaction: RuntimeCompactSessionResult | undefined;
  let settling = false;
  let backgroundSettled = false;
  let backgroundFailure: { phase: string; error: Error } | undefined;
  const auxiliaryFailures: { phase: string; toolName?: NativeRecoverableAuxiliaryError['toolName']; requestSha256?: string; message: string }[] = [];
  const responses: { kind: string; request: string; response: string; status: number }[] = [];
  const events: unknown[] = [];
  const tools: { id: string; name: string; content: string }[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stop = (error: unknown) => {
    stopped ??= error instanceof Error ? error : new Error(String(error));
    if (settling) backgroundFailure ??= { phase, error: stopped };
    controller.abort(stopped);
    return stopped;
  };
  const abortRun = () => {
    if (activeRunId && runtime) stopping = runtime.runs.abort(activeRunId).catch(error => { stopped ??= error instanceof Error ? error : new Error(String(error)); });
  };
  controller.signal.addEventListener('abort', abortRun);
  const externalAbort = () => stop(input.signal?.reason ?? new Error('Transport stopped the cell.'));
  input.signal?.addEventListener('abort', externalAbort, { once: true });
  if (input.signal?.aborted) externalAbort();
  const overallTimer = setTimeout(() => stop(new Error(`Cell exceeded ${limits.cellTimeoutMs / 60_000} minutes.`)), limits.cellTimeoutMs);
  globalThis.fetch = async (source, init) => {
    if (stopped) throw stopped;
    let backgroundRequest = false;
    try {
      const request = new Request(source, init);
      const raw = request.method === 'POST' ? await request.clone().text() : '';
      const wire = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const primary = request.method === 'POST' && new URL(request.url).pathname.endsWith('/messages')
        && (JSON.stringify(wire.tools) ?? '').includes('todo_update');
      backgroundRequest = !primary && phase !== 'compaction' && (JSON.stringify(wire.tools) ?? '').includes('commit_episode_learning_review');
      if (primary) {
        primarySequence++;
        if (phase === 'main') {
          if (mainResponses >= maxMainResponses) throw new Error(`${maxMainResponses} main response slots exhausted.`);
          mainResponses++;
        } else if (phase === 'history-0' || phase === 'history-1') {
          const index = phase === 'history-0' ? 0 : 1;
          if (historyResponses[index]! >= historyResponsesPerRound) throw new Error(`${historyResponsesPerRound} history response slots exhausted.`);
          historyResponses[index]!++;
        }
      }
      const response = await input.transportFetch(request, { signal: AbortSignal.any([request.signal, controller.signal]) });
      const text = await response.clone().text();
      responses.push({ kind: primary ? phase : phase === 'compaction' ? 'compaction' : 'auxiliary', request: raw, response: text, status: response.status });
      if (primary && responseToolCount(text) > 8) throw new Error('Eight tool calls per response exceeded.');
      return response;
    } catch (error) {
      if (error instanceof NativeRecoverableAuxiliaryError) {
        if (!error.requestSha256 || !auxiliaryFailures.some(failure => failure.requestSha256 === error.requestSha256)) {
          auxiliaryFailures.push({ phase, toolName: error.toolName, requestSha256: error.requestSha256, message: error.message });
        }
        if (backgroundRequest || settling) backgroundFailure ??= { phase, error };
        throw error;
      }
      if (backgroundRequest) backgroundFailure ??= { phase, error: error instanceof Error ? error : new Error(String(error)) };
      throw stop(error);
    }
  };
  try {
    runtime = await createKodaXRuntime({ homeDir: input.home, sharedDaemonHost: true,
      defaultProvider: input.provider, defaultModel: input.model });
    const session = input.resumeSessionId
      ? await runtime.sessions.load(input.resumeSessionId)
      : await runtime.sessions.create({ title: 'Visual task value', surface: 'repl', projectPath: input.workspace });
    await runtime.sessions.updateSettings(session.id, { provider: input.provider, model: input.model, agentMode: 'ama',
      workMode: 'coding', executionCwd: input.workspace, permissionMode: 'full-access', reasoningMode: 'deep', effort: 'high', maxIter: maxMainResponses });
    subscription = runtime.events.subscribe({ sessionId: session.id }, raw => {
      events.push(raw);
      const parsed = parseRuntimeEvent(raw);
      if (!parsed.ok) { stop(new Error(parsed.error)); return; }
      const event = parsed.event;
      if (event.runId) activeRunId = event.runId;
      if (event.type === 'tool.started') {
        const tool = event.payload.tool;
        timers.set(tool.id, setTimeout(() => stop(new Error(`Tool ${tool.name} exceeded ${limits.toolTimeoutMs / 1000} seconds.`)), limits.toolTimeoutMs));
      }
      if (event.type === 'tool.finished') {
        const result = event.payload.result;
        clearTimeout(timers.get(result.id)); timers.delete(result.id);
        tools.push({ id: result.id, name: result.name, content: result.content });
      }
    });
    const activeRuntime = runtime;
    const readable = [fileURLToPath(new URL('../../packages/agent/src/capabilities/skills/builtin/', import.meta.url)),
      path.join(input.home, '.kodax', 'sessions', session.id)];
    const boundary: ToolGuardrail = { kind: 'tool', name: 'native-eval-execution-boundary', beforeTool: async call => {
      if (stopped) return { action: 'block', reason: stopped.message };
      let target = call;
      for (let depth = 0; depth < 8; depth++) {
        if (GENERATION_ENTRANCES.has(target.name)) return { action: 'block', reason: stop(new Error('Child/workflow generation is outside the frozen call graph.')).message };
        const bridge = resolveToolBridgeTarget(target);
        if (!bridge?.ok) break;
        target = bridge.call;
        if (depth === 7) return { action: 'block', reason: stop(new Error('Tool bridge nesting exceeds the execution boundary.')).message };
      }
      // Runtime rechecks guardrails at admission and execution; count a concrete
      // call once per response, including dynamically dispatched Script leaves.
      const key = `${phase}:${primarySequence}:${target.id}`;
      if (!countedTools.has(key)) {
        if (toolCount >= limits.maxTools) return { action: 'block', reason: stop(new Error(`${limits.maxTools === 32 ? 'Thirty-two' : 'Sixty-four'} total tool calls exceeded.`)).message };
        countedTools.add(key); toolCount++;
      }
      const denied = scopeDenial(input.workspace, readable, target.name, target.input);
      return denied ? { action: 'block', reason: denied } : { action: 'allow' };
    } };
    const settle = async () => {
      settling = true;
      backgroundSettled = false;
      try {
        while ((await activeRuntime.status.preflight()).pendingBackgroundWork !== 0) {
          if (Date.now() - started >= limits.cellTimeoutMs) throw stop(new Error('Background settlement deadline exceeded.'));
          await pause(20);
        }
        backgroundSettled = true;
      } catch (error) {
        backgroundFailure ??= { phase, error: error instanceof Error ? error : new Error(String(error)) };
        throw error;
      } finally { settling = false; }
    };
    const run = async (text: string, images: readonly string[] | undefined, inputId: string, maxIter: number) => {
      if (stopped) throw stopped;
      backgroundSettled = false;
      const artifacts = images?.map(file => ({ kind: 'image' as const, path: path.resolve(input.workspace, file), mediaType: 'image/png' as const }));
      // acceptInput delegates this same product admission to startRun, but cannot
      // carry the host-only execution guardrail required by a bounded eval.
      const start: RuntimeStartRunInput & { productInput: { sessionId: string; inputId: string; text: string; inputArtifacts: typeof artifacts } } = {
        sessionId: session.id, prompt: text, permissionBroker: 'runtime',
        productInput: { sessionId: session.id, inputId, text, inputArtifacts: artifacts },
        options: { maxIter, maxOutputTokens, abortSignal: controller.signal, guardrails: [boundary], context: { inputArtifacts: artifacts, rawUserInput: text } },
      };
      const handle = await activeRuntime.runs.start(start);
      activeRunId = handle.runId;
      const result = await handle.result;
      const terminalMs = Date.now() - started;
      const outcome = { result, terminalMs };
      if (phase === 'main') mainResult = outcome;
      else historyResults.push(outcome);
      await settle();
      return outcome;
    };
    if (input.history) {
      for (const [index, round] of input.history.entries()) {
        phase = index === 0 ? 'history-0' : 'history-1';
        const historical = await run(round.text, round.images, phase, historyResponsesPerRound);
        if (historical.result.phase !== 'completed' || stopped) throw stop(new Error(`History round ${index + 1} did not complete.`));
      }
      phase = 'compaction';
      backgroundSettled = false;
      compaction = await runtime.sessions.compact({ sessionId: session.id, provider: input.provider, model: input.model, triggerTokens: 1 });
      await settle();
      if (!compaction.compacted) throw stop(new Error(`Historical compaction did not run: ${compaction.reason}`));
    }
    phase = 'main';
    await run(input.prompt, input.images, input.resumeSessionId ? `controlled-continuation-${randomUUID()}` : 'controlled-task', maxMainResponses);
  } catch (error) {
    stop(error);
  } finally {
    controller.signal.removeEventListener('abort', abortRun);
    input.signal?.removeEventListener('abort', externalAbort);
    try { await stopping; await runtime?.close(); }
    catch (error) {
      backgroundFailure ??= { phase: 'cleanup', error: error instanceof Error ? error : new Error(String(error)) };
      stop(error);
    }
    finally {
      subscription?.close(); clearTimeout(overallTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      globalThis.fetch = previousFetch;
      running = false;
    }
  }
  return { answer: mainResult?.result.result?.lastText ?? '', limits, phase, tools, toolCount, events, responses, auxiliaryFailures,
    mainResponses, historyResponses, historyResults, compaction, result: mainResult?.result,
    runTerminalMs: mainResult?.terminalMs ?? null,
    visibleCompletionMs: mainResult?.result.phase === 'completed' ? mainResult.terminalMs : null,
    settledMs: backgroundSettled ? Date.now() - started : null, backgroundSettled,
    backgroundError: backgroundFailure ? { kind: 'background-error', phase: backgroundFailure.phase, message: backgroundFailure.error.message } : undefined,
    error: stopped ? { kind: 'controlled-stop', phase, message: stopped.message } : undefined };
}
