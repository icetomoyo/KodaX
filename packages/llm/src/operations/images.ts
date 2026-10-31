import type { KodaXImageConnection, KodaXImageRequest, KodaXImageResult } from './types.js';
import { object, operationRequest, operationUrl, operationUsage, runOperation } from './request.js';
import { admitOperationImage, imageDataUrl } from './images-data.js';
import { nativeResponse } from '../providers/native-http.js';
import { readCloudSSE } from '../providers/cloud-sse.js';
import { observeProviderAttempt } from '../provider-request-observation.js';

async function parseImages(body: Record<string, unknown>, dialect: KodaXImageConnection['dialect'], signal?: AbortSignal): Promise<KodaXImageResult> {
  let data: unknown[], text: string | undefined;
  if (dialect === 'images') {
    if (!Array.isArray(body.data)) throw new Error('Image generation returned no image data.');
    data = body.data;
  } else {
    if (!Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Image generation requires one completed choice.');
    const choice = object(body.choices[0]);
    if (choice.finish_reason !== 'stop') throw new Error('Image generation did not complete.');
    const message = object(choice.message);
    if (!Array.isArray(message.images)) throw new Error('Image generation returned no image data.');
    text = typeof message.content === 'string' ? message.content : undefined;
    data = message.images.map(value => {
      const item = object(value), image = typeof item.image_url === 'string' ? item.image_url : object(item.image_url).url;
      const match = typeof image === 'string' ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
      if (!match) throw new Error('Generated images require inline bytes; output URLs are not downloaded.');
      return { b64_json: match[2], media_type: match[1] };
    });
  }
  if (!data.length || data.length > 10) throw new Error('Image generation returned an invalid image count.');
  const images = [];
  for (const value of data) {
    const item = object(value);
    if (typeof item.b64_json !== 'string' || (item.media_type !== undefined && typeof item.media_type !== 'string')) throw new Error('Invalid generated image data.');
    images.push(await admitOperationImage({ data: item.b64_json, mediaType: item.media_type as string | undefined }, signal, true));
  }
  const cost = body.usage === undefined ? undefined : object(body.usage).cost;
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new Error('Invalid reported image cost.');
  return { images, ...(text !== undefined ? { text } : {}), usage: operationUsage(body.usage),
    ...(cost !== undefined ? { cost: { amount: cost as number, currency: 'USD' as const, source: 'reported' as const } } : {}) };
}
async function streamImages(response: Response, request: KodaXImageRequest, signal?: AbortSignal): Promise<KodaXImageResult> {
  const data: Record<string, unknown>[] = [];
  let done = false, usage: unknown;
  for await (const raw of readCloudSSE(response, signal, { maxFrameBytes: 24 * 1024 * 1024,
    onDone: () => { if (done) throw new Error('Duplicate image stream terminal.'); done = true; } })) {
    if (done) throw new Error('Image event follows the terminal marker.');
    const event = object(raw);
    if (event.type === 'image_generation.partial_image') {
      if (!Number.isSafeInteger(event.partial_image_index) || (event.partial_image_index as number) < 0 || typeof event.b64_json !== 'string') throw new Error('Invalid image preview event.');
      const image = await admitOperationImage({ data: event.b64_json, mediaType: typeof event.media_type === 'string' ? event.media_type : undefined }, signal, true);
      await request.onPreview?.(image, event.partial_image_index as number);
    } else if (event.type === 'image_generation.completed') {
      if (data.length >= 10) throw new Error('Image stream exceeds the image count limit.');
      data.push(event); usage = event.usage;
    } else throw new Error('Image stream failed or returned an unknown event.');
  }
  if (!done || !data.length) throw new Error('Image stream did not reach a completed terminal.');
  return parseImages({ data, usage }, 'images', signal);
}
export async function generateImages(connection: KodaXImageConnection, request: KodaXImageRequest, signal?: AbortSignal): Promise<KodaXImageResult> {
  const onPreview = request.onPreview;
  connection = { ...connection }; request = { ...structuredClone({ ...request, onPreview: undefined }), onPreview };
  if (connection.api !== 'openrouter-images' || !['images', 'chat-completions'].includes(connection.dialect)) throw new Error('Select an explicit image API dialect.');
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('Image generation requires a prompt.');
  if (request.stream && connection.dialect !== 'images') throw new Error('Image SSE requires the dedicated image API dialect.');
  if (Object.keys(request.parameters ?? {}).some(key => ['model', 'prompt', 'stream', 'messages', 'images', 'input_references', 'modalities'].includes(key))) throw new Error('Image parameters cannot override core request fields.');
  return runOperation(connection, 'utility', signal, async (headers, activeSignal) => {
    const references = [];
    for (const image of request.images ?? []) references.push({ type: 'image_url', image_url: { url: imageDataUrl(await admitOperationImage(image, activeSignal)) } });
    const payload = connection.dialect === 'images' ? { ...request.parameters, model: connection.model, prompt: request.prompt, stream: request.stream ?? false,
      ...(references.length ? { input_references: references } : {}) }
      : { ...request.parameters, model: connection.model, modalities: ['image', 'text'], stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }, ...references] }] };
    if (request.stream) return observeProviderAttempt(connection.name, connection.model, async () => {
      headers.set('accept', 'text/event-stream');
      const response = await nativeResponse(operationUrl(connection, '/images'), { method: 'POST', headers, signal: activeSignal, body: JSON.stringify(payload) });
      return streamImages(response, request, activeSignal);
    }, true);
    return operationRequest(connection, connection.dialect === 'images' ? '/images' : '/chat/completions', headers, activeSignal, payload,
      body => parseImages(body, connection.dialect, activeSignal));
  });
}
