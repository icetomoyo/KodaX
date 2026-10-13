import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeArtifactRequest } from './runtime.js';
import JSZip from 'jszip';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
describe.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER)('real lightweight renderer', () => {
 it('reopens the final PPTX and returns decoded pixels bound to every requested page', async () => {
   const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact render 中文 ')); roots.push(root);
   const created = await executeArtifactRequest({ operation: 'create', input: { output: 'deck.pptx',
     slides: [{ elements: [{ type: 'text', text: 'Alpha', x: 1, y: 1, width: 8, height: 1 }] }] } }, { workspaceRoot: root });
   const rendered = await executeArtifactRequest({ operation: 'render', input: { path: created.artifact!.path,
     expectedSourceHash: created.artifact!.sourceHash } }, { workspaceRoot: root, browserExecutable: process.env.KODAX_ARTIFACT_TEST_BROWSER });
   expect(rendered.status).toBe('ready');
   expect(rendered.evidence!.source).toEqual({ kind: 'file', file: created.artifact });
   expect(rendered.evidence!.evidence[0]!.locator).toEqual({ kind: 'paginated', page: 1 });
   expect((await fs.readFile(rendered.evidence!.evidence[0]!.path)).subarray(1, 4).toString()).toBe('PNG');
 });
 it('renders Chinese text, shapes, image, table and 2D chart from the actual PPTX', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact all elements ')); roots.push(root);
  await fs.writeFile(path.join(root, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2SAAAAABJRU5ErkJggg==', 'base64'));
  const options = { workspaceRoot: root, browserExecutable: process.env.KODAX_ARTIFACT_TEST_BROWSER };
  await executeArtifactRequest({ operation: 'create', input: { output: 'all.pptx', slides: [{ elements: [
   { type: 'text', text: '季度评审 / Alpha', x: 1, y: 0.2, width: 8, height: 0.6 },
   { type: 'rectangle', color: '00AAFF', x: 1, y: 1, width: 2, height: 0.5 },
   { type: 'image', path: 'dot.png', x: 4, y: 1, width: 1, height: 1 },
   { type: 'table', rows: [['月份', '数值'], ['Jan', '12']], x: 1, y: 2, width: 4, height: 2 },
   { type: 'chart', categories: ['Jan', 'Feb'], values: [12, 24], x: 6, y: 2, width: 4, height: 3 },
  ] }] } }, options);
  const result = await executeArtifactRequest({ operation: 'render', input: { path: 'all.pptx', pages: [1] } }, options);
  expect(result.diagnostics).toEqual([]); expect(result.status).toBe('ready');
  expect(result.evidence!.evidence).toHaveLength(1);
 });
 it('reports missing fonts and corrupt image media while still exposing diagnostic pixels', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact render gaps ')); roots.push(root);
  const options = { workspaceRoot: root, browserExecutable: process.env.KODAX_ARTIFACT_TEST_BROWSER };
  await executeArtifactRequest({ operation: 'create', input: { output: 'font.pptx', slides: [{ elements: [{ type: 'text', text: 'Font test', fontFace: 'KodaXMissingFont97', x: 1, y: 1, width: 8, height: 1 }] }] } }, options);
  const result = await executeArtifactRequest({ operation: 'render', input: { path: 'font.pptx' } }, options);
  expect(result.status).toBe('unverified'); expect(result.diagnostics.some(item => /Font unavailable/.test(item.message))).toBe(true);
  await fs.writeFile(path.join(root, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2SAAAAABJRU5ErkJggg==', 'base64'));
  await executeArtifactRequest({ operation: 'create', input: { output: 'image.pptx', slides: [{ elements: [{ type: 'image', path: 'dot.png', x: 1, y: 1, width: 1, height: 1 }] }] } }, options);
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'image.pptx')));
  for (const name of Object.keys(zip.files)) if (name.startsWith('ppt/media/') && !zip.files[name]!.dir) zip.file(name, 'invalid pixels');
  await fs.writeFile(path.join(root, 'broken.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const broken = await executeArtifactRequest({ operation: 'render', input: { path: 'broken.pptx' } }, options);
  expect(broken.status).toBe('unverified'); expect(broken.diagnostics.some(item => item.code === 'render-resource')).toBe(true);
 });
 it('binds independent concurrent renders and rejects invalid/big page batches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact parallel ')); roots.push(root);
  const options = { workspaceRoot: root, browserExecutable: process.env.KODAX_ARTIFACT_TEST_BROWSER };
  await executeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [] }, { elements: [] }] } }, options);
  const result = await Promise.all([1, 2].map(number => executeArtifactRequest({ operation: 'render', input: { path: 'x.pptx', pages: [number] } }, options)));
  expect(result.map(item => item.evidence!.scope.pages)).toEqual([[1], [2]]);
  expect(result[0]!.evidence!.evidence[0]!.path).not.toBe(result[1]!.evidence!.evidence[0]!.path);
  for (const pages of [[], [0], [3]]) await expect(executeArtifactRequest({ operation: 'render', input: { path: 'x.pptx', pages } }, options)).rejects.toThrow(/pages/);
  await expect(executeArtifactRequest({ operation: 'render', input: { path: 'x.pptx' } }, { ...options, maxRenderPages: 1 })).rejects.toThrow(/batch/);
 });
});
