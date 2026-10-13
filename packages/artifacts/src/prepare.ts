import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultBrowserExecutable } from './render.js';
import { withArtifactPage } from './browser.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import type { ArtifactResult } from './types.js';

export async function browserAvailable(options: ArtifactRuntimeOptions): Promise<boolean> {
 try { const stat = await fs.stat(options.browserExecutable ?? defaultBrowserExecutable()); return stat.isFile(); }
 catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; }
}
export async function prepareBrowser(options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 if (!(await browserAvailable(options))) {
  if (options.browserExecutable) return { status: 'unverified', diagnostics: [{ code: 'missing-browser', message: 'The trusted custom browser path is missing; prepare it through its owning host.', blocking: true }] };
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('cli.js', import.meta.resolve('playwright-core/package.json'))), 'install', 'chromium'],
   { signal: options.signal, timeout: 600_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
 }
 options.signal?.throwIfAborted();
 if (!(await browserAvailable(options))) throw new Error('Chromium preparation completed without a browser executable.');
 const version = await withArtifactPage(options, async page => page.context().browser()!.version());
 return { status: 'ready', component: 'browser', engine: { name: 'Chromium', version }, diagnostics: [] };
}
