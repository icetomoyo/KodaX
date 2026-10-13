import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { expect, it } from 'vitest';
import { createArtifactSdk, validateVisualEvidence } from './index.js';
import { createNodeArtifactPort } from './runtime.js';

const browserExecutable = process.env.KODAX_ARTIFACT_TEST_BROWSER;
it.skipIf(!browserExecutable)('prepares an actual browser and rejects an existing non-browser executable', () => fixture(async (sdk, root) => {
 expect((await sdk.prepare()).engine?.name).toBe('Chromium');
 const invalid = createArtifactSdk(createNodeArtifactPort({ workspaceRoot: root, browserExecutable: process.execPath }));
 await expect(invalid.prepare()).rejects.toThrow();
}));
async function fixture<T>(run: (sdk: ReturnType<typeof createArtifactSdk>, root: string) => Promise<T>): Promise<T> {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact format pixels '));
 try { return await run(createArtifactSdk(createNodeArtifactPort({ workspaceRoot: root, browserExecutable, maxRenderPages: 4 })), root); }
 finally { await fs.rm(root, { recursive: true, force: true }); }
}
it.skipIf(!browserExecutable)('captures complete mixed PDF geometry, including the formerly cropped second page', () => fixture(async (sdk, root) => {
 await fs.copyFile('tests/fixtures/artifacts/mixed-pages.pdf', path.join(root, 'source.pdf'));
 const opened = await sdk.open({ path: 'source.pdf' }); expect(opened.artifact).toMatchObject({ format: 'pdf', pages: 2 });
 const rendered = await sdk.render({ path: 'source.pdf', pages: [1, 2] }); expect(rendered.status).toBe('ready');
 const evidence = rendered.evidence!; expect(evidence.kind).toBe('paginated');
 expect(evidence.evidence.map(r => [r.width, r.height])).toEqual([[534, 294], [294, 534]]);
 for (const raster of evidence.evidence) {
  const read = await sdk.readEvidence({ source: evidence.source, raster });
  const image = PNG.sync.read(Buffer.from(read.image!.dataBase64, 'base64'));
  expect([image.width, image.height]).toEqual([raster.width, raster.height]);
 }
 expect(validateVisualEvidence(evidence, { kind: 'paginated', source: evidence.source, pages: [1, 2] }).status).toBe('ready');
 await expect(sdk.render({ path: 'source.pdf', pages: [3] })).rejects.toThrow(/pages/);
}));
it.skipIf(!browserExecutable)('lays out minimal DOCX without settings, preserving original bytes and genuine pagination', () => fixture(async (sdk, root) => {
 for (const [name, count] of [['automatic-pagination', 3], ['explicit-break-table', 2]] as const) {
  await fs.copyFile('tests/fixtures/artifacts/' + name + '.docx', path.join(root, name + '.docx'));
  const original = await fs.readFile(path.join(root, name + '.docx')), opened = await sdk.open({ path: name + '.docx' });
  expect(opened.artifact).toMatchObject({ format: 'docx' }); expect(opened.artifact).not.toHaveProperty('pages');
  const rendered = await sdk.render({ path: name + '.docx', expectedSourceHash: opened.artifact!.sourceHash, pages: [1] });
  expect(rendered.status).toBe('unverified'); expect(rendered.evidence?.layout?.totalPages).toBe(count);
  expect(rendered.diagnostics.map(d => d.code)).toContain('docx-default-settings');
  const raster = rendered.evidence!.evidence[0]!;
  expect((await sdk.readEvidence({ source: rendered.evidence!.source, raster })).image!.height).toBeGreaterThan(1000);
  expect(await fs.readFile(path.join(root, name + '.docx'))).toEqual(original);
  const final = await sdk.render({ path: name + '.docx', pages: [count] }); expect(final.evidence!.evidence[0]!.locator).toEqual({ kind: 'paginated', page: count });
 }
}));
it.skipIf(!browserExecutable)('binds HTML loaded viewport and observed local dependencies, rejecting fake states', () => fixture(async (sdk, root) => {
 await fs.writeFile(path.join(root, 'a.css'), 'body { margin:0; background:#123456; }');
 await fs.writeFile(path.join(root, 'a.html'), '<!doctype html><html><head><link rel="stylesheet" href="a.css"></head><body><h1>Observed</h1></body></html>');
 const rendered = await sdk.capture({ kind: 'interactive', target: 'a.html', locators: [{ kind: 'interactive', target: 'a.html', state: 'loaded', viewport: [400, 300], sequence: 0 }] });
 expect(rendered.status).toBe('ready'); expect(rendered.evidence!.evidence[0]).toMatchObject({ width: 400, height: 300 });
 expect(rendered.evidence!.source).toMatchObject({ kind: 'file', dependencies: [{ path: path.join(root, 'a.css') }] });
 const input = { source: rendered.evidence!.source, raster: rendered.evidence!.evidence[0]! };
 expect((await sdk.readEvidence(input)).status).toBe('ready');
 await fs.writeFile(path.join(root, 'a.css'), 'body {background:red}'); await expect(sdk.readEvidence(input)).rejects.toThrow(/stale/i);
 const fake = await sdk.capture({ kind: 'interactive', target: 'a.html', locators: [{ kind: 'interactive', target: 'a.html', state: 'clicked', viewport: [400, 300], sequence: 1 }] });
 expect(fake.status).toBe('unverified'); expect(fake.evidence).toBeUndefined();
}));
it.skipIf(!browserExecutable)('samples actual SVG SMIL time and does not call animated source static or continuous', () => fixture(async (sdk, root) => {
 await fs.copyFile('tests/fixtures/artifacts/animated.svg', path.join(root, 'a.svg'));
 expect((await sdk.render({ path: 'a.svg' })).status).toBe('unverified');
 const sampled = await sdk.capture({ kind: 'temporal', target: 'a.svg', locators: [0, 1, 2].map(time => ({ kind: 'temporal', time })) });
 expect(sampled.status).toBe('ready'); expect(new Set(sampled.evidence!.evidence.map(r => r.sha256)).size).toBe(3);
 expect(validateVisualEvidence(sampled.evidence!, { kind: 'temporal', source: sampled.evidence!.source, times: [0, 1, 2], temporal: { start: 0, end: 2, coverage: 'continuous' } }).status).toBe('unverified');
}));
it.skipIf(!browserExecutable)('retains observed HTML pixels with blocking diagnostics when image resources are missing', () => fixture(async (sdk, root) => {
 await fs.writeFile(path.join(root, 'a.html'), '<html><body><h1>Visible content</h1><img src="missing.png"></body></html>');
 const result = await sdk.capture({ kind: 'interactive', target: 'a.html', locators: [{ kind: 'interactive', target: 'a.html', state: 'loaded', sequence: 0, viewport: [400, 300] }] });
 expect(result.status).toBe('unverified'); expect(result.evidence?.evidence).toHaveLength(1);
 expect(result.diagnostics.some(d => d.blocking)).toBe(true);
}));
it.skipIf(!browserExecutable)('decodes JPEG/WebP sources into readable PNG evidence and rejects corrupt JPEG', () => fixture(async (sdk, root) => {
 for (const name of ['valid.jpg', 'oriented.jpg', 'valid.webp', 'lossless.webp']) {
  await fs.copyFile('tests/fixtures/images/' + name, path.join(root, name));
  const result = await sdk.render({ path: name }); expect(result.status).toBe('ready');
  const image = await sdk.readEvidence({ source: result.evidence!.source, raster: result.evidence!.evidence[0]! });
  const png = PNG.sync.read(Buffer.from(image.image!.dataBase64, 'base64'));
  expect(png.width).toBeGreaterThan(0); expect(png.height).toBeGreaterThan(0);
 }
 await fs.copyFile('tests/fixtures/images/truncated-jpeg.jpg', path.join(root, 'corrupt.jpg'));
 await expect(sdk.render({ path: 'corrupt.jpg' })).rejects.toThrow(/decode|Image|pixel/i);
}));
