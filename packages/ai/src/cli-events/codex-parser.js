import { spawn } from 'node:child_process';
import process from 'node:process';
import { CLIExecutor } from './executor.js';
export class CodexCLIExecutor extends CLIExecutor {
    constructor(config) {
        super({
            command: 'codex',
            baseArgs: ['exec', '--json', '--full-auto'],
            timeout: 300000,
            ...config,
        });
    }
    async checkInstalled() {
        try {
            const isWin = process.platform === 'win32';
            const child = spawn(isWin ? 'codex.cmd' : 'codex', ['--version']);
            return new Promise((resolve) => {
                child.on('close', (code) => resolve(code === 0));
                child.on('error', () => resolve(false));
            });
        }
        catch {
            return false;
        }
    }
    buildArgs(options) {
        // Codex CLI 格式:
        //   首次: codex exec --json --full-auto "prompt"
        //   恢复: codex exec resume <session_id> "prompt" --json --full-auto
        // 注意: resume 是 exec 的子命令，flags 必须在子命令之后
        if (options.sessionId) {
            // 恢复会话: exec resume <id> <prompt> <flags>
            return [
                'exec', 'resume', options.sessionId,
                options.prompt,
                ...this.config.baseArgs.filter(a => a !== 'exec'), // exec 已手动插入
            ];
        }
        // 首次执行: exec <flags> <prompt>
        return [...this.config.baseArgs, options.prompt];
    }
    parseLine(line) {
        if (!line.startsWith('{'))
            return null;
        try {
            const raw = JSON.parse(line);
            return this.convertEvent(raw);
        }
        catch {
            return null;
        }
    }
    convertEvent(raw) {
        const timestamp = Date.now();
        switch (raw.type) {
            case 'thread.started':
                return {
                    type: 'session_start',
                    timestamp,
                    sessionId: raw.thread_id ?? '',
                    model: 'codex',
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
                // command_execution
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
//# sourceMappingURL=codex-parser.js.map