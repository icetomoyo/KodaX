import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { prepareValidatedImageBlock, validateImageBytesInRun } from '@kodax-ai/llm';
import type { RunnableTool, RunnerToolResult } from '../primitives/runner-tool-loop.js';
import { MAX_DIMENSION, TARGET_RAW_SIZE_BYTES } from './image-normalize.js';
import { visualObservationImage, type VisualObservation, type VisualObservationOwner } from './visual-observations.js';
import { visualObservationLabel } from './visual-observations.js';
import { countTokens } from '../tokenizer.js';

export const VISUAL_TOOL_DEFINITIONS: readonly KodaXToolDefinition[] = [
  { name: 'visual_history', description: 'List a bounded recent page of accepted historical images. Reuse the returned cursor with the same source filter; new observations appear in a new query.',
    input_schema: { type: 'object', properties: { sourceKey: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
  { name: 'visual_inspect', description: 'Inspect one accepted image or a region in original raster pixels (integer x/y/width/height, half-open). Optionally enlarge with displayLongEdge, preserving aspect ratio using nearest neighbor. Derived views support static 8-bit RGB/RGBA PNG without orientation/color transforms. State the question and label. Historical evidence leaves source history unchanged and does not verify the current source.',
    input_schema: { type: 'object', properties: { question: { type: 'string', minLength: 1 }, views: { type: 'array', minItems: 1, maxItems: 1,
      items: { type: 'object', properties: { label: { type: 'string', minLength: 1 }, observationId: { type: 'string' },
        region: { type: 'object', properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false },
        displayLongEdge: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION } }, required: ['label', 'observationId'], additionalProperties: false } } }, required: ['question', 'views'] } },
];
export const VISUAL_TOOL_NAMES: ReadonlySet<string> = new Set(VISUAL_TOOL_DEFINITIONS.map(tool => tool.name));

export interface VisualOutputReservation { cancel(): void }
export interface VisualToolBinding {
  readonly owner: VisualObservationOwner;
  /** Successful output stays reserved until the capacity owner settles the complete batch. */
  readonly reserveOutput: (tokens: number) => VisualOutputReservation;
  readonly signal?: AbortSignal;
}

interface HistoryCursor { ownerId: string; scope: string; sourceKey?: string; upper: string; before: string }

export async function executeVisualTool(name: string, input: Record<string, unknown>, binding: VisualToolBinding): Promise<RunnerToolResult> {
  try {
    binding.signal?.throwIfAborted();
    if (name === 'visual_history') return { content: JSON.stringify(await history(input, binding.owner)) };
    if (name !== 'visual_inspect') throw new Error('Unknown visual tool.');
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1000
      || !Array.isArray(input.views) || input.views.length !== 1) throw new Error('Provide a question and exactly one view.');
    const view = input.views[0] as Record<string, unknown> | null;
    if (!view || typeof view.label !== 'string' || !view.label.trim() || view.label.length > 200
      || typeof view.observationId !== 'string' || Object.keys(view).some(key => !['label', 'observationId', 'region', 'displayLongEdge'].includes(key))) {
      throw new Error('Each view requires label and observationId with optional region/displayLongEdge.');
    }
    const observations = await binding.owner.list();
    const observation = observations.find(item => item.observationId === view.observationId);
    if (!observation) throw new Error('Visual observation unavailable or access denied.');
    const reservation = binding.reserveOutput(1500 + 256 + countTokens(`${input.question}\n${view.label}\n${visualObservationLabel(observation)}`));
    try {
      const bytes = await binding.owner.read(observation);
      binding.signal?.throwIfAborted();
      if (view.region !== undefined || view.displayLongEdge !== undefined) {
        const { deriveVisualRaster } = await import('./visual-raster.js');
        const derived = await deriveVisualRaster(bytes, view, binding.owner, binding.signal);
        const image = { type: 'image' as const, path: await binding.owner.writeDerived(derived.bytes), mediaType: 'image/png' };
        binding.signal?.throwIfAborted();
        prepareValidatedImageBlock(image, derived.bytes, { status: 'valid', mediaType: 'image/png' });
        return { content: [{ type: 'text', text: `View ${view.label}: ${input.question}\n${visualObservationLabel(observation)}\n`
          + JSON.stringify({ region: derived.region, outputWidth: derived.width, outputHeight: derived.height,
            scaleX: derived.width / derived.region.width, scaleY: derived.height / derived.region.height,
            resampling: derived.resampling, profile: derived.profile }) }, image] };
      }
      if (bytes.length > TARGET_RAW_SIZE_BYTES || Math.max(observation.width ?? 0, observation.height ?? 0) > MAX_DIMENSION) {
        throw new Error('Visual output exceeds the display limit; request a smaller region or display size.');
      }
      const validation = await validateImageBytesInRun(bytes);
      if (validation.status === 'invalid') throw new Error('Visual observation cannot be decoded.');
      binding.signal?.throwIfAborted();
      return { content: [{ type: 'text', text: `View ${view.label}: ${input.question}` },
        ...visualObservationImage(binding.owner, observation, bytes, validation)] };
    } catch (error) { reservation.cancel(); throw error; }
  } catch (error) {
    return { content: `[Tool Error] ${name}: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

async function history(input: Record<string, unknown>, owner: VisualObservationOwner) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50
    || (input.sourceKey !== undefined && typeof input.sourceKey !== 'string')) throw new Error('Invalid visual history filter or limit (1–50).');
  let cursor: HistoryCursor | undefined;
  const scope = await owner.historyScope();
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 2048) throw new Error('Invalid visual history cursor.');
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as HistoryCursor; }
    catch { throw new Error('Invalid visual history cursor.'); }
    if (!cursor || cursor.ownerId !== owner.ownerId || cursor.scope !== scope || cursor.sourceKey !== input.sourceKey) throw new Error('Visual history cursor scope mismatch.');
  }
  const all = (await owner.list()).filter(item => input.sourceKey === undefined || item.sourceKey === input.sourceKey);
  const upper = cursor ? all.findIndex(item => item.observationId === cursor.upper) : all.length - 1;
  const before = cursor ? all.findIndex(item => item.observationId === cursor.before) : all.length;
  if (cursor && (upper < 0 || before < 0 || before > upper)) throw new Error('Visual history cursor lineage changed.');
  const page = all.slice(0, Math.min(upper + 1, before)).slice(-Number(limit)).reverse();
  const oldest = page.at(-1);
  const hasMore = oldest !== undefined && all.findIndex(item => item.observationId === oldest.observationId) > 0;
  return { observations: page.map((item: VisualObservation) => ({ ...item, status: 'retained' })),
    ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ ownerId: owner.ownerId, scope, sourceKey: input.sourceKey,
      upper: all[upper]!.observationId, before: oldest!.observationId })).toString('base64url') } : {}) };
}

export function createVisualTools(binding: Omit<VisualToolBinding, 'signal'>): readonly RunnableTool[] {
  return VISUAL_TOOL_DEFINITIONS.map(definition => ({ ...definition,
    execute: (input, ctx) => executeVisualTool(definition.name, input, { ...binding, signal: ctx.abortSignal }) }));
}
