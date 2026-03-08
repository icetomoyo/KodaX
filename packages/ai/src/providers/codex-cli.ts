/**
 * KodaX Codex CLI Provider
 *
 * 从本地已安装的 Codex CLI 提取 OAuth 凭证（~/.codex/auth.json），
 * 直接通过 HTTP/SSE 请求 OpenAI Codex Responses API。
 *
 * 前置条件: 用户需先安装官方 codex-cli 并完成登录授权。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { KodaXBaseProvider } from './base.js';
import {
    KodaXProviderConfig,
    KodaXMessage,
    KodaXToolDefinition,
    KodaXProviderStreamOptions,
    KodaXStreamResult,
    KodaXTextBlock,
    KodaXToolUseBlock,
} from '../types.js';

// ============== 端点配置 ==============

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_AUTH_FILENAME = 'auth.json';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// ============== 风险提示 ==============

const CODEX_RISK_WARNING = `
⚠️  [KodaX Codex CLI Provider] 非官方集成提示
──────────────────────────────────────
此集成方式并非 OpenAI 官方支持或认可。
通过第三方客户端使用 Codex CLI 凭证可能存在账户风险。
请知悉并自行承担风险。
──────────────────────────────────────
`.trim();

let codexRiskWarningShown = false;

// ============== 凭证提取工具 ==============

interface CodexCliCredential {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId?: string;
}

let cachedCodexCredential: CodexCliCredential | null = null;

/**
 * 解析 Codex CLI 的 Home 目录
 */
function resolveCodexHomePath(): string {
    const configured = process.env.CODEX_HOME;
    const home = configured ? configured : join(homedir(), '.codex');
    try {
        return require('node:fs').realpathSync.native(home);
    } catch (e) {
        console.debug('[CodexCli] realpathSync 失败:', e instanceof Error ? e.message : e);
        return home;
    }
}

/**
 * 从本地已安装的 Codex CLI 缓存中提取 OAuth 凭证
 * 读取 ~/.codex/auth.json 文件
 */
export function extractCodexCliCredentials(): CodexCliCredential | null {
    if (cachedCodexCredential && Date.now() < cachedCodexCredential.expiresAt) {
        return cachedCodexCredential;
    }

    const authPath = join(resolveCodexHomePath(), CODEX_AUTH_FILENAME);

    try {
        if (!existsSync(authPath)) return null;

        const raw = readFileSync(authPath, 'utf8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const tokens = data.tokens as Record<string, unknown> | undefined;

        if (!tokens || typeof tokens !== 'object') return null;

        const accessToken = tokens.access_token;
        const refreshToken = tokens.refresh_token;

        if (typeof accessToken !== 'string' || !accessToken) return null;
        if (typeof refreshToken !== 'string' || !refreshToken) return null;

        // 根据文件修改时间推算过期时间（约 1 小时有效）
        let expiresAt: number;
        try {
            const stat = statSync(authPath);
            expiresAt = stat.mtimeMs + 60 * 60 * 1000;
        } catch (e) {
            console.debug('[CodexCli] statSync 失败:', e instanceof Error ? e.message : e);
            expiresAt = Date.now() + 60 * 60 * 1000;
        }

        const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : undefined;

        cachedCodexCredential = { accessToken, refreshToken, expiresAt, accountId };
        return cachedCodexCredential;
    } catch (e) {
        console.debug('[CodexCli] 凭证读取失败:', e instanceof Error ? e.message : e);
    }
    return null;
}

/**
 * 从 JWT 中解码 accountId
 */
function decodeJwtAccountId(token: string): string | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        // JWT 使用 Base64URL 编码，需先转换为标准 Base64
        const base64 = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '=='.slice(0, (4 - base64.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        const auth = payload?.['https://api.openai.com/auth'];
        return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
    } catch (e) {
        console.debug('[CodexCli] JWT 解码失败:', e instanceof Error ? e.message : e);
        return null;
    }
}

/**
 * 刷新 Codex OAuth Token
 */
async function refreshCodexAccessToken(refreshToken: string): Promise<CodexCliCredential> {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
        }),
    });

    if (!response.ok) {
        throw new Error(
            `Codex Token 刷新失败 (${response.status})。\n` +
            'Token 可能已过期，请重新登录 Codex CLI: codex --full-setup'
        );
    }

    const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
    };

    if (!data.access_token || !data.refresh_token || typeof data.expires_in !== 'number') {
        throw new Error('Token refresh response missing fields');
    }

    const accountId = decodeJwtAccountId(data.access_token);

    const credential: CodexCliCredential = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
        accountId: accountId ?? undefined,
    };

    cachedCodexCredential = credential;
    return credential;
}

async function ensureValidCodexToken(): Promise<CodexCliCredential> {
    // 风险提示（仅显示一次）
    if (!codexRiskWarningShown) {
        console.warn(CODEX_RISK_WARNING);
        codexRiskWarningShown = true;
    }

    // 优先从环境变量获取
    const envToken = process.env.CODEX_CLI_ACCESS_TOKEN;
    const envRefresh = process.env.CODEX_CLI_REFRESH_TOKEN;
    if (envToken && envRefresh) {
        const accountId = decodeJwtAccountId(envToken);
        return {
            accessToken: envToken,
            refreshToken: envRefresh,
            expiresAt: Date.now() + 55 * 60 * 1000,
            accountId: accountId ?? undefined,
        };
    }

    // 从本地 CLI 缓存读取
    let cred = extractCodexCliCredentials();
    if (!cred) {
        throw new Error(
            '未找到 Codex CLI 的登录凭证。\n\n' +
            '请先在本机安装并登录 Codex CLI：\n' +
            '  1. npm install -g @openai/codex\n' +
            '  2. codex --full-setup\n\n' +
            '登录完成后 KodaX 会自动读取本地凭证，无需额外配置。'
        );
    }

    // Token 过期时刷新
    if (Date.now() >= cred.expiresAt) {
        cred = await refreshCodexAccessToken(cred.refreshToken);
    }

    return cred;
}

// ============== 请求/响应类型 ==============

interface CodexRequestBody {
    model: string;
    store: boolean;
    stream: boolean;
    instructions?: string;
    input: CodexResponseInput[];
    tools?: CodexTool[];
    tool_choice?: string;
    parallel_tool_calls?: boolean;
    reasoning?: { effort?: string; summary?: string };
    text?: { verbosity?: string };
    include?: string[];
    prompt_cache_key?: string;
}

interface CodexResponseInput {
    role: string;
    content?: string | CodexInputContent[];
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: string;
}

interface CodexInputContent {
    type: string;
    text?: string;
}

interface CodexTool {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: null;
}

// ============== 消息转换 ==============

function convertMessagesToCodex(
    messages: KodaXMessage[],
    system: string,
    tools: KodaXToolDefinition[],
): { input: CodexResponseInput[]; codexTools: CodexTool[] } {
    const input: CodexResponseInput[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') continue;

        if (typeof msg.content === 'string') {
            input.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content,
            });
            continue;
        }

        // 复合 content
        for (const block of msg.content) {
            if (block.type === 'text') {
                input.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: [{ type: 'input_text', text: block.text }],
                });
            } else if (block.type === 'tool_use' && msg.role === 'assistant') {
                input.push({
                    type: 'function_call',
                    role: 'assistant',
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                });
            } else if (block.type === 'tool_result' && msg.role === 'user') {
                input.push({
                    type: 'function_call_output',
                    role: 'user',
                    call_id: block.tool_use_id,
                    output: block.content,
                });
            }
        }
    }

    const codexTools: CodexTool[] = tools.map(t => ({
        type: 'function' as const,
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        strict: null,
    }));

    return { input, codexTools };
}

// ============== Provider 实现 ==============

export class KodaXCodexCliProvider extends KodaXBaseProvider {
    readonly name = 'codex-cli';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'CODEX_CLI_ACCESS_TOKEN',
        model: 'o4-mini',
        supportsThinking: false,
        contextWindow: 200000,
    };

    constructor() {
        super();
    }

    override isConfigured(): boolean {
        // 从环境变量或本地 CLI 缓存中检测凭证
        if (process.env.CODEX_CLI_ACCESS_TOKEN && process.env.CODEX_CLI_REFRESH_TOKEN) return true;
        return extractCodexCliCredentials() !== null;
    }

    override getModel(): string {
        return process.env.CODEX_CLI_MODEL ?? this.config.model;
    }

    async stream(
        messages: KodaXMessage[],
        tools: KodaXToolDefinition[],
        system: string,
        thinking = false,
        streamOptions?: KodaXProviderStreamOptions,
        signal?: AbortSignal
    ): Promise<KodaXStreamResult> {
        return this.withRateLimit(async () => {
            const cred = await ensureValidCodexToken();
            const model = this.getModel();

            const { input, codexTools } = convertMessagesToCodex(messages, system, tools);

            const body: CodexRequestBody = {
                model,
                store: false,
                stream: true,
                instructions: system,
                input,
                text: { verbosity: 'medium' },
                include: ['reasoning.encrypted_content'],
                tool_choice: 'auto',
                parallel_tool_calls: true,
            };

            // #5: 当 thinking=true 时，启用 Codex reasoning 模式
            if (thinking) {
                body.reasoning = { effort: 'medium', summary: 'auto' };
            }

            if (codexTools.length > 0) {
                body.tools = codexTools;
            }

            const headers: Record<string, string> = {
                'Authorization': `Bearer ${cred.accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
            };

            if (cred.accountId) {
                headers['ChatGPT-Account-Id'] = cred.accountId;
            }

            const baseUrl = process.env.CODEX_CLI_BASE_URL ?? DEFAULT_CODEX_BASE_URL;
            const url = `${baseUrl.replace(/\/+$/, '')}/codex/responses`;

            // 带重试的请求
            let response: Response | undefined;
            let lastError: Error | undefined;

            for (let attempt = 0; attempt <= 3; attempt++) {
                if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');

                try {
                    response = await fetch(url, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                        signal,
                    });

                    if (response.ok) break;

                    const errorText = await response.text();

                    if (attempt < 3 && [429, 500, 502, 503, 504].includes(response.status)) {
                        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
                        continue;
                    }

                    throw new Error(`Codex API error (${response.status}): ${errorText.slice(0, 200)}`);
                } catch (e) {
                    if (e instanceof Error && (e.name === 'AbortError' || e.message === 'Request aborted')) {
                        throw new DOMException('Request aborted', 'AbortError');
                    }
                    lastError = e instanceof Error ? e : new Error(String(e));
                    if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
                        continue;
                    }
                    throw lastError;
                }
            }

            if (!response || !response.ok) {
                throw lastError ?? new Error('Failed after retries');
            }

            return this.parseSSEStream(response, streamOptions, signal);
        }, signal);
    }

    private async parseSSEStream(
        response: Response,
        streamOptions?: KodaXProviderStreamOptions,
        signal?: AbortSignal,
    ): Promise<KodaXStreamResult> {
        if (!response.body) throw new Error('No response body');

        const textBlocks: KodaXTextBlock[] = [];
        const toolBlocks: KodaXToolUseBlock[] = [];

        let currentText = '';
        const toolCallsMap = new Map<string, { id: string; name: string; arguments: string }>();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');

                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Codex SSE 事件以 \n\n 分隔
                let idx = buffer.indexOf('\n\n');
                while (idx !== -1) {
                    const chunk = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);

                    const dataLines = chunk
                        .split('\n')
                        .filter(l => l.startsWith('data:'))
                        .map(l => l.slice(5).trim());

                    if (dataLines.length > 0) {
                        const data = dataLines.join('\n').trim();
                        if (data && data !== '[DONE]') {
                            try {
                                const event = JSON.parse(data) as Record<string, unknown>;
                                this.processCodexEvent(event, streamOptions, currentText, textBlocks, toolBlocks, toolCallsMap);
                                // 更新 currentText
                                if (event.type === 'response.output_text.delta') {
                                    currentText += (event as { delta?: string }).delta ?? '';
                                }
                            } catch (e) { console.debug('[CodexCli] SSE 事件解析失败:', e instanceof Error ? e.message : e); }
                        }
                    }

                    idx = buffer.indexOf('\n\n');
                }
            }
        } finally {
            reader.releaseLock();
        }

        // 收尾文本
        if (currentText && textBlocks.length === 0) {
            textBlocks.push({ type: 'text', text: currentText });
        }

        // 收尾工具调用
        for (const [, tc] of toolCallsMap) {
            if (tc.id && tc.name) {
                try {
                    toolBlocks.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: JSON.parse(tc.arguments),
                    });
                } catch (e) {
                    console.debug('[CodexCli] 工具调用 JSON 解析失败:', e instanceof Error ? e.message : e);
                    toolBlocks.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: {},
                    });
                }
            }
        }

        return { textBlocks, toolBlocks, thinkingBlocks: [] };
    }

    /**
     * 处理 Codex SSE 事件
     */
    private processCodexEvent(
        event: Record<string, unknown>,
        streamOptions: KodaXProviderStreamOptions | undefined,
        _currentText: string,
        textBlocks: KodaXTextBlock[],
        _toolBlocks: KodaXToolUseBlock[],
        toolCallsMap: Map<string, { id: string; name: string; arguments: string }>,
    ): void {
        const type = typeof event.type === 'string' ? event.type : '';

        if (type === 'error') {
            const msg = (event as { message?: string }).message || '';
            throw new Error(`Codex error: ${msg || JSON.stringify(event)}`);
        }

        if (type === 'response.failed') {
            const msg = ((event as { response?: { error?: { message?: string } } }).response?.error?.message) || 'Codex response failed';
            throw new Error(msg);
        }

        // 文本增量
        if (type === 'response.output_text.delta') {
            const delta = (event as { delta?: string }).delta ?? '';
            if (delta) {
                streamOptions?.onTextDelta?.(delta);
            }
        }

        // 文本完成
        if (type === 'response.output_text.done') {
            const text = (event as { text?: string }).text ?? '';
            if (text) {
                textBlocks.push({ type: 'text', text });
            }
        }

        // 工具调用
        if (type === 'response.function_call_arguments.delta') {
            const callId = (event as { call_id?: string }).call_id ?? '';
            const delta = (event as { delta?: string }).delta ?? '';
            const existing = toolCallsMap.get(callId) ?? { id: callId, name: '', arguments: '' };
            existing.arguments += delta;
            toolCallsMap.set(callId, existing);
            if (existing.name) {
                streamOptions?.onToolInputDelta?.(existing.name, delta);
            }
        }

        if (type === 'response.function_call_arguments.done') {
            const callId = (event as { call_id?: string }).call_id ?? '';
            const name = (event as { name?: string }).name ?? '';
            const existing = toolCallsMap.get(callId) ?? { id: callId, name: '', arguments: '' };
            if (name) existing.name = name;
            toolCallsMap.set(callId, existing);
        }
    }
}
