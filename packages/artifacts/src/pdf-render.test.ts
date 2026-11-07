import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { executeArtifactRequest } from './runtime.js';
const convert = vi.hoisted(() => vi.fn());
vi.mock('./libreoffice.js', () => ({ convertWithLibreOffice: convert }));

// A standards-based single-page PDF fixture; conversion is mocked, PDF.js pixels are real.
function fixturePdf(): Buffer {
 const content = 'BT /F1 24 Tf 40 100 Td (PDF fallback pixels) Tj ET';
 const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let result = '%PDF-1.4\n'; const offsets: number[] = [0];
 for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += index + 1 + ' 0 obj\n' + object + '\nendobj\n'; }
 const start = Buffer.byteLength(result);
 result += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
 return Buffer.from(result + 'trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n' + start + '\n%%EOF\n');
}
it.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER)('renders converted PDF pixels with page binding (not a live LibreOffice test)', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact PDF browser '));
 try {
  const options = { workspaceRoot: root, browserExecutable: process.env.KODAX_ARTIFACT_TEST_BROWSER, libreOfficeExecutable: process.execPath };
  await executeArtifactRequest({ operation: 'create', input: { output: 'x.pptx', slides: [{ elements: [] }] } }, options);
  convert.mockResolvedValue({ bytes: fixturePdf(), version: 'LibreOffice fixture' });
  const result = await executeArtifactRequest({ operation: 'render', input: { path: 'x.pptx', backend: 'libreoffice' } }, options);
  expect(convert).toHaveBeenCalledOnce(); expect(result.status).toBe('ready');
  expect(result.evidence!.engine!.name).toBe('LibreOffice/PDF.js');
  expect((await fs.readFile(result.evidence!.evidence[0]!.path)).subarray(1, 4).toString()).toBe('PNG');
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it.skipIf(!process.env.KODAX_ARTIFACT_TEST_BROWSER)('renders DOCX through the host converter by default while binding evidence to the DOCX source', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact DOCX PDF browser '));
 try {
  await fs.copyFile('tests/fixtures/artifacts/inline-image.docx', path.join(root, 'x.docx'));
  const options = { workspaceRoot: root, browserExecutable: process.env.KODAX_ARTIFACT_TEST_BROWSER, libreOfficeExecutable: process.execPath };
  convert.mockReset(); convert.mockResolvedValue({ bytes: fixturePdf(), version: 'LibreOffice fixture' });
  const opened = await executeArtifactRequest({ operation: 'open', input: { path: 'x.docx' } }, options);
  const result = await executeArtifactRequest({ operation: 'render', input: { path: 'x.docx' } }, options);
  expect(convert).toHaveBeenCalledOnce(); expect(convert.mock.calls[0]![3]).toBe('docx');
  expect(result.status).toBe('ready'); expect(result.artifact).toEqual(opened.artifact);
  expect(result.evidence!.engine).toEqual({ name: 'LibreOffice/PDF.js', version: 'LibreOffice fixture' });
  expect(result.evidence!.source).toEqual({ kind: 'file', file: opened.artifact });
  expect(result.diagnostics.map(d => d.code)).toEqual(['docx-converted']); expect(result.diagnostics[0]!.blocking).toBeUndefined();
  expect(result.evidence!.layout!.totalPages).toBe(1);
  const lightweight = await executeArtifactRequest({ operation: 'render', input: { path: 'x.docx', backend: 'lightweight' } }, options);
  expect(convert).toHaveBeenCalledOnce(); expect(lightweight.status).toBe('unverified');
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});
