import { KodaXBaseProvider } from './base.js';
import { AcpClient, AcpClientOptions } from '../cli-events/acp-client.js';
import {
    CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
    cloneCapabilityProfile,
} from './capability-profile.js';
import type {
    KodaXMessage,
    KodaXProviderCapabilityProfile,
    KodaXReasoningRequest,
    KodaXStreamResult,
    KodaXProviderStreamOptions,
    KodaXToolDefinition,
    KodaXTextBlock,
    KodaXTokenUsage,
    KodaXToolUseBlock
} from '../types.js';

interface ActiveStreamContext {
    streamOptions?: KodaXProviderStreamOptions;
    output: { text: string };
}

function normalizeAcpUsage(usage: unknown): KodaXTokenUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const usageRecord = usage as Record<string, unknown>;

  const inputTokens = typeof usageRecord.inputTokens === 'number' ? usageRecord.inputTokens : 0;
  const outputTokens = typeof usageRecord.outputTokens === 'number' ? usageRecord.outputTokens : 0;
  const totalTokens = typeof usageRecord.totalTokens === 'number' ? usageRecord.totalTokens : inputTokens + outputTokens;

    if ([inputTokens, outputTokens, totalTokens].some((value) => !Number.isFinite(value) || value < 0)) {
        return undefined;
    }

    if (totalTokens < inputTokens || totalTokens < outputTokens) {
        return undefined;
    }

    return {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedReadTokens:
            typeof usageRecord.cachedReadTokens === 'number' ? usageRecord.cachedReadTokens : undefined,
        cachedWriteTokens:
            typeof usageRecord.cachedWriteTokens === 'number' ? usageRecord.cachedWriteTokens : undefined,
        thoughtTokens:
            typeof usageRecord.thoughtTokens === 'number' ? usageRecord.thoughtTokens : undefined,
    };
}

/**
 * Shared base class for ACP-backed providers.
 * It can connect either to a native ACP server process or to our in-memory
 * pseudo ACP bridge that adapts CLI executors into ACP session updates.
 */
export abstract class KodaXAcpProvider extends KodaXBaseProvider {
    protected abstract readonly acpClientOptions: AcpClientOptions;
    private _client: AcpClient | null = null;
    private _sessionMap = new Map<string, string>();
    private _activeStreams = new Map<string, ActiveStreamContext>();

    // CLI-backed ACP adapters do not require a real API key.
    override isConfigured(): boolean {
        return true;
    }

    override getCapabilityProfile(): KodaXProviderCapabilityProfile {
        return cloneCapabilityProfile(CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE);
    }

    async stream(
        messages: KodaXMessage[],
        tools: KodaXToolDefinition[],
        system: string,
        _reasoning?: boolean | KodaXReasoningRequest,
        streamOptions?: KodaXProviderStreamOptions,
        signal?: AbortSignal
    ): Promise<KodaXStreamResult> {

        void tools;
        void system;

        // Pseudo-server adapters expose their executor so we can fail closed when
        // the required local CLI is missing.
        if (this.acpClientOptions.executor && typeof this.acpClientOptions.executor.isInstalled === 'function') {
            if (!await this.acpClientOptions.executor.isInstalled()) {
                throw new Error(
                    `${this.name} requires a local CLI environment, but the CLI was not found or is not configured correctly.`,
                );
            }
        }

        const textBlocks: KodaXTextBlock[] = [];
        const toolBlocks: KodaXToolUseBlock[] = [];

        // Flatten the latest KodaX message into a string because ACP prompt()
        // primarily accepts prompt blocks rather than full KodaX messages.
        const latestMessage = messages[messages.length - 1];
        let promptText = '';
        if (latestMessage && typeof latestMessage.content === 'string') {
            promptText = latestMessage.content;
        } else if (latestMessage && Array.isArray(latestMessage.content)) {
            promptText = latestMessage.content
                .filter(b => b.type === 'text')
                .map(b => (b as KodaXTextBlock).text)
                .join('\n');
        }

        // Build client event hooks once and route updates into the active stream.
        const options: AcpClientOptions = {
            ...this.acpClientOptions,
            onSessionUpdate: (notification: any) => {
                const update = notification.update;
                const sessionId = notification.sessionId;
                if (!('sessionUpdate' in update)) return;

                const activeCtx = sessionId ? this._activeStreams.get(sessionId) : undefined;
                if (!activeCtx) return;

                switch (update.sessionUpdate) {
                    case 'agent_message_chunk':
                        if (update.content?.type === 'text') {
                            const chunk = update.content.text;
                            activeCtx.output.text += chunk;
                            activeCtx.streamOptions?.onTextDelta?.(chunk);
                        }
                        break;

                    case 'tool_call': {
                        let toolArgs = '{}';
                        const rawArgs =
                            (update as any).arguments ??
                            (update as any).parameters;
                        if (rawArgs) {
                            toolArgs = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
                        }

                        activeCtx.streamOptions?.onToolInputDelta?.(update.title, toolArgs);
                        const logEntry = `\n> [Tool Use] ${update.title}: ${toolArgs}\n`;
                        activeCtx.output.text += logEntry;
                        activeCtx.streamOptions?.onTextDelta?.(logEntry);
                        break;
                    }

                    case 'tool_call_update':
                        if (update.status) {
                            const resEntry = `> [Tool Result] ${update.status}\n\n`;
                            activeCtx.output.text += resEntry;
                            activeCtx.streamOptions?.onTextDelta?.(resEntry);
                        }
                        break;
                }
            }
        };

        const kodaxSessionId = streamOptions?.sessionId ?? 'default';

        if (!this._client) {
            this._client = new AcpClient(options);
            await this._client.connect();
        }

        let acpSessionId = this._sessionMap.get(kodaxSessionId);
        if (!acpSessionId) {
            acpSessionId = await this._client.createNewSession();
            this._sessionMap.set(kodaxSessionId, acpSessionId);
        }

        const localOutput = { text: '' };
        this._activeStreams.set(acpSessionId, {
            streamOptions,
            output: localOutput
        });

        let promptResponse: Awaited<ReturnType<AcpClient['prompt']>> | undefined;

        try {
            promptResponse = await this._client.prompt(
                promptText,
                acpSessionId,
                signal,
                { model: streamOptions?.modelOverride },
            );
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                // User cancellation is expected.
            } else {
                throw err;
            }
        } finally {
            this._activeStreams.delete(acpSessionId);
        }

        if (localOutput.text) {
            textBlocks.push({ type: 'text', text: localOutput.text });
        }

        return {
            textBlocks,
            toolBlocks,
            thinkingBlocks: [],
            usage: normalizeAcpUsage(promptResponse?.usage),
        };
    }

    /**
     * Manually close and clear the ACP connection maintained by this provider.
     */
    disconnect(): void {
        if (this._client) {
            this._client.disconnect();
            this._client = null;
        }
        this._activeStreams.clear();
        this._sessionMap.clear();
    }
}
