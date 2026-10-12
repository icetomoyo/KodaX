import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { convertWithLibreOffice } from './libreoffice.js';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => undefined, { [promisify.custom]: run }) }));
const roots: string[] = [];
afterEach(async () => { run.mockReset(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
it('keeps optional conversion fixed-argv, isolated profile, bounded, and checks actual PDF output', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact LO 中文 ')); roots.push(directory);
 run.mockImplementation(async (_exe: string, args: string[]) => {
  if (args[0] === '--version') return { stdout: 'LibreOffice test-converter' };
  await fs.writeFile(path.join(directory, 'source.pdf'), '%PDF-1.4\nfixture'); return { stdout: 'converted' };
 });
 const result = await convertWithLibreOffice(Buffer.from('PPTX snapshot'), directory, { workspaceRoot: directory, libreOfficeExecutable: process.execPath });
 expect(result.bytes.toString()).toContain('%PDF-'); expect(run).toHaveBeenCalledTimes(2);
 expect(run.mock.calls[1]![1]).toEqual([expect.stringMatching(/^-env:UserInstallation=file:/), '--headless', '--convert-to', 'pdf:impress_pdf_Export', '--outdir', directory, path.join(directory, 'source.pptx')]);
 expect(run.mock.calls[1]![2]).toMatchObject({ timeout: 90_000, windowsHide: true });
 expect((await fs.readFile(path.join(directory, 'source.pptx'))).toString()).toBe('PPTX snapshot');
});
it('rejects missing or non-LibreOffice converters and propagates failures', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact LO missing ')); roots.push(directory);
 await expect(convertWithLibreOffice(Buffer.alloc(0), directory, { workspaceRoot: directory })).rejects.toThrow(/Prepare/);
 run.mockResolvedValue({ stdout: 'different program' });
 await expect(convertWithLibreOffice(Buffer.alloc(0), directory, { workspaceRoot: directory, libreOfficeExecutable: process.execPath })).rejects.toThrow(/not LibreOffice/);
});
