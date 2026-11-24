import type { ArtifactExecutionPort, ArtifactOperation, ArtifactRequest, ArtifactResults } from './types.js';
import { artifactToolName, decodeArtifactRequest, decodeArtifactResult, decodeArtifactWireResult, record } from './contract.js';
import { encodeBase64, verifyImageData } from './image-data.js';

const MAX_PAYLOAD = 2 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;

export interface ArtifactHostRun {
  readonly id: string;
  readonly sessionId: string;
  readonly outcome?: { readonly status: string; readonly code: string; readonly message?: string };
}

/** The part of a Session view item the port reads. */
export interface ArtifactHostItem {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly textTotal?: number;
  readonly runId?: string;
  readonly tool?: { readonly name: string; readonly status: string; readonly outputSaved?: boolean };
  readonly attachments?: readonly { readonly kind: string; readonly blobId: string; readonly mediaType?: string; readonly sha256?: string }[];
}

/** What the port uses of a protocol v2 Host client. `KodaXHostClient` from `@kodax-ai/kodax/client` is one. */
export interface ArtifactHostClient {
  call(method: 'run.startTool', params: { requestId: string; sessionId: string; tool: string; input: Record<string, unknown>; text: string }): Promise<{ readonly run: ArtifactHostRun }>;
  call(method: 'run.wait', params: { runId: string; timeoutMs?: number }): Promise<{ readonly run: ArtifactHostRun }>;
  call(method: 'run.stop', params: { requestId: string; runId: string }): Promise<unknown>;
  call(method: 'item.read', params: { sessionId: string; itemId: string; part: 'text' | 'output'; cursor?: string }): Promise<{ readonly text: string; readonly total: number; readonly nextCursor?: string }>;
  call(method: 'blob.read', params: { sessionId: string; blobId: string; cursor?: string }): Promise<{ readonly data: string; readonly mediaType: string; readonly byteLength: number; readonly sha256: string; readonly nextCursor?: string }>;
  observeSession(sessionId: string, observer: { onView(view: { readonly items: readonly ArtifactHostItem[] }): void }): Promise<{ close(): void }>;
}

/**
 * Runs artifact operations as named tool Runs on a protocol v2 Host. An image
 * is read by the blob its tool item names and must hash to the reference the
 * tool returned. Nothing is run again: a Run that did not complete is an error.
 */
export function createKodaXArtifactHostPort(client: ArtifactHostClient, sessionId: string): ArtifactExecutionPort {
  return {
    execute: async <O extends ArtifactOperation>(raw: ArtifactRequest<O>, signal?: AbortSignal): Promise<ArtifactResults[O]> => {
      const request = decodeArtifactRequest(raw);
      signal?.throwIfAborted();
      const tool = artifactToolName(request.operation);
      const { run } = await client.call('run.startTool', {
        requestId: crypto.randomUUID(), sessionId, tool, input: { ...request.input }, text: JSON.stringify(request.input),
      });
      const result = await untilSettled(client, run.id, signal, async () => {
        const item = await toolItem(client, sessionId, run.id, tool);
        const payload = record(JSON.parse(await toolOutput(client, sessionId, item)));
        if (payload.protocol !== 'kodax-artifact/1' || payload.operation !== request.operation) throw new Error('Artifact tool payload does not match the invocation.');
        const wire = decodeArtifactWireResult(request, payload);
        if (!wire.imageRef) return decodeArtifactResult(raw.operation, wire);
        const dataBase64 = await readImage(client, sessionId, item, wire.imageRef.sha256, signal);
        const image = { mediaType: 'image/png' as const, sha256: wire.imageRef.sha256, width: wire.imageRef.width, height: wire.imageRef.height, dataBase64 };
        await verifyImageData(image);
        return decodeArtifactResult(raw.operation, { status: wire.status, diagnostics: wire.diagnostics, image });
      });
      signal?.throwIfAborted();
      return result;
    },
  };
}

/** Waits for the Run's outcome, asking it to stop once if the caller gives up, then reads what it left. */
async function untilSettled<T>(client: ArtifactHostClient, runId: string, signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  let stop: Promise<{ error?: unknown }> | undefined;
  const cancel = () => { stop ??= client.call('run.stop', { requestId: crypto.randomUUID(), runId }).then(() => ({}), (error: unknown) => ({ error })); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let failure: unknown;
  try {
    let current: ArtifactHostRun;
    do current = (await client.call('run.wait', { runId, timeoutMs: 60_000 })).run;
    while (current.outcome === undefined);
    const { status, code, message } = current.outcome;
    if (current.id !== runId || status !== 'completed') throw new Error(`Artifact Host Run did not complete: ${status}: ${code}${message ? ': ' + message.slice(0, 2000) : ''}`);
    return await read();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    const stopped = await stop;
    if (stopped && 'error' in stopped) {
      if (failure !== undefined) throw new AggregateError([failure, stopped.error], 'Artifact operation and Stop settlement failed.');
      throw stopped.error;
    }
  }
}

/** The one tool item of the Run. A Run started for one named tool has exactly one. */
async function toolItem(client: ArtifactHostClient, sessionId: string, runId: string, tool: string): Promise<ArtifactHostItem> {
  let items: readonly ArtifactHostItem[] = [];
  const observation = await client.observeSession(sessionId, { onView: view => { items = view.items; } });
  observation.close();
  const matches = items.filter(item => item.runId === runId && item.tool?.name === tool);
  if (matches.length !== 1 || matches[0]!.tool!.status !== 'success') throw new Error('Artifact Host tool result is unavailable.');
  return matches[0]!;
}

/**
 * The tool's metadata: its first text block, which is one line of JSON. The
 * item's text joins every text block of the output, one per line.
 */
async function toolOutput(client: ArtifactHostClient, sessionId: string, item: ArtifactHostItem): Promise<string> {
  if (!item.tool?.outputSaved && item.textTotal === undefined) return firstLine(item.text);
  const part = item.tool?.outputSaved ? 'output' : 'text';
  let text = '', cursor: string | undefined;
  do {
    const page = await client.call('item.read', { sessionId, itemId: item.id, part, ...(cursor ? { cursor } : {}) });
    text += page.text;
    cursor = page.nextCursor;
  } while (cursor !== undefined && !text.includes('\n') && text.length <= MAX_PAYLOAD);
  return firstLine(text);
}

function firstLine(text: string): string {
  const end = text.indexOf('\n');
  const line = end < 0 ? text : text.slice(0, end);
  if (!line || line.length > MAX_PAYLOAD) throw new Error('Artifact metadata is missing or exceeds its bound.');
  return line;
}

/** The item's one image, read by its blob and checked against the hash the tool reported. */
async function readImage(client: ArtifactHostClient, sessionId: string, item: ArtifactHostItem, sha256: string, signal: AbortSignal | undefined): Promise<string> {
  const images = (item.attachments ?? []).filter(attachment => attachment.kind === 'image');
  if (images.length !== 1 || (images[0]!.sha256 !== undefined && images[0]!.sha256 !== sha256)) throw new Error('Artifact Host invocation must deliver exactly one PNG.');
  const { blobId } = images[0]!;
  let bytes: Uint8Array | undefined, offset = 0, cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const chunk = await client.call('blob.read', { sessionId, blobId, ...(cursor ? { cursor } : {}) });
    if (chunk.sha256 !== sha256 || chunk.mediaType !== 'image/png' || !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 33 || chunk.byteLength > MAX_IMAGE || (bytes && bytes.length !== chunk.byteLength)) {
      throw new Error('Artifact attachment metadata is missing or inconsistent.');
    }
    bytes ??= new Uint8Array(chunk.byteLength);
    const data = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
    if (!data.length || offset + data.length > bytes.length) throw new Error('Artifact attachment chunk is inconsistent.');
    bytes.set(data, offset);
    offset += data.length;
    cursor = chunk.nextCursor;
  } while (cursor !== undefined);
  if (offset !== bytes.length) throw new Error('Artifact attachment ended early.');
  return encodeBase64(bytes);
}
