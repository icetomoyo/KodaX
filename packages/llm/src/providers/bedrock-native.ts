import type { BedrockRuntimeClient as BedrockClient, ContentBlock, ConverseCommandInput, ConverseStreamOutput, TokenUsage } from '@aws-sdk/client-bedrock-runtime';
import type { KodaXAssistantBlock, KodaXStreamResult, KodaXTokenUsage } from '../types.js';
import { observeProviderStreamUsage } from '../provider-request-observation.js';
import { KodaXNativeCloudProvider, type NativeCloudRequest } from './native-cloud.js';
import { requireCloudCredential } from './cloud-auth.js';
import { bedrockDocument, projectBedrockMessages } from './bedrock-messages.js';
import { bedrockHttpHandler } from './bedrock-http.js';

function usageFrom(usage?: TokenUsage): KodaXTokenUsage | undefined {
  return usage ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: usage.totalTokens ?? 0,
    cachedReadTokens: usage.cacheReadInputTokens, cachedWriteTokens: usage.cacheWriteInputTokens } : undefined;
}
type StreamBlock = { stopped: boolean } & (
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: string }
  | { kind: 'reasoning'; text: string; signature: string; redacted: Uint8Array[] }
);
type RequestSigner = Awaited<ReturnType<BedrockClient['config']['signer']>>;
export class KodaXBedrockProvider extends KodaXNativeCloudProvider {
  protected async invoke(request: NativeCloudRequest): Promise<KodaXStreamResult> {
    if (this.cloud.service !== 'bedrock') throw this.protocolError('Bedrock requires a region.');
    const credential = requireCloudCredential(this.name);
    if (credential.type === 'api-key') throw this.protocolError('Bedrock requires AWS credentials or a Bedrock bearer token.');
    const [{ BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }, { SignatureV4, clearCredentialCache }] = await Promise.all([
      import('@aws-sdk/client-bedrock-runtime'), import('@smithy/signature-v4'),
    ]);
    const aws = credential.type === 'aws';
    const deny = async (): Promise<never> => { throw new Error('Ambient cloud credentials are not authorized.'); };
    const region = this.cloud.region;
    const iam = credential.type === 'aws' ? { accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey, sessionToken: credential.sessionToken } : undefined;
    const client: BedrockClient = new BedrockRuntimeClient({ region, endpoint: this.config.baseUrl, maxAttempts: 1,
      useFipsEndpoint: false, useDualstackEndpoint: false,
      credentials: iam ?? deny,
      // Use the same module instance we clear below, regardless of transitive SDK versions.
      signer: iam ? async (): Promise<RequestSigner> => {
        const signer = new SignatureV4({ credentials: iam, region, service: 'bedrock', sha256: client.config.sha256 });
        return { async sign(...args: Parameters<RequestSigner['sign']>) {
          try { return await signer.sign(...args); } finally { clearCredentialCache(); }
        } };
      } : undefined,
      token: aws ? deny : { token: credential.token },
      authSchemePreference: [aws ? 'sigv4' : 'httpBearerAuth'],
      // Locked SDK adapter: offer exactly one scheme, never an ambient alternative.
      httpAuthSchemeProvider: () => aws ? [{ schemeId: 'aws.auth#sigv4', signingProperties: { name: 'bedrock', region },
        propertiesExtractor: (config, context) => ({ signingProperties: { config, context } }) }] : [{ schemeId: 'smithy.api#httpBearerAuth' }],
      requestHandler: bedrockHttpHandler(request.signal),
    });
    try {
      const params: ConverseCommandInput = { modelId: request.model,
        messages: await projectBedrockMessages(request.messages, request.source, this.config.promptCacheAffinity === true, this.getCapabilityProfile().multimodalSupport !== 'none'),
        ...(request.system ? { system: [{ text: request.system }] } : {}), inferenceConfig: { maxTokens: request.maxOutputTokens },
        ...(request.tools.length ? { toolConfig: { tools: request.tools.map(t => ({ toolSpec: { name: t.name, description: t.description,
          inputSchema: { json: bedrockDocument(t.input_schema) } } })), ...(request.options?.forcedToolName ? { toolChoice: { tool: { name: request.options.forcedToolName } } } : {}) } } : {}),
        ...this.thinkingConfig(request),
      };
      if (request.streaming) {
        const response = await client.send(new ConverseStreamCommand(params), { abortSignal: request.signal });
        return await this.consume(response.stream, request);
      }
      const response = await client.send(new ConverseCommand(params), { abortSignal: request.signal });
      request.signal?.throwIfAborted();
      const usage = usageFrom(response.usage);
      observeProviderStreamUsage(usage);
      if (response.output?.message?.role !== 'assistant' || !['end_turn', 'tool_use', 'stop_sequence'].includes(response.stopReason ?? '')) throw this.protocolError(`Bedrock response did not complete: ${response.stopReason ?? 'missing stopReason'}`);
      return this.finish(request, this.parseContent(response.output.message.content ?? [], request), usage, response.stopReason!);
    } catch (error) {
      if (error && typeof error === 'object' && '$metadata' in error) {
        const metadata = error.$metadata as { httpStatusCode?: number } | undefined;
        const response = '$response' in error ? error.$response as { headers?: Record<string, string> } | undefined : undefined;
        Object.assign(error, { status: metadata?.httpStatusCode, headers: response?.headers });
      }
      throw error;
    } finally { client.destroy(); clearCredentialCache(); }
  }
  private async consume(stream: AsyncIterable<ConverseStreamOutput> | undefined, request: NativeCloudRequest): Promise<KodaXStreamResult> {
    if (!stream) throw this.protocolError('Bedrock returned no EventStream.');
    const blocks = new Map<number, StreamBlock>();
    let started = false;
    let stopReason: string | undefined;
    let usage: KodaXTokenUsage | undefined;
    const indexOf = (index: number | undefined): number => {
      if (!Number.isSafeInteger(index) || index! < 0) throw this.protocolError('Invalid Bedrock content block index.');
      return index!;
    };
    for await (const event of stream) {
      request.signal?.throwIfAborted();
      request.options?.onHeartbeat?.();
      if (event.messageStart) {
        if (started || event.messageStart.role !== 'assistant') throw this.protocolError('Invalid Bedrock message start.');
        started = true;
      } else if (event.metadata) {
        usage = usageFrom(event.metadata.usage) ?? usage;
        observeProviderStreamUsage(usage);
      } else if (event.messageStop) {
        if (!started || stopReason || [...blocks.values()].some(block => !block.stopped)) throw this.protocolError('Bedrock stopped before completing its blocks.');
        stopReason = event.messageStop.stopReason;
      } else if (event.contentBlockStart) {
        if (!started || stopReason) throw this.protocolError('Bedrock block outside an active message.');
        const index = indexOf(event.contentBlockStart.contentBlockIndex);
        const call = event.contentBlockStart.start?.toolUse;
        if (blocks.has(index) || !call?.toolUseId || !call.name) throw this.protocolError('Unsupported or duplicate Bedrock content block start.');
        blocks.set(index, { kind: 'tool', id: call.toolUseId, name: call.name, input: '', stopped: false });
      } else if (event.contentBlockDelta) {
        if (!started || stopReason) throw this.protocolError('Bedrock delta outside an active message.');
        const index = indexOf(event.contentBlockDelta.contentBlockIndex);
        const delta = event.contentBlockDelta.delta;
        let block = blocks.get(index);
        if (block?.stopped) throw this.protocolError('Bedrock delta after block stop.');
        if (typeof delta?.text === 'string') {
          if (!block) { block = { kind: 'text', text: '', stopped: false }; blocks.set(index, block); }
          if (block.kind !== 'text') throw this.protocolError('Bedrock changed a block type.');
          block.text += delta.text;
          request.options?.onTextDelta?.(delta.text);
        } else if (delta?.toolUse) {
          if (block?.kind !== 'tool' || typeof delta.toolUse.input !== 'string') throw this.protocolError('Bedrock tool delta has no complete start.');
          block.input += delta.toolUse.input;
          request.options?.onToolInputDelta?.(block.name, delta.toolUse.input, { toolId: block.id });
        } else if (delta?.reasoningContent) {
          if (!block) { block = { kind: 'reasoning', text: '', signature: '', redacted: [], stopped: false }; blocks.set(index, block); }
          if (block.kind !== 'reasoning') throw this.protocolError('Bedrock changed a block type.');
          const reasoning = delta.reasoningContent;
          if ((reasoning.redactedContent && (block.text || block.signature)) || (!reasoning.redactedContent && block.redacted.length)) throw this.protocolError('Bedrock mixed redacted and signed reasoning.');
          if (reasoning.redactedContent) {
            block.redacted.push(reasoning.redactedContent);
          } else if (typeof reasoning.text === 'string') { block.text += reasoning.text; request.options?.onThinkingDelta?.(reasoning.text); }
          else if (typeof reasoning.signature === 'string') block.signature += reasoning.signature;
          else throw this.protocolError('Unsupported Bedrock reasoning delta.');
        } else throw this.protocolError('Unsupported Bedrock content delta.');
      } else if (event.contentBlockStop) {
        const block = blocks.get(indexOf(event.contentBlockStop.contentBlockIndex));
        if (!started || stopReason || !block || block.stopped) throw this.protocolError('Invalid Bedrock content block stop.');
        block.stopped = true;
      } else {
        const key = Object.keys(event)[0] ?? 'unknown';
        const detail: unknown = Object.values(event)[0];
        const message = detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string' ? detail.message : `Bedrock event ${key}`;
        throw Object.assign(new Error(message), { status: key === 'throttlingException' ? 429 : key === 'validationException' ? 400 : 500 });
      }
    }
    request.signal?.throwIfAborted();
    if (!started || !stopReason) throw this.protocolError('Stream incomplete: Bedrock ended without messageStop.', true);
    if (!['end_turn', 'tool_use', 'stop_sequence'].includes(stopReason)) throw this.protocolError(`Bedrock response did not complete: ${stopReason}`);
    const content: ContentBlock[] = [...blocks].sort(([a], [b]) => a - b).map(([index, block], position) => {
      if (index !== position || !block.stopped) throw this.protocolError('Bedrock returned incomplete or missing blocks.');
      if (block.kind === 'text') return { text: block.text };
      if (block.kind === 'reasoning') return { reasoningContent: block.redacted.length ? { redactedContent: Buffer.concat(block.redacted) }
        : { reasoningText: { text: block.text, signature: block.signature || undefined } } };
      let input: unknown;
      try { input = JSON.parse(block.input || '{}'); } catch { throw this.protocolError('Bedrock returned invalid final tool arguments.'); }
      return { toolUse: { toolUseId: block.id, name: block.name, input: bedrockDocument(input) } };
    });
    return this.finish(request, this.parseContent(content, request), usage, stopReason);
  }
  private thinkingConfig(request: NativeCloudRequest): Partial<ConverseCommandInput> {
    if (request.profile?.effortStrategy === 'provider-budget') {
      const requested = request.effort ? request.profile.budgetByEffort?.[request.effort] : undefined;
      const budget = requested === undefined ? undefined : this.boundThinkingBudget(request, requested);
      if (request.disabled) return { additionalModelRequestFields: { thinking: { type: 'disabled' } } };
      if (budget !== undefined) {
        if (!Number.isSafeInteger(budget) || budget <= 0 || budget >= request.maxOutputTokens) throw this.protocolError('Bedrock thinking budget must be positive and smaller than max output tokens.');
        return { additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: budget } } };
      }
    }
    if (request.profile?.effortStrategy === 'bedrock-anthropic-effort') {
      if (request.disabled) return { additionalModelRequestFields: { thinking: { type: 'disabled' } } };
      if (request.effort) return { additionalModelRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort: request.effort } } };
    }
    return {};
  }
  private parseContent(content: ContentBlock[], request: NativeCloudRequest): KodaXAssistantBlock[] {
    const blocks: KodaXAssistantBlock[] = [];
    const calls = new Set<string>();
    for (const item of content) {
      if (typeof item.text === 'string') blocks.push({ type: 'text', text: item.text });
      else if (item.reasoningContent?.reasoningText) {
        const reasoning = item.reasoningContent.reasoningText;
        blocks.push({ type: 'thinking', thinking: reasoning.text ?? '', signature: reasoning.signature, source: request.source });
      } else if (item.reasoningContent?.redactedContent) blocks.push({ type: 'redacted_thinking', data: Buffer.from(item.reasoningContent.redactedContent).toString('base64'), source: request.source });
      else if (item.toolUse) {
        const call = item.toolUse;
        if (!call.toolUseId || !call.name || !call.input || typeof call.input !== 'object' || Array.isArray(call.input) || calls.has(call.toolUseId)) throw this.protocolError('Bedrock returned an invalid or duplicate tool call.');
        calls.add(call.toolUseId);
        blocks.push({ type: 'tool_use', id: call.toolUseId, name: call.name, input: call.input as Record<string, unknown> });
      } else throw this.protocolError('Unsupported Bedrock response content.');
    }
    return blocks;
  }
}
