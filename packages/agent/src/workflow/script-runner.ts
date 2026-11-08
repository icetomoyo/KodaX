import { Script, createContext } from 'node:vm';

import type {
  WorkflowApi,
  WorkflowArtifactRef,
  WorkflowBudget,
  WorkflowLogEvent,
  WorkflowModule,
  WorkflowSpawnAgentInput,
  WorkflowSynthesizeInput,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskVerification,
  WorkflowTaskSnapshot,
  WorkflowWaitOptions,
} from './types.js';
import type { WorkflowScriptManifest } from './manifest.js';
import { validateWorkflowScriptManifest } from './manifest.js';
import { assertRestrictedWorkflowQuality } from './quality-lint.js';
import { WorkflowAbortError } from './runtime.js';

export class WorkflowScriptExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowScriptExecutionError';
  }
}

export interface RunRestrictedWorkflowScriptOptions {
  readonly source: string;
  readonly wf: WorkflowApi;
  readonly args?: unknown;
  readonly filename?: string;
  /** Optional explicit wall-clock cap. Default workflows are open-ended. */
  readonly timeoutMs?: number;
}

export interface RestrictedWorkflowModuleInput {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly timeoutMs?: number;
}

export interface ValidateRestrictedWorkflowSourceOptions {
  readonly filename?: string;
  readonly requireAsyncRun?: boolean;
  readonly checkSourcePolicy?: boolean;
}

export const DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS = 10_000;

const FORBIDDEN_RESTRICTED_SOURCE_PATTERNS: readonly {
  readonly id: string;
  readonly pattern: RegExp;
}[] = [
  { id: 'import', pattern: /\bimport\s*(?:\(|['"*{]|\w+\s+from\b)/ },
  { id: 'require', pattern: /\brequire\s*\(/ },
  { id: 'process', pattern: /\bprocess\s*(?:\.|\[)/ },
  { id: 'fs', pattern: /\b(?:node:)?fs\b/ },
  { id: 'child_process', pattern: /\bchild_process\b/ },
  { id: 'shell', pattern: /\b(?:exec|spawn|execFile)\s*\(/ },
  { id: 'fetch', pattern: /\bfetch\s*\(/ },
  { id: 'Deno', pattern: /\bDeno\s*(?:\.|\[)/ },
  { id: 'Bun', pattern: /\bBun\s*(?:\.|\[)/ },
  // Computed `globalThis[...]` access smuggles a stripped string key (e.g.
  // `globalThis["process"]`) past the token checks above, then hits an
  // undefined sandbox global at runtime and throws a cryptic
  // `Cannot read properties of undefined`. Reject it at validation. Dot access
  // (`globalThis.Math`) is intentionally still allowed for the determinism guard.
  { id: 'globalThis-index', pattern: /\bglobalThis\s*\[/ },
];

function wrapSource(source: string): string {
  return [
    '"use strict";',
    source,
    'if (typeof run !== "function") {',
    '  throw new Error("restricted workflow script must define async function run(wf, args)");',
    '}',
    'Promise.resolve(run(wf, args));',
  ].join('\n');
}

type WorkflowRpcMethod =
  | 'artifact'
  | 'log'
  | 'output'
  | 'phaseEnter'
  | 'phaseExit'
  | 'runAgent'
  | 'send'
  | 'snapshot'
  | 'spawnAgent'
  | 'stop'
  | 'synthesize'
  | 'wait'
  | 'workflow';

interface WorkflowRpcCommand {
  readonly id: string;
  readonly method: WorkflowRpcMethod;
  readonly input: unknown;
}

interface WorkflowRpcEnvelope {
  readonly value: unknown;
  readonly budget: {
    readonly spent: number;
    readonly remaining: number | null;
  };
}

interface WorkflowRpcPhaseScope {
  close(): void;
  readonly finished: Promise<void>;
  failure(): unknown;
}

interface WorkflowRpcHostState {
  readonly openPhases: Map<string, WorkflowRpcPhaseScope>;
  nextPhaseToken(): string;
}

function jsonStringify(value: unknown, label: string): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptExecutionError(`${label} must be JSON-serializable: ${message}`);
  }
}

function jsonClone(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(jsonStringify(value, label)) as unknown;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new WorkflowScriptExecutionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowScriptExecutionError(`workflow command ${key} must be a non-empty string`);
  }
  return value;
}

/** Require a non-empty string field, attributing the error to `label`. */
function readNonEmptyField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowScriptExecutionError(`${label} ${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new WorkflowScriptExecutionError(`${label} ${key} must be a boolean when provided`);
  }
  return value;
}

function readOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new WorkflowScriptExecutionError(`${label} ${key} must be a positive integer when provided`);
  }
  return value;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new WorkflowScriptExecutionError(`${label} ${key} must be an array of non-empty strings when provided`);
  }
  return value as readonly string[];
}

function readTaskVerification(value: unknown, label: string): WorkflowTaskVerification {
  const record = readRecord(value, label);
  const enforcement = record.enforcement;
  if (
    enforcement !== undefined &&
    enforcement !== 'hard' &&
    enforcement !== 'warn'
  ) {
    throw new WorkflowScriptExecutionError(`${label} enforcement must be "hard" or "warn" when provided`);
  }
  const requiresMutation = readOptionalBoolean(record, 'requiresMutation', label);
  const requiredChangedPaths = readOptionalStringArray(record, 'requiredChangedPaths', label);
  const requiredReadPaths = readOptionalStringArray(record, 'requiredReadPaths', label);
  const minFinalTextChars = readOptionalPositiveInteger(record, 'minFinalTextChars', label);
  const rejectPreparatoryFinalText = readOptionalBoolean(record, 'rejectPreparatoryFinalText', label);
  return {
    ...(enforcement !== undefined ? { enforcement } : {}),
    ...(requiresMutation !== undefined ? { requiresMutation } : {}),
    ...(requiredChangedPaths !== undefined ? { requiredChangedPaths } : {}),
    ...(requiredReadPaths !== undefined ? { requiredReadPaths } : {}),
    ...(minFinalTextChars !== undefined ? { minFinalTextChars } : {}),
    ...(rejectPreparatoryFinalText !== undefined ? { rejectPreparatoryFinalText } : {}),
  };
}

/** Validate a `WorkflowSpawnAgentInput` payload at the host boundary so a
 *  malformed generated call fails loudly with a clear message instead of
 *  silently spawning a real child agent with an undefined name/prompt. */
function readSpawnAgentInput(value: unknown, label: string): WorkflowSpawnAgentInput {
  const record = readRecord(value, label);
  const input: {
    name: string;
    phase?: string;
    prompt: string;
    scopeSummary?: string;
    constraints?: readonly string[];
    readOnly?: boolean;
    subagentType?: string;
    target?: WorkflowSpawnAgentInput['target'];
    modelHint?: WorkflowSpawnAgentInput['modelHint'];
    isolation?: WorkflowSpawnAgentInput['isolation'];
    evidenceRefs?: readonly string[];
    verification?: WorkflowTaskVerification;
    outputSchema?: unknown;
    effort?: string;
    terseResult?: boolean;
  } = {
    name: readNonEmptyField(record, 'name', label),
    prompt: readNonEmptyField(record, 'prompt', label),
  };
  if (record.phase !== undefined) {
    input.phase = readNonEmptyField(record, 'phase', label);
  }
  if (record.scopeSummary !== undefined) {
    input.scopeSummary = readNonEmptyField(record, 'scopeSummary', label);
  }
  if (record.constraints !== undefined) {
    input.constraints = readOptionalStringArray(record, 'constraints', label);
  }
  if (record.readOnly !== undefined) {
    if (typeof record.readOnly !== 'boolean') {
      throw new WorkflowScriptExecutionError(`${label} readOnly must be a boolean when provided`);
    }
    input.readOnly = record.readOnly;
  }
  if (record.subagentType !== undefined) {
    input.subagentType = readNonEmptyField(record, 'subagentType', label);
  }
  if (record.target !== undefined) {
    const target = readRecord(record.target, `${label} target`);
    input.target = {
      agentId: readNonEmptyField(target, 'agentId', `${label} target`),
      ...(target.expectedConfigurationRevision !== undefined
        ? {
            expectedConfigurationRevision: readNonEmptyField(
              target,
              'expectedConfigurationRevision',
              `${label} target`,
            ),
          }
        : {}),
    };
  }
  if (record.modelHint !== undefined) {
    input.modelHint = readNonEmptyField(record, 'modelHint', label) as WorkflowSpawnAgentInput['modelHint'];
  }
  if (record.isolation !== undefined) {
    input.isolation = readNonEmptyField(record, 'isolation', label) as WorkflowSpawnAgentInput['isolation'];
  }
  if (record.effort !== undefined) {
    input.effort = readNonEmptyField(record, 'effort', label);
  }
  if (record.evidenceRefs !== undefined) {
    if (
      !Array.isArray(record.evidenceRefs) ||
      record.evidenceRefs.some((ref) => typeof ref !== 'string')
    ) {
      throw new WorkflowScriptExecutionError(`${label} evidenceRefs must be an array of strings when provided`);
    }
    input.evidenceRefs = record.evidenceRefs as readonly string[];
  }
  if (record.verification !== undefined) {
    input.verification = readTaskVerification(record.verification, `${label} verification`);
  }
  if (record.outputSchema !== undefined) {
    // Opaque JSON Schema — validated downstream by the coding backend, not here.
    input.outputSchema = record.outputSchema;
  }
  if (record.terseResult !== undefined) {
    if (typeof record.terseResult !== 'boolean') {
      throw new WorkflowScriptExecutionError(`${label} terseResult must be a boolean when provided`);
    }
    input.terseResult = record.terseResult;
  }
  return input;
}

/** Validate a `WorkflowSynthesizeInput` payload at the host boundary. The
 *  runtime normalizes `inputs` (array | string | object) into a list; this
 *  gate rejects the shapes that normalization cannot handle so the failure
 *  is attributed to the generated call rather than surfacing deep inside
 *  prompt construction. */
function readSynthesizeInput(value: unknown, label: string): WorkflowSynthesizeInput {
  const record = readRecord(value, label);
  const rubric = readNonEmptyField(record, 'rubric', label);
  const inputs = record.inputs;
  const isUsable =
    Array.isArray(inputs) || typeof inputs === 'string' || (typeof inputs === 'object' && inputs !== null);
  if (!isUsable) {
    throw new WorkflowScriptExecutionError(`${label} inputs must be an array, string, or object`);
  }
  return { inputs, rubric } as WorkflowSynthesizeInput;
}

/** Validate a `WorkflowLogEvent` payload at the host boundary. A bare string is
 *  tolerated (coerced to `{ message }`): log is fire-and-forget narration, so a
 *  `wf.log("…")` call must never abort the run. The sandbox coerces the same way. */
function readLogEvent(value: unknown, label: string): WorkflowLogEvent {
  if (typeof value === 'string' && value.trim().length > 0) return { message: value };
  const record = readRecord(value, label);
  const message = readNonEmptyField(record, 'message', label);
  return record.data !== undefined ? { message, data: record.data } : { message };
}

function budgetEnvelope(wf: WorkflowApi, value: unknown): WorkflowRpcEnvelope {
  const budget = workflowBudget(wf);
  const remaining = budget.remaining();
  return {
    value,
    budget: {
      spent: budget.spent(),
      remaining: Number.isFinite(remaining) ? remaining : null,
    },
  };
}

function workflowBudget(wf: WorkflowApi): WorkflowBudget {
  const maybe = (wf as { readonly budget?: WorkflowBudget }).budget;
  return maybe ?? {
    total: null,
    spent: () => 0,
    remaining: () => Infinity,
  };
}

function errorEnvelope(error: unknown): WorkflowRpcEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  // Tag run-control errors so the sandbox can distinguish a torn-down/halted run
  // from an ordinary task failure. `wf.parallel`/`wf.pipeline` swallow ordinary
  // failures into a null item but MUST re-throw run-control errors (abort /
  // agent-cap limit / token budget) — they halt the whole run. Detect by name to
  // avoid a runtime import (mirrors runtime isWorkflowRunControlError).
  const name = error instanceof Error ? error.name : '';
  const aborted = name === 'WorkflowAbortError';
  const runControl =
    aborted || name === 'WorkflowLimitError' || name === 'WorkflowBudgetError';
  return {
    value: {
      message,
      ...(aborted ? { aborted: true } : {}),
      ...(runControl ? { runControl: true } : {}),
    },
    budget: { spent: 0, remaining: null },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripRestrictedSourceLiterals(source: string): string {
  let stripped = '';
  let i = 0;
  // Context stack. 'code' preserves characters so the forbidden-token scan sees
  // real code — INCLUDING template `${...}` interpolations, which are code, not
  // prose. 'template' blanks a template literal's text but re-enters 'code' at
  // each `${...}`. Blanking the whole template (the old behavior) let forbidden
  // tokens such as `process.cwd()` hide inside an interpolation and evade the
  // scan, crashing cryptically at runtime instead (Space run-mr4qvtbw).
  const stack: Array<'code' | 'template'> = ['code'];
  const braceDepth: number[] = [0];
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (stack[stack.length - 1] === 'template') {
      if (ch === '\\') {
        stripped += '  ';
        i += 2;
        continue;
      }
      if (ch === '`') {
        stripped += ' ';
        i += 1;
        stack.pop();
        braceDepth.pop();
        continue;
      }
      if (ch === '$' && next === '{') {
        stripped += '  ';
        i += 2;
        stack.push('code');
        braceDepth.push(0);
        continue;
      }
      stripped += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      stripped += '  ';
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        stripped += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      stripped += '  ';
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          stripped += '  ';
          i += 2;
          break;
        }
        stripped += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      stripped += ' ';
      i += 1;
      while (i < source.length) {
        const current = source[i];
        stripped += current === '\n' ? '\n' : ' ';
        i += 1;
        if (current === '\\') {
          if (i < source.length) {
            stripped += source[i] === '\n' ? '\n' : ' ';
            i += 1;
          }
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    if (ch === '`') {
      stripped += ' ';
      i += 1;
      stack.push('template');
      braceDepth.push(0);
      continue;
    }
    if (ch === '{') {
      braceDepth[braceDepth.length - 1] += 1;
      stripped += ch;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (braceDepth[braceDepth.length - 1] > 0) {
        braceDepth[braceDepth.length - 1] -= 1;
        stripped += ch;
        i += 1;
        continue;
      }
      if (stack.length > 1) {
        // Closes a `${...}` interpolation → return to the enclosing template.
        stripped += ' ';
        i += 1;
        stack.pop();
        braceDepth.pop();
        continue;
      }
      stripped += ch;
      i += 1;
      continue;
    }
    stripped += ch ?? '';
    i += 1;
  }
  return stripped;
}

function assertRestrictedWorkflowSourcePolicy(source: string): void {
  const stripped = stripRestrictedSourceLiterals(source);
  for (const forbidden of FORBIDDEN_RESTRICTED_SOURCE_PATTERNS) {
    if (forbidden.pattern.test(stripped)) {
      throw new WorkflowScriptExecutionError(`forbidden restricted workflow token: ${forbidden.id}`);
    }
  }
}

export function validateRestrictedWorkflowSource(
  source: string,
  options: ValidateRestrictedWorkflowSourceOptions = {},
): void {
  if (source.trim().length === 0) {
    throw new WorkflowScriptExecutionError('restricted workflow script source must be non-empty');
  }
  if (options.requireAsyncRun === true && !/\basync\s+function\s+run\s*\(/.test(source)) {
    throw new WorkflowScriptExecutionError(
      'restricted workflow script must define async function run(wf, args)',
    );
  }
  try {
    new Script(wrapSource(source), {
      filename: options.filename ?? 'generated-workflow.js',
    });
  } catch (error) {
    throw new WorkflowScriptExecutionError(
      `restricted workflow script failed to compile: ${errorMessage(error)}`,
    );
  }
  if (options.checkSourcePolicy !== false) {
    assertRestrictedWorkflowSourcePolicy(source);
  }
}

function buildBootstrap(opts: RunRestrictedWorkflowScriptOptions): string {
  const argsJson =
    opts.args === undefined ? 'undefined' : JSON.stringify(jsonStringify(opts.args, 'workflow args'));
  const budget = workflowBudget(opts.wf);
  const budgetTotal = budget.total === null ? 'null' : String(budget.total);
  const budgetRemaining = Number.isFinite(budget.remaining())
    ? String(budget.remaining())
    : 'Infinity';
  return `
"use strict";
globalThis.process = undefined;
globalThis.require = undefined;
globalThis.module = undefined;
globalThis.exports = undefined;
globalThis.fetch = undefined;
globalThis.WebSocket = undefined;
globalThis.XMLHttpRequest = undefined;
globalThis.eval = undefined;
globalThis.Function = undefined;
globalThis.constructor = undefined;

// FEATURE_246 Part D (ADR-048): determinism guards. A workflow script that reads
// wall-clock or randomness would make same-session resume replay diverge, so
// Math.random / Date.now / argless new Date throw inside scripts. Built from the
// real globals (no TDZ on the local shadow). Derive variation from args or the
// item index; pass timestamps via args.
const Math = new Proxy(globalThis.Math, {
  get(target, prop, receiver) {
    if (prop === "random") {
      return () => {
        throw new Error(
          "Math.random() is disabled in workflow scripts (it breaks resume replay determinism); derive variation from args or the item index.",
        );
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});
const Date = new Proxy(globalThis.Date, {
  apply() {
    throw new Error(
      "Date() is disabled in workflow scripts (it breaks resume replay determinism); pass a timestamp via args.",
    );
  },
  construct(target, argv) {
    if (argv.length === 0) {
      throw new Error(
        "argless new Date() is disabled in workflow scripts (it breaks resume replay determinism); pass a timestamp via args, e.g. new Date(args.now).",
      );
    }
    return Reflect.construct(target, argv);
  },
  get(target, prop, receiver) {
    if (prop === "now") {
      return () => {
        throw new Error(
          "Date.now() is disabled in workflow scripts (it breaks resume replay determinism); pass a timestamp via args.",
        );
      };
    }
    // Close the prototype-chain escape: Date.prototype.constructor.now() (and
    // Date.constructor) would otherwise reach the real, un-proxied Date and
    // bypass the now/apply/construct guards. (Reflection through an instance own
    // prototype is out of scope — this sandbox guards a script natural
    // non-determinism, not an adversary deliberately evading it.)
    if (prop === "prototype" || prop === "constructor") {
      throw new Error(
        "Date.prototype / Date.constructor are disabled in workflow scripts (they bypass the resume-replay determinism guard); pass a timestamp via args.",
      );
    }
    return Reflect.get(target, prop, receiver);
  },
});
// Also route the globalThis references through the guard proxies, so
// globalThis.Math.random() / globalThis.Date.now() (and anything reaching them
// via AsyncFunction/GeneratorFunction constructors or Reflect) cannot bypass the
// local const shadows. The proxies captured the real targets above, so this
// does not recurse.
globalThis.Math = Math;
globalThis.Date = Date;

const args = ${argsJson} === undefined ? undefined : JSON.parse(${argsJson});
const __kodaxQueue = [];
const __kodaxPending = new Map();
let __kodaxNextId = 0;
let __kodaxBudgetSpent = ${String(budget.spent())};
let __kodaxBudgetRemaining = ${budgetRemaining};

function __kodaxJsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function __kodaxCommandPropertyName(prop) {
  if (typeof prop === "symbol") return prop.description ? "Symbol(" + prop.description + ")" : String(prop);
  return String(prop);
}

function __kodaxUnawaitedCommandError(method, action) {
  return new Error("wf." + method + " result must be awaited before " + action);
}

function __kodaxGuardCommandPromise(method, promise) {
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        return target[prop].bind(target);
      }
      if (prop === Symbol.toStringTag) {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "toJSON") {
        throw __kodaxUnawaitedCommandError(method, "JSON serialization");
      }
      throw __kodaxUnawaitedCommandError(method, "reading ." + __kodaxCommandPropertyName(prop));
    },
    set() {
      throw __kodaxUnawaitedCommandError(method, "assigning properties");
    },
    defineProperty() {
      throw __kodaxUnawaitedCommandError(method, "defining properties");
    },
    deleteProperty() {
      throw __kodaxUnawaitedCommandError(method, "deleting properties");
    },
    ownKeys() {
      throw __kodaxUnawaitedCommandError(method, "enumerating properties");
    },
  });
}

function __kodaxEnqueue(method, input) {
  const id = String(++__kodaxNextId);
  const command = { id, method, input: __kodaxJsonClone(input) };
  const promise = new Promise((resolve, reject) => {
    __kodaxPending.set(id, { resolve, reject });
  });
  // Fire-and-forget commands must not escape as Node unhandled rejections.
  // Awaiting the original promise still observes the rejection.
  promise.catch(() => undefined);
  __kodaxQueue.push(command);
  return __kodaxGuardCommandPromise(method, promise);
}

function __kodaxNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("workflow command " + label + " must be a non-empty string");
  }
  return value;
}

function __kodaxRecord(value, label) {
  if (typeof value !== "object" || value === null) {
    throw new Error("workflow command " + label + " must be an object");
  }
  return value;
}

function __kodaxTakeCommands() {
  return __kodaxQueue.splice(0, __kodaxQueue.length);
}

function __kodaxPendingCount() {
  return __kodaxPending.size;
}

function __kodaxSettle(id, ok, envelopeJson) {
  const pending = __kodaxPending.get(id);
  if (!pending) return;
  __kodaxPending.delete(id);
  const envelope = JSON.parse(envelopeJson);
  if (envelope && envelope.budget) {
    __kodaxBudgetSpent = envelope.budget.spent;
    __kodaxBudgetRemaining = envelope.budget.remaining === null ? Infinity : envelope.budget.remaining;
  }
  if (ok) {
    pending.resolve(envelope.value);
    return;
  }
  const message =
    envelope && envelope.value && typeof envelope.value.message === "string"
      ? envelope.value.message
      : "workflow command failed";
  const error = new Error(message);
  if (envelope && envelope.value && envelope.value.aborted === true) {
    error.aborted = true;
  }
  if (envelope && envelope.value && envelope.value.runControl === true) {
    error.runControl = true;
  }
  pending.reject(error);
}

async function __kodaxParallel(items, options) {
  if (!Array.isArray(items)) {
    throw new Error("wf.parallel expects an array of thunks");
  }
  const requested = options && Number.isInteger(options.concurrency)
    ? options.concurrency
    : items.length;
  const lanes = Math.max(1, Math.min(requested, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (typeof item !== "function") {
        throw new Error("wf.parallel items must be functions");
      }
      // Fault isolation (FEATURE_246 Part E): an ordinary failed thunk becomes
      // null so siblings continue and parallel never rejects; run-control errors
      // (abort / agent-cap / budget) re-throw to tear down the whole run.
      try {
        results[index] = await item();
      } catch (error) {
        if (error && error.runControl === true) throw error;
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

async function __kodaxPipeline(items, ...stages) {
  if (!Array.isArray(items)) {
    throw new Error("wf.pipeline expects an array as its first argument");
  }
  const runnable = stages.filter((stage) => typeof stage === "function");
  // No barrier between stages: each item advances its own chain independently.
  // A throwing stage drops THIS item to null (siblings continue); an aborted
  // run propagates instead of being swallowed.
  return Promise.all(items.map(async (item, index) => {
    try {
      let value = item;
      for (const stage of runnable) {
        value = await stage(value, item, index);
      }
      return value;
    } catch (error) {
      if (error && error.runControl === true) throw error;
      return null;
    }
  }));
}

const console = Object.freeze({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
});

const wf = Object.freeze({
  runId: ${JSON.stringify(opts.wf.runId)},
  args,
  budget: Object.freeze({
    total: ${budgetTotal},
    spent: () => __kodaxBudgetSpent,
    remaining: () => __kodaxBudgetRemaining,
  }),
  phase: async (name, fn) => {
    const entered = await __kodaxEnqueue("phaseEnter", { name: __kodaxNonEmptyString(name, "name") });
    try {
      return await fn();
    } finally {
      await __kodaxEnqueue("phaseExit", { token: entered && entered.token });
    }
  },
  spawnAgent: (input) => __kodaxEnqueue("spawnAgent", __kodaxRecord(input, "spawnAgent input")),
  runAgent: (input) => __kodaxEnqueue("runAgent", __kodaxRecord(input, "runAgent input")),
  wait: (taskId, opts) => __kodaxEnqueue("wait", { taskId: __kodaxNonEmptyString(taskId, "taskId"), opts }),
  snapshot: (taskId) => __kodaxEnqueue("snapshot", { taskId: __kodaxNonEmptyString(taskId, "taskId") }),
  output: (taskId) => __kodaxEnqueue("output", { taskId: __kodaxNonEmptyString(taskId, "taskId") }),
  send: (taskId, content) => __kodaxEnqueue("send", {
    taskId: __kodaxNonEmptyString(taskId, "taskId"),
    content: __kodaxNonEmptyString(content, "content"),
  }),
  stop: (taskId, reason) => __kodaxEnqueue("stop", {
    taskId: __kodaxNonEmptyString(taskId, "taskId"),
    reason: __kodaxNonEmptyString(reason, "reason"),
  }),
  parallel: __kodaxParallel,
  pipeline: __kodaxPipeline,
  synthesize: (input) => __kodaxEnqueue("synthesize", __kodaxRecord(input, "synthesize input")),
  workflow: (name, args) => __kodaxEnqueue("workflow", { name: __kodaxNonEmptyString(name, "name"), args }),
  artifact: (name, value) => __kodaxEnqueue("artifact", { name: __kodaxNonEmptyString(name, "name"), value }),
  log: (event) => { void __kodaxEnqueue("log", typeof event === "string" ? { message: event } : __kodaxRecord(event, "log input")); },
});
`;
}

function runTrustedHostScript<T>(context: object, source: string): T {
  // These snippets are KodaX-authored RPC glue, not generated workflow code.
  // Avoid node:vm watchdog timeouts here: repeated short timeout runs can
  // abort the Windows Node process before JavaScript can catch anything.
  return new Script(source).runInContext(context) as T;
}

function readCommands(context: object): readonly WorkflowRpcCommand[] {
  const raw = runTrustedHostScript<unknown>(context, 'JSON.stringify(__kodaxTakeCommands())');
  if (typeof raw !== 'string') {
    throw new WorkflowScriptExecutionError('workflow command queue did not serialize');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new WorkflowScriptExecutionError('workflow command queue must be an array');
  }
  return parsed.map((item): WorkflowRpcCommand => {
    const record = readRecord(item, 'workflow command');
    const id = readString(record, 'id');
    const method = readString(record, 'method') as WorkflowRpcMethod;
    return { id, method, input: record.input };
  });
}

function pendingCount(context: object): number {
  const value = runTrustedHostScript<unknown>(context, '__kodaxPendingCount()');
  if (typeof value !== 'number') {
    throw new WorkflowScriptExecutionError('workflow pending count must be a number');
  }
  return value;
}

function settleCommand(
  context: object,
  command: WorkflowRpcCommand,
  ok: boolean,
  envelope: WorkflowRpcEnvelope,
): void {
  const envelopeJson = jsonStringify(envelope, 'workflow command result');
  const code = `__kodaxSettle(${JSON.stringify(command.id)}, ${ok ? 'true' : 'false'}, ${JSON.stringify(envelopeJson)})`;
  runTrustedHostScript<unknown>(context, code);
}

async function handleCommand(
  wf: WorkflowApi,
  command: WorkflowRpcCommand,
  state: WorkflowRpcHostState,
): Promise<unknown> {
  const input = command.input;
  switch (command.method) {
    case 'artifact': {
      const record = readRecord(input, 'workflow artifact input');
      return wf.artifact(readString(record, 'name'), record.value) satisfies Promise<WorkflowArtifactRef>;
    }
    case 'log':
      wf.log(readLogEvent(input, 'workflow log input'));
      return undefined;
    case 'output': {
      const record = readRecord(input, 'workflow output input');
      return wf.snapshot(readString(record, 'taskId')) satisfies Promise<WorkflowTaskSnapshot>;
    }
    case 'snapshot': {
      const record = readRecord(input, 'workflow snapshot input');
      return wf.snapshot(readString(record, 'taskId')) satisfies Promise<WorkflowTaskSnapshot>;
    }
    case 'phaseEnter': {
      const record = readRecord(input, 'workflow phase input');
      const token = state.nextPhaseToken();
      let closePhase: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        closePhase = resolve;
      });
      let phaseFailure: unknown;
      const finished = wf.phase(readString(record, 'name'), async () => closed).then(
        () => undefined,
        (error: unknown) => {
          phaseFailure = error;
        },
      );
      state.openPhases.set(token, {
        close: closePhase!,
        finished,
        failure: () => phaseFailure,
      });
      return { token };
    }
    case 'phaseExit': {
      const record = readRecord(input, 'workflow phase exit input');
      const token = readString(record, 'token');
      const phase = state.openPhases.get(token);
      if (phase) {
        state.openPhases.delete(token);
        phase.close();
        await phase.finished;
        const failure = phase.failure();
        if (failure !== undefined) throw failure;
      }
      return undefined;
    }
    case 'runAgent':
      return wf.runAgent(readSpawnAgentInput(input, 'workflow runAgent input')) satisfies Promise<WorkflowTaskResult | null>;
    case 'send': {
      const record = readRecord(input, 'workflow send input');
      await wf.send(readString(record, 'taskId'), readString(record, 'content'));
      return undefined;
    }
    case 'spawnAgent':
      return wf.spawnAgent(readSpawnAgentInput(input, 'workflow spawnAgent input')) satisfies Promise<WorkflowTaskHandle>;
    case 'stop': {
      const record = readRecord(input, 'workflow stop input');
      await wf.stop(readString(record, 'taskId'), readString(record, 'reason'));
      return undefined;
    }
    case 'synthesize':
      return wf.synthesize(readSynthesizeInput(input, 'workflow synthesize input'));
    case 'workflow': {
      const record = readRecord(input, 'workflow input');
      if (!wf.workflow) {
        throw new Error('wf.workflow(name, args) is not available in this run');
      }
      return wf.workflow(readString(record, 'name'), record.args);
    }
    case 'wait': {
      const record = readRecord(input, 'workflow wait input');
      const waitOpts = record.opts === undefined
        ? undefined
        : (readRecord(record.opts, 'workflow wait options') as unknown as WorkflowWaitOptions);
      return wf.wait(readString(record, 'taskId'), waitOpts) satisfies Promise<WorkflowTaskResult>;
    }
    default:
      throw new WorkflowScriptExecutionError(`unsupported workflow command: ${command.method}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExplicitTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WorkflowScriptExecutionError('workflow script timeoutMs must be a positive finite number');
  }
  return Math.floor(timeoutMs);
}

async function closeOpenPhases(state: WorkflowRpcHostState): Promise<void> {
  const phases = [...state.openPhases.values()];
  state.openPhases.clear();
  for (const phase of phases) phase.close();
  await Promise.all(phases.map((phase) => phase.finished));
  const failure = phases.map((phase) => phase.failure()).find((error) => error !== undefined);
  if (failure !== undefined) throw failure;
}

export async function runRestrictedWorkflowScript(
  opts: RunRestrictedWorkflowScriptOptions,
): Promise<unknown> {
  const wallTimeoutMs = normalizeExplicitTimeoutMs(opts.timeoutMs);
  const syncTimeoutMs = wallTimeoutMs === undefined
    ? DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS
    : Math.min(wallTimeoutMs, DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS);
  let settled = false;
  let result: unknown;
  let failure: unknown;
  let hostState: WorkflowRpcHostState | undefined;
  try {
    validateRestrictedWorkflowSource(opts.source, { filename: opts.filename });
    const context = createContext({});
    new Script(buildBootstrap(opts), { filename: 'workflow-capability-bootstrap.js' }).runInContext(context);
    const script = new Script(wrapSource(opts.source), {
      filename: opts.filename ?? 'generated-workflow.js',
    });
    const scriptResult = script.runInContext(context, { timeout: syncTimeoutMs }) as unknown;
    void Promise.resolve(scriptResult).then(
      (value) => {
        settled = true;
        result = value;
      },
      (error) => {
        settled = true;
        failure = error;
      },
    );

    const startedAt = Date.now();
    const inFlight = new Set<Promise<void>>();
    let nextPhaseToken = 0;
    hostState = {
      openPhases: new Map<string, WorkflowRpcPhaseScope>(),
      nextPhaseToken: () => `phase-${++nextPhaseToken}`,
    };

    for (;;) {
      if (wallTimeoutMs !== undefined && Date.now() - startedAt > wallTimeoutMs) {
        throw new WorkflowScriptExecutionError(`workflow script timed out after ${wallTimeoutMs}ms`);
      }

      if (opts.wf.signal?.aborted) throw new WorkflowAbortError();

      const commands = readCommands(context);
      for (const command of commands) {
        const task = handleCommand(opts.wf, command, hostState)
          .then((value) => {
            settleCommand(context, command, true, budgetEnvelope(opts.wf, jsonClone(value, 'workflow command result')));
          })
          .catch((error: unknown) => {
            settleCommand(context, command, false, errorEnvelope(error));
          })
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
      }

      if (settled && pendingCount(context) === 0 && inFlight.size === 0) {
        break;
      }

      if (commands.length === 0) {
        await Promise.race([sleep(1), ...inFlight]);
      }
    }

    if (failure !== undefined) {
      throw failure;
    }
    await closeOpenPhases(hostState);
    return jsonClone(result, 'workflow script result');
  } catch (error) {
    // Close any phase scopes if the generated script fails before its
    // finally block can send phaseExit.
    let cleanupError: unknown;
    if (hostState) {
      try {
        await closeOpenPhases(hostState);
      } catch (error2) {
        cleanupError = error2;
      }
    }
    const cleanupSuffix =
      cleanupError === undefined ? '' : `; workflow phase cleanup failed: ${errorMessage(cleanupError)}`;
    if (error instanceof WorkflowAbortError && cleanupError === undefined) throw error;
    if (error instanceof WorkflowScriptExecutionError) {
      if (cleanupError === undefined) throw error;
      throw new WorkflowScriptExecutionError(`${error.message}${cleanupSuffix}`);
    }
    throw new WorkflowScriptExecutionError(
      `restricted workflow script failed: ${errorMessage(error)}${cleanupSuffix}`,
    );
  }
}

export function createRestrictedWorkflowModule(
  input: RestrictedWorkflowModuleInput,
): WorkflowModule {
  const manifest = validateWorkflowScriptManifest(input.manifest);
  validateRestrictedWorkflowSource(input.source, {
    filename: `${manifest.name}.workflow.js`,
    requireAsyncRun: true,
  });
  assertRestrictedWorkflowQuality(input.source, {
    filename: `${manifest.name}.workflow.js`,
    manifest,
  });
  return {
    meta: {
      name: manifest.name,
      description: manifest.description,
      phases: manifest.phases,
      readOnly: manifest.readOnly,
      ...(manifest.plannedAgents !== undefined ? { plannedAgents: manifest.plannedAgents } : {}),
      maxAgents: manifest.maxAgents,
      maxConcurrency: manifest.maxConcurrency,
      ...(manifest.tokenBudget !== undefined ? { tokenBudget: manifest.tokenBudget } : {}),
    },
    run: (wf, args) =>
      runRestrictedWorkflowScript({
        wf,
        args,
        source: input.source,
        filename: `${manifest.name}.workflow.js`,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }),
  };
}
