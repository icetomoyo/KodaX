import { describe, expect, it } from 'vitest';
import { createArtifactSdk, validateVisualEvidence } from './index.js';
import type { EvidenceLocator, VisualEvidenceBatch, VisualKind } from './types.js';

describe('artifact public contract', () => {
 it('cannot certify a paginated requirement with stale or missing raster evidence', () => {
   expect(validateVisualEvidence({ kind: 'paginated', sourceHash: 'a', evidence: [],
     diagnostics: [], scope: { pages: [1] } }, { sourceHash: 'b', kind: 'paginated', pages: [1] }).status).toBe('unverified');
 });
 it('uses the caller execution port without owning a KodaX session', async () => {
   const requests: unknown[] = [];
   const sdk = createArtifactSdk({ execute: async request => { requests.push(request); return { status: 'unverified', diagnostics: [{ code: 'unsupported', message: 'no capture adapter' }] }; } });
   const result = await sdk.capture({ kind: 'temporal', target: 'clip.mp4', times: [0, 1], locators: [{ kind: 'temporal', time: 1, frame: 30 }] });
   expect(result.status).toBe('unverified');
   expect(requests).toEqual([{ operation: 'capture', input: { kind: 'temporal', target: 'clip.mp4', times: [0, 1], locators: [{ kind: 'temporal', time: 1, frame: 30 }] } }]);
 });
 it.each<['static' | 'paginated' | 'interactive' | 'temporal', EvidenceLocator]>([
  ['static', { kind: 'static', region: [0, 0, 100, 100] }], ['paginated', { kind: 'paginated', page: 2, sheet: 'Summary', range: 'A1:B4' }],
  ['interactive', { kind: 'interactive', target: 'app', state: 'clicked', viewport: [1200, 800], camera: 'front', sequence: 1 }],
  ['temporal', { kind: 'temporal', time: 1, frame: 30 }],
 ])('validates current %s coverage without returning approval', (kind, locator) => {
  const batch: VisualEvidenceBatch = { kind, sourceHash: 'a'.repeat(64), diagnostics: [], scope: { pages: [2] }, evidence: [{ path: 'raster.png', sha256: 'b'.repeat(64), mediaType: 'image/png', locator }] };
  const requirement = { kind, sourceHash: batch.sourceHash, pages: [2], target: 'app', states: ['clicked'], times: [1] };
  expect(validateVisualEvidence(batch, requirement)).toEqual({ status: 'ready', missing: [] });
  expect(validateVisualEvidence({ ...batch, diagnostics: [{ code: 'unsupported', message: 'gap', blocking: true }] }, requirement).status).toBe('unverified');
  expect(validateVisualEvidence({ ...batch, sourceHash: 'c'.repeat(64) }, requirement).missing).toContain('stale-source');
 });
 it.each<['static' | 'paginated' | 'interactive' | 'temporal', EvidenceLocator]>([
  ['static', { kind: 'static', region: [0, 0, -1, 1] }], ['paginated', { kind: 'paginated', page: 0 }],
  ['interactive', { kind: 'interactive', target: 'app', state: 'clicked', viewport: [0, 800], sequence: -1 }], ['temporal', { kind: 'temporal', time: -1 }],
 ])('rejects invalid %s raster locations', (kind, locator) => {
  expect(validateVisualEvidence({ kind, sourceHash: 'a'.repeat(64), diagnostics: [], scope: {}, evidence: [{ path: 'x', sha256: 'b'.repeat(64), mediaType: 'image/png', locator }] }, { kind, sourceHash: 'a'.repeat(64) }).status).toBe('unverified');
 });
 it('does not treat one screenshot as unspecified interaction or animation coverage', () => {
  for (const kind of ['interactive', 'temporal'] as VisualKind[]) expect(validateVisualEvidence({ kind, sourceHash: 'a'.repeat(64), evidence: [], diagnostics: [], scope: {} }, { kind, sourceHash: 'a'.repeat(64) }).status).toBe('unverified');
 });
 it('dispatches every content operation through the caller port', async () => {
  const operations: string[] = [];
  const sdk = createArtifactSdk({ execute: async request => { operations.push(request.operation); return { status: 'ready', diagnostics: [] }; } });
  await sdk.capabilities(); await sdk.create({ output: 'x.pptx', slides: [] }); await sdk.open({ path: 'x.pptx' });
  await sdk.edit({ path: 'x.pptx', expectedSourceHash: 'a', output: 'y.pptx', changes: [] });
  await sdk.export({ path: 'x.pptx', output: 'z.pptx' }); await sdk.render({ path: 'x.pptx' });
  expect(operations).toEqual(['capabilities', 'create', 'open', 'edit', 'export', 'render']);
 });
 it.each<EvidenceLocator>([
  { kind: 'static', region: [1, 2, 30, 40] },
  { kind: 'paginated', page: 1, sheet: 'Summary', range: 'A1:D8' },
  { kind: 'interactive', target: 'app', state: 'clicked', viewport: [800, 600], camera: 'front', sequence: 2 },
  { kind: 'temporal', time: 2, frame: 60 },
 ])('matches complete locator requirements %j', locator => {
  const batch: VisualEvidenceBatch = { kind: locator.kind, sourceHash: 'a'.repeat(64), diagnostics: [], scope: {}, evidence: [{ path: 'x.png', sha256: 'b'.repeat(64), mediaType: 'image/png', locator }] };
  expect(validateVisualEvidence(batch, { kind: locator.kind, sourceHash: batch.sourceHash, locators: [locator] }).status).toBe('ready');
  const changed = locator.kind === 'static' ? { ...locator, region: [0, 0, 30, 40] as const } : locator.kind === 'paginated' ? { ...locator, range: 'A1:A2' } : locator.kind === 'interactive' ? { ...locator, sequence: 3 } : { ...locator, frame: 61 };
  expect(validateVisualEvidence(batch, { kind: locator.kind, sourceHash: batch.sourceHash, locators: [changed] }).missing).toContain('locator:0');
 });
 it('cannot verify continuous playback with a labelled sample batch', () => {
  const batch: VisualEvidenceBatch = { kind: 'temporal', sourceHash: 'a'.repeat(64), diagnostics: [], scope: { temporal: { start: 0, end: 10, coverage: 'sampled' } }, evidence: [{ path: 'x', sha256: 'b'.repeat(64), mediaType: 'image/png', locator: { kind: 'temporal', time: 1 } }] };
  expect(validateVisualEvidence(batch, { kind: 'temporal', sourceHash: batch.sourceHash, times: [1], temporal: { start: 0, end: 10, coverage: 'sampled' } }).status).toBe('ready');
  expect(validateVisualEvidence(batch, { kind: 'temporal', sourceHash: batch.sourceHash, times: [1], temporal: { start: 0, end: 10, coverage: 'continuous' } }).missing).toContain('temporal-range');
 });
});
