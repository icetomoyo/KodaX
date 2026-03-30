import { CLIExecutor } from './executor.js';
import { checkCliCommandInstalled } from './command-utils.js';
import type { CLIEvent, CLIExecutorConfig, CLIExecutionOptions } from './types.js';

/**
 * Raw event shape emitted by Gemini CLI JSON streaming mode.
 */
interface GeminiRawEvent {
    type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'error' | 'result';
    timestamp?: string;
    session_id?: string;
    model?: string;
    role?: string;
    content?: string;
    delta?: boolean;
    tool_name?: string;
    tool_id?: string;
    parameters?: Record<string, unknown>;
    status?: string;
    output?: string;
    message?: string;
    stats?: {
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
    };
}

export class GeminiCLIExecutor extends CLIExecutor {
    private model: string;

    constructor(config?: Partial<CLIExecutorConfig> & { model?: string }) {
        super({
            command: 'gemini',
            // `--approval-mode yolo` keeps the CLI non-interactive for the bridge.
            // If this provider becomes user-facing, revisit this default carefully.
            baseArgs: ['--output-format', 'stream-json', '--approval-mode', 'yolo'],
            timeout: 300000,
            ...config,
        });
        this.model = config?.model ?? 'gemini-2.5-pro';
    }

    protected async checkInstalled(): Promise<boolean> {
        return checkCliCommandInstalled('gemini');
    }

    protected buildArgs(options: CLIExecutionOptions): string[] {
        const args = ['-m', options.model ?? this.model];

        // Resume uses `-r`; fresh prompts use `-p`.
        if (options.sessionId) {
            args.push('-r', options.sessionId);
            args.push(options.prompt);
        } else {
            args.push('-p', options.prompt);
        }

        return [...args, ...this.config.baseArgs];
    }

    protected parseLine(line: string): CLIEvent | null {
        if (!line.startsWith('{')) return null;

        try {
            const raw = JSON.parse(line) as GeminiRawEvent;
            return this.convertEvent(raw);
        } catch {
            return null;
        }
    }

    private convertEvent(raw: GeminiRawEvent): CLIEvent | null {
        const timestamp = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();

        switch (raw.type) {
            case 'init':
                return {
                    type: 'session_start',
                    timestamp,
                    sessionId: raw.session_id ?? '',
                    model: raw.model ?? this.model,
                    raw,
                };

            case 'message':
                return {
                    type: 'message',
                    timestamp,
                    role: raw.role as 'user' | 'assistant',
                    content: raw.content ?? '',
                    delta: raw.delta,
                    raw,
                };

            case 'tool_use':
                return {
                    type: 'tool_use',
                    timestamp,
                    toolId: raw.tool_id ?? '',
                    toolName: raw.tool_name ?? '',
                    parameters: raw.parameters ?? {},
                    raw,
                };

            case 'tool_result':
                return {
                    type: 'tool_result',
                    timestamp,
                    toolId: raw.tool_id ?? '',
                    status: raw.status === 'success' ? 'success' : 'error',
                    output: raw.output ?? '',
                    raw,
                };

            case 'error':
                return {
                    type: 'error',
                    timestamp,
                    errorType: 'error',
                    message: raw.message ?? 'Unknown error',
                    raw,
                };

            case 'result':
                return {
                    type: 'complete',
                    timestamp,
                    status: raw.status === 'success' ? 'success' : 'failed',
                    usage: raw.stats ? {
                        inputTokens: raw.stats.input_tokens ?? 0,
                        outputTokens: raw.stats.output_tokens ?? 0,
                        totalTokens: raw.stats.total_tokens ?? 0,
                    } : undefined,
                    raw,
                };

            default:
                return null;
        }
    }
}
