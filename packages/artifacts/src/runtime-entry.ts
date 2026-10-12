import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executeArtifactRequest } from './runtime.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import type { ArtifactRequest } from './types.js';

const requestFile = process.argv[2];
if (!requestFile || !/^\.artifact-request-[a-f0-9-]{36}\.json$/.test(path.basename(requestFile))) throw new Error('Invalid artifact worker manifest.');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
try {
 const source = await fs.readFile(requestFile, 'utf8');
 if (source.length > 2 * 1024 * 1024) throw new Error('Artifact manifest exceeds 2 MiB.');
 if (!/^[a-f0-9]{64}$/.test(process.argv[3] ?? '') || createHash('sha256').update(source).digest('hex') !== process.argv[3]) throw new Error('Artifact manifest changed after admission.');
 const manifest = JSON.parse(source) as { request: ArtifactRequest; options: ArtifactRuntimeOptions };
 const result = await executeArtifactRequest(manifest.request, { ...manifest.options, signal: controller.signal });
 process.stdout.write('ARTIFACT_RESULT:' + JSON.stringify(result) + '\n');
} catch (error) {
 process.stderr.write('Artifact operation failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
 process.exitCode = 1;
} finally { await fs.unlink(requestFile); }
