import type { CLIExecutor } from './executor.js';
/**
 * 创建一个伪装的 ACP Server 内存流对。
 * 它会在内部拦截客户端发来的 JSON-RPC 请求，
 * 并在收到 `prompt` 时启动传入的 CLIExecutor，将输出转换成 ACP 事件返回。
 */
export declare function createPseudoAcpServer(executor: CLIExecutor, executorModel: string): {
    inputStream: ReadableStream<Uint8Array>;
    outputStream: WritableStream<Uint8Array>;
    abort: () => void;
    executor: CLIExecutor;
};
//# sourceMappingURL=pseudo-acp-server.d.ts.map