import { expect, it } from 'vitest';
import { createArtifactSdk, decodeArtifactRequest, decodeArtifactResult } from './index.js';

it('exposes preparation and binary evidence through the same SDK port', async () => {
 const operations: string[] = [];
 const sdk = createArtifactSdk({ execute: async request => { operations.push(request.operation);
  return { status: 'unverified', diagnostics: [{ code: 'not-prepared', message: 'Prepare explicitly.' }] }; } });
 expect((await sdk.prepare()).status).toBe('unverified');
 await sdk.readEvidence({ source: { kind: 'surface', target: 'authorized-tab', observedAt: '2026-10-13T00:00:00Z' },
  raster: { path: '/owned/a.png', sha256: 'a'.repeat(64), width: 100, height: 100, mediaType: 'image/png', locator: { kind: 'static' } } });
 expect(operations).toEqual(['prepare', 'readEvidence']);
});

it('rejects malformed or authority-changing JSON before execution', () => {
 for (const request of [ { operation: 'prepare', input: { executable: 'other.exe' } },
  { operation: 'render', input: { path: 'a.pdf', backend: 'word' } },
  { operation: 'capture', input: { kind: 'static', target: 'a.svg', locators: [{ kind: 'temporal', time: 0 }] } },
  { operation: 'open', input: { path: 'a.pdf', expectedSourceHash: 'bad' } },
  { operation: 'unknown', input: {} } ]) expect(() => decodeArtifactRequest(request)).toThrow();
});

it('rejects ready results without operation payloads and invalid source facts', () => {
 for (const operation of ['open', 'prepare', 'render', 'capture', 'readEvidence', 'capabilities'] as const) {
  expect(() => decodeArtifactResult(operation, { status: 'ready', diagnostics: [] })).toThrow();
 }
 expect(() => decodeArtifactResult('open', { status: 'ready', diagnostics: [],
  artifact: { path: 'a.docx', sourceHash: 'a'.repeat(64), format: 'docx', pages: 3 } })).toThrow();
});
it('checks optional authoring fields and rejects fields from another element variant', () => {
 const box = { x: 0, y: 0, width: 1, height: 1 };
 for (const element of [{ ...box, type: 'text', text: 'x', fontSize: 'large' }, { ...box, type: 'text', text: 'x', fontFace: 3 },
  { ...box, type: 'rectangle', color: 3 }, { ...box, type: 'rectangle', color: 'FFFFFF', text: 'wrong variant' },
  { ...box, type: 'chart', categories: ['a'], values: [1], name: 4 } ]) {
  expect(() => decodeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [element] }] } })).toThrow();
 }
});
