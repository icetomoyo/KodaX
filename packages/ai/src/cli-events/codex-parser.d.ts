import { CLIExecutor } from './executor.js';
import type { CLIEvent, CLIExecutorConfig, CLIExecutionOptions } from './types.js';
export declare class CodexCLIExecutor extends CLIExecutor {
    constructor(config?: Partial<CLIExecutorConfig>);
    protected checkInstalled(): Promise<boolean>;
    protected buildArgs(options: CLIExecutionOptions): string[];
    protected parseLine(line: string): CLIEvent | null;
    private convertEvent;
}
//# sourceMappingURL=codex-parser.d.ts.map