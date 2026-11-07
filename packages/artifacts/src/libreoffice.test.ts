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
 let snapshot = '';
 run.mockImplementation(async (_exe: string, args: string[]) => {
  if (args[0] === '--version') return { stdout: 'LibreOffice test-converter' };
  snapshot = (await fs.readFile(args.at(-1)!)).toString(); await fs.mkdir(path.join(directory, 'profile'));
  await fs.writeFile(path.join(directory, 'source.pdf'), '%PDF-1.4\nfixture'); return { stdout: 'converted' };
 });
 const result = await convertWithLibreOffice(Buffer.from('PPTX snapshot'), directory, { workspaceRoot: directory, libreOfficeExecutable: process.execPath });
 expect(result.bytes.toString()).toContain('%PDF-'); expect(run).toHaveBeenCalledTimes(2);
 expect(run.mock.calls[1]![1]).toEqual([expect.stringMatching(/^-env:UserInstallation=file:/), '--headless', '--convert-to', 'pdf:impress_pdf_Export', '--outdir', directory, path.join(directory, 'source.pptx')]);
 expect(run.mock.calls[1]![2]).toMatchObject({ timeout: 90_000, windowsHide: true });
 expect(snapshot).toBe('PPTX snapshot'); expect(await fs.readdir(directory)).toEqual([]);
});
it('converts DOCX with the Writer PDF filter from a DOCX snapshot', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact LO docx ')); roots.push(directory);
 let snapshot = '';
 run.mockImplementation(async (_exe: string, args: string[]) => {
  if (args[0] === '--version') return { stdout: 'LibreOffice test-converter' };
  snapshot = (await fs.readFile(args.at(-1)!)).toString();
  await fs.writeFile(path.join(directory, 'source.pdf'), '%PDF-1.4\nfixture'); return { stdout: 'converted' };
 });
 await convertWithLibreOffice(Buffer.from('DOCX snapshot'), directory, { workspaceRoot: directory, libreOfficeExecutable: process.execPath }, 'docx');
 expect(run.mock.calls[1]![1]).toEqual([expect.stringMatching(/^-env:UserInstallation=file:/), '--headless', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', directory, path.join(directory, 'source.docx')]);
 expect(snapshot).toBe('DOCX snapshot');
});
it('rejects missing or non-LibreOffice converters and propagates failures', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact LO missing ')); roots.push(directory);
 await expect(convertWithLibreOffice(Buffer.alloc(0), directory, { workspaceRoot: directory })).rejects.toThrow(/Prepare/);
 run.mockResolvedValue({ stdout: 'different program' });
 await expect(convertWithLibreOffice(Buffer.alloc(0), directory, { workspaceRoot: directory, libreOfficeExecutable: process.execPath })).rejects.toThrow(/not LibreOffice/);
 expect(await fs.readdir(directory)).toEqual([]);
});
it.runIf(process.platform === 'win32')('uses the console soffice.com twin because Windows soffice.exe blocks on CLI calls', async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact LO console ')); roots.push(directory);
 for (const name of ['soffice.exe', 'soffice.com']) await fs.writeFile(path.join(directory, name), '');
 run.mockImplementation(async (_exe: string, args: string[]) => {
  if (args[0] === '--version') return { stdout: 'LibreOffice test-converter' };
  await fs.writeFile(path.join(directory, 'source.pdf'), '%PDF-1.4'); return { stdout: 'converted' };
 });
 await convertWithLibreOffice(Buffer.from('DOCX'), directory, { workspaceRoot: directory, libreOfficeExecutable: path.join(directory, 'soffice.exe') }, 'docx');
 expect(run.mock.calls.map(call => call[0])).toEqual([path.join(directory, 'soffice.com'), path.join(directory, 'soffice.com')]);
});
