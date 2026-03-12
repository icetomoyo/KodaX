import { KodaXBaseProvider } from './base.js';
import { AcpClientOptions } from '../cli-events/acp-client.js';
import type { KodaXMessage, KodaXStreamResult, KodaXProviderStreamOptions, KodaXToolDefinition } from '../types.js';
/**
 * 通用的 ACP Provider 基类。
 * 通过传入 Client Options，它可以连接原生的 CLI 命令，
 * 也可以连接我们在内存中伪造的 PseudoAcpServer。
 */
export declare abstract class KodaXAcpProvider extends KodaXBaseProvider {
    protected abstract readonly acpClientOptions: AcpClientOptions;
    private _client;
    private _sessionMap;
    private _activeStreams;
    isConfigured(): boolean;
    stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, thinking: boolean, streamOptions?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult>;
    /**
     * 手动关闭并清理当前 Provider 维护的 ACP 连接
     */
    disconnect(): void;
}
//# sourceMappingURL=acp-base.d.ts.map