import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { KodaXBaseProvider, registerModelProvider, runWithProviderRequestAttribution,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult,
  type KodaXReasoningRequest, type KodaXProviderStreamOptions } from '@kodax-ai/llm';
import { currentProviderRequestAttribution } from '../packages/llm/src/provider-request-observation.js';
import { SkillRegistry, type ToolGuardrail } from '@kodax-ai/agent';
import { createKodaXRuntime, type KodaXRuntime } from '../src/sdk-runtime.js';
import { resolveToolBridgeTarget } from '../packages/coding/src/tools/tool-bridge.js';
import type { KodaXOptions } from '../packages/coding/src/types.js';
import { parseBashCommand } from '../packages/coding/src/permissions/bash-ast.js';
import { checkComplexTool } from './first-turn-complex-guard.js';
import { prepareNaturalCase, RECOVERY_FILES } from '../benchmark/datasets/shared-contract-natural/fixture.js';
import { RECOVERY_ORACLE } from '../benchmark/datasets/shared-contract-natural/oracle.js';
import type { NaturalCaseId } from '../benchmark/datasets/shared-contract-natural/cases.js';
import type { FrozenInput } from './first-turn-eval-support.js';

const CONTROL_TOOLS = new Set(['spawn_agent', 'list_agents', 'wait_agent', 'send_message', 'interrupt_agent', 'agent_output',
  'todo_create', 'todo_update', 'todo_list', 'todo_get', 'ask_user_question', 'enter_plan_mode', 'exit_plan_mode',
  'tool_search', 'tool_describe', 'script_exec', 'undo']);
const MUTABLE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'insert_after_anchor']);
const DENIAL = 'No part of this command ran. This fixture permits read-only Git inspection and local tests; use built-in read/glob/grep for file inspection. Do not retry prohibited operations with aliases or another shell.';
const COMPOSITION_DENIAL = 'This fixture accepts one foreground command per call; command lists and pipelines are not supported. No part of this command ran. Changing the executable or alias does not permit command composition. Submit individually permitted commands separately. Each command must still satisfy the path, argument and read-only restrictions.';

/** Evaluation scope only, not a general sandbox for arbitrary hostile JavaScript. */
export function checkNaturalTool(workspace: string, name: string, input: Record<string, unknown>, readOnly: boolean, feedback: 'specific' | 'legacy' = 'specific'): string | null {
  const denied = checkNaturalToolPolicy(workspace, name, input, readOnly, feedback);
  if (denied !== null && readOnly && name === 'bash') {
    return `${denied} General tool availability does not override this child's read-only scope: repository execution remains unavailable. Changing the command does not change that boundary. Continue with permitted static inspection and report which execution checks were not run.`;
  }
  return denied;
}

function checkNaturalToolPolicy(workspace: string, name: string, input: Record<string, unknown>, readOnly: boolean, feedback: 'specific' | 'legacy'): string | null {
  if (MUTABLE_TOOLS.has(name)) {
    const paths = /^[A-Za-z]:[/\\]/.test(workspace) ? path.win32 : path;
    const target = typeof input.path === 'string' ? paths.relative(workspace, paths.resolve(workspace, input.path)).replaceAll('\\', '/') : '';
    if (readOnly || !/^(?:src|tests?)\/.+\.(?:js|mjs)$/.test(target)) return 'Only root source files and new tests may be changed.';
    if (!target.startsWith('src/') && Object.keys(RECOVERY_FILES).some(file => file.toLowerCase() === target.toLowerCase())) return 'Original public fixture files are protected; add a new regression test.';
    return null;
  }
  const existing = checkComplexTool(workspace, name, input, readOnly);
  // The public reproducer is immutable fixture code. This explicit exception
  // does not admit arbitrary node scripts, flags, shell pipelines or children.
  const windowsWorkspace = /^[A-Za-z]:[/\\]|^\\\\/.test(workspace);
  const publicReproducer = name === 'bash' && (input.command === 'node examples/restart.mjs'
    || (windowsWorkspace && input.command === 'node examples\\restart.mjs'));
  const parsed = name === 'bash' ? parseBashCommand(String(input.command)) : undefined;
  const composed = parsed && !parsed.unparseable && (parsed.statements.length > 1 || parsed.statements.some(statement => statement.stages.length > 1));
  if (existing !== null && !(publicReproducer && existing === 'Only local test execution is in scope.')) {
    if (feedback === 'specific' && existing === 'Only local test execution is in scope.' && composed) return COMPOSITION_DENIAL;
    return `${existing} No part of the denied operation ran.`;
  }
  if (name === 'spawn_agent' && (input.model_hint !== undefined || input.isolation === 'worktree')) return 'Children must be read-only and inherit the current provider/model in this fixture.';
  if (name === 'undo' && readOnly) return 'Read-only children cannot undo changes.';
  if (name !== 'bash') return ['read', 'glob', 'grep'].includes(name) || CONTROL_TOOLS.has(name) ? null : 'This tool is outside the isolated natural fixture scope.';
  if (input.run_in_background === true) return 'Use foreground execution so this fixture can retain the actual test receipt.';
  if (publicReproducer) return readOnly ? 'Read-only children cannot run repository code.' : null;
  if (!parsed || parsed.unparseable) return DENIAL;
  if (composed) return feedback === 'specific' ? COMPOSITION_DENIAL : DENIAL;
  if (parsed.statements.length !== 1 || parsed.statements[0]?.stages.length !== 1) return DENIAL;
  const stage = parsed.statements[0]?.stages[0];
  if (!stage || stage.redirections.length) return DENIAL;
  const [executable, operation, ...args] = stage.argv;
  if (executable === 'node' && operation === '--test' && args.every(arg => /^(?:\.\/)?tests?\/[\w./-]+\.(?:m?js)$/.test(arg))) return readOnly ? 'Read-only children cannot run repository code.' : null;
  if (executable === 'npm' && operation === 'test' && args.length === 0) return readOnly ? 'Read-only children cannot run repository code.' : null;
  if (executable !== 'git' || !['diff', 'status', 'show', 'log', 'ls-files', 'rev-parse', 'grep'].includes(operation ?? '')) return DENIAL;
  const safeFlags = /^(?:--(?:short|porcelain|stat|name-only|name-status|oneline|cached|staged|no-pager|no-ext-diff|no-textconv)|--(?:max-count|abbrev)=\d+|-n\d*|--|-[0-9]+)$/;
  if (args.some(arg => arg.startsWith('-') && !safeFlags.test(arg))) return DENIAL;
  return null;
}

export interface NaturalRuntimeOptions {
  /** Eval-only controlled feedback revision; admission and production tools are identical. */
  guardFeedback?: 'specific' | 'legacy';
  /** Offline continuity checks: real user turns in one Session, optionally reopening the host. */
  followUps?: readonly { prompt: string; permissionMode: 'plan' | 'full-access'; reopen?: boolean }[];
  workMode?: 'agent' | 'coding' | 'script';
  limits?: { calls: number; tools: number; timeoutMs: number };
  signal?: AbortSignal;
  model?: string;
  maxOutputTokens?: number;
  reasoning?: KodaXOptions['reasoningMode'];
  effort?: KodaXOptions['effort'];
}
export type NaturalInvoke = (input: FrozenInput, signal: AbortSignal, index: number, meta: {
  kind: 'root' | 'child' | 'auxiliary'; reasoning?: boolean | KodaXReasoningRequest; streamOptions?: KodaXProviderStreamOptions; taskSignal?: AbortSignal;
}) => Promise<KodaXStreamResult>;

/** Formal AMA Run with injected provider callback. No network/provider dispatch is built into this helper. */
export async function runNaturalRuntime(directory: string, id: NaturalCaseId, invoke: NaturalInvoke, options: NaturalRuntimeOptions = {}) {
  const relative = path.relative(os.tmpdir(), path.resolve(directory));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Natural evaluation output must stay in OS temporary storage');
  const limits = options.limits ?? { calls: 32, tools: 80, timeoutMs: 600_000 };
  if (Object.values(limits).some(value => !Number.isInteger(value) || value < 1)) throw new Error('Invalid natural Runtime limits');
  const started = Date.now();
  const prepared = await prepareNaturalCase(directory, id);
  const { workspace } = prepared;
  await fs.mkdir(path.join(workspace, '.git/info'), { recursive: true });
  await fs.appendFile(path.join(workspace, '.git/info/exclude'), '\n.agent/\n');
  const protectedFiles = Object.keys(RECOVERY_FILES).filter(file => !file.startsWith('src/'));
  const original = new Map(await Promise.all(protectedFiles.map(async file => [file, await fs.readFile(path.join(workspace, file), 'utf8')] as const)));
  const events: Record<string, unknown>[] = [];
  const runs: { sessionId: string; phase: string; requests: number }[] = [];
  const calls: { index: number; kind: 'root' | 'child' | 'auxiliary'; input: FrozenInput; result?: KodaXStreamResult; error?: string; wallMs?: number }[] = [];
  const counts = { requests: 0, rootRequests: 0, childRequests: 0, auxiliaryRequests: 0, tools: 0, scriptLeaves: 0, spawns: 0, maxConcurrentRequests: 0 };
  let concurrent = 0;
  let error: string | null = null;
  let success = false;
  let phase: string | undefined;
  let finalText = '';
  let runtime: KodaXRuntime | undefined;
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
  const timer = setTimeout(() => abort.abort(new Error('Natural Runtime timeout')), limits.timeoutMs);
  const snapshot = () => fs.writeFile(path.join(directory, 'runtime-live.json'), JSON.stringify({ counts, calls, events, error }, null, 2));
  const stop = (reason: string): never => { error ??= reason; abort.abort(new Error(reason)); throw new Error(reason); };
  const boundary: ToolGuardrail = { kind: 'tool', name: 'natural-fixture-boundary', beforeTool: async (call, context) => {
    if (signal.aborted) return { action: 'block', reason: 'Evaluation already stopped.' };
    const bridge = resolveToolBridgeTarget(call);
    if (bridge && !bridge.ok) return { action: 'block', reason: bridge.error };
    const target = bridge?.ok ? bridge.call : call;
    const attribution = currentProviderRequestAttribution();
    const readOnly = context.permissionIntent?.readOnly === true || (attribution?.kind === 'actor_turn' && attribution.actorPath !== '/root');
    counts.tools++;
    if (call.id.includes('script')) counts.scriptLeaves++;
    if (counts.tools > limits.tools) return stop('budget-censored: tool cap');
    let denied = checkNaturalTool(workspace, target.name, target.input, readOnly, options.guardFeedback);
    if (target.name === 'spawn_agent' && !denied) {
      if (counts.spawns >= 1) denied = 'At most one read-only inherited-model child per natural smoke.';
      else counts.spawns++;
    }
    events.push({ kind: 'guard', name: target.name, input: target.input, readOnly, denied });
    await snapshot();
    return denied ? { action: 'block', reason: denied } : { action: 'allow' };
  } };
  let tail = Promise.resolve();
  const providerName = `natural-runtime-${randomUUID()}`;
  class Wrapped extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = options.reasoning !== undefined && options.reasoning !== 'off';
    protected readonly config = { apiKeyEnv: 'KODAX_NATURAL_CALLBACK_ONLY', model: options.model ?? 'fixture', contextWindow: 128000, supportsThinking: this.supportsThinking };
    override isConfigured() { return true; } // All credentials/paid budgets belong to the explicit callback.
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, reasoning?: boolean | KodaXReasoningRequest, streamOptions?: KodaXProviderStreamOptions, requestSignal?: AbortSignal): Promise<KodaXStreamResult> {
      const prior = tail; let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      try {
        const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
        combined.throwIfAborted();
        if (counts.requests >= limits.calls) return stop('budget-censored: shared request cap');
        const attribution = currentProviderRequestAttribution();
        const kind = tools.some(tool => ['report_stall_judgment', 'commit_episode_learning_review'].includes(tool.name)) ? 'auxiliary'
          : attribution?.kind === 'actor_turn' && attribution.actorPath !== '/root' ? 'child' : 'root';
        // Child tools can carry executable SDK metadata. Providers consume only
        // these three definition fields; do not clone the handler into the wire snapshot.
        const input = structuredClone({ messages, tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })), system });
        const entry: (typeof calls)[number] = { index: counts.requests++, kind, input };
        counts[`${kind}Requests`]++;
        calls.push(entry);
        concurrent++; counts.maxConcurrentRequests = Math.max(counts.maxConcurrentRequests, concurrent);
        const start = Date.now();
        try { entry.result = await invoke(entry.input, combined, entry.index, { kind, reasoning, streamOptions, taskSignal: signal }); return entry.result; }
        catch (cause) { entry.error = cause instanceof Error ? cause.message : String(cause); throw cause; }
        finally { concurrent--; entry.wallMs = Date.now() - start; await snapshot(); }
      } finally { release(); }
    }
  }
  const unregister = registerModelProvider(providerName, () => new Wrapped());
  try {
    runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(directory, 'home'), defaultProvider: providerName, defaultModel: options.model ?? 'fixture' });
    const session = await runtime.sessions.create({ projectPath: workspace });
    await fs.mkdir(path.join(workspace, '.agent/tmp/sessions', session.id), { recursive: true });
    const turns = [{ prompt: [prepared.priorContext, prepared.prompt].filter(Boolean).join('\n\n'), permissionMode: 'full-access' as const, reopen: false }, ...(options.followUps ?? [])];
    for (const turn of turns) {
      if (turn.reopen) {
        await runtime.close();
        runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(directory, 'home'), defaultProvider: providerName, defaultModel: options.model ?? 'fixture' });
      }
      await runtime.sessions.updateSettings(session.id, { permissionMode: turn.permissionMode, executionCwd: workspace });
      const startRequests = counts.requests;
      const active = runtime;
      const handle = await runWithProviderRequestAttribution({ kind: 'actor_turn', actorPath: '/root', turnId: `natural-fixture-${randomUUID()}` }, () => active.runs.start({
        sessionId: session.id, mode: 'managed_task', prompt: turn.prompt,
        options: { provider: providerName, model: options.model ?? 'fixture', agentMode: 'ama', workMode: options.workMode ?? 'coding',
          lsp: false, reasoningMode: options.reasoning ?? 'off', effort: options.effort ?? 'none', maxIter: limits.calls, maxOutputTokens: options.maxOutputTokens ?? 4096, abortSignal: signal, disablePromptCache: true,
          guardrails: [boundary],
          learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['eval-isolated'] } }),
          context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', skillRegistry: new SkillRegistry(workspace), repoIntelligenceMode: 'off', resolveShellPermissionMode: () => turn.permissionMode },
          events: { onToolUseStart: (tool, meta) => { events.push({ kind: 'start', ...tool, meta }); }, onToolResult: (receipt, meta) => { events.push({ kind: 'result', ...receipt, meta }); } },
        },
      }));
      const settled = await handle.result;
      phase = settled.phase; success = settled.result?.success === true; finalText = settled.result?.lastText ?? '';
      if (settled.error) error ??= `${settled.error.name}: ${settled.error.message}`;
      runs.push({ sessionId: session.id, phase: settled.phase, requests: counts.requests - startRequests });
      if (settled.phase !== 'completed' || error) break;
    }
  } catch (cause) { error ??= cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause); abort.abort(cause); }
  finally { clearTimeout(timer); try { await runtime?.close(); } finally { unregister(); await snapshot(); } }
  // Only now create and execute the hidden oracle, outside the model workspace.
  const oraclePath = path.join(directory, 'oracle.mjs');
  await fs.writeFile(oraclePath, RECOVERY_ORACLE, { flag: 'wx' });
  const execute = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, ...env } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
  };
  const protectedUnchanged = (await Promise.all([...original].map(async ([file, bytes]) => await fs.readFile(path.join(workspace, file), 'utf8') === bytes))).every(Boolean);
  const record = { kind: 'natural-runtime-smoke-not-causal-comparison', workMode: options.workMode ?? 'coding', caseId: id,
    wallMs: Date.now() - started, prepared, success, phase, error, finalText, counts, calls, runs, events, protectedUnchanged,
    sourceSha256: createHash('sha256').update(await fs.readFile(path.join(workspace, 'src/recovery.js'))).digest('hex'),
    verification: { public: execute(workspace, ['--test']), oracle: execute(directory, ['--test', oraclePath], { NATURAL_ORACLE_WORKSPACE: workspace }) } };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
  return record;
}
