import type { EvidenceImage } from './types.js';

export function encodeBase64(bytes: Uint8Array): string {
 const parts: string[] = [];
 for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
 return btoa(parts.join(''));
}
export async function verifyImageData(image: EvidenceImage): Promise<void> {
 const bytes = Uint8Array.from(atob(image.dataBase64), c => c.charCodeAt(0));
 if (bytes.length > 10 * 1024 * 1024 || bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) throw new Error('Evidence payload must be a bounded PNG.');
 const header = new DataView(bytes.buffer);
 if (header.getUint32(16) !== image.width || header.getUint32(20) !== image.height || image.width * image.height > 40_000_000) throw new Error('Evidence payload geometry differs from the reference.');
 const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
 if (sha !== image.sha256) throw new Error('Evidence payload hash differs from the reference.');
}
