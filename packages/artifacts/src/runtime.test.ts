import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeArtifactRequest } from './runtime.js';
import JSZip from 'jszip';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
describe('real PPT public operations', () => {
 it('creates, opens, edits and exports a new revision while preserving the original', async () => {
   const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact 中文 ')); roots.push(root);
   const original = await executeArtifactRequest({ operation: 'create', input: { output: 'deck.pptx', slides: [
     { elements: [{ type: 'text', text: 'Alpha', x: 1, y: 1, width: 8, height: 1 }] },
   ] } }, { workspaceRoot: root });
   const opened = await executeArtifactRequest({ operation: 'open', input: { path: original.artifact!.path } }, { workspaceRoot: root });
   expect(opened.objects!.find(item => item.text === 'Alpha')).toBeDefined();
   const edited = await executeArtifactRequest({ operation: 'edit', input: { path: original.artifact!.path,
     expectedSourceHash: original.artifact!.sourceHash, output: 'fixed.pptx',
     changes: [{ page: 1, objectId: opened.objects![0]!.objectId, text: 'Beta' }] } }, { workspaceRoot: root });
   const checked = await executeArtifactRequest({ operation: 'open', input: { path: edited.artifact!.path } }, { workspaceRoot: root });
   expect(checked.objects!.some(item => item.text === 'Beta')).toBe(true);
   expect((await executeArtifactRequest({ operation: 'open', input: { path: original.artifact!.path } }, { workspaceRoot: root })).artifact!.sourceHash).toBe(original.artifact!.sourceHash);
   await expect(executeArtifactRequest({ operation: 'edit', input: { path: edited.artifact!.path,
     expectedSourceHash: original.artifact!.sourceHash, output: 'bad.pptx', changes: [] } }, { workspaceRoot: root })).rejects.toThrow(/stale/i);
   await expect(executeArtifactRequest({ operation: 'export', input: { path: edited.artifact!.path, output: 'deck.pptx' } }, { workspaceRoot: root })).rejects.toThrow();
 });
 it('exports exact bytes, supports literal dot prefixes and rejects protected/escaping outputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact paths ')); roots.push(root);
  const input = { output: '..literal/deck.pptx', slides: [{ elements: [] }] };
  const created = await executeArtifactRequest({ operation: 'create', input }, { workspaceRoot: root });
  const exported = await executeArtifactRequest({ operation: 'export', input: { path: created.artifact!.path, output: 'out/deck.pptx' } }, { workspaceRoot: root });
  expect(exported.artifact!.sourceHash).toBe(created.artifact!.sourceHash);
  for (const output of ['../escape.pptx', '.GIT/internal.pptx', '.kodax/state.pptx', 'bad.pdf']) await expect(executeArtifactRequest({ operation: 'create', input: { ...input, output } }, { workspaceRoot: root })).rejects.toThrow();
 });
 it('edits text and geometry while rejecting unknown objects and group geometry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact edits ')); roots.push(root);
  const created = await executeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [{ type: 'text', text: 'Before', x: 1, y: 1, width: 3, height: 1 }] }] } }, { workspaceRoot: root });
  const opened = await executeArtifactRequest({ operation: 'open', input: { path: 'x.pptx' } }, { workspaceRoot: root });
  const change = { page: 1, objectId: opened.objects![0]!.objectId, text: 'After < & >', box: { x: 1, y: 2, width: 5, height: 1 } };
  const edit = { path: 'x.pptx', output: 'fixed.pptx', expectedSourceHash: created.artifact!.sourceHash, changes: [change] };
  await executeArtifactRequest({ operation: 'edit', input: edit }, { workspaceRoot: root });
  expect((await executeArtifactRequest({ operation: 'open', input: { path: 'fixed.pptx' } }, { workspaceRoot: root })).objects![0]!.text).toBe('After < & >');
  for (const changes of [[{ ...change, page: 0 }], [{ ...change, objectId: '9999' }], [{ ...change, box: { ...change.box, width: -1 } }]]) await expect(executeArtifactRequest({ operation: 'edit', input: { ...edit, output: 'invalid.pptx', changes } }, { workspaceRoot: root })).rejects.toThrow();
 });
 it('assigns unique IDs to generated title/table and preserves table bytes when editing title', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact table IDs ')); roots.push(root);
  const options = { workspaceRoot: root };
  const created = await executeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [
   { type: 'text', text: 'Title', x: 1, y: 1, width: 5, height: 1 },
   { type: 'table', rows: [['Name', 'Value'], ['Alpha', '12']], x: 1, y: 2, width: 5, height: 2 },
  ] }] } }, options);
  const opened = await executeArtifactRequest({ operation: 'open', input: { path: 'x.pptx' } }, options);
  expect(new Set(opened.objects!.map(item => item.objectId)).size).toBe(opened.objects!.length);
  const before = await JSZip.loadAsync(await fs.readFile(path.join(root, 'x.pptx')));
  const table = (await before.file('ppt/slides/slide1.xml')!.async('string')).match(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/)![0];
  await executeArtifactRequest({ operation: 'edit', input: { path: 'x.pptx', expectedSourceHash: created.artifact!.sourceHash, output: 'fixed.pptx', changes: [{ page: 1, objectId: opened.objects!.find(item => item.text === 'Title')!.objectId, text: 'Repaired' }] } }, options);
  const after = await JSZip.loadAsync(await fs.readFile(path.join(root, 'fixed.pptx')));
  expect(await after.file('ppt/slides/slide1.xml')!.async('string')).toContain(table);
  await expect(executeArtifactRequest({ operation: 'edit', input: { path: 'x.pptx', expectedSourceHash: created.artifact!.sourceHash, output: 'bad.pptx', changes: [{ page: 1, objectId: opened.objects!.find(item => item.type === 'graphicFrame')!.objectId, text: 'Unsafe table edit' }] } }, options)).rejects.toThrow(/restricted/);
 });
 it('identifies temporal, unsupported graphic, active and external media rather than approving', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact unsupported ')); roots.push(root);
  await executeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [] }] } }, { workspaceRoot: root });
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'x.pptx')));
  const page = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide1.xml', page.replace('</p:sld>', '<p:timing/><p:oleObj/><mc:AlternateContent/><a:graphicData uri="unknown"/></p:sld>'));
  zip.file('ppt/media/unsupported.emf', 'vector'); zip.file('ppt/vbaProject.bin', 'macro');
  zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="remote" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.test/image.png"/></Relationships>');
  await fs.writeFile(path.join(root, 'unsupported.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await executeArtifactRequest({ operation: 'open', input: { path: 'unsupported.pptx' } }, { workspaceRoot: root });
  expect(result.status).toBe('unverified'); expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['temporal-content', 'unsupported-object', 'unsupported-graphic', 'unsupported-vector-media', 'active-content', 'external-resource']));
  await expect(executeArtifactRequest({ operation: 'edit', input: { path: 'unsupported.pptx', expectedSourceHash: result.artifact!.sourceHash, output: 'changed.pptx', changes: [] } }, { workspaceRoot: root })).rejects.toThrow(/unsupported/);
 });
 it('reports missing adapters and dependencies, and respects cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact missing ')); roots.push(root);
  for (const kind of ['static', 'paginated', 'interactive', 'temporal'] as const) expect((await executeArtifactRequest({ operation: 'capture', input: { kind, target: 'anything' } }, { workspaceRoot: root })).status).toBe('unverified');
  const options = { workspaceRoot: root, browserExecutable: path.join(root, 'missing.exe') };
  expect((await executeArtifactRequest({ operation: 'capabilities', input: {} }, options)).capabilities!.render).toBe('missing-browser');
  await executeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [] }] } }, options);
  expect((await executeArtifactRequest({ operation: 'render', input: { path: 'x.pptx' } }, options)).diagnostics[0]!.code).toBe('missing-browser');
  expect((await executeArtifactRequest({ operation: 'render', input: { path: 'x.pptx', backend: 'libreoffice' } }, options)).status).toBe('unverified');
  await expect(executeArtifactRequest({ operation: 'open', input: { path: 'x.pptx' } }, { ...options, signal: AbortSignal.abort() })).rejects.toThrow(/cancel/);
 });
 it('rejects falsely declared compressed ZIP expansion before parsing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact zip expansion ')); roots.push(root);
  const zip = new JSZip(); zip.file('oversized.xml', Buffer.alloc(33 * 1024 * 1024, 65));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bytes.writeUInt32LE(1, directory + 24);
  await fs.writeFile(path.join(root, 'bad.pptx'), bytes);
  await expect(executeArtifactRequest({ operation: 'open', input: { path: 'bad.pptx' } }, { workspaceRoot: root })).rejects.toThrow(/maxOutputLength|larger than|size|buffer/i);
 });
 it('does not present grouped local coordinates as editable slide boxes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact grouped ')); roots.push(root);
  const options = { workspaceRoot: root };
  await executeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [{ type: 'text', text: 'Grouped', x: 1, y: 1, width: 5, height: 1 }] }] } }, options);
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'x.pptx')));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide1.xml', xml.replace(/(<p:sp\b[\s\S]*?<\/p:sp>)/, '<p:grpSp>$1</p:grpSp>'));
  await fs.writeFile(path.join(root, 'grouped.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const opened = await executeArtifactRequest({ operation: 'open', input: { path: 'grouped.pptx' } }, options);
  expect(opened.objects![0]!.box).toBeUndefined();
  await expect(executeArtifactRequest({ operation: 'edit', input: { path: 'grouped.pptx', expectedSourceHash: opened.artifact!.sourceHash, output: 'bad.pptx', changes: [{ page: 1, objectId: opened.objects![0]!.objectId, box: { x: 1, y: 1, width: 2, height: 1 } }] } }, options)).rejects.toThrow(/Group geometry/);
 });
 it.each([
  { type: 'text', text: 'x', x: 0, y: 0, width: 0, height: 1 },
  { type: 'rectangle', color: 'bad!', x: 0, y: 0, width: 1, height: 1 },
  { type: 'table', rows: [], x: 0, y: 0, width: 1, height: 1 },
  { type: 'chart', categories: ['one'], values: [], x: 0, y: 0, width: 1, height: 1 },
 ])('rejects invalid content %j without writing output', async element => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact invalid ')); roots.push(root);
  await expect(executeArtifactRequest({ operation: 'create', input: { output: 'bad.pptx', slides: [{ elements: [element] }] } } as Parameters<typeof executeArtifactRequest>[0], { workspaceRoot: root })).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
 });
});
