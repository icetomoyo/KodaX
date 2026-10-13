import { chromium, type Page } from 'playwright-core';
import type { ArtifactRuntimeOptions } from './runtime.js';
import { defaultBrowserExecutable } from './render.js';

export async function withArtifactPage<T>(options: ArtifactRuntimeOptions, use: (page: Page) => Promise<T>): Promise<T> {
 options.signal?.throwIfAborted();
 const browser = await chromium.launch({ executablePath: options.browserExecutable ?? defaultBrowserExecutable(), headless: true });
 let closing: Promise<void> | undefined, closeError: unknown, timedOut = false;
 const close = () => { closing ??= browser.close(); void closing.catch(error => { closeError = error; }); };
 const timeout = setTimeout(() => { timedOut = true; close(); }, 90_000);
 options.signal?.addEventListener('abort', close, { once: true });
 try {
  options.signal?.throwIfAborted();
  const context = await browser.newContext({ deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
  await context.routeWebSocket('**/*', socket => socket.close());
  const page = await context.newPage(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(20_000);
  return await use(page);
 } catch (error) { options.signal?.throwIfAborted(); if (timedOut) throw new Error('Artifact browser operation timed out.', { cause: error }); throw error; }
 finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', close); await (closing ?? browser.close()); if (closeError) throw closeError; }
}
