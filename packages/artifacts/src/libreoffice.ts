import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ArtifactRuntimeOptions } from './runtime.js';

const run = promisify(execFile);
// Windows soffice.exe is a GUI launcher that blocks on CLI calls; its sibling soffice.com is the console entry.
async function consoleEntry(executable: string): Promise<string> {
 if (process.platform !== 'win32' || path.basename(executable).toLowerCase() !== 'soffice.exe') return executable;
 const entry = path.join(path.dirname(executable), 'soffice.com');
 try { await fs.access(entry); return entry; }
 catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return executable; }
}
const exportFilters = { pptx: 'pdf:impress_pdf_Export', docx: 'pdf:writer_pdf_Export' } as const;
/** Fixed conversion inside the caller's managed worker/sandbox, isolated LO profile. */
export async function convertWithLibreOffice(bytes: Buffer, directory: string, options: ArtifactRuntimeOptions,
 format: keyof typeof exportFilters = 'pptx'): Promise<{ bytes: Buffer; version: string }> {
 const configured = options.libreOfficeExecutable;
 if (!configured || !path.isAbsolute(configured)) throw new Error('Prepare an absolute LibreOffice executable through the host.');
 const executable = await consoleEntry(configured);
 const source = path.join(directory, 'source.' + format);
 await fs.writeFile(source, bytes, { flag: 'wx' });
 const settings = { cwd: directory, signal: options.signal, timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true };
 const output = path.join(directory, 'source.pdf'), profile = path.join(directory, 'profile');
 try {
  const version = (await run(executable, ['--version'], settings)).stdout.trim();
  if (!/^LibreOffice\b/.test(version)) throw new Error('Configured converter is not LibreOffice.');
  await run(executable, ['-env:UserInstallation=' + pathToFileURL(profile).href,
   '--headless', '--convert-to', exportFilters[format], '--outdir', directory, source], settings);
  const pdf = await fs.readFile(output);
  if (pdf.length > 64 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('LibreOffice did not produce a supported PDF.');
  return { bytes: pdf, version };
 } finally {
  // Only PNG evidence belongs in the render directory; a stray source copy could be mistaken for the deliverable.
  await Promise.all([source, output, profile].map(file => fs.rm(file, { recursive: true, force: true })));
 }
}
