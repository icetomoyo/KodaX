import { CLIExecutor } from './executor.js';
import { checkCliCommandInstalled } from './command-utils.js';
import type { CLIEvent, CLIExecutorConfig, CLIExecutionOptions } from './types.js';

/**
 * Raw event shape emitted by Codex CLI JSON mode.
 */
interface CodexRawEvent {
    type: string;
    thread_id?: string;
    item?: {
        id: string;
        type: string;
        text?: string;
        command?: string;
        status?: string;
        name?: string;
        arguments?: string;
    };
    usage?: {
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
    };
    message?: string;
    response?: unknown;
}

export class CodexCLIExecutor extends CLIExecutor {
    private model: string;

    constructor(config?: Partial<CLIExecutorConfig> & { model?: string }) {
        super({
            command: 'codex',
            baseArgs: ['exec', '--json', '--full-auto'],
            timeout: 300000,
            ...config,
        });
        this.model = config?.model ?? 'gpt-5.4';
    }

    protected async checkInstalled(): Promise<boolean> {
        return checkCliCommandInstalled('codex');
    }

    protected buildArgs(options: CLIExecutionOptions): string[] {
        this.model = options.model ?? this.model;
        const modelArgs = options.model ? ['-m', options.model] : [];

        // Codex CLI shapes:
        //   first prompt: codex exec --json --full-auto "prompt"
        //   resume flow:  codex exec resume <session_id> "prompt" --json --full-auto
        // Note that `resume` is a subcommand of `exec`, so flags must follow it.

        if (options.sessionId) {
            // Resume an existing Codex session.
            return [
                'exec', 'resume', options.sessionId,
                ...modelArgs,
                options.prompt,
                ...this.config.baseArgs.filter(a => a !== 'exec'), // `exec` was inserted manually above.
            ];
        }

        // Fresh execution.
        return [...this.config.baseArgs, ...modelArgs, options.prompt];
    }

    protected parseLine(line: string): CLIEvent | null {
        if (!line.startsWith('{')) return null;

        try {
            const raw = JSON.parse(line) as CodexRawEvent;
            return this.convertEvent(raw);
        } catch {
            return null;
        }
    }

    private convertEvent(raw: CodexRawEvent): CLIEvent | null {
        const timestamp = Date.now();

        switch (raw.type) {
            case 'thread.started':
                return {
                    type: 'session_start',
                    timestamp,
                    sessionId: raw.thread_id ?? '',
                    model: this.model,
                    raw,
                };

            case 'item.completed':
                if (raw.item?.type === 'agent_message') {
                    return {
                        type: 'message',
                        timestamp,
                        role: 'assistant',
                        content: raw.item.text ?? '',
                        raw,
                    };
                }
                if (raw.item?.type === 'command_execution') {
                    return {
                        type: 'tool_use',
                        timestamp,
                        toolId: raw.item.id,
                        toolName: 'Bash',
                        parameters: { command: raw.item.command },
                        raw,
                    };
                }
                return null;

            case 'turn.completed':
                return {
                    type: 'complete',
                    timestamp,
                    status: 'success',
                    usage: raw.usage ? {
                        inputTokens: raw.usage.input_tokens,
                        outputTokens: raw.usage.output_tokens,
                        totalTokens: raw.usage.input_tokens + raw.usage.output_tokens,
                    } : undefined,
                    raw,
                };

            case 'error':
            case 'turn.failed':
                return {
                    type: 'error',
                    timestamp,
                    errorType: raw.type,
                    message: raw.message ?? 'Unknown error',
                    raw,
                };

            default:
                return null;
        }
    }
}
