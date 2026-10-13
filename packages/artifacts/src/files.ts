import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export async function artifactPath(root: string, requested: string, output = false): Promise<string> {
 if (!requested || requested.includes('\0')) throw new Error('Invalid artifact path.');
 const base = await fs.realpath(root);
 const resolved = path.resolve(base, requested);
 const relative = path.relative(base, resolved);
 if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Artifact path must remain inside its workspace.');
 if (output && relative.split(path.sep).some(part => ['.git', '.kodax'].includes(part.toLowerCase()))) throw new Error('Protected output namespace.');
 let parent = path.dirname(resolved);
 if (output) {
   const ancestors: string[] = [];
   while (parent !== base) { ancestors.push(parent); parent = path.dirname(parent); }
   for (const ancestor of ancestors.reverse()) {
     try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Artifact output cannot traverse a symlink.'); }
     catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(ancestor); }
   }
 } else {
   const actual = await fs.realpath(resolved);
   const scope = path.relative(base, actual);
   if (scope === '..' || scope.startsWith('..' + path.sep) || path.isAbsolute(scope)) throw new Error('Artifact input escapes workspace.');
 }
 return resolved;
}
export async function readPresentation(root: string, requested: string, expected?: string) {
 const file = await artifactPath(root, requested);
 const bytes = await fs.readFile(file);
 if (bytes.length > 32 * 1024 * 1024) throw new Error('Artifact input exceeds 32 MiB.');
 const sourceHash = hashBytes(bytes);
 if (expected !== undefined && expected !== sourceHash) throw new Error('Stale artifact source hash.');
 return { path: file, bytes, sourceHash };
}
export async function writePresentation(root: string, requested: string, bytes: Uint8Array): Promise<string> {
 if (path.extname(requested).toLowerCase() !== '.pptx') throw new Error('Output must be a new PPTX file.');
 const file = await artifactPath(root, requested, true);
 const handle = await fs.open(file, 'wx');
 try { await handle.writeFile(bytes); await handle.sync(); }
 finally { await handle.close(); }
 return file;
}
export function checkZipLimits(bytes: Buffer): void {
 const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
 const end = bytes.lastIndexOf(signature);
 if (end < 0 || end + 22 > bytes.length || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw new Error('Invalid PPTX ZIP.');
 if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) throw new Error('Unsupported split ZIP.');
 const entries = bytes.readUInt16LE(end + 10);
 if (entries === 0xffff || entries > 4000) throw new Error('PPTX ZIP entry limit exceeded.');
 let offset = bytes.readUInt32LE(end + 16), total = 0;
 const directoryEnd = offset + bytes.readUInt32LE(end + 12), names = new Set<string>();
 const directoryStart = offset;
 if (directoryEnd !== end) throw new Error('Invalid ZIP directory bounds.');
 for (let i = 0; i < entries; i++) {
   if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
   const size = bytes.readUInt32LE(offset + 24);
   if (bytes.readUInt16LE(offset + 8) & 1) throw new Error('Encrypted PPTX is unsupported.');
   total += size;
   if (size > 32 * 1024 * 1024 || total > 192 * 1024 * 1024) throw new Error('PPTX ZIP uncompressed limit exceeded.');
   const nameLength = bytes.readUInt16LE(offset + 28);
   const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
   if (next > directoryEnd) throw new Error('Invalid ZIP entry bounds.');
   const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
   if (names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('Unsafe or duplicate ZIP entry.');
   const local = bytes.readUInt32LE(offset + 42), compressedSize = bytes.readUInt32LE(offset + 20);
   if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local entry.');
   const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
   if (dataStart + compressedSize > directoryStart) throw new Error('Invalid ZIP data bounds.');
   const compressed = bytes.subarray(dataStart, dataStart + compressedSize), method = bytes.readUInt16LE(offset + 10);
   const expanded = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.min(32 * 1024 * 1024, 192 * 1024 * 1024 - (total - size)) })
    : method === 0 ? compressed : undefined;
   if (!expanded || expanded.length !== size) throw new Error('ZIP actual size differs from declared size.');
   names.add(name); offset = next;
 }
 if (offset !== directoryEnd) throw new Error('Invalid ZIP directory length.');
}
