import type { CLIExecutorConfig, CLIEvent, CLIExecutionOptions } from './types.js';
export declare abstract class CLIExecutor {
    protected config: CLIExecutorConfig;
    private _installedCache;
    constructor(config: CLIExecutorConfig);
    /**
     * 检测 CLI 是否安装（带缓存，避免每次 stream() 重复 spawn）
     */
    isInstalled(): Promise<boolean>;
    /**
     * 子类实现的安装检测
     */
    protected abstract checkInstalled(): Promise<boolean>;
    /**
     * 执行 CLI 并流式返回事件
     */
    execute(options: CLIExecutionOptions): AsyncGenerator<CLIEvent>;
    /**
     * 构建命令行参数
     */
    protected abstract buildArgs(options: CLIExecutionOptions): string[];
    /**
     * 解析输出流
     */
    protected parseOutputStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): AsyncGenerator<CLIEvent>;
    /**
     * 解析单行 JSON
     */
    protected abstract parseLine(line: string): CLIEvent | null;
}
//# sourceMappingURL=executor.d.ts.map