import { createHash } from 'node:crypto';
import { credentialFingerprint } from '../credential-fingerprint.js';
import { requestIdentity } from '../providers/request-extensions.js';
import type { Response as OpenAIResponse, ResponseInputContent } from 'openai/resources/responses/responses';
import type { KodaXAssistantBlock, KodaXGenerationSource, KodaXTokenUsage } from '../types.js';
import { KodaXProviderError } from '../errors.js';
import { getScopedProviderCredential, resolveProviderCredential } from '../provider-credential-context.js';
import { projectResponsesMessages } from '../providers/responses-messages.js';
import { parseResponsesOutput } from '../providers/responses-output.js';
import { prepareImageBlock } from '../providers/image-serialization.js';
import { object, operationRequest, operationUrl, operationUsage, runOperation } from './request.js';
import type { KodaXDeferredConnection, KodaXDeferredReference, KodaXDeferredRequest, KodaXDeferredResult } from './types.js';
import { observeProviderStreamUsage } from '../provider-request-observation.js';
import { responseTools, validateToolCapabilities } from '../providers/tool-constraints.js';

export class KodaXDeferredOutputError extends KodaXProviderError {
  readonly usageKind = 'cumulative' as const;
  readonly usageId: string;
  constructor(provider: string, readonly reference: KodaXDeferredReference, readonly partialUsage: KodaXTokenUsage | undefined, cause: unknown) {
    super('Deferred response contains invalid completed output.', provider, { failureCode: 'response_stream_error', stage: 'response_stream', retryable: false });
    this.name = 'KodaXDeferredOutputError'; this.cause = cause;
    this.usageId = `${reference.scope}:${reference.id}`;
  }
}

function connectionScope(connection: KodaXDeferredConnection): string {
  if (connection.api !== 'openai-background-responses' || typeof connection.accountScope !== 'string' || !connection.accountScope.trim()) throw new Error('Deferred operations require an explicit trusted account scope.');
  validateToolCapabilities(connection.toolCapabilities);
  return createHash('sha256').update(JSON.stringify([connection.name, connection.api, connection.model, operationUrl(connection, ''), connection.accountScope])).digest('hex');
}
function validateReference(connection: KodaXDeferredConnection, reference: KodaXDeferredReference): void {
  if (!reference || reference.version !== 1 || typeof reference.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(reference.id)
    || reference.scope !== connectionScope(connection)) throw new Error('Deferred reference does not match the authorized connection/account.');
  validateCustomProperties(reference.customToolProperties);
}
function validateCustomProperties(value: unknown): void {
  if (value !== undefined) {
    const fields = object(value);
    if (Object.keys(fields).length > 128 || Object.entries(fields).some(([name, field]) => !name.trim() || name.length > 256
      || typeof field !== 'string' || !field.trim() || field.length > 256)) throw new Error('Invalid deferred tool conversion data.');
  }
}
function source(connection: KodaXDeferredConnection): KodaXGenerationSource {
  const key = getScopedProviderCredential(connection.name) ?? resolveProviderCredential(connection.name,
    connection.credentialSource === 'broker' ? undefined : connection.apiKeyEnv ? process.env[connection.apiKeyEnv] : undefined);
  return { provider: connection.name, api: 'openai-responses', model: connection.model, baseUrl: connection.baseUrl,
    credentialScope: credentialFingerprint(key, requestIdentity()) };
}
function decode(connection: KodaXDeferredConnection, body: Record<string, unknown>, reference?: KodaXDeferredReference,
  customProperties: ReadonlyMap<string, string> = new Map()): KodaXDeferredResult {
  if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.id) || (reference && body.id !== reference.id)) throw new Error('Invalid deferred response identity.');
  const ref: KodaXDeferredReference = reference ?? { version: 1, id: body.id, scope: connectionScope(connection),
    ...(customProperties.size ? { customToolProperties: Object.fromEntries(customProperties) } : {}) };
  if (body.status === 'queued' || body.status === 'in_progress') return { status: body.status, reference: ref };
  if (body.status === 'failed' || body.status === 'cancelled' || body.status === 'incomplete') {
    const reason = body.status === 'incomplete' && body.incomplete_details ? object(body.incomplete_details).reason : undefined;
    return { status: body.status, reference: ref, usageKind: 'cumulative', usageId: `${ref.scope}:${ref.id}`,
      partialUsage: operationUsage(body.usage), ...(reason === 'max_output_tokens' || reason === 'content_filter' ? { reason } : {}) };
  }
  if (body.status !== 'completed' || body.error) throw new Error('Invalid deferred response terminal.');
  const usage = operationUsage(body.usage);
  let contentBlocks: KodaXAssistantBlock[];
  try { contentBlocks = parseResponsesOutput(body as unknown as OpenAIResponse, source(connection), undefined, new Map(Object.entries(ref.customToolProperties ?? {}))); }
  catch (error) { throw new KodaXDeferredOutputError(connection.name, ref, usage, error); }
  const toolBlocks = contentBlocks.filter(b => b.type === 'tool_use');
  return { status: 'completed', reference: ref, usageKind: 'cumulative', usageId: `${ref.scope}:${ref.id}`,
    result: { contentBlocks, textBlocks: contentBlocks.filter(b => b.type === 'text'),
      thinkingBlocks: contentBlocks.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking'), toolBlocks,
      stopReason: toolBlocks.length ? 'tool_use' : 'end_turn', usage } };
}
async function deferredInput(request: KodaXDeferredRequest, generationSource: KodaXGenerationSource) {
  const images = new Map<object, ResponseInputContent[]>();
  for (const message of request.messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      const candidates = block.type === 'image' ? [block] : block.type === 'tool_result' && typeof block.content !== 'string'
        ? block.content.filter(item => item.type === 'image') : [];
      for (const image of candidates) {
        const prepared = await prepareImageBlock(image);
        images.set(image, 'placeholder' in prepared ? [{ type: 'input_text', text: prepared.placeholder }]
          : [{ type: 'input_image', image_url: `data:${prepared.mediaType};base64,${prepared.data}`, detail: 'auto' }]);
      }
    }
  }
  return projectResponsesMessages(request.messages, generationSource, image => images.get(image)!);
}
export async function submitDeferred(connection: KodaXDeferredConnection, request: KodaXDeferredRequest, signal?: AbortSignal): Promise<KodaXDeferredResult> {
  connection = structuredClone(connection); request = structuredClone(request); connectionScope(connection);
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) throw new Error('Deferred requests require an explicit positive output budget.');
  return runOperation(connection, 'utility', signal, async (headers, activeSignal) => {
    const input = await deferredInput(request, source(connection));
    const tools = responseTools(request.tools, connection.toolCapabilities ?? {}, connection.name);
    validateCustomProperties(Object.fromEntries(tools.customProperties));
    const body = { model: connection.model, input, instructions: request.system, background: true, store: request.store ?? false,
      stream: false, include: ['reasoning.encrypted_content'], max_output_tokens: request.maxOutputTokens,
      ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
      ...(request.tools.length ? { tools: tools.tools } : {}) };
    const submitted = await operationRequest(connection, '/responses', headers, activeSignal, body, value => {
      if (['completed', 'failed', 'cancelled', 'incomplete'].includes(value.status as string)) observeProviderStreamUsage(operationUsage(value.usage));
      const result = decode(connection, value, undefined, tools.customProperties);
      return { value: result, ...(result.status === 'completed' ? { usage: result.result.usage } : {}) };
    });
    return submitted.value;
  });
}
async function act(connection: KodaXDeferredConnection, reference: KodaXDeferredReference, cancel: boolean, signal?: AbortSignal): Promise<KodaXDeferredResult> {
  connection = structuredClone(connection); reference = structuredClone(reference); validateReference(connection, reference);
  reference = { version: 1, id: reference.id, scope: reference.scope,
    ...(reference.customToolProperties ? { customToolProperties: reference.customToolProperties } : {}) };
  return runOperation(connection, 'utility', signal, (headers, activeSignal) => operationRequest(connection,
    `/responses/${encodeURIComponent(reference.id)}${cancel ? '/cancel' : ''}`, headers, activeSignal, undefined,
    body => decode(connection, body, reference), cancel ? 'POST' : 'GET'));
}
export function fetchDeferred(connection: KodaXDeferredConnection, reference: KodaXDeferredReference, signal?: AbortSignal): Promise<KodaXDeferredResult> { return act(connection, reference, false, signal); }
export function cancelDeferred(connection: KodaXDeferredConnection, reference: KodaXDeferredReference, signal?: AbortSignal): Promise<KodaXDeferredResult> { return act(connection, reference, true, signal); }
