import { createReadStream } from 'node:fs';
import type { ClientItemContent } from '@kodax-ai/coding/client-contract';

/** Read a saved original on the Host with the same UTF-16 offsets as SDK item reads. */
export async function readSavedToolOutput(path: string, id: string, offset = 0): Promise<ClientItemContent> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Item offset must be a non-negative integer.');
  const end = offset + 65_536;
  let text = '';
  let totalLength = 0;
  try {
    for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
      const content = String(chunk);
      if (totalLength < end && totalLength + content.length > offset) {
        text += content.slice(Math.max(0, offset - totalLength), end - totalLength);
      }
      totalLength += content.length;
    }
  } catch (cause: unknown) {
    const code = cause instanceof Error && 'code' in cause && cause.code === 'ENOENT' ? 'not_found' : 'internal_error';
    throw Object.assign(new Error('Saved tool output is unavailable.', { cause }), { code });
  }
  const nextOffset = offset + text.length;
  return { id, text, offset, totalLength, ...(nextOffset < totalLength ? { nextOffset } : {}) };
}
