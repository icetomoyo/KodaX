/**
 * KodaX OpenAI Compatible Provider
 *
 * 支持 OpenAI API 格式的 Provider 基类
 */
import OpenAI from 'openai';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderConfig, KodaXMessage, KodaXToolDefinition, KodaXProviderStreamOptions, KodaXStreamResult } from '../types.js';
export declare abstract class KodaXOpenAICompatProvider extends KodaXBaseProvider {
    abstract readonly name: string;
    readonly supportsThinking = false;
    protected abstract readonly config: KodaXProviderConfig;
    protected client: OpenAI;
    protected initClient(): void;
    stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, _thinking?: boolean, streamOptions?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult>;
    private convertMessages;
}
//# sourceMappingURL=openai.d.ts.map