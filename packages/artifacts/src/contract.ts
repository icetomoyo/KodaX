import type { ArtifactOperation, ArtifactRequest, ArtifactResults, ArtifactResult, EvidenceLocator, VisualSource, RasterEvidence } from './types.js';
import { sameJson } from './identity.js';

const operations = ['create', 'open', 'edit', 'export', 'render', 'capture', 'capabilities', 'prepare', 'readEvidence'] as const;
const kinds = ['static', 'paginated', 'interactive', 'temporal'];
const formats = ['pptx', 'pdf', 'docx', 'png', 'jpeg', 'webp', 'svg', 'html'];
export const artifactToolName = (operation: ArtifactOperation): string => 'artifact_' + (operation === 'readEvidence' ? 'read_evidence' : operation);
export function record(value: unknown): Record<string, unknown> {
 if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected artifact object.');
 return value as Record<string, unknown>;
}
function check(condition: unknown, message = 'Invalid artifact contract.'): asserts condition { if (!condition) throw new Error(message); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !value.includes('\0'); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function integer(value: unknown): value is number { return positive(value) && Number.isSafeInteger(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]) { check(Object.keys(value).every(key => allowed.includes(key)), 'Unknown artifact field.'); }
function array(value: unknown): unknown[] { check(Array.isArray(value)); return value; }
function tuple(value: unknown, count: number) { const result = array(value); check(result.length === count && result.every(positive)); return result; }
function engine(value: unknown) { const e = record(value); check(text(e.name) && text(e.version)); }
function diagnostics(value: unknown) { for (const item of array(value)) { const d = record(item); check(text(d.code) && text(d.message)); check(d.blocking === undefined || typeof d.blocking === 'boolean'); if (d.page !== undefined) check(integer(d.page)); } }
function artifact(value: unknown) { const f = record(value); keys(f, ['path', 'sourceHash', 'format', 'pages']); check(text(f.path) && hash(f.sourceHash) && formats.includes(String(f.format)));
 if (f.format === 'pptx' || f.format === 'pdf') check(integer(f.pages)); else check(f.pages === undefined, 'This format has no intrinsic page count.'); }
export function validateSource(value: unknown): asserts value is VisualSource {
 const s = record(value);
 if (s.kind === 'file') { keys(s, ['kind', 'file', 'dependencies']); artifact(s.file);
  if (s.dependencies !== undefined) for (const item of array(s.dependencies)) { const d = record(item); keys(d, ['path', 'sha256']); check(text(d.path) && hash(d.sha256)); }
 } else { keys(s, ['kind', 'target', 'observedAt', 'revision']); check(s.kind === 'surface' && text(s.target) && text(s.observedAt) && Number.isFinite(Date.parse(s.observedAt))); check(s.revision === undefined || text(s.revision)); }
}
export function validateLocator(value: unknown): asserts value is EvidenceLocator {
 const l = record(value); check(kinds.includes(String(l.kind)));
 switch (l.kind) {
  case 'static': keys(l, ['kind', 'region']); if (l.region !== undefined) { const region = array(l.region); check(region.length === 4 && region.every(n => typeof n === 'number' && Number.isFinite(n)) && positive(region[2]) && positive(region[3])); } break;
  case 'paginated': keys(l, ['kind', 'page', 'sheet', 'range']); check(integer(l.page)); check(l.sheet === undefined || text(l.sheet)); check(l.range === undefined || text(l.range)); break;
  case 'interactive': keys(l, ['kind', 'target', 'state', 'viewport', 'camera', 'sequence']); check(text(l.target) && text(l.state)); tuple(l.viewport, 2); check(typeof l.sequence === 'number' && Number.isSafeInteger(l.sequence) && l.sequence >= 0); check(l.camera === undefined || text(l.camera)); break;
  case 'temporal': keys(l, ['kind', 'time', 'frame']); check(typeof l.time === 'number' && Number.isFinite(l.time) && l.time >= 0); check(l.frame === undefined || (typeof l.frame === 'number' && Number.isSafeInteger(l.frame) && l.frame >= 0)); break;
 }
}
export function validateRaster(value: unknown): asserts value is RasterEvidence { const r = record(value);
 keys(r, ['path', 'sha256', 'mediaType', 'width', 'height', 'locator']);
 check(text(r.path) && hash(r.sha256) && r.mediaType === 'image/png' && integer(r.width) && integer(r.height));
 check(r.width * r.height <= 40_000_000); validateLocator(r.locator);
}
function evidence(value: unknown) {
 const b = record(value); validateSource(b.source); engine(b.engine); diagnostics(b.diagnostics); check(kinds.includes(String(b.kind)));
 const rasters = array(b.evidence); check(rasters.length <= 1000);
 for (const r of rasters) { validateRaster(r); check(r.locator.kind === b.kind); }
 const scope = record(b.scope); if (scope.pages !== undefined) check(array(scope.pages).every(integer));
 if (scope.locators !== undefined) for (const l of array(scope.locators)) validateLocator(l);
 if (scope.temporal !== undefined) { const t = record(scope.temporal); check(typeof t.start === 'number' && t.start >= 0 && typeof t.end === 'number' && t.end >= t.start && ['sampled', 'continuous'].includes(String(t.coverage))); }
 if (b.kind === 'paginated') { const layout = record(b.layout); check(integer(layout.totalPages));
  for (const item of array(layout.pages)) { const p = record(item); check(integer(p.page) && p.page <= layout.totalPages && positive(p.width) && positive(p.height) && typeof p.rotation === 'number' && Number.isFinite(p.rotation) && positive(p.scale)); }
  for (const r of rasters) { const raster = r as RasterEvidence; check(array(layout.pages).some(p => record(p).page === (raster.locator.kind === 'paginated' ? raster.locator.page : 0) && Math.ceil(Number(record(p).width)) === raster.width && Math.ceil(Number(record(p).height)) === raster.height)); }
 } else check(b.layout === undefined);
 check(b.background === undefined || text(b.background));
}
function box(value: unknown, allowZero = false) { const b = record(value); check(typeof b.x === 'number' && Number.isFinite(b.x) && typeof b.y === 'number' && Number.isFinite(b.y)
 && (positive(b.width) || (allowZero && b.width === 0)) && (positive(b.height) || (allowZero && b.height === 0))); }
export function decodeArtifactRequest(value: unknown): ArtifactRequest {
 const r = record(value); keys(r, ['operation', 'input']); check(operations.includes(r.operation as ArtifactOperation), 'Unknown artifact operation.'); const i = record(r.input);
 switch (r.operation) {
  case 'prepare': case 'capabilities': keys(i, []); break;
  case 'readEvidence': keys(i, ['source', 'raster']); validateSource(i.source); validateRaster(i.raster); break;
  case 'capture': keys(i, ['kind', 'target', 'expectedSource', 'background', 'locators']); check(text(i.target) && kinds.includes(String(i.kind))); check(array(i.locators).length > 0 && array(i.locators).length <= 1000);
   for (const l of array(i.locators)) { validateLocator(l); check(l.kind === i.kind, 'Capture locators must match the visual kind.'); }
   if (i.expectedSource !== undefined) validateSource(i.expectedSource); if (i.background !== undefined) check(text(i.background)); break;
  case 'create': keys(i, ['slides', 'output']); check(text(i.output)); check(array(i.slides).length > 0 && array(i.slides).length <= 1000);
   for (const slide of array(i.slides)) { const s = record(slide); keys(s, ['elements']); for (const item of array(s.elements)) { const el = record(item); box(el); check(['text', 'rectangle', 'image', 'table', 'chart'].includes(String(el.type)));
    keys(el, ['type', 'x', 'y', 'width', 'height', ...(el.type === 'text' ? ['text', 'fontSize', 'fontFace', 'color'] : el.type === 'rectangle' ? ['color'] : el.type === 'image' ? ['path'] : el.type === 'table' ? ['rows'] : ['categories', 'values', 'name'])]);
    if (el.type === 'text') { check(typeof el.text === 'string'); check(el.fontSize === undefined || positive(el.fontSize)); check(el.fontFace === undefined || text(el.fontFace)); check(el.color === undefined || text(el.color)); }
    if (el.type === 'rectangle') check(text(el.color)); if (el.type === 'image') check(text(el.path));
    if (el.type === 'table') for (const row of array(el.rows)) check(array(row).every(v => typeof v === 'string'));
    if (el.type === 'chart') { check(array(el.categories).every(v => typeof v === 'string') && array(el.values).every(v => typeof v === 'number' && Number.isFinite(v))); check(el.name === undefined || text(el.name)); }
   } } break;
  default: keys(i, r.operation === 'render' ? ['path', 'expectedSourceHash', 'pages', 'backend'] : r.operation === 'edit' ? ['path', 'expectedSourceHash', 'output', 'changes'] : r.operation === 'export' ? ['path', 'expectedSourceHash', 'output'] : ['path', 'expectedSourceHash']);
   check(text(i.path)); if (i.expectedSourceHash !== undefined) check(hash(i.expectedSourceHash), 'Invalid source hash.');
   if (r.operation === 'export' || r.operation === 'edit') check(text(i.output));
   if (r.operation === 'render') { if (i.pages !== undefined) { const pages = array(i.pages); check(pages.length > 0 && pages.every(integer) && new Set(pages).size === pages.length, 'Invalid render pages.'); } check(i.backend === undefined || ['lightweight', 'libreoffice'].includes(String(i.backend))); }
   if (r.operation === 'edit') { check(hash(i.expectedSourceHash)); for (const change of array(i.changes)) { const c = record(change); keys(c, ['page', 'objectId', 'text', 'box']); check(integer(c.page) && text(c.objectId)); check(c.text === undefined || typeof c.text === 'string'); if (c.box !== undefined) { keys(record(c.box), ['x', 'y', 'width', 'height']); box(c.box); } } }
 }
 // All operation branches and nested public fields have been checked above.
 return value as ArtifactRequest;
}
export function decodeArtifactResult<O extends ArtifactOperation>(operation: O, value: unknown): ArtifactResults[O] {
 const r = record(value); check(r.status === 'ready' || r.status === 'unverified'); diagnostics(r.diagnostics);
 if (r.artifact !== undefined) artifact(r.artifact); if (r.evidence !== undefined) evidence(r.evidence);
 if (r.image !== undefined) { const image = record(r.image); check(image.mediaType === 'image/png' && hash(image.sha256) && integer(image.width) && integer(image.height));
  check(typeof image.dataBase64 === 'string' && image.dataBase64.length <= 14 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64) && image.dataBase64.length % 4 === 0); }
 if (r.capabilities !== undefined) for (const item of array(r.capabilities)) { const c = record(item); check(operations.includes(c.operation as ArtifactOperation) && [...formats, 'surface', 'runtime', 'raster'].includes(String(c.input)) && ['available', 'not-prepared', 'unsupported'].includes(String(c.availability)));
  check(c.backend === undefined || c.operation === 'render' && (c.backend === 'lightweight' || c.backend === 'libreoffice' && c.input === 'pptx')); diagnostics(c.diagnostics); if (c.engine !== undefined) engine(c.engine); }
 if (r.engine !== undefined) engine(r.engine);
 if (r.objects !== undefined) for (const item of array(r.objects)) { const o = record(item); check(integer(o.page) && text(o.objectId) && text(o.type)); check(o.text === undefined || typeof o.text === 'string'); if (o.box !== undefined) box(o.box, true); }
 if (r.status === 'ready') { check(!array(r.diagnostics).some(d => record(d).blocking === true), 'Ready result contains a blocking diagnostic.');
  const required = operation === 'capabilities' ? ['capabilities'] : operation === 'prepare' ? ['component', 'engine'] : operation === 'readEvidence' ? ['image'] : operation === 'capture' ? ['evidence'] : operation === 'render' ? ['artifact', 'evidence'] : ['artifact'];
  check(required.every(key => r[key] !== undefined), 'Ready result is missing its operation payload.');
  if (operation === 'prepare') check(r.component === 'browser');
  if (operation === 'create' || operation === 'edit' || operation === 'export') check(record(r.artifact).format === 'pptx');
  if (operation === 'render' || operation === 'capture') { check(array(record(r.evidence).evidence).length > 0); check(!array(record(r.evidence).diagnostics).some(d => record(d).blocking === true)); }
 }
 return value as ArtifactResults[O];
}

/** Managed worker metadata. PNG bytes travel through the existing attachment channel. */
type ArtifactWireResult = Pick<ArtifactResult, 'status' | 'diagnostics' | 'artifact' | 'evidence'> & { readonly imageRef?: RasterEvidence };
export function decodeArtifactWireResult(request: ArtifactRequest, value: unknown): ArtifactWireResult {
 if (request.operation !== 'readEvidence') return decodeArtifactResult(request.operation, value);
 const r = record(value); diagnostics(r.diagnostics); check(r.status === 'ready' || r.status === 'unverified'); check(r.image === undefined, 'Image bytes must not use worker stdout.');
 if (r.imageRef !== undefined) { validateRaster(r.imageRef); check(sameJson(r.imageRef, request.input.raster), 'Evidence reference differs from the admitted request.'); }
 if (r.status === 'ready') check(r.imageRef !== undefined && !array(r.diagnostics).some(d => record(d).blocking === true), 'Ready evidence metadata is missing.');
 return value as ArtifactWireResult;
}
