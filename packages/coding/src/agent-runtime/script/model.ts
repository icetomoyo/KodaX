import { staticText } from '../../prompts/static-text.js';
import { isDeepStrictEqual } from 'node:util';
import { isRunnableTool, type Agent, type RunnableTool } from '@kodax-ai/agent';
import type { KodaXToolDefinition, KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXToolExecutionContext } from '../../types.js';
import { markRegistryManagedAgent } from '../../tools/model-tool-definition.js';
import { validateScriptCell, type ScriptCellResult } from './cell.js';
import { createScriptModelSession, type ScriptModelRun, type ScriptObservation } from './model-session.js';

export const SCRIPT_TOOL_NAME = 'script_exec';
// Safety bounds for one isolated cell, separate from the existing parent work budget.
export const SCRIPT_MODEL_LIMITS = { timeoutMs: 60_000, memoryBytes: 32 * 1024 * 1024,
  maxCalls: 64, maxTransferBytes: 1024 * 1024 };
interface ScriptModelContracts {
  readonly entry: KodaXToolDefinition;
  readonly leaves: readonly KodaXToolDefinition[];
}
const scriptContracts = new WeakMap<Agent, ScriptModelContracts>();
const scriptSessions = new WeakMap<Agent, ReturnType<typeof createScriptModelSession>>();

export async function closeScriptModelSession(agent: Agent): Promise<void> {
  const session = scriptSessions.get(agent);
  if (!session) return;
  try { await session.close(); }
  finally { scriptSessions.delete(agent); }
}

/** Structured contracts are serialized once, never recovered by parsing generated teaching. */
export function buildScriptModelDescription(leaves: readonly KodaXToolDefinition[], nativeBridge = false): string {
  return staticText("t12.agent-runtime/script/model.0")
    + (nativeBridge ? 'Native tool_call({name,input}) can call these same tools without a Script cell; use whichever fits the task. ' : '')
    + `Use native bash for background commands. Limits: ${SCRIPT_MODEL_LIMITS.timeoutMs / 1000}s cell deadline (admitted host calls drain before return), ${SCRIPT_MODEL_LIMITS.maxCalls} attempted calls, ${SCRIPT_MODEL_LIMITS.memoryBytes / 1024 / 1024}MiB VM memory, ${SCRIPT_MODEL_LIMITS.maxTransferBytes / 1024 / 1024}MiB per transfer.\nCallable contracts (JSON Schema):\n`
    + leaves.map(tool => `tools[${JSON.stringify(tool.name)}](input): ${JSON.stringify(tool)}`).join('\n');
}

/** Only actually disclosed, unchanged bindings prove leaf-contract coverage. */
export function getScriptModelContracts(agent: Agent, tools: readonly KodaXToolDefinition[]): ScriptModelContracts | undefined {
  const bound = scriptContracts.get(agent);
  return bound && tools.some(tool => tool.name === SCRIPT_TOOL_NAME
    && tool.description === bound.entry.description && isDeepStrictEqual(tool.input_schema, bound.entry.input_schema))
    ? bound : undefined;
}

/** Same-response reference only; guest results and durable receipts remain complete. */
function serializeModelReceipt(cell: ScriptCellResult | ScriptObservation, selected = false, readable = false): string {
  const receipts = cell.receipts.map(({ id, name, result }) => {
    const notes = result.metadata?.scriptModelContent;
    const original = { cell_id: cell.cellId, call_id: id };
    const presented = selected && !result.isError && typeof notes === 'string'
      ? { ...result, content: notes, contentOmitted: true, original } : result;
    if (readable && result.data?.kind === 'text') {
      const { text: _text, ...range } = result.data;
      return { id, name, result: { ...presented, data: { ...range, textOmitted: true, original } } };
    }
    if (readable && result.data?.kind === 'json') {
      const value = result.data.value;
      const duplicate = value === null ? undefined : typeof value === 'string' ? value.trim() ? value : undefined : JSON.stringify(value);
      const displayed = duplicate && (typeof presented.content === 'string' ? presented.content.includes(duplicate)
        : presented.content.some(item => item.type === 'text' && item.text.includes(duplicate)));
      if (displayed) {
        const data = { kind: 'json' as const, valueOmitted: true, original };
        if (Buffer.byteLength(JSON.stringify(data)) < Buffer.byteLength(JSON.stringify(result.data))) {
          return { id, name, result: { ...presented, data } };
        }
      }
    }
    return { id, name, result: presented };
  });
  const full = JSON.stringify({ ...cell, receipts });
  if (selected) return full;
  const findReference = (value: unknown): { id: number; field: 'result' | 'content' } | undefined => {
    for (const receipt of receipts) {
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
    value_reference_note: staticText("t12.agent-runtime/script/model.1") });
  return compact.length < full.length ? compact : full;
}

/** Only changes the model presentation. Native execution and AMA capability teaching remain intact. */
export function withScriptModelTool(agent: Agent, context: KodaXToolExecutionContext,
  leaves: readonly KodaXToolDefinition[], run: ScriptModelRun,
  readReceipt?: (cellId: string, callId: number, offset?: number) => unknown): Agent {
  if (agent.tools?.some(tool => [SCRIPT_TOOL_NAME, 'script_read', 'script_wait'].includes(tool.name))) throw new Error('Script entry conflicts with a host tool.');
  const contracts = Object.freeze(leaves.map(tool => ({ ...tool, input_schema: structuredClone(tool.input_schema) })));
  let closed = false;
  const session = createScriptModelSession(run);
  function render(result: ScriptCellResult | ScriptObservation, selected: boolean) {
    const images = result.receipts.flatMap(receipt => typeof receipt.result.content === 'string' ? []
      : receipt.result.content.filter(item => item.type === 'image'));
    const readable = readReceipt !== undefined && result.cellId !== undefined;
    const text = serializeModelReceipt(result, selected && readable, readable);
    return { content: images.length ? [{ type: 'text' as const, text }, ...images] : text,
      isError: !['completed', 'running', 'cancelling'].includes(result.status) || result.hadToolErrors,
      metadata: { scriptCellStatus: result.status, scriptReadPaths: result.receipts.flatMap(receipt => {
        const call = receipt.result.metadata?.toolCall as KodaXToolUseBlock | undefined;
        const name = call?.name ?? receipt.name;
        const path = (call?.input ?? receipt.input).path;
        return name === 'read' && !receipt.result.isError && typeof path === 'string' ? [path] : [];
      }), ...(result.status === 'cancelled' ? { cancelled: true } : {}) } };
  }
  const entry: RunnableTool = {
    name: SCRIPT_TOOL_NAME,
    description: buildScriptModelDescription(contracts, agent.tools?.some(tool => tool.name === 'tool_call')),
    input_schema: { type: 'object', properties: { code: { type: 'string', description: 'Async function body. Await or return async helper calls before the cell body finishes; return a JSON value.' },
      yield_time_ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'Observation window only; a running cell continues until its independent deadline or cancellation.' },
      selected_output: { type: 'boolean', description: 'Return your selected value and mandatory notes; unclassified tool output remains complete.' } }, required: ['code'] },
    requiresSerialExecution: () => true,
    execute: async (input, caller) => {
      if (closed) return { content: '[Tool Error] Script closed after a host failure. Inspect durable receipts before starting a new Run; do not replay effects.', isError: true };
      if (session.active) return { content: '[Tool Error] A Script cell is still running; use script_wait before starting another.', isError: true };
      if (typeof input.code !== 'string') return { content: '[Tool Error] code must be a string.', isError: true };
      try { validateScriptCell(input.code, SCRIPT_MODEL_LIMITS); }
      catch (error) { return { content: `[Tool Error] ${String(error)}`, isError: true }; }
      if (input.yield_time_ms !== undefined && (typeof input.yield_time_ms !== 'number' || !Number.isSafeInteger(input.yield_time_ms) || input.yield_time_ms < 0 || input.yield_time_ms > 60_000)) return { content: '[Tool Error] yield_time_ms must be an integer from 0 to 60000.', isError: true };
      let result: ScriptCellResult | ScriptObservation;
      try { result = await session.start(input.code, caller, input.yield_time_ms as number | undefined); }
      catch (error) { closed = true; throw error; }
      return render(result, input.selected_output === true);
    },
  };
  const read: RunnableTool = {
    name: 'script_read', description: 'Read a complete original Script call receipt in this Session, including actual arguments and result. Follow nextOffset with offset; unknown means no settled evidence, never automatic replay.',
    input_schema: { type: 'object', properties: { cell_id: { type: 'string' }, call_id: { type: 'integer' }, offset: { type: 'integer' } }, required: ['cell_id', 'call_id'] },
    execute: async (input, caller) => {
      session.update(caller);
      if (typeof input.cell_id !== 'string' || typeof input.call_id !== 'number' || (input.offset !== undefined && typeof input.offset !== 'number')) return { content: '[Tool Error] Invalid Script receipt reference.', isError: true };
      try { return { content: JSON.stringify(await readReceipt!(input.cell_id, input.call_id, input.offset as number | undefined)) }; }
      catch (error) { return { content: `[Tool Error] ${String(error)}`, isError: true }; }
    },
  };
  const wait: RunnableTool = {
    name: 'script_wait', description: 'Observe the active or last completed cell. Reuse a cursor to reread output; use the returned cursor for new output. cancel requests cancellation; cleanupComplete alone confirms drain. Observation timeouts do not extend the cell deadline.',
    input_schema: { type: 'object', properties: { cell_id: { type: 'string' }, cursor: { type: 'integer' },
      yield_time_ms: { type: 'integer', minimum: 0, maximum: 60000 }, cancel: { type: 'boolean' }, selected_output: { type: 'boolean' } }, required: ['cell_id'] },
    requiresSerialExecution: () => true,
    execute: async (input, caller) => {
      if (typeof input.cell_id !== 'string' || (input.cursor !== undefined && typeof input.cursor !== 'number') || (input.yield_time_ms !== undefined && typeof input.yield_time_ms !== 'number')) return { content: '[Tool Error] Invalid Script observation arguments.', isError: true };
      try { return render(await session.wait(input.cell_id, caller, input.cursor as number | undefined, input.yield_time_ms as number | undefined, input.cancel === true), input.selected_output === true); }
      catch (error) { return { content: `[Tool Error] ${String(error)}`, isError: true }; }
    },
  };
  const native = (agent.tools ?? []).map(tool => !isRunnableTool(tool) ? tool : { ...tool,
    execute: async (input: Parameters<RunnableTool['execute']>[0], caller: Parameters<RunnableTool['execute']>[1]) => {
      await session.beforeNative(caller);
      return tool.execute(input, caller);
    } });
  const bound = markRegistryManagedAgent(Object.freeze({ ...agent, tools: [...native, entry, wait, ...(readReceipt ? [read] : [])] }), context);
  scriptSessions.set(bound, session);
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
