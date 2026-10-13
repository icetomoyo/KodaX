import { describe, expect, it } from 'vitest';
import { createArtifactSdk, validateVisualEvidence } from './index.js';
import type { EvidenceLocator, VisualEvidenceBatch, VisualSource } from './types.js';
const source: VisualSource = { kind: 'file', file: { path: '/work/a.png', sourceHash: 'a'.repeat(64), format: 'png' } };
function batch(locator: EvidenceLocator): VisualEvidenceBatch {
 const common = { source, diagnostics: [], engine: { name: 'fixture', version: '1' }, scope: {},
  evidence: [{ path: '/work/a.png', sha256: 'b'.repeat(64), mediaType: 'image/png' as const, width: 100, height: 100, locator }] };
 return locator.kind === 'paginated' ? { ...common, kind: 'paginated', layout: { totalPages: 3, pages: [{ page: 2, width: 100, height: 100, rotation: 0, scale: 1 }] } } : { ...common, kind: locator.kind };
}
describe('artifact public contract', () => {
 it('uses the caller port and does not manufacture a capture owner', async () => {
  const requests: unknown[] = [];
  const sdk = createArtifactSdk({ execute: async request => { requests.push(request); return { status: 'unverified', diagnostics: [{ code: 'unsupported', message: 'no capture owner' }] }; } });
  const input = { kind: 'temporal' as const, target: 'clip.mp4', locators: [{ kind: 'temporal' as const, time: 1, frame: 30 }] };
  expect((await sdk.capture(input)).status).toBe('unverified'); expect(requests).toEqual([{ operation: 'capture', input }]);
 });
 it.each<EvidenceLocator>([{ kind: 'static', region: [1, 2, 30, 40] }, { kind: 'paginated', page: 2, sheet: 'Summary', range: 'A1:D8' },
  { kind: 'interactive', target: 'app', state: 'clicked', viewport: [800, 600], camera: 'front', sequence: 2 }, { kind: 'temporal', time: 2, frame: 60 }])('requires exact %j locators and source', locator => {
  const evidence = batch(locator), requirement = { kind: locator.kind, source, locators: [locator] };
  expect(validateVisualEvidence(evidence, requirement)).toEqual({ status: 'ready', missing: [] });
  expect(validateVisualEvidence({ ...evidence, diagnostics: [{ code: 'gap', message: 'unsupported', blocking: true }] }, requirement).status).toBe('unverified');
  expect(validateVisualEvidence(evidence, { ...requirement, source: { kind: 'file', file: { ...source.file, sourceHash: 'c'.repeat(64) } } }).missing).toContain('stale-source');
  const changed = locator.kind === 'static' ? { ...locator, region: [0, 0, 30, 40] as const } : locator.kind === 'paginated' ? { ...locator, range: 'A1:A2' } : locator.kind === 'interactive' ? { ...locator, sequence: 3 } : { ...locator, frame: 61 };
  expect(validateVisualEvidence(evidence, { ...requirement, locators: [changed] }).missing).toContain('locator:0');
 });
 it.each<EvidenceLocator>([{ kind: 'static', region: [0, 0, -1, 1] }, { kind: 'paginated', page: 0 },
  { kind: 'interactive', target: 'app', state: 'clicked', viewport: [0, 800], sequence: -1 }, { kind: 'temporal', time: -1 }])('rejects invalid locator %j', locator => {
  expect(validateVisualEvidence(batch(locator), { kind: locator.kind, source }).status).toBe('unverified');
 });
 it('cannot treat samples as continuous playback or certify unspecified states', () => {
  const evidence = batch({ kind: 'temporal', time: 1 });
  expect(validateVisualEvidence(evidence, { source, kind: 'temporal' }).missing).toContain('temporal-scope-required');
  const sampled = { ...evidence, scope: { temporal: { start: 0, end: 10, coverage: 'sampled' as const } } };
  expect(validateVisualEvidence(sampled, { source, kind: 'temporal', times: [1], temporal: { start: 0, end: 10, coverage: 'continuous' } }).missing).toContain('temporal-range');
  expect(validateVisualEvidence(batch({ kind: 'interactive', target: 'app', state: 'loaded', viewport: [800, 600], sequence: 0 }), { source, kind: 'interactive' }).missing).toContain('interactive-scope-required');
 });
 it('does not certify changed dependencies or a different surface observation', () => {
  const evidence = batch({ kind: 'static' });
  expect(validateVisualEvidence(evidence, { kind: 'static', source: { ...source, dependencies: [{ path: '/work/a.css', sha256: 'b'.repeat(64) }] } }).missing).toContain('stale-source');
  const withDependency = { ...evidence, source: { ...source, dependencies: [{ path: '/work/a.css', sha256: 'b'.repeat(64) }] } };
  expect(validateVisualEvidence(withDependency, { kind: 'static', source: { ...source, dependencies: [{ sha256: 'b'.repeat(64), path: '/work/a.css' }] } }).status).toBe('ready');
  const surface: VisualSource = { kind: 'surface', target: 'tab', observedAt: '2026-10-13T00:00:00Z' };
  expect(validateVisualEvidence({ ...evidence, source: surface }, { kind: 'static', source: { ...surface, observedAt: '2026-10-13T00:00:01Z' } }).missing).toContain('stale-source');
  expect(validateVisualEvidence({ ...evidence, background: 'white' }, { kind: 'static', source, background: 'black' }).status).toBe('unverified');
 });
});
