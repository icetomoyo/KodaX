import { staticText } from '../prompts/static-text.js';
/**
 * FEATURE_217 (v0.7.49) Phase G — LLM-generated workflow scripts.
 *
 * The generator is intentionally small: one text-only LLM call must return
 * structured JSON, which is validated before it can become a capability-routed
 * workflow module. Execution safety belongs to the WorkflowApi command bridge;
 * this file adds an earlier prompt/output gate so bad generations fail closed.
 */

import {
  createRestrictedWorkflowModule,
  expandSkillForLLM,
  getSkillRegistry,
  initializeSkillRegistry,
  lintRestrictedWorkflowSource,
  runRestrictedWorkflowScript,
  validateRestrictedWorkflowSource,
  validateWorkflowScriptManifest,
  WORKFLOW_PATTERN_IDS,
  type SkillContext,
  type WorkflowApi,
  type WorkflowModule,
  type WorkflowQualityLintFinding,
  type WorkflowScriptManifest,
  type WorkflowTaskHandle,
  type WorkflowTaskResult,
  type WorkflowTaskSnapshot,
  type WorkflowTaskStatus,
} from '@kodax-ai/agent';
import { resolveProvider, sideQuery } from '@kodax-ai/llm';
import type { KodaXMessage } from '@kodax-ai/llm';

import { renderWorkflowPatternGuidance } from '../orchestration/pattern-catalog.js';
import type { WorkflowScriptSnapshotInput } from './run-graph.js';
import {
  parseBareInlineSlashReferences,
  parseInlineSkillReferences,
  uniqueBareInlineSlashNames,
  uniqueInlineSkillNames,
} from '../skill-references.js';
import type { KodaXOptions } from '../types.js';
import {
  parseTimeoutSecEnvMs,
  timeoutSecToMs,
  type KodaXTimeoutConfig,
} from '../timeouts.js';

export const WORKFLOW_GENERATION_SYSTEM_PROMPT = [
  staticText("t12i.workflows/generator.block.0"),
].join('\n');

export const DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS = 120_000;
const WORKFLOW_GENERATION_TIMEOUT_SEC_ENV = 'KODAX_WORKFLOW_GENERATION_TIMEOUT_SEC';
const WORKFLOW_GENERATION_TIMEOUT_ENV = 'KODAX_WORKFLOW_GENERATION_TIMEOUT_MS';
const GENERATED_WORKFLOW_MAX_AGENTS_HARD_CAP = 64;
const WORKFLOW_GENERATION_REPAIR_ATTEMPTS = 2;
const GENERATED_WORKFLOW_SMOKE_TIMEOUT_MS = 2_000;
interface GeneratedWorkflowSmokeScenario {
  readonly name: string;
  readonly args?: (request: string) => unknown;
  readonly status?: (name: string, taskId: string) => WorkflowTaskStatus;
  readonly finalText?: (name: string, taskId: string) => string;
  readonly synthesizeText?: string;
}

const GENERATED_WORKFLOW_SMOKE_SCENARIOS: readonly GeneratedWorkflowSmokeScenario[] = [
  { name: 'default' },
  {
    name: 'variant-results',
    finalText: (name, taskId) => `Variant smoke child report from ${name} (${taskId}).`,
    synthesizeText: 'Variant smoke synthesis report.',
  },
  {
    name: 'unverified-success',
    status: () => 'completed_unverified',
    finalText: (name) => `Smoke result for ${name}: completed with verification warnings.`,
    synthesizeText: 'Smoke synthesis: completed with verification warnings.',
  },
  {
    name: 'empty-args-rerun',
    args: () => ({}),
  },
];

export interface WorkflowGenerationTextRequest {
  readonly system: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export type WorkflowGenerationTextFn = (
  request: WorkflowGenerationTextRequest,
) => Promise<string>;

export interface GenerateWorkflowInput {
  readonly request: string;
  readonly generateText: WorkflowGenerationTextFn;
  readonly skillContext?: string;
  readonly signal?: AbortSignal;
}

export interface GenerateWorkflowFromOptionsInput {
  readonly request: string;
  readonly options: KodaXOptions;
  readonly skillContext?: string;
  readonly timeoutSec?: number;
  /** @deprecated Prefer timeoutSec for public SDK calls. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GeneratedWorkflow {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly module: WorkflowModule;
  readonly scriptSnapshot: WorkflowScriptSnapshotInput;
  readonly approvalSummary: string;
  readonly qualityWarnings?: readonly WorkflowQualityLintFinding[];
  readonly rawText: string;
}

export type WorkflowGenerationResult =
  | { readonly kind: 'declined'; readonly reason: string; readonly rawText: string }
  | ({ readonly kind: 'generated' } & GeneratedWorkflow);

const FORBIDDEN_SOURCE_PATTERNS: readonly {
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
  // `Cannot read properties of undefined`. Reject it at generation. Dot access
  // (`globalThis.Math`) is intentionally still allowed for the determinism guard.
  { id: 'globalThis-index', pattern: /\bglobalThis\s*\[/ },
];

export function resolveWorkflowGenerationTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  timeouts?: KodaXTimeoutConfig,
): number {
  const configured = timeoutSecToMs(
    timeouts?.workflow?.generationTimeoutSec,
    'timeouts.workflow.generationTimeoutSec',
  );
  if (configured !== undefined) return configured;

  const secEnv = parseTimeoutSecEnvMs(env[WORKFLOW_GENERATION_TIMEOUT_SEC_ENV]);
  if (secEnv !== undefined) return secEnv;

  const raw = env[WORKFLOW_GENERATION_TIMEOUT_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`workflow generation ${key} must be a non-empty string`);
  }
  return value;
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  throw new Error('workflow generation output did not contain a JSON object');
}

function parseGenerationJson(rawText: string): Record<string, unknown> {
  const jsonText = extractJsonText(rawText);
  return readRecord(JSON.parse(jsonText) as unknown, 'workflow generation output');
}

function normalizePhaseEntry(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['name', 'id', 'title', 'phase']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function splitPhaseString(value: string): readonly string[] {
  return value
    .split(/(?:->|\u2192|,|\n)/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeGeneratedManifestCandidate(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const phasesValue = record.phases;
  let phases: readonly string[] | undefined;

  if (Array.isArray(phasesValue)) {
    const normalized = phasesValue.map(normalizePhaseEntry);
    if (normalized.every((item): item is string => item !== undefined)) {
      phases = normalized;
    }
  } else if (typeof phasesValue === 'string') {
    const split = splitPhaseString(phasesValue);
    if (split.length > 0) {
      phases = split;
    }
  }

  return phases ? { ...record, phases } : value;
}

function estimateDirectAgentCalls(source: string): number {
  return source.match(/\bwf\.(?:runAgent|spawnAgent|synthesize)\s*\(/g)?.length ?? 0;
}

function reserveGeneratedWorkflowAgentCapacity(
  manifest: WorkflowScriptManifest,
  source: string,
): WorkflowScriptManifest {
  const phaseConcurrencyReserve =
    manifest.maxConcurrency * Math.max(1, manifest.phases.length) + 2;
  const directCallReserve = estimateDirectAgentCalls(source) + 2;
  const required = Math.min(
    GENERATED_WORKFLOW_MAX_AGENTS_HARD_CAP,
    Math.max(manifest.maxAgents, phaseConcurrencyReserve, directCallReserve),
  );

  return required > manifest.maxAgents
    ? { ...manifest, maxAgents: required }
    : manifest;
}

function stripGeneratedSourceLiterals(source: string): string {
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

function templateLiteralHasExpression(source: string, start: number): boolean {
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') return false;
    if (ch === '$' && source[i + 1] === '{') return true;
  }
  return false;
}

function findLiteralWorkflowTaskTarget(source: string): { readonly method: string } | undefined {
  const stripped = stripGeneratedSourceLiterals(source);
  const pattern = /\bwf\s*\.\s*(wait|snapshot|send|stop)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    const method = match[1];
    if (!method) continue;
    const open = stripped.indexOf('(', match.index);
    if (open < 0) continue;
    let argStart = open + 1;
    while (/\s/.test(source[argStart] ?? '')) argStart += 1;
    const firstArgChar = source[argStart];
    if (firstArgChar === '`' && templateLiteralHasExpression(source, argStart)) {
      continue;
    }
    if (firstArgChar === '"' || firstArgChar === "'" || firstArgChar === '`') {
      return { method };
    }
  }
  return undefined;
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function findRunBodyRange(source: string): { readonly start: number; readonly end: number } | undefined {
  const stripped = stripGeneratedSourceLiterals(source);
  const match = /\basync\s+function\s+run\s*\([^)]*\)\s*\{/.exec(stripped);
  if (!match) return undefined;
  const open = stripped.indexOf('{', match.index);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  return undefined;
}

function findTopLevelReturnExpression(
  source: string,
  range: { readonly start: number; readonly end: number },
): string | undefined {
  const stripped = stripGeneratedSourceLiterals(source);
  let depth = 1;
  for (let i = range.start; i < range.end; i += 1) {
    const ch = stripped[i];
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      continue;
    }
    if (
      depth === 1
      && stripped.startsWith('return', i)
      && !isIdentifierPart(stripped[i - 1])
      && !isIdentifierPart(stripped[i + 'return'.length])
    ) {
      const expressionStart = i + 'return'.length;
      let nested = 0;
      for (let j = expressionStart; j < range.end; j += 1) {
        const current = stripped[j];
        if (current === '(' || current === '[' || current === '{') nested += 1;
        if (current === ')' || current === ']' || current === '}') nested -= 1;
        if (nested === 0 && (current === ';' || current === '\n' || current === '\r')) {
          return source.slice(expressionStart, j).trim();
        }
      }
      return source.slice(expressionStart, range.end).trim();
    }
  }
  return undefined;
}

function findOuterRunReturnExpression(source: string): string | undefined {
  const range = findRunBodyRange(source);
  if (!range) return undefined;
  return findTopLevelReturnExpression(source, range);
}

function findOuterRunStatements(source: string): readonly string[] {
  const range = findRunBodyRange(source);
  if (!range) return [];
  const stripped = stripGeneratedSourceLiterals(source);
  const statements: string[] = [];
  let start = range.start;
  let depth = 1;
  for (let i = range.start; i < range.end; i += 1) {
    const ch = stripped[i];
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      continue;
    }
    if (ch === ';' && depth === 1) {
      const statement = source.slice(start, i + 1).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const trailing = source.slice(start, range.end).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isReturnedArtifactHandle(source: string, expression: string): boolean {
  const variable = /^[A-Za-z_$][A-Za-z0-9_$]*$/.exec(expression.trim())?.[0];
  if (!variable) return false;
  const escaped = escapeRegExp(variable);
  const declaration = new RegExp(
    `^\\s*(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:await\\s+)?wf\\s*\\.\\s*artifact\\b`,
  );
  const assignment = new RegExp(
    `^\\s*${escaped}\\s*=\\s*(?:await\\s+)?wf\\s*\\.\\s*artifact\\b`,
  );
  return findOuterRunStatements(source).some((statement) =>
    declaration.test(statement) || assignment.test(statement),
  );
}

function findMatchingDelimiter(source: string, open: number, openChar: string, closeChar: string): number | undefined {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function findTopLevelComma(source: string, start: number, end: number): number | undefined {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      continue;
    }
    if (ch === ',' && depth === 0) return i;
  }
  return undefined;
}

function findPhaseCallbackReturnExpression(expression: string): string | undefined {
  const stripped = stripGeneratedSourceLiterals(expression);
  const phaseMatch = /^\s*(?:await\s+)?wf\s*\.\s*phase\s*\(/.exec(stripped);
  if (!phaseMatch) return undefined;
  const open = stripped.indexOf('(', phaseMatch.index);
  if (open < 0) return undefined;
  const close = findMatchingDelimiter(stripped, open, '(', ')');
  if (close === undefined) return undefined;
  const comma = findTopLevelComma(stripped, open + 1, close);
  if (comma === undefined) return undefined;

  const callbackSource = expression.slice(comma + 1, close).trim();
  const callbackStripped = stripGeneratedSourceLiterals(callbackSource);
  const arrow = callbackStripped.indexOf('=>');
  if (arrow < 0) return undefined;
  const bodyStart = arrow + 2;
  const offset = callbackStripped.slice(bodyStart).search(/\S/);
  if (offset < 0) return undefined;
  const firstBodyChar = bodyStart + offset;
  if (callbackStripped[firstBodyChar] !== '{') {
    return callbackSource.slice(firstBodyChar).trim();
  }
  const blockClose = findMatchingDelimiter(callbackStripped, firstBodyChar, '{', '}');
  if (blockClose === undefined) return undefined;
  return findTopLevelReturnExpression(callbackSource, { start: firstBodyChar + 1, end: blockClose });
}

function isDirectWorkflowCall(expression: string, method: 'artifact' | 'phase'): boolean {
  return new RegExp(`^(?:await\\s+)?wf\\s*\\.\\s*${method}\\b`).test(expression.trim());
}

function isDisplayableReturnExpression(source: string, expression: string): boolean {
  const trimmed = expression.trim();
  if (/^(?:undefined|null|void\s+0|\{\s*\}|\[\s*\]|''|""|``)$/.test(trimmed)) return false;
  if (isDirectWorkflowCall(trimmed, 'artifact')) return false;
  if (isReturnedArtifactHandle(source, trimmed)) return false;
  if (isDirectWorkflowCall(trimmed, 'phase')) {
    const callbackReturn = findPhaseCallbackReturnExpression(trimmed);
    return callbackReturn !== undefined && isDisplayableReturnExpression(trimmed, callbackReturn);
  }
  return true;
}

function hasDisplayableRunReturn(source: string): boolean {
  const expression = findOuterRunReturnExpression(source);
  if (!expression) return false;
  return isDisplayableReturnExpression(source, expression);
}

function assertGeneratedWorkflowSyntax(source: string): void {
  try {
    validateRestrictedWorkflowSource(source, {
      filename: 'generated-workflow.js',
      requireAsyncRun: true,
      checkSourcePolicy: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The most common author mistake is an unescaped quote/apostrophe inside a
    // child-prompt string (e.g. 'review the refactor's impact' closes the string
    // early → "Unexpected identifier"). Point the retry at the likely cause so it
    // fixes it in one pass instead of guessing.
    const looksLikeQuoteError =
      /Unexpected (identifier|string|token|end of input)|Invalid or unexpected token/i.test(message);
    const hint = looksLikeQuoteError
      ? " — a prompt string likely has an unescaped quote or apostrophe; wrap that string in double quotes or backticks, or escape the quote, then retry"
      : "";
    throw new Error(`workflow generation source has invalid JavaScript syntax: ${message}${hint}`);
  }
}

function createSmokeWorkflowApi(scenario: GeneratedWorkflowSmokeScenario): {
  readonly api: WorkflowApi;
  readonly artifactCount: () => number;
} {
  let nextTask = 0;
  const names = new Map<string, string>();
  const artifacts: string[] = [];
  const nextHandle = (name: string): WorkflowTaskHandle => {
    nextTask += 1;
    const taskId = `smoke-task-${nextTask}-${Math.random().toString(36).slice(2, 8)}`;
    names.set(taskId, name);
    return { taskId, name };
  };
  const assertKnownTaskId = (method: string, taskId: string): void => {
    if (names.has(taskId)) return;
    const nameMatch = [...names.entries()].find((entry) => entry[1] === taskId);
    if (nameMatch) {
      throw new Error(
        `wf.${method}("${taskId}") used an agent name, but workflow task APIs require ` +
          'the taskId returned by spawnAgent/runAgent. Store the handle/result and pass ' +
          'handle.taskId or result.taskId. wf.runAgent already returns the completed result; ' +
          'wf.parallel returns the array of results.',
      );
    }
    throw new Error(`wf.${method}("${taskId}") references an unknown workflow task id`);
  };
  const assertEvidenceRefs = (input: {
    readonly name: string;
    readonly evidenceRefs?: readonly string[];
  }): void => {
    for (const ref of input.evidenceRefs ?? []) {
      if (ref.startsWith('file:') || ref.startsWith('diff:') || ref.startsWith('finding:')) {
        continue;
      }
      if (ref.startsWith('task_id:')) {
        const taskId = ref.slice('task_id:'.length).trim();
        if (taskId.length === 0) {
          throw new Error(`wf.runAgent("${input.name}") evidenceRefs contains empty task_id: reference`);
        }
        assertKnownTaskId('evidenceRefs', taskId);
        continue;
      }
      const nameMatch = [...names.entries()].find((entry) => entry[1] === ref);
      if (nameMatch) {
        throw new Error(
          `wf.runAgent("${input.name}") evidenceRefs contains agent name "${ref}". ` +
            'Use "task_id:" + result.taskId from the child result.',
        );
      }
      throw new Error(
        `wf.runAgent("${input.name}") evidenceRefs contains unsupported ref "${ref}". ` +
          'Use file:, diff:, finding:, or task_id:<id>.',
      );
    }
  };
  const resultFor = (taskId: string, fallbackName?: string): WorkflowTaskResult => {
    assertKnownTaskId('wait', taskId);
    const name = names.get(taskId) ?? fallbackName ?? taskId;
    const status = scenario.status?.(name, taskId) ?? 'completed';
    return {
      taskId,
      name,
      status,
      finalText: scenario.finalText?.(name, taskId) ?? `Smoke result for ${name}: completed, done, verified.`,
    };
  };
  const snapshotFor = (method: string, taskId: string): WorkflowTaskSnapshot => {
    assertKnownTaskId(method, taskId);
    const name = names.get(taskId) ?? taskId;
    return {
      taskId,
      name,
      status: 'completed',
      lastText: `Smoke snapshot for ${name}`,
    };
  };
  const api: WorkflowApi = {
    runId: 'run-smoke',
    args: undefined,
    budget: {
      total: null,
      spent: () => 0,
      remaining: () => Infinity,
    },
    phase: async (_name, fn) => fn(),
    spawnAgent: async (input) => {
      assertEvidenceRefs(input);
      return nextHandle(input.name);
    },
    runAgent: async (input) => {
      assertEvidenceRefs(input);
      const handle = nextHandle(input.name);
      const result = resultFor(handle.taskId, input.name);
      if (result.status === 'failed' || result.status === 'stopped') {
        throw new Error(`workflow task ${result.name} (${result.taskId}) ${result.status}`);
      }
      return result;
    },
    wait: async (taskId) => resultFor(taskId),
    snapshot: async (taskId) => snapshotFor('snapshot', taskId),
    output: async (taskId) => snapshotFor('output', taskId),
    send: async (taskId) => {
      assertKnownTaskId('send', taskId);
    },
    stop: async (taskId) => {
      assertKnownTaskId('stop', taskId);
    },
    parallel: async (items) => Promise.all(items.map((item) => item())),
    synthesize: async () => ({ text: scenario.synthesizeText ?? 'Smoke synthesis: completed, done, verified.' }),
    artifact: async (name) => {
      artifacts.push(name);
      return { name };
    },
    log: () => undefined,
  };
  return {
    api,
    artifactCount: () => artifacts.length,
  };
}

function isSmokeResultDisplayable(value: unknown, artifactCount: number): boolean {
  if (artifactCount > 0) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (value === undefined || value === null) return false;
  if (typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.length > 0;
  const record = value as Record<string, unknown>;
  let sawDisplayKey = false;
  const synthesis = record.synthesis;
  if (typeof synthesis === 'string') {
    sawDisplayKey = true;
    if (synthesis.trim().length > 0) return true;
  }
  if (synthesis && typeof synthesis === 'object') {
    sawDisplayKey = true;
    const text = (synthesis as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim().length > 0) return true;
  }
  for (const key of ['summary', 'report', 'text', 'result']) {
    const candidate = record[key];
    if (candidate !== undefined) sawDisplayKey = true;
    if (typeof candidate === 'string' && candidate.trim().length > 0) return true;
  }
  if (sawDisplayKey && Object.keys(record).every((key) =>
    key === 'synthesis' || key === 'summary' || key === 'report' || key === 'text' || key === 'result'
  )) {
    return false;
  }
  return Object.keys(record).length > 0;
}

async function assertGeneratedWorkflowSmoke(input: {
  readonly source: string;
  readonly request: string;
}): Promise<void> {
  for (const scenario of GENERATED_WORKFLOW_SMOKE_SCENARIOS) {
    try {
      const smoke = createSmokeWorkflowApi(scenario);
      const result = await runRestrictedWorkflowScript({
        source: input.source,
        wf: smoke.api,
        args: scenario.args?.(input.request) ?? { request: input.request },
        filename: 'generated-workflow-smoke.js',
        timeoutMs: GENERATED_WORKFLOW_SMOKE_TIMEOUT_MS,
      });
      if (!isSmokeResultDisplayable(result, smoke.artifactCount())) {
        throw new Error('run() returned no displayable result or artifact');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `workflow generation source failed safe smoke validation (${scenario.name}): ${message}`,
      );
    }
  }
}

export function validateGeneratedWorkflowSource(source: string): string {
  if (source.trim().length === 0) {
    throw new Error('workflow generation source must be non-empty');
  }
  if (!/\basync\s+function\s+run\s*\(/.test(source)) {
    throw new Error('workflow generation source must define async function run(wf, args)');
  }
  assertGeneratedWorkflowSyntax(source);
  const strippedSource = stripGeneratedSourceLiterals(source);
  for (const forbidden of FORBIDDEN_SOURCE_PATTERNS) {
    if (forbidden.pattern.test(strippedSource)) {
      throw new Error(`forbidden generated workflow token: ${forbidden.id}`);
    }
  }
  if (/\.\s*output\b/.test(strippedSource)) {
    if (/\bwf\s*\.\s*output\s*\(/.test(strippedSource)) {
      throw new Error('workflow generation source must use wf.snapshot(taskId) instead of legacy wf.output(taskId)');
    }
    throw new Error('workflow generation source must use finalText/text instead of non-existent .output');
  }
  const literalTaskTarget = findLiteralWorkflowTaskTarget(source);
  if (literalTaskTarget) {
    throw new Error(
      `workflow generation source must pass taskId variables to wf.${literalTaskTarget.method}(...) instead of string literals; ` +
        'use handle.taskId from wf.spawnAgent(...) or result.taskId from wf.runAgent(...).',
    );
  }
  for (const line of strippedSource.split(/\r?\n/)) {
    const artifactCall = line.search(/\bwf\.artifact\s*\(/);
    if (artifactCall >= 0 && !/\b(?:await|return)\b/.test(line.slice(0, artifactCall))) {
      throw new Error('workflow generation source must await wf.artifact(...)');
    }
  }
  if (!hasDisplayableRunReturn(source)) {
    const expr = findOuterRunReturnExpression(source);
    const detail = expr === undefined
      ? 'no top-level `return` was found in run() — a return inside a wf.phase(...) callback does not count'
      : `the top-level return \`${expr.slice(0, 80)}\` is not displayable — do not return undefined/null/{}, a bare wf.artifact(...) write, or a wf.phase(...) without a displayable callback return`;
    throw new Error(
      `workflow generation source outer run function must return displayable final text (${detail})`,
    );
  }
  return source;
}

function buildReferencedSkillPromptSection(skillContext: string | undefined): string[] {
  const trimmed = skillContext?.trim();
  if (!trimmed) return [];
  return [
    '',
    'Referenced skill instructions (authoritative):',
    trimmed,
    '',
    'Skill handling requirements:',
    '- Treat the referenced skill instructions above as binding requirements for this workflow generation.',
    '- Preserve skill-specific file layout, naming, and process requirements in child-agent prompts that do the work.',
    staticText("t12h.workflow-generator.7"),
  ];
}

export function buildWorkflowGenerationUserPrompt(
  request: string,
  skillContext?: string,
): string {
  return [
    'Task request:',
    request,
    ...buildReferencedSkillPromptSection(skillContext),
    staticText("t12i.workflows/generator.block.1"),
    `Supported pattern ids: ${WORKFLOW_PATTERN_IDS.join(', ')}`,
    '',
    'Pattern selection guidance:',
    ...renderWorkflowPatternGuidance(),
    staticText("t12i.workflows/generator.block.2"),
  ].join('\n');
}

export async function buildWorkflowGenerationSkillContext(
  request: string,
  options: Pick<KodaXOptions, 'context' | 'skillDynamicContext'>,
): Promise<string | undefined> {
  const explicitSkillNames = uniqueInlineSkillNames(request);
  const bareSlashNames = uniqueBareInlineSlashNames(request);
  if (explicitSkillNames.length === 0 && bareSlashNames.length === 0) return undefined;

  const projectRoot = options.context?.gitRoot
    ?? options.context?.executionCwd
    ?? process.cwd();
  const workingDirectory = options.context?.executionCwd ?? projectRoot;
  const registry = getSkillRegistry(projectRoot);
  if (registry.size === 0) {
    await initializeSkillRegistry(projectRoot);
  }

  const skillContext: SkillContext = {
    workingDirectory,
    projectRoot,
    environment: {},
    // FEATURE_222 (R4): a workflow-generation request may reference a project
    // skill whose SKILL.md has `!`cmd`` dynamic-context — honor the host policy
    // here too, not just the interactive `skill` tool path.
    executeDynamicContext: options.skillDynamicContext?.execute,
    disableDynamicContext: options.skillDynamicContext?.disable,
  };
  const skillNames = [
    ...explicitSkillNames,
    ...bareSlashNames.filter((name) =>
      !explicitSkillNames.includes(name) && registry.has(name)
    ),
  ];
  if (skillNames.length === 0) return undefined;

  const blocks: string[] = [];
  const references = [
    ...parseInlineSkillReferences(request),
    ...parseBareInlineSlashReferences(request),
  ].sort((left, right) => left.start - right.start);
  const firstReferenceByName = new Map<string, (typeof references)[number]>();
  for (const reference of references) {
    if (!firstReferenceByName.has(reference.name)) {
      firstReferenceByName.set(reference.name, reference);
    }
  }

  for (const skillName of explicitSkillNames) {
    if (!registry.has(skillName)) {
      const available = registry.list().map((skill) => skill.name).sort().join(', ');
      throw new Error(
        `workflow generation referenced unknown skill "${skillName}". Available skills: ${available || '(none)'}`,
      );
    }
  }

  for (const skillName of skillNames) {
    const skill = await registry.loadFull(skillName);
    const reference = firstReferenceByName.get(skillName);
    const argumentsText = reference ? request.slice(reference.end).trim() : '';
    const expanded = await expandSkillForLLM(skill, argumentsText, skillContext);
    blocks.push(expanded.content);
  }

  return blocks.join('\n\n');
}

function buildWorkflowGenerationRepairPrompt(input: {
  readonly request: string;
  readonly skillContext?: string;
  readonly previousOutput: string;
  readonly error: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}): string {
  const commonFixes = [
    '- Replace result.output from wf.runAgent(...) or wf.wait(...) with result.finalText.',
    '- Replace result.output from wf.synthesize(...) with result.text.',
    '- Replace hardcoded wf.wait("...")/wf.snapshot("...")/wf.send("...", ...)/wf.stop("...", ...) calls with handle.taskId/result.taskId variables.',
    '- Replace wf.wait("agent-name") after wf.runAgent(...) with captured runAgent/parallel results; wf.wait only accepts taskId values from spawnAgent handles.',
    staticText("t12h.workflow-generator.8"),
    '- Keep the outer run() return displayable, such as { synthesis: finalText }.',
    '- Fix generated JavaScript harness errors, including ReferenceError, wrong wf.* argument shapes, and multi-line prompts/rubrics that need template literals or "\\n".',
  ];
  if (
    /\bwf\s*\.\s*output\s*\(/.test(input.previousOutput) ||
    input.error.includes('wf.snapshot(taskId)')
  ) {
    commonFixes.splice(
      2,
      0,
      '- Replace wf.output(taskId) with wf.snapshot(taskId) for in-flight task snapshots.',
    );
  }

  return [
    buildWorkflowGenerationUserPrompt(input.request, input.skillContext),
    '',
    'Your previous output failed KodaX workflow validation.',
    `Repair attempt: ${input.attempt} of ${input.maxAttempts}.`,
    `Validation error: ${input.error}`,
    '',
    'Common contract fixes:',
    ...commonFixes,
    '',
    'Previous output:',
    input.previousOutput,
    '',
    'Return corrected JSON only. Keep the same task intent, but make the manifest and source valid.',
  ].join('\n');
}

interface ParseWorkflowGenerationOptions {
  readonly request?: string;
}

function requestExplicitlyMentionsTokenBudget(request: string): boolean {
  return /(?:token\s*(?:budget|limit|cap)|budget\s*(?:for|of)?\s*tokens?|\b\d+(?:\.\d+)?\s*(?:k|m)?\s*tokens?\b|\d+(?:\.\d+)?\s*(?:k|m)?\s*令牌|(?:tokens?|令牌).{0,12}(?:预算|上限|限制)|(?:预算|上限|限制).{0,12}(?:tokens?|令牌))/i.test(request);
}

function stripImplicitTokenBudget(
  manifest: WorkflowScriptManifest,
  request: string | undefined,
): WorkflowScriptManifest {
  if (manifest.tokenBudget === undefined || request === undefined) {
    return manifest;
  }
  if (requestExplicitlyMentionsTokenBudget(request)) {
    return manifest;
  }
  const { tokenBudget: _tokenBudget, ...withoutTokenBudget } = manifest;
  return withoutTokenBudget;
}

export function parseWorkflowGeneration(
  rawText: string,
  options: ParseWorkflowGenerationOptions = {},
): WorkflowGenerationResult {
  const data = parseGenerationJson(rawText);
  const action = data.action;

  if (action === 'decline') {
    return {
      kind: 'declined',
      reason: readNonEmptyString(data, 'reason'),
      rawText,
    };
  }

  if (action !== 'generate') {
    throw new Error('workflow generation action must be "generate" or "decline"');
  }

  const source = validateGeneratedWorkflowSource(readNonEmptyString(data, 'source'));
  const manifest = stripImplicitTokenBudget(
    reserveGeneratedWorkflowAgentCapacity(
      validateWorkflowScriptManifest(normalizeGeneratedManifestCandidate(data.manifest)),
      source,
    ),
    options.request,
  );
  const approvalSummary =
    typeof data.approvalSummary === 'string' && data.approvalSummary.trim().length > 0
      ? data.approvalSummary
      : manifest.description;
  const module = createRestrictedWorkflowModule({ manifest, source });
  const qualityWarnings = lintRestrictedWorkflowSource(source, { manifest })
    .filter((finding) => finding.severity === 'warning');

  return {
    kind: 'generated',
    manifest,
    source,
    module,
    scriptSnapshot: { manifest, source },
    approvalSummary,
    ...(qualityWarnings.length > 0 ? { qualityWarnings } : {}),
    rawText,
  };
}

export async function generateWorkflow(
  input: GenerateWorkflowInput,
): Promise<WorkflowGenerationResult> {
  const request = input.request.trim();
  if (!request) {
    return { kind: 'declined', reason: 'Workflow request is empty.', rawText: '' };
  }

  const maxAttempts = WORKFLOW_GENERATION_REPAIR_ATTEMPTS + 1;
  let prompt = buildWorkflowGenerationUserPrompt(request, input.skillContext);
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const rawText = await input.generateText({
      system: WORKFLOW_GENERATION_SYSTEM_PROMPT,
      prompt,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    try {
      const parsed = parseWorkflowGeneration(rawText, { request });
      if (parsed.kind === 'generated') {
        await assertGeneratedWorkflowSmoke({
          source: parsed.source,
          request,
        });
      }
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts) break;
      prompt = buildWorkflowGenerationRepairPrompt({
        request,
        ...(input.skillContext ? { skillContext: input.skillContext } : {}),
        previousOutput: rawText,
        error: lastError,
        attempt: attempt + 1,
        maxAttempts,
      });
    }
  }

  throw new Error(
    `workflow generation did not produce a valid workflow after ${maxAttempts} attempts. Last validation error: ${lastError}`,
  );
}

export async function generateWorkflowFromOptions(
  input: GenerateWorkflowFromOptionsInput,
): Promise<WorkflowGenerationResult> {
  const provider = resolveProvider(input.options.provider);
  const model = input.options.modelOverride ?? input.options.model ?? provider.getModel();
  const effort = input.options.effort?.trim();
  if (input.timeoutMs !== undefined && input.timeoutSec !== undefined) {
    throw new Error('workflow generation timeoutSec and timeoutMs cannot both be set');
  }
  const timeoutMs = input.timeoutMs
    ?? timeoutSecToMs(input.timeoutSec, 'workflow generation timeoutSec')
    ?? resolveWorkflowGenerationTimeoutMs(process.env, input.options.timeouts);
  const skillContext = input.skillContext
    ?? await buildWorkflowGenerationSkillContext(input.request, input.options);
  return generateWorkflow({
    request: input.request,
    ...(skillContext ? { skillContext } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    generateText: async (request) => {
      const messages: readonly KodaXMessage[] = [
        { role: 'user', content: request.prompt },
      ];
      const result = await sideQuery({
        provider,
        model,
        system: request.system,
        messages,
        querySource: 'workflow-generation',
        credentialPurpose: 'workflow',
        timeoutMs,
        ...(effort ? { reasoning: { effort } } : {}),
        ...(request.signal ? { abortSignal: request.signal } : {}),
      });

      if (!result.text.trim()) {
        const suffix = result.error ? `: ${result.error.message}` : '';
        const timeoutHint = result.stopReason === 'timeout' ? ` after ${timeoutMs}ms` : '';
        throw new Error(`workflow generation failed (${result.stopReason}${timeoutHint})${suffix}`);
      }
      return result.text;
    },
  });
}
