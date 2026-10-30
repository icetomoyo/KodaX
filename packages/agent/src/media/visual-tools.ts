import type { KodaXToolDefinition, KodaXToolResultContentItem } from '@kodax-ai/llm';
import { prepareValidatedImageBlock, validateImageBytesInRun } from '@kodax-ai/llm';
import type { RunnableTool, RunnerToolResult } from '../primitives/runner-tool-loop.js';
import { MAX_DIMENSION, TARGET_RAW_SIZE_BYTES } from './image-normalize.js';
import { visualObservationImage, type VisualObservation, type VisualObservationOwner } from './visual-observations.js';
import { visualObservationLabel } from './visual-observations.js';
import { countTokens } from '../tokenizer.js';

const regionSchema = { type: 'object', properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false };
const viewProperties = { label: { type: 'string', minLength: 1 }, observationId: { type: 'string',
  description: 'Use the exact observationId returned with an accepted image or by visual_history; filenames, paths and view labels are not IDs.' }, region: regionSchema };

export const VISUAL_TOOL_DEFINITIONS: readonly KodaXToolDefinition[] = [
  { name: 'visual_history', description: 'List a bounded recent page of accepted historical images. Reuse the returned cursor with the same source filter; new observations appear in a new query.',
    input_schema: { type: 'object', properties: { sourceKey: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
  { name: 'visual_inspect', description: 'Before answering a visual question, identify the evidence needed to settle it. Inspect unclear details or historical views; use exact pixel measurements when a visual impression is insufficient. Check the result against your assumption and revise contradictions before concluding. Skip calls when existing evidence suffices. Inspect 1–4 accepted images or regions in request order, using original raster pixels (integer x/y/width/height, half-open). Optionally enlarge with displayLongEdge, preserving aspect ratio using nearest neighbor. Derived views support static 8-bit RGB/RGBA PNG without orientation/color transforms. State the question and label each view. Per-view failures mark the result partial. Historical evidence leaves source history unchanged and does not verify the current source.',
    input_schema: { type: 'object', properties: { question: { type: 'string', minLength: 1 }, views: { type: 'array', minItems: 1, maxItems: 4,
      items: { type: 'object', properties: { ...viewProperties,
        displayLongEdge: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION } }, required: ['label', 'observationId'], additionalProperties: false } } }, required: ['question', 'views'] } },
  { name: 'visual_read_pixels', description: 'Sample original raster pixels from 1–4 ordered historical regions, at equal-grid cell centers. Specify question, label, region, rows and columns; grid counts cannot exceed region dimensions or 4096 samples across the entire call. Returns original sampleX/sampleY axes, row-major indices into one exact 8-bit RGBA palette, preserving alpha without quantization. Uses the same strict PNG profile as visual_inspect. Per-view failures are explicit; samples do not prove unsampled details or verify the current source. Returns text only, no image or second model.',
    input_schema: { type: 'object', properties: { question: { type: 'string', minLength: 1 }, views: { type: 'array', minItems: 1, maxItems: 4,
      items: { type: 'object', properties: { ...viewProperties, rows: { type: 'integer', minimum: 1, maximum: 4096 }, columns: { type: 'integer', minimum: 1, maximum: 4096 } },
        required: ['label', 'observationId', 'region', 'rows', 'columns'], additionalProperties: false } } }, required: ['question', 'views'] } },
];
export const VISUAL_TOOL_NAMES: ReadonlySet<string> = new Set(VISUAL_TOOL_DEFINITIONS.map(tool => tool.name));

export interface VisualOutputReservation { cancel(): void }
export interface VisualToolBinding {
  readonly owner: VisualObservationOwner;
  /** Successful output stays reserved until the capacity owner settles the complete batch. */
  readonly reserveOutput: (tokens: number, textBytes?: number) => VisualOutputReservation;
  readonly signal?: AbortSignal;
}

interface HistoryCursor { ownerId: string; scope: string; sourceKey?: string; upper: string; before: string }
interface VisualSelection { index: number; view: { label: string; region?: unknown; displayLongEdge?: unknown; rows?: unknown; columns?: unknown }; observation: VisualObservation }
interface VisualInspection {
  question: string; binding: VisualToolBinding;
  results: (readonly KodaXToolResultContentItem[])[]; failures: Map<number, string>;
}

export async function executeVisualTool(name: string, input: Record<string, unknown>, binding: VisualToolBinding): Promise<RunnerToolResult> {
  try {
    binding.signal?.throwIfAborted();
    if (name === 'visual_history') return { content: JSON.stringify(await history(input, binding.owner)) };
    if (name !== 'visual_inspect' && name !== 'visual_read_pixels') throw new Error('Unknown visual tool.');
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1000
      || !Array.isArray(input.views) || input.views.length < 1 || input.views.length > 4) throw new Error('Provide a question and 1–4 views.');
    const observations = await binding.owner.list();
    const selections = input.views.map((value: unknown, index: number): VisualSelection => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each view must be an object.');
      const view = value as Record<string, unknown>;
      if (typeof view.label !== 'string' || !view.label.trim() || view.label.length > 200 || typeof view.observationId !== 'string'
        || Object.keys(view).some(key => !(name === 'visual_inspect' ? ['label', 'observationId', 'region', 'displayLongEdge'] : ['label', 'observationId', 'region', 'rows', 'columns']).includes(key))) throw new Error('Each view requires label and observationId with valid inspection or pixel parameters.');
      const observation = observations.find(item => item.observationId === view.observationId);
      if (!observation) throw new Error('Visual observation unavailable or access denied.');
      return { index, view: view as VisualSelection['view'], observation };
    });
    if (name === 'visual_read_pixels') return await sampleViews(input.question, selections, binding);
    const { validateVisualDisplay } = await import('./visual-raster.js');
    for (const { view, observation } of selections) if (view.region !== undefined || view.displayLongEdge !== undefined) {
      validateVisualDisplay(view, { width: observation.width ?? Number.MAX_SAFE_INTEGER, height: observation.height ?? Number.MAX_SAFE_INTEGER });
    }
    return await inspectViews(input.question, selections, binding);
  } catch (error) {
    return { content: `[Tool Error] ${name}: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

async function sampleViews(question: string, selections: readonly VisualSelection[], binding: VisualToolBinding): Promise<RunnerToolResult> {
  const { validateVisualPixels, validateVisualSampleCount, sampleVisualRasters, VISUAL_RASTER_PROFILE } = await import('./visual-raster.js');
  const plans = selections.map(({ view, observation }) => validateVisualPixels(view,
    { width: observation.width ?? Number.MAX_SAFE_INTEGER, height: observation.height ?? Number.MAX_SAFE_INTEGER }));
  const total = validateVisualSampleCount(plans);
  const metadata = selections.map((item, index) => ({ label: item.view.label, observationId: item.observation.observationId,
    source: visualObservationLabel(item.observation), ...plans[index]! }));
  const bound = JSON.stringify({ status: 'partial', profile: VISUAL_RASTER_PROFILE, question,
    palette: Array.from({ length: total }, () => [255, 255, 255, 255]), views: metadata.map(item => ({ ...item,
      sampleX: Array(item.columns).fill(item.region.x + item.region.width - 1), sampleY: Array(item.rows).fill(item.region.y + item.region.height - 1),
      indices: Array.from({ length: item.rows }, () => Array(item.columns).fill(total - 1)), error: '\0'.repeat(500) })) });
  const capacity = countTokens(bound) + 64;
  const reservation = binding.reserveOutput(capacity, Buffer.byteLength(bound, 'utf8') + 64);
  const sampled = new Map<number, import('./visual-raster.js').SampledRaster>();
  const errors = new Map<number, string>();
  const groups = new Map<string, VisualSelection[]>();
  for (const item of selections) groups.set(item.observation.sha256, [...groups.get(item.observation.sha256) ?? [], item]);
  for (const group of groups.values()) {
    try {
      binding.signal?.throwIfAborted();
      const bytes = await binding.owner.read(group[0]!.observation);
      await sampleVisualRasters(bytes, group.map(item => item.view), binding.owner,
        async (index, result) => { sampled.set(group[index]!.index, result); }, binding.signal);
    } catch (error) {
      for (const item of group) if (!sampled.has(item.index)) errors.set(item.index, (error instanceof Error ? error.message : String(error)).slice(0, 500));
    }
  }
  const palette: number[][] = []; const colorIndices = new Map<string, number>();
  const views = metadata.map((item, index) => {
    const raster = sampled.get(index);
    if (!raster) return { ...item, status: 'error', error: errors.get(index) };
    const indices = raster.rgba.map(rgba => {
      const color = rgba.join(','); let paletteIndex = colorIndices.get(color);
      if (paletteIndex === undefined) { paletteIndex = palette.length; colorIndices.set(color, paletteIndex); palette.push(rgba); }
      return paletteIndex;
    });
    return { ...item, status: 'complete', sampleX: raster.sampleX, sampleY: raster.sampleY,
      indices: Array.from({ length: item.rows }, (_, row) => indices.slice(row * item.columns, (row + 1) * item.columns)) };
  });
  const content = JSON.stringify({ status: errors.size === selections.length ? 'error' : errors.size ? 'partial' : 'complete', profile: VISUAL_RASTER_PROFILE, question, palette, views });
  if (errors.size === selections.length) { reservation.cancel(); binding.reserveOutput(countTokens(content) + 16); }
  if (countTokens(content) > capacity) throw new Error('Pixel output exceeds its preflight estimate.');
  return { content, ...(errors.size ? { isError: true } : {}) };
}

async function inspectViews(question: string, selections: readonly VisualSelection[], binding: VisualToolBinding): Promise<RunnerToolResult> {
  const reservation = binding.reserveOutput(selections.reduce((sum, { view, observation }) => sum + 1500 + 512
    + countTokens(`${question}\n${view.label}\n${visualObservationLabel(observation)}`), 0));
  const groups = new Map<string, VisualSelection[]>();
  for (const selection of selections) groups.set(selection.observation.sha256, [...groups.get(selection.observation.sha256) ?? [], selection]);
  const state: VisualInspection = { question, binding, results: new Array(selections.length), failures: new Map() };
  for (const group of groups.values()) {
    try { await inspectSource(state, group); }
    catch (error) { failViews(state, group.filter(item => !state.results[item.index]), error); }
  }
  const { results, failures } = state;
  if (failures.size === selections.length) {
    reservation.cancel();
    if (selections.length === 1) {
      const content = `[Tool Error] visual_inspect: ${failures.get(0)}`;
      binding.reserveOutput(countTokens(content) + 16);
      return { content, isError: true };
    }
    const content = [...results.flat(), { type: 'text' as const,
      text: JSON.stringify({ status: 'error', failedViews: selections.map(item => item.index) }) }];
    binding.reserveOutput(countTokens(JSON.stringify(content)) + 64);
    return { content, isError: true };
  }
  return { content: [...results.flat(), ...(failures.size ? [{ type: 'text' as const, text: JSON.stringify({ status: 'partial', failedViews: [...failures.keys()].sort((a, b) => a - b) }) }] : [])],
    ...(failures.size ? { isError: true } : {}) };
}

function viewLabel(state: VisualInspection, item: VisualSelection): string {
  return `View ${item.view.label}: ${state.question}\n${visualObservationLabel(item.observation)}`;
}

function failViews(state: VisualInspection, items: readonly VisualSelection[], error: unknown): void {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  for (const item of items) {
    state.failures.set(item.index, reason);
    state.results[item.index] = [{ type: 'text', text: `${viewLabel(state, item)}\n`
      + JSON.stringify({ status: 'error', error: reason, viewIndex: item.index }) }];
  }
}

async function inspectSource(state: VisualInspection, group: readonly VisualSelection[]): Promise<void> {
  const { binding } = state;
  binding.signal?.throwIfAborted();
  const bytes = await binding.owner.read(group[0]!.observation);
  const derived = group.filter(({ view }) => view.region !== undefined || view.displayLongEdge !== undefined);
  if (derived.length) {
    try { await inspectDerived(state, derived, bytes); }
    catch (error) { failViews(state, derived.filter(item => !state.results[item.index]), error); }
  }
  for (const item of group.filter(({ view }) => view.region === undefined && view.displayLongEdge === undefined)) {
    try {
      if (bytes.length > TARGET_RAW_SIZE_BYTES || Math.max(item.observation.width ?? 0, item.observation.height ?? 0) > MAX_DIMENSION) throw new Error('Visual output exceeds the display limit; request a smaller region or display size.');
      const validation = await validateImageBytesInRun(bytes);
      if (validation.status === 'invalid') throw new Error('Visual observation cannot be decoded.');
      binding.signal?.throwIfAborted();
      state.results[item.index] = [{ type: 'text', text: viewLabel(state, item) },
        ...visualObservationImage(binding.owner, item.observation, bytes, validation).filter(block => block.type === 'image')];
    } catch (error) { failViews(state, [item], error); }
  }
}

async function inspectDerived(state: VisualInspection, items: readonly VisualSelection[], bytes: Buffer): Promise<void> {
  const { binding } = state;
  const { deriveVisualRasters } = await import('./visual-raster.js');
  await deriveVisualRasters(bytes, items.map(item => item.view), binding.owner, async (index, raster) => {
    const item = items[index]!;
    try {
      if (raster instanceof Error) throw raster;
      const image = { type: 'image' as const, path: await binding.owner.writeDerived(raster.bytes), mediaType: 'image/png' };
      binding.signal?.throwIfAborted();
      prepareValidatedImageBlock(image, raster.bytes, { status: 'valid', mediaType: 'image/png' });
      state.results[item.index] = [{ type: 'text', text: `${viewLabel(state, item)}\n`
        + JSON.stringify({ region: raster.region, outputWidth: raster.width, outputHeight: raster.height,
          scaleX: raster.width / raster.region.width, scaleY: raster.height / raster.region.height,
          resampling: raster.resampling, profile: raster.profile }) }, image];
    } catch (error) { failViews(state, [item], error); }
  }, binding.signal);
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
