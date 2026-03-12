import { spawn } from 'node:child_process';
import process from 'node:process';
import { CLIExecutor } from './executor.js';
export class GeminiCLIExecutor extends CLIExecutor {
    model;
    constructor(config) {
        super({
            command: 'gemini',
            // ⚠️ --approval-mode yolo: 自动批准所有工具调用。生产环境应考虑替换为更安全的模式
            baseArgs: ['--output-format', 'stream-json', '--approval-mode', 'yolo'],
            timeout: 300000,
            ...config,
        });
        this.model = config?.model ?? 'gemini-2.5-pro';
    }
    async checkInstalled() {
        try {
            const isWin = process.platform === 'win32';
            const child = spawn(isWin ? 'gemini.cmd' : 'gemini', ['--version']);
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
        const args = ['-m', this.model];
        // 如果有会话恢复，使用 -r；否则传 -p
        if (options.sessionId) {
            args.push('-r', options.sessionId);
            args.push(options.prompt);
        }
        else {
            args.push('-p', options.prompt);
        }
        return [...args, ...this.config.baseArgs];
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
                    role: raw.role,
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
//# sourceMappingURL=gemini-parser.js.map