import { PNG } from 'pngjs';

export function inspectPng(bytes: Buffer): { width: number; height: number } {
 if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG image.');
 const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
 if (!width || !height || width > 8192 || height > 8192 || width * height > 40_000_000 || bytes.length > 10 * 1024 * 1024) throw new Error('PNG processing limit exceeded.');
 const image = PNG.sync.read(bytes, { checkCRC: true });
 if (image.width !== width || image.height !== height) throw new Error('PNG geometry differs from its header.');
 return { width, height };
}
