import { type SessionNotification } from '@agentclientprotocol/sdk';
export interface AcpClientOptions {
    /** 启动子进程的命令，如果是原生 ACP 则必填 */
    command?: string;
    /** 启动子进程的参数，如果是原生 ACP 则必填 */
    args?: string[];
    /** 如果是内部模拟进程（Pseudo Server），直接传入 Web 标准的流 */
    inputStream?: ReadableStream<Uint8Array>;
    outputStream?: WritableStream<Uint8Array>;
    /** 当前工作目录 */
    cwd?: string;
    /** Session Update 回调 */
    onSessionUpdate?: (update: SessionNotification) => void;
    /** 模拟进程下用于关闭资源的钩子 */
    abort?: () => void;
    /** 直接暴露的底层执行器，用于验证是否安装 */
    executor?: import('./executor.js').CLIExecutor;
}
export declare class AcpClient {
    private client;
    private agentProcess;
    private options;
    constructor(options: AcpClientOptions);
    connect(): Promise<void>;
    createNewSession(): Promise<string>;
    prompt(text: string, sessionId: string, signal?: AbortSignal): Promise<void>;
    disconnect(): void;
}
//# sourceMappingURL=acp-client.d.ts.map