/**
 * Coding Agent internal tools for runtime tool construction
 * (FEATURE_087 + FEATURE_088, v0.7.28).
 *
 * The five tools form an end-to-end staircase the LLM walks through to
 * generate a tool at runtime:
 *
 *   scaffold_tool       → emit a fillable artifact skeleton.
 *   validate_tool       → dry-run shape + AST + provider-schema checks
 *                         on a candidate JSON (no disk write).
 *   stage_construction  → persist the artifact under .kodax/constructed/.
 *   test_tool           → run the full Phase 2 check pipeline on a staged
 *                         artifact (shape + AST + schema + materialize).
 *   activate_tool       → register the tested artifact into TOOL_REGISTRY.
 *
 * Notes:
 *   - All tools are read/write side-effecting on `.kodax/constructed/` only;
 *     none of them require the network. The LLM static review is opt-in
 *     and not invoked from `test_tool` because tool handlers do not
 *     receive a provider client through `KodaXToolExecutionContext`.
 *     Callers that want the L2 review should drive it directly through
 *     the runtime API or future variant tool.
 *   - These tools are gated at the agent layer (active tool set) — they
 *     are NOT exposed unconditionally. The Tool Construction prompt
 *     section turns them on for sessions that need self-construction.
 */

import type { KodaXToolExecutionContext } from '../types.js';
import {
  type ConstructionArtifact,
  type SchemaProvider,
  type StagedHandle,
  type TestResult,
  DEFAULT_HANDLER_TIMEOUT_MS,
  runAstRules,
  validateToolSchemaForProvider,
  stage as stageArtifact,
  testArtifact,
  activate as activateArtifact,
  readArtifact,
} from '../construction/index.js';
import { readOptionalString } from './internal.js';

/**
 * Names of the five construction-staircase tools. Single source of truth
 * used by both the registry definitions below and the agent-layer gating
 * in `filterConstructionToolNames` so the two can never drift.
 */
export const CONSTRUCTION_TOOL_NAMES = [
  'scaffold_tool',
  'validate_tool',
  'stage_construction',
  'test_tool',
  'activate_tool',
] as const;

const CONSTRUCTION_TOOL_NAME_SET = new Set<string>(CONSTRUCTION_TOOL_NAMES);

export function isConstructionToolName(name: string): boolean {
  return CONSTRUCTION_TOOL_NAME_SET.has(name);
}

/**
 * Filter the construction tools out of an active-tool-name list when
 * tool-construction mode is OFF. Mirrors the pattern of
 * `filterMcpToolNames` / `filterRepoIntelligenceWorkingToolNames`:
 * registration is unconditional, exposure is mode-gated.
 */
export function filterConstructionToolNames<T extends string>(
  toolNames: readonly T[],
  toolConstructionMode: boolean | undefined,
): T[] {
  if (toolConstructionMode) return [...toolNames];
  return toolNames.filter((name) => !isConstructionToolName(name));
}

/**
 * Strict required-string reader. Returns the trimmed value or throws.
 * Used by tools that cannot proceed with missing identifiers (name /
 * version / json blob).
 */
function readRequiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`'${key}' is required and must be a non-empty string.`);
  }
  return value.trim();
}

/** Tolerant JSON parse — surface a clear message on syntax error. */
function parseArtifactJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`artifact_json failed to parse as JSON: ${(err as Error).message}`);
  }
}

/**
 * Shape-narrow an unknown into a ConstructionArtifact, throwing with a
 * pointed message on the first missing/wrong field. Cheap up-front check
 * before delegating to the runtime; lets the tool fail fast with a
 * useful error instead of an opaque downstream throw.
 */
function asConstructionArtifact(value: unknown): ConstructionArtifact {
  if (!value || typeof value !== 'object') {
    throw new Error('artifact must be a JSON object.');
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'tool') {
    throw new Error(`artifact.kind must be 'tool' (got ${JSON.stringify(obj.kind)}).`);
  }
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    throw new Error('artifact.name must be a non-empty string.');
  }
  if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    throw new Error('artifact.version must be a non-empty string (semver recommended).');
  }
  if (!obj.content || typeof obj.content !== 'object') {
    throw new Error('artifact.content must be an object.');
  }
  const content = obj.content as Record<string, unknown>;
  if (typeof content.description !== 'string') {
    throw new Error('artifact.content.description must be a string.');
  }
  if (!content.inputSchema || typeof content.inputSchema !== 'object') {
    throw new Error('artifact.content.inputSchema must be an object.');
  }
  if (!content.capabilities || typeof content.capabilities !== 'object') {
    throw new Error('artifact.content.capabilities must be an object with a tools array.');
  }
  const handler = content.handler as Record<string, unknown> | undefined;
  if (!handler || handler.kind !== 'script' || handler.language !== 'javascript') {
    throw new Error("artifact.content.handler must be { kind: 'script', language: 'javascript', code }.");
  }
  if (typeof handler.code !== 'string' || handler.code.trim() === '') {
    throw new Error('artifact.content.handler.code must be a non-empty JavaScript source string.');
  }
  return value as ConstructionArtifact;
}

/** Render a TestResult into a stable, LLM-friendly text block. */
function renderTestResult(result: TestResult): string {
  const lines: string[] = [];
  lines.push(`ok=${result.ok ? 'true' : 'false'}`);
  if (result.errors && result.errors.length > 0) {
    lines.push('errors:');
    for (const err of result.errors) lines.push(`  - ${err}`);
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push('warnings:');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

// ============================================================
// 1. scaffold_tool
// ============================================================

const SCAFFOLD_HANDLER_TEMPLATE =
  'export async function handler(input, ctx) {\n'
  + "  // TODO: implement using only declared capabilities (ctx.tools.<name>).\n"
  + "  // Return a string. Throw on unrecoverable input. The runtime applies\n"
  + "  // a timeout (default 30s) and rejects calls to undeclared tools.\n"
  + '  return JSON.stringify({ note: \'scaffold — replace this body\', input });\n'
  + '}\n';

export async function toolScaffoldTool(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const name = readRequiredString(input, 'name');
    const version = readOptionalString(input, 'version') ?? '0.1.0';
    const description = readOptionalString(input, 'description')
      ?? 'TODO: short tool description.';

    const capsRaw = input.capabilities;
    const capabilities: { tools: string[] } = (() => {
      if (!capsRaw) return { tools: [] };
      if (typeof capsRaw !== 'object') {
        throw new Error('capabilities must be an object with a tools[] array.');
      }
      const tools = (capsRaw as { tools?: unknown }).tools;
      if (tools === undefined) return { tools: [] };
      if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) {
        throw new Error('capabilities.tools must be an array of builtin tool names (strings).');
      }
      return { tools: tools as string[] };
    })();

    const skeleton: ConstructionArtifact = {
      kind: 'tool',
      name,
      version,
      status: 'staged',
      createdAt: Date.now(),
      content: {
        description,
        inputSchema: {
          type: 'object',
          properties: {
            // TODO: define inputs the LLM will pass to the handler.
          },
        },
        capabilities,
        handler: {
          kind: 'script',
          language: 'javascript',
          code: SCAFFOLD_HANDLER_TEMPLATE,
        },
        timeoutMs: DEFAULT_HANDLER_TIMEOUT_MS,
      },
    };

    return [
      'Scaffolded artifact JSON (fill TODO sections, then call validate_tool):',
      '',
      JSON.stringify(skeleton, null, 2),
    ].join('\n');
  } catch (err) {
    return `[Tool Error] scaffold_tool: ${(err as Error).message}`;
  }
}

// ============================================================
// 2. validate_tool
// ============================================================

export async function toolValidateTool(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const raw = readRequiredString(input, 'artifact_json');
    const provider = (readOptionalString(input, 'provider') ?? 'anthropic') as SchemaProvider;

    let artifact: ConstructionArtifact;
    try {
      artifact = asConstructionArtifact(parseArtifactJson(raw));
    } catch (err) {
      return `[Tool Error] validate_tool: ${(err as Error).message}`;
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    if (artifact.kind !== 'tool') {
      errors.push(
        `validate_tool only inspects tool artifacts (got kind='${artifact.kind}'). ` +
          'Use validate_agent for agent artifacts (FEATURE_089).',
      );
      return renderTestResult({ ok: false, errors });
    }

    // Shape: capabilities.tools array sanity (handled in asConstructionArtifact for top-level).
    const capTools = (artifact.content.capabilities as { tools?: unknown }).tools;
    if (!Array.isArray(capTools)) {
      errors.push('capabilities.tools must be an array of strings.');
    } else {
      for (const t of capTools) {
        if (typeof t !== 'string' || t.trim() === '') {
          errors.push(`capabilities.tools entry must be a non-empty string (got: ${JSON.stringify(t)}).`);
          break;
        }
      }
    }

    // AST hard rules.
    const ast = runAstRules(artifact.content.handler.code);
    if (!ast.ok) {
      for (const v of ast.violations) errors.push(`[${v.rule}] ${v.message}`);
    }

    // Provider schema.
    const schema = validateToolSchemaForProvider(artifact.content.inputSchema, provider);
    for (const w of schema.warnings) warnings.push(`[schema] ${w}`);
    if (!schema.ok) {
      for (const e of schema.errors) errors.push(`[schema] ${e}`);
    }

    return renderTestResult({
      ok: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    return `[Tool Error] validate_tool: ${(err as Error).message}`;
  }
}

// ============================================================
// 3. stage_construction
// ============================================================

export async function toolStageConstruction(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const raw = readRequiredString(input, 'artifact_json');
    const artifact = asConstructionArtifact(parseArtifactJson(raw));
    const handle = await stageArtifact(artifact);
    return [
      `staged: ${handle.artifact.name}@${handle.artifact.version}`,
      `status=${handle.artifact.status}`,
      'Next: call test_tool with name and version.',
    ].join('\n');
  } catch (err) {
    return `[Tool Error] stage_construction: ${(err as Error).message}`;
  }
}

// ============================================================
// 4. test_tool
// ============================================================

export async function toolTestTool(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const name = readRequiredString(input, 'name');
    const version = readRequiredString(input, 'version');
    const provider = readOptionalString(input, 'provider') as SchemaProvider | undefined;

    const artifact = await readArtifact(name, version);
    if (!artifact) {
      return `[Tool Error] test_tool: no staged artifact found for ${name}@${version}.`;
    }
    if (artifact.status === 'revoked') {
      return `[Tool Error] test_tool: artifact ${name}@${version} is revoked. Bump the version and re-stage.`;
    }

    const handle: StagedHandle = { artifact, stagedAt: Date.now() };
    const result = await testArtifact(handle, provider ? { provider } : undefined);
    return renderTestResult(result);
  } catch (err) {
    return `[Tool Error] test_tool: ${(err as Error).message}`;
  }
}

// ============================================================
// 5. activate_tool
// ============================================================

export async function toolActivateTool(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const name = readRequiredString(input, 'name');
    const version = readRequiredString(input, 'version');

    const artifact = await readArtifact(name, version);
    if (!artifact) {
      return `[Tool Error] activate_tool: no artifact found for ${name}@${version}. Stage and test it first.`;
    }
    if (artifact.status === 'revoked') {
      return `[Tool Error] activate_tool: ${name}@${version} is revoked. Bump the version and re-stage.`;
    }

    const handle: StagedHandle = { artifact, stagedAt: Date.now() };
    await activateArtifact(handle);
    return [
      `activated: ${name}@${version}`,
      `The handler is now registered in TOOL_REGISTRY and callable as '${name}'.`,
    ].join('\n');
  } catch (err) {
    return `[Tool Error] activate_tool: ${(err as Error).message}`;
  }
}
