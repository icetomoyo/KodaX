import type { KodaXProductClient, ClientViewItem } from '@kodax-ai/kodax/client';
import type { ArtifactExecutionPort, ArtifactOperation, ArtifactRequest, ArtifactResults } from './types.js';
import { artifactToolName, decodeArtifactRequest, decodeArtifactResult, decodeArtifactWireResult, record } from './contract.js';
import { encodeBase64, verifyImageData } from './image-data.js';
import { sameJson } from './identity.js';

/** Uses the connected Host's explicit tool Run. No local execution or automatic replay. */
export function createKodaXArtifactPort(client: Pick<KodaXProductClient, 'runs' | 'sessions'>, sessionId: string): ArtifactExecutionPort {
 return { execute: async <O extends ArtifactOperation>(raw: ArtifactRequest<O>, signal?: AbortSignal): Promise<ArtifactResults[O]> => {
  const request = decodeArtifactRequest(raw); signal?.throwIfAborted();
  const name = artifactToolName(request.operation);
  const started = await client.runs.startTool({ sessionId, inputId: crypto.randomUUID(), name,
   input: { ...request.input }, rawInput: JSON.stringify(request.input) });
  let stop: Promise<{ receipt: Awaited<ReturnType<typeof client.runs.stop>> } | { error: unknown }> | undefined;
  let operationError: unknown;
  const cancel = () => { stop ??= client.runs.stop(started.runId).then(receipt => ({ receipt }), error => ({ error })); };
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  try {
   const terminal = await client.runs.await(started.runId);
   if (terminal.runId !== started.runId || terminal.sessionId !== sessionId || terminal.phase !== 'completed' || !terminal.result?.success) throw new Error('Artifact Host Run did not complete: ' + terminal.phase + ': ' + (terminal.error ?? terminal.result?.lastText ?? '').slice(0, 2000));
   signal?.throwIfAborted();
   const messages = terminal.result.messages, callMessage = messages.at(-2), resultMessage = messages.at(-1);
   const call = Array.isArray(callMessage?.content) ? callMessage.content.find(block => block.type === 'tool_use' && block.name === name && sameJson(block.input, request.input)) : undefined;
   if (call?.type !== 'tool_use' || !Array.isArray(resultMessage?.content)) throw new Error('Artifact Host invocation identity is missing.');
   const block = resultMessage.content.find(block => block.type === 'tool_result' && block.tool_use_id === call.id);
   if (block?.type !== 'tool_result' || block.is_error) throw new Error('Artifact Host tool result is unavailable.');
   const first = typeof block.content === 'string' ? block.content : block.content.find(item => item.type === 'text')?.text;
   if (!first || first.length > 2 * 1024 * 1024) throw new Error('Artifact metadata is missing or exceeds its bound.');
   const payload = record(JSON.parse(first));
   if (payload.protocol !== 'kodax-artifact/1' || payload.operation !== request.operation) throw new Error('Artifact tool payload does not match the invocation.');
   const result = decodeArtifactWireResult(request, payload);
   if (!result.imageRef) return decodeArtifactResult(raw.operation, result);
   let items: readonly ClientViewItem[] = [];
   const observation = await client.sessions.observe(sessionId, view => { items = view.items; });
   try {
    const item = items.find(item => item.tool?.callId === call.id && item.tool.name === name && (!item.sourceRunId || item.sourceRunId === started.runId));
    const attachmentIndex = item?.attachments?.findIndex(image => image.path === result.imageRef!.path);
    if (!item || attachmentIndex === undefined || attachmentIndex < 0) throw new Error('Artifact PNG is not attached to its Host invocation.');
    let offset = 0, bytes: Uint8Array | undefined;
    do {
     signal?.throwIfAborted();
     const chunk = (await client.sessions.readItem(sessionId, item.id, { part: 'attachment', attachmentIndex, attachmentOffset: offset, expectedImageSha256: result.imageRef.sha256 }))?.image;
     if (!chunk || chunk.sha256 !== result.imageRef.sha256 || chunk.width !== result.imageRef.width || chunk.height !== result.imageRef.height || chunk.mediaType !== 'image/png' || chunk.offset !== offset || !Number.isSafeInteger(chunk.totalLength) || chunk.totalLength < 33 || chunk.totalLength > 10 * 1024 * 1024) throw new Error('Artifact attachment metadata is missing or inconsistent.');
     bytes ??= new Uint8Array(chunk.totalLength);
     const data = Uint8Array.from(atob(chunk.dataBase64), c => c.charCodeAt(0));
     if (!data.length || bytes.length !== chunk.totalLength || offset + data.length > bytes.length || (chunk.nextOffset !== undefined && chunk.nextOffset !== offset + data.length)) throw new Error('Artifact attachment chunk is inconsistent.');
     bytes.set(data, offset); offset += data.length;
     if (chunk.nextOffset === undefined && offset !== bytes.length) throw new Error('Artifact attachment ended early.');
    } while (offset < bytes!.length);
    const image = { mediaType: 'image/png' as const, sha256: result.imageRef.sha256, width: result.imageRef.width, height: result.imageRef.height, dataBase64: encodeBase64(bytes!) };
    await verifyImageData(image); signal?.throwIfAborted(); return decodeArtifactResult(raw.operation, { status: result.status, diagnostics: result.diagnostics, image });
   } finally { observation.close(); }
  } catch (error) { operationError = error; throw error; }
  finally {
   signal?.removeEventListener('abort', cancel);
   if (stop) { const outcome = await stop; if ('error' in outcome) {
    if (operationError !== undefined) throw new AggregateError([operationError, outcome.error], 'Artifact operation and Stop settlement failed.');
    throw outcome.error;
   } }
  }
 } };
}
