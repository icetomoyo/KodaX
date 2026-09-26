import type { ClientItemContent } from './client-contract.js';

/** Shared by Ink, classic, and ACP. A captured range may grow, but never shrink or change identity. */
export async function readClientItemRange(
  read: (offset: number) => Promise<ClientItemContent | null>,
  id: string,
  captured?: { readonly length?: number; readonly offset?: number; readonly signal?: AbortSignal;
    readonly version?: Pick<ClientItemContent, 'textRevision' | 'outputState'> },
): Promise<string> {
  const parts: string[] = [];
  let offset = captured?.offset ?? 0;
  let length = captured?.length;
  for (;;) {
    captured?.signal?.throwIfAborted();
    if (length !== undefined && offset >= length) return parts.join('');
    const page = await read(offset);
    captured?.signal?.throwIfAborted();
    if (!page) throw new Error('Full transcript content is unavailable: item disappeared; reopen history.');
    length ??= page.totalLength;
    if (captured?.version && ((page.textRevision ?? 0) !== (captured.version.textRevision ?? 0)
      || page.outputState !== captured.version.outputState)) {
      throw new Error('Transcript content changed during the read; try again.');
    }
    const end = offset + page.text.length;
    if (page.id !== id || page.offset !== offset || !Number.isSafeInteger(page.totalLength)
      || page.totalLength < length || (captured?.length === undefined && page.totalLength !== length)
      || end > page.totalLength
      || (page.nextOffset === undefined ? end !== page.totalLength : page.nextOffset !== end || end <= offset || end >= page.totalLength)) {
      throw new Error('Transcript content changed or returned an inconsistent page; reopen history.');
    }
    parts.push(page.text.slice(0, length - offset));
    offset = end;
  }
}
