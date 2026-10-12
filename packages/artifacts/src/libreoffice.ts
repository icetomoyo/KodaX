import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ArtifactRuntimeOptions } from './runtime.js';

const run = promisify(execFile);
/** Fixed conversion inside the caller's managed worker/sandbox, isolated LO profile. */
export async function convertWithLibreOffice(bytes: Buffer, directory: string, options: ArtifactRuntimeOptions): Promise<{ bytes: Buffer; version: string }> {
 const executable = options.libreOfficeExecutable;
 if (!executable || !path.isAbsolute(executable)) throw new Error('Prepare an absolute LibreOffice executable through the host.');
 const source = path.join(directory, 'source.pptx');
 await fs.writeFile(source, bytes, { flag: 'wx' });
 const settings = { cwd: directory, signal: options.signal, timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true };
 const version = (await run(executable, ['--version'], settings)).stdout.trim();
 if (!/^LibreOffice\b/.test(version)) throw new Error('Configured converter is not LibreOffice.');
 await run(executable, ['-env:UserInstallation=' + pathToFileURL(path.join(directory, 'profile')).href,
  '--headless', '--convert-to', 'pdf:impress_pdf_Export', '--outdir', directory, source], settings);
 const pdf = await fs.readFile(path.join(directory, 'source.pdf'));
 if (pdf.length > 64 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('LibreOffice did not produce a supported PDF.');
 return { bytes: pdf, version };
}
