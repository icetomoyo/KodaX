import { isDeepStrictEqual } from 'node:util';
import type { Agent, RunnableTool, RunnerToolContext } from '@kodax-ai/agent';
import type { KodaXToolDefinition, KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXToolExecutionContext } from '../../types.js';
import { markRegistryManagedAgent } from '../../tools/model-tool-definition.js';
import { validateScriptCell, type ScriptCellResult } from './cell.js';

export const SCRIPT_TOOL_NAME = 'script_exec';
// Safety bounds for one isolated cell, separate from the existing parent work budget.
export const SCRIPT_MODEL_LIMITS = { timeoutMs: 60_000, memoryBytes: 32 * 1024 * 1024,
  maxCalls: 64, maxTransferBytes: 1024 * 1024 };
interface ScriptModelContracts {
  readonly entry: KodaXToolDefinition;
  readonly leaves: readonly KodaXToolDefinition[];
}
const scriptContracts = new WeakMap<Agent, ScriptModelContracts>();

/** Structured contracts are serialized once, never recovered by parsing generated teaching. */
export function buildScriptModelDescription(leaves: readonly KodaXToolDefinition[]): string {
  return 'Run an async JavaScript function body in an isolated, fresh VM. Use await tools.NAME(JSON arguments) with the complete contracts below; no discovery call is needed. Calls execute serially, even in Promise.all. No process, filesystem, network, imports or state between cells. Optionally return a JSON summary; original leaf outputs and warnings are already included in receipts, so avoid repeating them. Every leaf returns {content,isError,metadata}; check isError before dependent operations. Partial effects are retained on failure/cancellation; inspect receipts and never blindly replay a cell. Native control tools and undo remain outside Script. Existing permissions and shared work budget apply to every leaf. Foreground shell only. '
    + `Use native bash for background commands. Limits: ${SCRIPT_MODEL_LIMITS.timeoutMs / 1000}s cell deadline (admitted host calls drain before return), ${SCRIPT_MODEL_LIMITS.maxCalls} attempted calls, ${SCRIPT_MODEL_LIMITS.memoryBytes / 1024 / 1024}MiB VM memory, ${SCRIPT_MODEL_LIMITS.maxTransferBytes / 1024 / 1024}MiB per transfer.\nCallable contracts (JSON Schema):\n`
    + leaves.map(tool => JSON.stringify(tool)).join('\n');
}

/** Only actually disclosed, unchanged bindings prove leaf-contract coverage. */
export function getScriptModelContracts(agent: Agent, tools: readonly KodaXToolDefinition[]): ScriptModelContracts | undefined {
  const bound = scriptContracts.get(agent);
  return bound && tools.some(tool => tool.name === SCRIPT_TOOL_NAME
    && tool.description === bound.entry.description && isDeepStrictEqual(tool.input_schema, bound.entry.input_schema))
    ? bound : undefined;
}

/** Same-response reference only; guest results and durable receipts remain complete. */
function serializeModelReceipt(cell: ScriptCellResult): string {
  const receipts = cell.receipts.map(({ id, name, result }) => ({ id, name, result }));
  const full = JSON.stringify({ ...cell, receipts });
  const findReference = (value: unknown): { id: number; field: 'result' | 'content' } | undefined => {
    for (const receipt of cell.receipts) {
      if (isDeepStrictEqual(value, receipt.result)) return { id: receipt.id, field: 'result' };
      if (isDeepStrictEqual(value, receipt.result.content)) return { id: receipt.id, field: 'content' };
    }
    return undefined;
  };
  const matching = findReference(cell.value);
  let projected: object;
  if (matching) {
    const { value: _value, ...rest } = cell;
    projected = { ...rest, receipts, value_from_receipt: matching };
  } else if (cell.value && typeof cell.value === 'object' && !Array.isArray(cell.value)) {
    // Only immediate return fields; no recursive compression or cross-response references.
    const entries = Object.entries(cell.value);
    const references = entries.flatMap(([key, value]) => {
      const reference = findReference(value);
      return reference ? [[key, reference] as const] : [];
    });
    if (!references.length) return full;
    const shared = new Set(references.map(([key]) => key));
    projected = { ...cell, receipts, value: Object.fromEntries(entries.filter(([key]) => !shared.has(key))),
      value_fields_from_receipts: Object.fromEntries(references) };
  } else return full;
  const compact = JSON.stringify({ ...projected,
    value_reference_note: 'References identify identical return data in this response: value_from_receipt replaces value; value_fields_from_receipts supplies omitted value fields. Use receipt id and field; no additional tool call is needed.' });
  return compact.length < full.length ? compact : full;
}

/** Only changes the model presentation. Native execution and AMA capability teaching remain intact. */
export function withScriptModelTool(agent: Agent, context: KodaXToolExecutionContext,
  leaves: readonly KodaXToolDefinition[], run: (code: string, caller: RunnerToolContext) => Promise<ScriptCellResult>): Agent {
  if (agent.tools?.some(tool => tool.name === SCRIPT_TOOL_NAME)) throw new Error('Script entry conflicts with a host tool.');
  const contracts = Object.freeze(leaves.map(tool => ({ ...tool, input_schema: structuredClone(tool.input_schema) })));
  let closed = false;
  const entry: RunnableTool = {
    name: SCRIPT_TOOL_NAME,
    description: buildScriptModelDescription(contracts),
    input_schema: { type: 'object', properties: { code: { type: 'string', description: 'Async function body; return a JSON value.' } }, required: ['code'] },
    requiresSerialExecution: () => true,
    execute: async (input, caller) => {
      if (closed) return { content: '[Tool Error] Script closed after a host failure. Inspect durable receipts before starting a new Run; do not replay effects.', isError: true };
      if (typeof input.code !== 'string') return { content: '[Tool Error] code must be a string.', isError: true };
      try { validateScriptCell(input.code, SCRIPT_MODEL_LIMITS); }
      catch (error) { return { content: `[Tool Error] ${String(error)}`, isError: true }; }
      let result: ScriptCellResult;
      try { result = await run(input.code, caller); }
      catch (error) { closed = true; throw error; }
      const images = result.receipts.flatMap(receipt => typeof receipt.result.content === 'string' ? []
        : receipt.result.content.filter(item => item.type === 'image'));
      // Native tools also encode degradation/pagination in text, without an error flag.
      // Keep their evidence verbatim; do not invent a second success classifier here.
      const text = serializeModelReceipt(result);
      return { content: images.length ? [{ type: 'text' as const, text }, ...images] : text,
        isError: result.status !== 'completed' || result.hadToolErrors,
        metadata: { scriptCellStatus: result.status, scriptReadPaths: result.receipts.flatMap(receipt => {
          const call = receipt.result.metadata?.toolCall as KodaXToolUseBlock | undefined;
          const name = call?.name ?? receipt.name;
          const path = (call?.input ?? receipt.input).path;
          return name === 'read' && !receipt.result.isError && typeof path === 'string' ? [path] : [];
        }),
          ...(result.status === 'cancelled' ? { cancelled: true } : {}) } };
    },
  };
  const bound = markRegistryManagedAgent(Object.freeze({ ...agent, tools: [...agent.tools ?? [], entry] }), context);
  scriptContracts.set(bound, { entry: { name: entry.name, description: entry.description,
    input_schema: structuredClone(entry.input_schema) }, leaves: contracts });
  return bound;
}

export function projectScriptModelTools<T extends KodaXToolDefinition>(agent: Agent, tools: readonly T[]): readonly T[] {
  const bound = getScriptModelContracts(agent, tools);
  const leaves = bound && new Set(bound.leaves.map(tool => tool.name));
  // Script only qualifies foreground shell; keep the full native path directly callable.
  return leaves ? tools.filter(tool => tool.name === 'bash' || !leaves.has(tool.name)) : tools;
}

/** Recovery needs a callable read path, not necessarily a native read schema. */
export function canReadWithModelTools(agent: Agent, tools: readonly KodaXToolDefinition[]): boolean {
  return tools.some(tool => tool.name === 'read')
    || getScriptModelContracts(agent, tools)?.leaves.some(tool => tool.name === 'read') === true;
}
