import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXToolExecutionContext } from '../types.js';
import type {
  LocalToolDefinition,
  RegisteredToolDefinition,
  ToolSideEffect,
  ToolDefinitionSource,
  ToolHandler,
  ToolResult,
  ToolRegistry,
  ToolRegistrationOptions,
} from './types.js';
import { BUILTIN_TOOL_DEFINITIONS } from './tool-definitions.js';
import { safeFallbackToClassifierInput } from './classifier-projection.js';
import type { RunScopedToolDefinition } from '../extensions/runtime-contract.js';
const TOOL_REGISTRY: ToolRegistry = new Map();
let nextToolRegistrationId = 0;

const VALID_SIDE_EFFECTS = new Set<ToolSideEffect>([
  'readonly',
  'reads-network',
  'mutates-fs',
  'mutates-shell',
  'mutates-network',
  'mutates-state',
]);

export const REPO_INTELLIGENCE_WORKING_TOOL_NAMES = [
  'repo_overview',
  'changed_scope',
  'changed_diff',
  'changed_diff_bundle',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
  'relationship_scan',
  'cyclic_dependencies',
  'semantic_lookup',
] as const;

const REPO_INTELLIGENCE_WORKING_TOOL_NAME_SET = new Set<string>(
  REPO_INTELLIGENCE_WORKING_TOOL_NAMES,
);

export const MCP_TOOL_NAMES = [
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'mcp_read_resource',
  'mcp_get_prompt',
] as const;

const MCP_TOOL_NAME_SET = new Set<string>(MCP_TOOL_NAMES);

function extractRequiredParams(
  inputSchema: KodaXToolDefinition['input_schema'] | undefined,
): string[] {
  if (
    !inputSchema
    || typeof inputSchema !== 'object'
    || !('required' in inputSchema)
    || !Array.isArray(inputSchema.required)
  ) {
    return [];
  }

  return inputSchema.required.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

function toToolDefinition(definition: RegisteredToolDefinition): KodaXToolDefinition {
  const { handler: _handler, registrationId: _registrationId, requiredParams: _requiredParams, source: _source, ...tool } = definition;
  return tool;
}

function getActiveToolRegistration(name: string): RegisteredToolDefinition | undefined {
  const registrations = TOOL_REGISTRY.get(name);
  if (!registrations || registrations.length === 0) {
    return undefined;
  }
  return registrations[registrations.length - 1];
}

function removeToolRegistration(registrationId: string): void {
  for (const [name, registrations] of TOOL_REGISTRY) {
    const nextRegistrations = registrations.filter(
      (registration) => registration.registrationId !== registrationId,
    );

    if (nextRegistrations.length === registrations.length) {
      continue;
    }

    if (nextRegistrations.length === 0) {
      TOOL_REGISTRY.delete(name);
    } else {
      TOOL_REGISTRY.set(name, nextRegistrations);
    }
    return;
  }
}

function registerToolInternal(
  definition: LocalToolDefinition,
  options: ToolRegistrationOptions = {},
): () => void {
  const normalized = normalizeToolDefinition(definition);
  const registrationId = `tool:${++nextToolRegistrationId}`;
  const source: ToolDefinitionSource = options.source ?? {
    kind: 'extension',
    id: registrationId,
    label: normalized.name,
  };

  const registration: RegisteredToolDefinition = {
    ...normalized,
    registrationId,
    requiredParams: extractRequiredParams(normalized.input_schema),
    source,
  };

  const existing = TOOL_REGISTRY.get(normalized.name) ?? [];
  TOOL_REGISTRY.set(normalized.name, [...existing, registration]);

  return () => {
    removeToolRegistration(registrationId);
  };
}

function normalizeToolDefinition(definition: LocalToolDefinition): LocalToolDefinition {
  const runtimeDefinition = definition as unknown as {
    readonly name: string;
    readonly sideEffect?: unknown;
    readonly toClassifierInput?: unknown;
    readonly classifierExemptReason?: unknown;
  };
  const sideEffect = isToolSideEffect(runtimeDefinition.sideEffect)
    ? runtimeDefinition.sideEffect
    : 'mutates-state';
  const originalProjector = typeof runtimeDefinition.toClassifierInput === 'function'
    ? runtimeDefinition.toClassifierInput as (input: unknown) => unknown
    : undefined;
  const exempt = typeof runtimeDefinition.classifierExemptReason === 'string'
    && runtimeDefinition.classifierExemptReason.trim().length > 0;

  const toClassifierInput = (input: unknown): string => {
    if (!originalProjector) {
      return sideEffect === 'readonly' || exempt
        ? ''
        : safeFallbackToClassifierInput(runtimeDefinition.name, input);
    }
    const projected: unknown = originalProjector(input);
    if (typeof projected !== 'string') {
      throw new TypeError('classifier projector must return a string');
    }
    if (projected.trim().length === 0 && sideEffect !== 'readonly' && !exempt) {
      return safeFallbackToClassifierInput(runtimeDefinition.name, input);
    }
    return projected.trim().length === 0 ? '' : projected;
  };

  return { ...definition, sideEffect, toClassifierInput };
}

function isToolSideEffect(value: unknown): value is ToolSideEffect {
  return typeof value === 'string' && VALID_SIDE_EFFECTS.has(value as ToolSideEffect);
}


for (const definition of BUILTIN_TOOL_DEFINITIONS) {
  registerToolInternal(definition, {
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  });
}

export const KODAX_TOOLS: KodaXToolDefinition[] = BUILTIN_TOOL_DEFINITIONS.map((definition) => {
  const { handler: _handler, ...tool } = definition;
  return tool;
});

export function registerTool(
  definition: LocalToolDefinition,
  options: ToolRegistrationOptions = {},
): () => void {
  return registerToolInternal(definition, options);
}

export function getTool(name: string): ToolHandler | undefined {
  return getActiveToolRegistration(name)?.handler;
}

export function getToolDefinition(name: string): KodaXToolDefinition | undefined {
  const registration = getActiveToolRegistration(name);
  return registration ? toToolDefinition(registration) : undefined;
}

export function getRegisteredToolDefinition(name: string): RegisteredToolDefinition | undefined {
  return getActiveToolRegistration(name);
}

export function getToolRegistrations(name: string): RegisteredToolDefinition[] {
  return [...(TOOL_REGISTRY.get(name) ?? [])];
}

export function getBuiltinToolDefinition(name: string): KodaXToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }
  const { handler: _handler, ...tool } = definition;
  return tool;
}

export function getBuiltinRegisteredToolDefinition(
  name: string,
): RegisteredToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }

  return {
    ...definition,
    registrationId: `builtin:${definition.name}`,
    requiredParams: extractRequiredParams(definition.input_schema),
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  };
}

export function createBuiltinToolDefinition(
  name: string,
): LocalToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }
  return {
    ...definition,
    input_schema: definition.input_schema
      ? JSON.parse(JSON.stringify(definition.input_schema))
      : definition.input_schema,
  };
}

export function listBuiltinToolDefinitions(): RegisteredToolDefinition[] {
  return BUILTIN_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    registrationId: `builtin:${definition.name}`,
    requiredParams: extractRequiredParams(definition.input_schema),
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  }));
}

/**
 * v0.7.42 — snapshot of every currently-active tool registration.
 *
 * Returns the most-recent registration for each tool name (mirroring
 * {@link getRegisteredToolDefinition}'s single-name semantics across the
 * full registry). Use this to drive metadata-based filters such as:
 *
 *   - SDK embedder permission brokers building a blocklist by side-effect class:
 *     `getAllRegisteredTools().filter(t => t.sideEffect !== 'readonly')`
 *   - UI that displays available tools grouped by category.
 *   - Plan-mode gates that compute their own blocklist from metadata
 *     instead of hardcoded `Set<string>` of names.
 *
 * The returned array is a fresh copy per call (safe to mutate without
 * affecting the registry). Order is registration order (sorted by name
 * within each registration to keep the snapshot deterministic).
 */
export function getAllRegisteredTools(): RegisteredToolDefinition[] {
  const result: RegisteredToolDefinition[] = [];
  for (const [name] of TOOL_REGISTRY) {
    const active = getActiveToolRegistration(name);
    if (active) result.push(active);
  }
  result.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}

/**
 * v0.7.42 — plan-mode permit check driven by tool metadata.
 *
 *   - `sideEffect === 'readonly'` ⇒ permitted (unless explicitly
 *     `planModeAllowed: false`).
 *   - `planModeAllowed: true` ⇒ permitted (overrides non-readonly).
 *   - any other sideEffect ⇒ blocked.
 *
 * Returns `false` for unknown tool names (fail-closed). Use this in
 * preference to hardcoded `Set<string>` of tool names — adding a new
 * `'mutates-fs'` builtin will flow through automatically.
 */
export function isToolPlanModeAllowed(
  name: string,
  runScopedTools?: ReadonlyMap<string, RunScopedToolDefinition>,
): boolean {
  const def = runScopedOrRegisteredDefinition(name, runScopedTools);
  if (!def) return false;
  if (def.planModeAllowed === true) return true;
  if (def.planModeAllowed === false) return false;
  return def.sideEffect === 'readonly';
}
function runScopedOrRegisteredDefinition(
  name: string,
  runScopedTools: ReadonlyMap<string, RunScopedToolDefinition> | undefined,
) {
  return getActiveToolRegistration(name)
    ?? BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name)
    ?? runScopedTools?.get(name);
}

/**
 * v0.7.42 — does this tool mutate the filesystem? *
 * Wraps `sideEffect === 'mutates-fs'`. Used by the REPL permission
 * pipeline's gitRoot guard and Space's permission broker. Replaces the
 * previous practice of hardcoding `Set(["write", "edit"])`-style lookups
 * scattered across 5+ callsites.
 */
export function isToolFileMutation(
  name: string,
  runScopedTools?: ReadonlyMap<string, RunScopedToolDefinition>,
): boolean {
  const def = runScopedOrRegisteredDefinition(name, runScopedTools);
  return def?.sideEffect === 'mutates-fs';
}

/**
 * FEATURE_247 — does this tool perform a read-only network request
 * (`sideEffect === 'reads-network'`)?
 *
 * Lets an SDK embedder's permission broker (e.g. KodaX-Space Partner) allow
 * web research / MCP reads (`web_search`, `mcp_read_resource`, `mcp_get_prompt`)
 * while still blocking mutating network calls (`mcp_call` →
 * `mutates-network`). `web_fetch` is a bounded read-only GET. Fail-closed:
 * unknown names return `false`.
 *
 * Note: `isToolMutation` intentionally still returns `true` for a
 * `reads-network` tool (only `readonly` is treated as non-mutating there), so
 * existing mutation-gate behavior is unchanged — use THIS predicate, or the
 * `sideEffect` value directly, to select the read-network class.
 */
export function isToolNetworkRead(
  name: string,
  runScopedTools?: ReadonlyMap<string, RunScopedToolDefinition>,
): boolean {
  const def = runScopedOrRegisteredDefinition(name, runScopedTools);
  return def?.sideEffect === 'reads-network';
}

/**
 * v0.7.42 — does this tool mutate anything (FS, shell, network, state)? *
 * True for every `sideEffect` except `'readonly'`. Fail-closed (unknown
 * names return `true` — assumed mutating until proven otherwise).
 */
export function isToolMutation(
  name: string,
  runScopedTools?: ReadonlyMap<string, RunScopedToolDefinition>,
): boolean {
  const def = runScopedOrRegisteredDefinition(name, runScopedTools);
  if (!def) return true;
  return def.sideEffect !== 'readonly';
}

export function getRequiredToolParams(name: string): string[] {
  return getActiveToolRegistration(name)?.requiredParams ?? [];
}

export function listTools(): string[] {
  return Array.from(TOOL_REGISTRY.keys())
    .filter((name) => getActiveToolRegistration(name) !== undefined)
    .sort((left, right) => left.localeCompare(right));
}

export function listToolDefinitions(): KodaXToolDefinition[] {
  return listTools()
    .map((name) => getToolDefinition(name))
    .filter((definition): definition is KodaXToolDefinition => definition !== undefined);
}

export function isRepoIntelligenceWorkingToolName(name: string): boolean {
  return REPO_INTELLIGENCE_WORKING_TOOL_NAME_SET.has(name);
}

export function filterRepoIntelligenceWorkingToolNames<T extends string>(
  toolNames: readonly T[],
): T[] {
  return toolNames.filter((name) => !isRepoIntelligenceWorkingToolName(name));
}

export function isMcpToolName(name: string): boolean {
  return MCP_TOOL_NAME_SET.has(name);
}

export function filterMcpToolNames<T extends string>(
  toolNames: readonly T[],
): T[] {
  return toolNames.filter((name) => !isMcpToolName(name));
}

/**
 * Detect whether a handler's return value is an AsyncGenerator (streaming tool).
 * Async generators have Symbol.asyncIterator; Promises do not.
 */
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    value !== null
    && value !== undefined
    && typeof value === 'object'
    && Symbol.asyncIterator in (value as object)
  );
}

/**
 * Consume an async generator: forward each yield as a progress update,
 * then return the generator's final return value.
 *
 * NOTE: `for await...of` does NOT capture the return value of a generator.
 * We must use manual .next() iteration to capture `{ done: true, value }`.
 */
async function consumeToolGenerator(
  gen: AsyncGenerator<import('./types.js').ToolProgress, ToolResult, void>,
  onProgress?: (message: string) => void,
): Promise<ToolResult> {
  let step = await gen.next();
  while (!step.done) {
    const progress = step.value;
    if (progress && typeof progress.message === 'string') {
      onProgress?.(progress.message);
    }
    step = await gen.next();
  }
  // step.done === true → step.value is the return value (text or multimodal content)
  return step.value;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<ToolResult> {
  const definition = getRegisteredToolDefinition(name);
  if (!definition) {
    return `[Tool Error] Unknown tool: ${name}. Available tools: ${listTools().join(', ')}`;
  }

  const missing = definition.requiredParams.filter(
    (param) => input[param] === undefined || input[param] === null,
  );
  if (missing.length > 0) {
    return `[Tool Error] ${name}: Missing required parameter(s): ${missing.join(', ')}`;
  }

  try {
    const result = definition.handler(input, ctx);

    // Streaming tool (async generator): consume yields as progress, return final value
    if (isAsyncGenerator(result)) {
      return await consumeToolGenerator(
        result as AsyncGenerator<import('./types.js').ToolProgress, ToolResult, void>,
        ctx.reportToolProgress,
      );
    }

    // Standard tool (Promise<ToolResult>): await as before
    return await (result as Promise<ToolResult>);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('ENOENT')) {
      return `[Tool Error] ${name}: File or directory not found`;
    }
    if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
      return `[Tool Error] ${name}: Permission denied`;
    }
    if (errorMsg.includes('ENOSPC')) {
      return `[Tool Error] ${name}: No space left on device`;
    }
    return `[Tool Error] ${name}: ${errorMsg}`;
  }
}
