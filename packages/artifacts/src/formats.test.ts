import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createArtifactSdk } from './index.js';
import { executeArtifactRequest } from './runtime.js';

it('reads actual PNG evidence through the SDK and rejects changed source/raster', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact source pixels '));
 try {
  await fs.copyFile('tests/fixtures/images/valid-png.png', path.join(root, 'source.png'));
  const sdk = createArtifactSdk({ execute: request => executeArtifactRequest(request, { workspaceRoot: root }) });
  const opened = await sdk.open({ path: 'source.png' }); expect(opened.status).toBe('ready'); expect(opened.artifact?.format).toBe('png');
  const rendered = await sdk.render({ path: 'source.png', expectedSourceHash: opened.artifact!.sourceHash });
  expect(rendered.status).toBe('ready');
  const input = { source: rendered.evidence!.source, raster: rendered.evidence!.evidence[0]! };
  const read = await sdk.readEvidence(input); expect(read.status).toBe('ready');
  const reordered = Object.fromEntries(Object.entries(input.raster).reverse());
  expect((await sdk.readEvidence({ ...input, raster: reordered as typeof input.raster })).status).toBe('ready');
  expect(Buffer.from(read.image!.dataBase64, 'base64')).toEqual(await fs.readFile(input.raster.path));
  await fs.copyFile(path.join(root, 'source.png'), path.join(root, 'other.png'));
  await expect(sdk.capture({ kind: 'static', target: 'source.png', expectedSource: { kind: 'file', file: { ...opened.artifact!, path: path.join(root, 'other.png') } }, locators: [{ kind: 'static' }] })).rejects.toThrow(/identity|source/i);
  await fs.writeFile(input.raster.path, 'corrupt'); await expect(sdk.readEvidence(input)).rejects.toThrow(/hash|PNG/i);
  await fs.writeFile(path.join(root, 'source.png'), 'new source'); await expect(sdk.readEvidence(input)).rejects.toThrow(/source|stale/i);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('requires genuine evidence provenance and honors cancellation', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact ownership '));
 try {
  await fs.copyFile('tests/fixtures/images/valid-png.png', path.join(root, 'image.png'));
  const controller = new AbortController(); controller.abort();
  await expect(executeArtifactRequest({ operation: 'open', input: { path: 'image.png' } }, { workspaceRoot: root, signal: controller.signal })).rejects.toThrow(/cancel|abort/i);
  await expect(executeArtifactRequest({ operation: 'readEvidence', input: {
   source: { kind: 'surface', target: 'private-tab', observedAt: '2026-10-13T00:00:00Z' },
   raster: { path: 'image.png', sha256: 'a'.repeat(64), mediaType: 'image/png', width: 160, height: 46, locator: { kind: 'static' } },
  } }, { workspaceRoot: root })).rejects.toThrow(/provenance|evidence|ENOENT/i);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('declares each implemented capture and its engine without preparing software', async () => {
 const result = await executeArtifactRequest({ operation: 'capabilities', input: {} }, { workspaceRoot: process.cwd(), browserExecutable: path.resolve('does-not-exist-browser.exe') });
 for (const input of ['pdf', 'docx', 'png', 'jpeg', 'webp', 'svg', 'html']) {
  expect(result.capabilities!.find(c => c.operation === 'capture' && c.input === input)?.engine?.name).toBeTruthy();
 }
 expect(result.capabilities!.find(c => c.operation === 'render' && c.input === 'pptx' && c.backend === 'libreoffice')?.availability).toBe('not-prepared');
});
it('preserves the existing PPT authoring/repair/export loop through the public SDK', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact SDK PPT '));
 try {
  const sdk = createArtifactSdk({ execute: request => executeArtifactRequest(request, { workspaceRoot: root }) });
  const created = await sdk.create({ output: 'original.pptx', slides: [{ elements: [{ type: 'text', text: 'Original', x: 1, y: 1, width: 5, height: 1 }] }] });
  const opened = await sdk.open({ path: created.artifact!.path });
  const fixed = await sdk.edit({ path: created.artifact!.path, expectedSourceHash: created.artifact!.sourceHash, output: 'fixed.pptx', changes: [{ page: 1, objectId: opened.objects![0]!.objectId, text: 'Repaired' }] });
  const exported = await sdk.export({ path: fixed.artifact!.path, expectedSourceHash: fixed.artifact!.sourceHash, output: 'export.pptx' });
  expect(exported.artifact!.sourceHash).toBe(fixed.artifact!.sourceHash);
  expect((await sdk.open({ path: 'original.pptx' })).objects![0]!.text).toBe('Original');
  expect((await sdk.open({ path: 'export.pptx' })).objects![0]!.text).toBe('Repaired');
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});
