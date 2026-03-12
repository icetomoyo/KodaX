/**
 * KodaX Base Provider
 *
 * Provider 抽象基类 - 所有 Provider 的公共基础
 */
import { KodaXProviderConfig, KodaXMessage, KodaXToolDefinition, KodaXProviderStreamOptions, KodaXStreamResult } from '../types.js';
export declare abstract class KodaXBaseProvider {
    abstract readonly name: string;
    abstract readonly supportsThinking: boolean;
    protected abstract readonly config: KodaXProviderConfig;
    abstract stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, thinking?: boolean, streamOptions?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult>;
    isConfigured(): boolean;
    getModel(): string;
    /**
     * 获取模型的上下文窗口大小
     * @returns 上下文窗口大小 (tokens)
     */
    getContextWindow(): number;
    protected getApiKey(): string;
    protected isRateLimitError(error: unknown): boolean;
    protected withRateLimit<T>(fn: () => Promise<T>, signal?: AbortSignal, retries?: number, onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void): Promise<T>;
}
//# sourceMappingURL=base.d.ts.map