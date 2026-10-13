import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await build({ entryPoints: [require.resolve('docx-renderer')], bundle: true, platform: 'browser', format: 'iife',
 globalName: 'kodaxDocx', outfile: fileURLToPath(new URL('../dist/docx.browser.js', import.meta.url)), minify: true });
