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
