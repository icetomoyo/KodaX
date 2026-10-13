import path from 'node:path';
import JSZip from 'jszip';
import type { ArtifactRef } from './types.js';
import { checkZipLimits } from './files.js';

export async function detectFormat(bytes: Buffer, file: string): Promise<ArtifactRef['format']> {
 if (bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
 if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
 if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
 if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
 if (bytes.subarray(0, 2).toString() === 'PK') { checkZipLimits(bytes); const zip = await JSZip.loadAsync(bytes);
  if (zip.file('ppt/presentation.xml')) return 'pptx'; if (zip.file('word/document.xml')) return 'docx';
  throw new Error('Unsupported ZIP document format.'); }
 const head = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
 if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(head)) return 'svg';
 if (/^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)/i.test(head) && ['.html', '.htm'].includes(path.extname(file).toLowerCase())) return 'html';
 throw new Error('Unsupported artifact content (legacy DOC/OLE, encrypted Office, GIF/video and unknown formats require their owning backend).');
}
