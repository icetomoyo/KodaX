import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ClientImageAttachmentContent, ClientItemReadOptions, ClientViewItem } from '@kodax-ai/coding/client-contract';

export async function readItemImage(item: ClientViewItem, options: ClientItemReadOptions): Promise<ClientImageAttachmentContent> {
  const index = options.attachmentIndex, offset = options.attachmentOffset ?? 0;
  if (!Number.isSafeInteger(index) || index === undefined || index < 0) throw new Error('Invalid attachment index.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid attachment offset.');
  if (options.expectedImageSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedImageSha256)) throw new Error('Invalid image hash.');
  const attachment = item.attachments?.[index];
  if (!attachment) throw new Error('Image attachment is unavailable.');
  const file = await open(attachment.path, 'r');
  let bytes: Buffer;
  try {
    if ((await file.stat()).size > 10 * 1024 * 1024) throw new Error('Image attachment exceeds 10 MiB.');
    bytes = await file.readFile();
  } finally { await file.close(); }
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Image attachment exceeds 10 MiB.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (options.expectedImageSha256 !== undefined && options.expectedImageSha256 !== sha256) throw new Error('Image attachment hash changed.');
  const { validateImageBytesInRun } = await import('@kodax-ai/llm');
  const validation = await validateImageBytesInRun(bytes);
  if (validation.status !== 'valid' || validation.mediaType !== 'image/png') throw new Error('Attachment must be a decodable PNG image.');
  if (offset > bytes.length) throw new Error('Attachment offset exceeds image length.');
  const chunk = bytes.subarray(offset, offset + 512 * 1024), nextOffset = offset + chunk.length;
  return { mediaType: 'image/png', sha256, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
    dataBase64: chunk.toString('base64'), offset, totalLength: bytes.length,
    ...(nextOffset < bytes.length ? { nextOffset } : {}) };
}
