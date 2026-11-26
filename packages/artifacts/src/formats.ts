import path from 'node:path';
import JSZip from 'jszip';
import type { ArtifactRef } from './types.js';
import { checkZipLimits } from './files.js';

export type VideoFormat = 'mp4' | 'mov' | 'webm';
export type AnimatedFormat = 'gif' | 'webp';
export const isVideoFormat = (format: ArtifactRef['format']): format is VideoFormat => format === 'mp4' || format === 'mov' || format === 'webm';
// Major brands of MP4/MOV video. Other ISO BMFF files (AVIF, HEIC, M4A, 3GP) stay unsupported instead of reaching ffmpeg.
const videoBrands = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'dash', 'qt  ']);
/** ISO BMFF `ftyp` video brand or Matroska DocType `webm`; only these are handed to ffmpeg. */
export function detectVideo(head: Buffer): VideoFormat | undefined {
 if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
  const brand = head.subarray(8, 12).toString('latin1');
  return brand === 'qt  ' ? 'mov' : videoBrands.has(brand) ? 'mp4' : undefined;
 }
 if (head.readUInt32BE(0) === 0x1a45dfa3) {
  const docType = head.indexOf(Buffer.from([0x42, 0x82]));
  if (docType > 0 && docType < 64 && head.subarray(docType + 3, docType + 7).toString('latin1') === 'webm') return 'webm';
 }
 return undefined;
}
export const isAnimatedWebp = (bytes: Buffer): boolean => bytes.subarray(12, 16).toString('latin1') === 'VP8X' && (bytes[20]! & 0x02) !== 0;
/** `complete` is false when only the header of a large file was read; only video may be that large. */
export async function detectFormat(bytes: Buffer, file: string, complete = true): Promise<ArtifactRef['format']> {
 const video = bytes.length >= 12 ? detectVideo(bytes) : undefined;
 if (video) return video;
 if (!complete) throw new Error('Artifact input exceeds 32 MiB; only MP4, MOV and WebM video may be larger, up to 1 GiB.');
 if (bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
 if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
 if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
 if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
 if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
 if (bytes.subarray(0, 2).toString() === 'PK') { checkZipLimits(bytes); const zip = await JSZip.loadAsync(bytes);
  if (zip.file('ppt/presentation.xml')) return 'pptx'; if (zip.file('word/document.xml')) return 'docx';
  throw new Error('Unsupported ZIP document format.'); }
 const head = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
 if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(head)) return 'svg';
 if (/^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)/i.test(head) && ['.html', '.htm'].includes(path.extname(file).toLowerCase())) return 'html';
 throw new Error('Unsupported artifact content (legacy DOC/OLE, encrypted Office, video other than MP4/MOV/WebM and unknown formats require their owning backend).');
}
