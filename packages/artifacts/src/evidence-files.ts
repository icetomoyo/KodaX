import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactInputs, EvidenceImage, RasterEvidence, VisualSource } from './types.js';
import { artifactPath, hashBytes, readPresentation } from './files.js';
import { inspectPng } from './pixels.js';
import { record, validateRaster, validateSource } from './contract.js';
import { sameJson, sameSource } from './identity.js';

/** Ordinary per-image provenance beside the output, owned by the caller like the PNG. */
export async function saveEvidence(directory: string, name: string, bytes: Buffer, source: VisualSource,
 locator: RasterEvidence['locator']): Promise<RasterEvidence> {
 const dimensions = inspectPng(bytes), file = path.join(directory, name + '.png');
 const raster: RasterEvidence = { path: file, sha256: hashBytes(bytes), mediaType: 'image/png', ...dimensions, locator };
 await fs.writeFile(file, bytes, { flag: 'wx' });
 await fs.writeFile(file + '.evidence.json', JSON.stringify({ source, raster }), { flag: 'wx' });
 return raster;
}
export async function assertCurrentSource(root: string, source: VisualSource): Promise<void> {
 if (source.kind === 'surface') return; // Only the observed capture, never a claim about the live revision now.
 await readPresentation(root, source.file.path, source.file.sourceHash);
 for (const dependency of source.dependencies ?? []) await readPresentation(root, dependency.path, dependency.sha256);
}
export async function readEvidenceFile(root: string, input: ArtifactInputs['readEvidence'], signal?: AbortSignal): Promise<EvidenceImage> {
 signal?.throwIfAborted();
 const file = await artifactPath(root, input.raster.path);
 const provenanceFile = await artifactPath(root, file + '.evidence.json');
 const provenanceBytes = await fs.readFile(provenanceFile); if (provenanceBytes.length > 1024 * 1024) throw new Error('Evidence provenance exceeds limit.');
 const provenance = record(JSON.parse(provenanceBytes.toString())); validateSource(provenance.source); validateRaster(provenance.raster);
 if (!sameSource(provenance.source, input.source) || !sameJson(provenance.raster, input.raster)) throw new Error('Evidence provenance differs from the requested source/raster.');
 await assertCurrentSource(root, input.source);
 const handle = await fs.open(file, 'r'); let bytes: Buffer;
 try { if ((await handle.stat()).size > 10 * 1024 * 1024) throw new Error('Evidence image exceeds limit.'); bytes = await handle.readFile(); }
 finally { await handle.close(); }
 if (hashBytes(bytes) !== input.raster.sha256) throw new Error('Evidence PNG hash changed.');
 const dimensions = inspectPng(bytes);
 if (dimensions.width !== input.raster.width || dimensions.height !== input.raster.height) throw new Error('Evidence PNG geometry changed.');
 await assertCurrentSource(root, input.source); signal?.throwIfAborted();
 return { mediaType: 'image/png', dataBase64: bytes.toString('base64'), sha256: input.raster.sha256, ...dimensions };
}
