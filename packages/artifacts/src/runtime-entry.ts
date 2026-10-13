import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executeArtifactRequest } from './runtime.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import { decodeArtifactRequest, record } from './contract.js';

const requestFile = process.argv[2];
if (!requestFile || !/^\.artifact-request-[a-f0-9-]{36}\.json$/.test(path.basename(requestFile))) throw new Error('Invalid artifact worker manifest.');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
try {
 const source = await fs.readFile(requestFile, 'utf8');
 if (source.length > 2 * 1024 * 1024) throw new Error('Artifact manifest exceeds 2 MiB.');
 if (!/^[a-f0-9]{64}$/.test(process.argv[3] ?? '') || createHash('sha256').update(source).digest('hex') !== process.argv[3]) throw new Error('Artifact manifest changed after admission.');
 const manifest = record(JSON.parse(source)), request = decodeArtifactRequest(manifest.request), settings = record(manifest.options);
 if (typeof settings.workspaceRoot !== 'string' || !path.isAbsolute(settings.workspaceRoot)) throw new Error('Invalid artifact workspace.');
 for (const key of ['browserExecutable', 'libreOfficeExecutable']) if (settings[key] !== undefined && (typeof settings[key] !== 'string' || !path.isAbsolute(settings[key]))) throw new Error('Invalid artifact executable.');
 if (settings.maxRenderPages !== undefined && (typeof settings.maxRenderPages !== 'number' || !Number.isSafeInteger(settings.maxRenderPages) || settings.maxRenderPages < 1)) throw new Error('Invalid artifact batch limit.');
 const result = await executeArtifactRequest(request, { ...settings, signal: controller.signal } as ArtifactRuntimeOptions);
 const payload = request.operation === 'readEvidence' ? { status: result.status, diagnostics: result.diagnostics,
  ...('image' in result && result.image ? { imageRef: request.input.raster } : {}) } : result;
 process.stdout.write('ARTIFACT_RESULT:' + JSON.stringify(payload) + '\n');
} catch (error) {
 process.stderr.write('Artifact operation failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
 process.exitCode = 1;
} finally { await fs.unlink(requestFile); }
