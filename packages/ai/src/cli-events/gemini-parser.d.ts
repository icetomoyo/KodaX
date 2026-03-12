import { CLIExecutor } from './executor.js';
import type { CLIEvent, CLIExecutorConfig, CLIExecutionOptions } from './types.js';
export declare class GeminiCLIExecutor extends CLIExecutor {
    private model;
    constructor(config?: Partial<CLIExecutorConfig> & {
        model?: string;
    });
    protected checkInstalled(): Promise<boolean>;
    protected buildArgs(options: CLIExecutionOptions): string[];
    protected parseLine(line: string): CLIEvent | null;
    private convertEvent;
}
//# sourceMappingURL=gemini-parser.d.ts.map