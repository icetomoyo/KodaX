/**
 * KodaX Anthropic Compatible Provider
 *
 * 支持 Anthropic API 格式的 Provider 基类
 */
import Anthropic from '@anthropic-ai/sdk';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderConfig, KodaXMessage, KodaXToolDefinition, KodaXProviderStreamOptions, KodaXStreamResult } from '../types.js';
export declare abstract class KodaXAnthropicCompatProvider extends KodaXBaseProvider {
    abstract readonly name: string;
    readonly supportsThinking = true;
    protected abstract readonly config: KodaXProviderConfig;
    protected client: Anthropic;
    protected initClient(): void;
    stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, thinking?: boolean, streamOptions?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult>;
    private convertMessages;
}
//# sourceMappingURL=anthropic.d.ts.map