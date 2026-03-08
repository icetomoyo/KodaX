/**
 * KodaX Gemini CLI Provider
 *
 * 从本地已安装的 Gemini CLI 提取 OAuth 凭证，
 * 直接通过 HTTP/SSE 请求 Google Cloud Code Assist API。
 *
 * 前置条件: 用户需先安装官方 gemini-cli 并完成登录授权。
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { KodaXBaseProvider } from './base.js';
import {
    KodaXProviderConfig,
    KodaXMessage,
    KodaXToolDefinition,
    KodaXProviderStreamOptions,
    KodaXStreamResult,
    KodaXTextBlock,
    KodaXToolUseBlock,
    KodaXThinkingBlock,
    KodaXRedactedThinkingBlock,
} from '../types.js';
import { KODAX_MAX_TOKENS } from '../constants.js';

// ============== 端点配置 ==============

const CODE_ASSIST_ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://autopush-cloudcode-pa.sandbox.googleapis.com',
];

const GEMINI_CLI_HEADERS = {
    'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'X-Goog-Api-Client': `gl-node/${process.versions.node}`,
    'Client-Metadata': JSON.stringify({
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
    }),
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ============== 风险提示 ==============

const RISK_WARNING = `
⚠️  [KodaX Gemini CLI Provider] 非官方集成提示
──────────────────────────────────────
此集成方式并非 Google 官方支持或认可。
部分用户报告了在使用第三方 Gemini CLI OAuth 客户端后
账户被限制或封禁的情况。请知悉并自行承担风险。
──────────────────────────────────────
`.trim();

let riskWarningShown = false;

// ============== 凭证提取工具 ==============

let cachedGeminiCliCredentials: { clientId: string; clientSecret: string } | null = null;

/**
 * 从已安装的 Gemini CLI 的 oauth2.js 中提取 OAuth Client ID 和 Client Secret
 */
export function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
    if (cachedGeminiCliCredentials) {
        return cachedGeminiCliCredentials;
    }

    try {
        const geminiPath = findInPath('gemini');
        if (!geminiPath) {
            return null;
        }

        const resolvedPath = realpathSync(geminiPath);
        const geminiCliDirs = resolveGeminiCliDirs(geminiPath, resolvedPath);

        let content: string | null = null;
        for (const geminiCliDir of geminiCliDirs) {
            const searchPaths = [
                join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'),
                join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'code_assist', 'oauth2.js'),
            ];

            for (const p of searchPaths) {
                if (existsSync(p)) {
                    content = readFileSync(p, 'utf8');
                    break;
                }
            }
            if (content) break;

            // 递归搜索 oauth2.js
            const found = findFile(geminiCliDir, 'oauth2.js', 10);
            if (found) {
                content = readFileSync(found, 'utf8');
                break;
            }
        }
        if (!content) return null;

        const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
        const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
        if (idMatch && secretMatch) {
            cachedGeminiCliCredentials = { clientId: idMatch[1], clientSecret: secretMatch[1] };
            return cachedGeminiCliCredentials;
        }
    } catch (e) {
        console.debug('[GeminiCli] 凭证提取失败:', e instanceof Error ? e.message : e);
    }
    return null;
}

function resolveGeminiCliDirs(geminiPath: string, resolvedPath: string): string[] {
    const binDir = dirname(geminiPath);
    const candidates = [
        dirname(dirname(resolvedPath)),
        join(dirname(resolvedPath), 'node_modules', '@google', 'gemini-cli'),
        join(binDir, 'node_modules', '@google', 'gemini-cli'),
        join(dirname(binDir), 'node_modules', '@google', 'gemini-cli'),
        join(dirname(binDir), 'lib', 'node_modules', '@google', 'gemini-cli'),
    ];

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const key = process.platform === 'win32' ? candidate.replace(/\\/g, '/').toLowerCase() : candidate;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
    }
    return deduped;
}

function findInPath(name: string): string | null {
    const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        for (const ext of exts) {
            const p = join(dir, name + ext);
            if (existsSync(p)) return p;
        }
    }
    return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
    if (depth <= 0) return null;
    try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isFile() && e.name === name) return p;
            if (e.isDirectory() && !e.name.startsWith('.')) {
                const found = findFile(p, name, depth - 1);
                if (found) return found;
            }
        }
    } catch (e) { console.debug('[GeminiCli] 文件搜索跳过:', e instanceof Error ? e.message : e); }
    return null;
}

// ============== 本地凭证缓存读取 ==============

const GEMINI_DIR = '.gemini';
const OAUTH_CREDS_FILE = 'oauth_creds.json';

interface GeminiCachedTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

/**
 * 从 ~/.gemini/oauth_creds.json 读取 gemini-cli 登录后缓存的 OAuth Token。
 * 用户只需运行过 `gemini auth login`，KodaX 即可自动复用其凭证。
 */
export function readGeminiCliCachedTokens(): GeminiCachedTokens | null {
    try {
        const credsPath = join(homedir(), GEMINI_DIR, OAUTH_CREDS_FILE);
        if (!existsSync(credsPath)) return null;

        const raw = readFileSync(credsPath, 'utf8');
        const data = JSON.parse(raw) as Record<string, unknown>;

        const accessToken = data.access_token;
        const refreshToken = data.refresh_token;
        const expiryDate = data.expiry_date;

        if (typeof refreshToken !== 'string' || !refreshToken) return null;

        return {
            accessToken: typeof accessToken === 'string' ? accessToken : '',
            refreshToken,
            expiresAt: typeof expiryDate === 'number' ? expiryDate : 0,
        };
    } catch (e) {
        console.debug('[GeminiCli] 本地凭证读取失败:', e instanceof Error ? e.message : e);
        return null;
    }
}

// ============== Project ID 自动发现 ==============

const TIER_FREE = 'free-tier';
const TIER_LEGACY = 'legacy-tier';

function resolvePlatform(): string {
    if (process.platform === 'win32') return 'WINDOWS';
    if (process.platform === 'darwin') return 'MACOS';
    return 'PLATFORM_UNSPECIFIED';
}

/**
 * 通过 Cloud Code Assist API 自动发现用户的 Google Cloud Project ID。
 * 参考 OpenClaw 的实现。
 */
async function discoverProject(accessToken: string): Promise<string> {
    const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GEMINI_CLI_PROJECT_ID;
    const platform = resolvePlatform();
    const metadata = { ideType: 'IDE_UNSPECIFIED', platform, pluginType: 'GEMINI' };

    const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': `google-api-nodejs-client/9.15.1`,
        'X-Goog-Api-Client': `gl-node/${process.versions.node}`,
        'Client-Metadata': JSON.stringify(metadata),
    };

    const loadBody = {
        ...(envProject ? { cloudaicompanionProject: envProject } : {}),
        metadata: {
            ...metadata,
            ...(envProject ? { duetProject: envProject } : {}),
        },
    };

    let data: {
        currentTier?: { id?: string };
        cloudaicompanionProject?: string | { id?: string };
        allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
    } = {};
    let activeEndpoint = CODE_ASSIST_ENDPOINTS[0];
    let loadError: Error | undefined;

    for (const endpoint of CODE_ASSIST_ENDPOINTS) {
        try {
            const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers,
                body: JSON.stringify(loadBody),
            });

            if (!response.ok) {
                loadError = new Error(`loadCodeAssist failed: ${response.status}`);
                continue;
            }

            data = await response.json() as typeof data;
            activeEndpoint = endpoint;
            loadError = undefined;
            break;
        } catch (err) {
            loadError = err instanceof Error ? err : new Error('loadCodeAssist failed');
        }
    }

    // 如果 loadCodeAssist 有数据，提取 projectId
    if (data.currentTier) {
        const project = data.cloudaicompanionProject;
        if (typeof project === 'string' && project) return project;
        if (typeof project === 'object' && project?.id) return project.id;
        if (envProject) return envProject;
        throw new Error(
            '此账户需要设置 GOOGLE_CLOUD_PROJECT 或 GOOGLE_CLOUD_PROJECT_ID 环境变量。'
        );
    }

    // 尝试 onboard 免费层
    const tier = data.allowedTiers?.find(t => t.isDefault) ?? { id: TIER_LEGACY };
    const tierId = tier?.id || TIER_FREE;

    if (tierId !== TIER_FREE && !envProject) {
        if (loadError) throw loadError;
        throw new Error('此账户需要设置 GOOGLE_CLOUD_PROJECT 或 GOOGLE_CLOUD_PROJECT_ID 环境变量。');
    }

    try {
        const onboardBody: Record<string, unknown> = { tierId, metadata };
        if (tierId !== TIER_FREE && envProject) {
            onboardBody.cloudaicompanionProject = envProject;
        }

        const onboardResponse = await fetch(`${activeEndpoint}/v1internal:onboardUser`, {
            method: 'POST',
            headers,
            body: JSON.stringify(onboardBody),
        });

        if (onboardResponse.ok) {
            let lro = await onboardResponse.json() as {
                done?: boolean;
                name?: string;
                response?: { cloudaicompanionProject?: { id?: string } };
            };

            // 轮询 LRO
            if (!lro.done && lro.name) {
                for (let i = 0; i < 12; i++) {
                    await new Promise(r => setTimeout(r, 5000));
                    const pollResponse = await fetch(`${activeEndpoint}/v1internal/${lro.name}`, { headers });
                    if (pollResponse.ok) {
                        lro = await pollResponse.json() as typeof lro;
                        if (lro.done) break;
                    }
                }
            }

            const projectId = lro.response?.cloudaicompanionProject?.id;
            if (projectId) return projectId;
        }
    } catch (e) {
        // onboard 失败，回退到环境变量
        console.debug('[GeminiCli] onboard 失败:', e instanceof Error ? e.message : e);
    }

    if (envProject) return envProject;
    throw new Error(
        '无法自动发现 Google Cloud Project。\n' +
        '请设置环境变量: export GOOGLE_CLOUD_PROJECT="your-project-id"\n' +
        '或确保已通过 gemini-cli 完成登录: gemini auth login'
    );
}

// ============== OAuth Token 管理 ==============

interface GeminiTokenState {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    projectId: string;
    clientId: string;
    clientSecret: string;
}

let tokenState: GeminiTokenState | null = null;

/**
 * 使用提取到的 Client 凭证执行 OAuth Token 刷新
 */
async function refreshAccessToken(state: GeminiTokenState): Promise<void> {
    const body = new URLSearchParams({
        client_id: state.clientId,
        client_secret: state.clientSecret,
        refresh_token: state.refreshToken,
        grant_type: 'refresh_token',
    });

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    if (!response.ok) {
        throw new Error(
            `Gemini Token 刷新失败 (${response.status})。\n` +
            'Token 可能已过期，请重新登录: gemini auth login'
        );
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    state.accessToken = data.access_token;
    state.expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;
}

/**
 * 确保 Token 有效。自动从本地缓存中初始化（若尚未初始化）。
 */
async function ensureValidToken(): Promise<GeminiTokenState> {
    // 风险提示（仅显示一次）
    if (!riskWarningShown) {
        console.warn(RISK_WARNING);
        riskWarningShown = true;
    }

    // 懒加载：首次调用时自动从本地缓存初始化
    if (!tokenState) {
        const creds = extractGeminiCliCredentials();

        // 1. 优先从环境变量覆写
        const envAccess = process.env.GEMINI_CLI_ACCESS_TOKEN;
        const envRefresh = process.env.GEMINI_CLI_REFRESH_TOKEN;

        let accessToken: string;
        let refreshToken: string;
        let expiresAt: number;

        if (envAccess && envRefresh) {
            accessToken = envAccess;
            refreshToken = envRefresh;
            expiresAt = Date.now() + 55 * 60 * 1000;
        } else {
            // 2. 从 ~/.gemini/oauth_creds.json 自动读取
            const cached = readGeminiCliCachedTokens();
            if (!cached) {
                throw new Error(
                    '未找到 Gemini CLI 的登录凭证。\n\n' +
                    '请先在本机安装并登录 Gemini CLI：\n' +
                    '  1. npm install -g @google/gemini-cli\n' +
                    '  2. gemini auth login\n\n' +
                    '登录完成后 KodaX 会自动读取本地凭证，无需额外配置。'
                );
            }
            accessToken = cached.accessToken;
            refreshToken = cached.refreshToken;
            expiresAt = cached.expiresAt;
        }

        // 3. 自动发现 ProjectId
        let projectId: string;
        try {
            projectId = await discoverProject(accessToken);
        } catch (e) {
            // 如果发现失败但有环境变量，回退使用
            projectId = process.env.GEMINI_CLI_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
            if (!projectId) {
                console.error('[GeminiCli] Project ID 自动发现失败，将使用空值。如遇问题请设置 GOOGLE_CLOUD_PROJECT 环境变量。');
            }
        }

        tokenState = {
            accessToken,
            refreshToken,
            expiresAt,
            projectId,
            clientId: creds?.clientId ?? '',
            clientSecret: creds?.clientSecret ?? '',
        };
    }

    // Token 过期时自动刷新
    if (Date.now() >= tokenState.expiresAt) {
        await refreshAccessToken(tokenState);
    }

    return tokenState;
}

// ============== 请求/响应类型 ==============

interface CloudCodeAssistRequest {
    project: string;
    model: string;
    request: {
        contents: GeminiContent[];
        systemInstruction?: { role?: string; parts: { text: string }[] };
        generationConfig?: {
            maxOutputTokens?: number;
            temperature?: number;
            thinkingConfig?: { thinkingBudget?: number };
        };
        tools?: GeminiTool[];
        toolConfig?: {
            functionCallingConfig: { mode: string };
        };
    };
}

interface GeminiContent {
    role: string;
    parts: GeminiPart[];
}

interface GeminiPart {
    text?: string;
    thought?: boolean;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiTool {
    functionDeclarations: Array<{
        name: string;
        description: string;
        parameters?: Record<string, unknown>;
    }>;
}

interface CloudCodeAssistResponseChunk {
    response?: {
        candidates?: Array<{
            content?: {
                role: string;
                parts?: Array<{
                    text?: string;
                    thought?: boolean;
                    functionCall?: { name: string; args: Record<string, unknown>; id?: string };
                }>;
            };
            finishReason?: string;
        }>;
        usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            thoughtsTokenCount?: number;
            totalTokenCount?: number;
        };
    };
}

// ============== 消息转换 ==============

function convertMessagesToGemini(
    messages: KodaXMessage[],
    system: string,
    tools: KodaXToolDefinition[]
): CloudCodeAssistRequest['request'] {
    const contents: GeminiContent[] = [];

    // 构建 tool_use_id → name 的映射，用于 tool_result 回传正确的函数名
    const toolNameMap = new Map<string, string>();
    for (const msg of messages) {
        if (typeof msg.content !== 'string') {
            for (const block of msg.content) {
                if (block.type === 'tool_use') {
                    toolNameMap.set(block.id, block.name);
                }
            }
        }
    }

    for (const msg of messages) {
        if (msg.role === 'system') continue; // system 通过 systemInstruction 传递

        const role = msg.role === 'assistant' ? 'model' : 'user';
        const parts: GeminiPart[] = [];

        if (typeof msg.content === 'string') {
            parts.push({ text: msg.content });
        } else {
            for (const block of msg.content) {
                if (block.type === 'text') {
                    parts.push({ text: block.text });
                } else if (block.type === 'thinking') {
                    parts.push({ text: block.thinking, thought: true });
                } else if (block.type === 'tool_use') {
                    parts.push({ functionCall: { name: block.name, args: block.input } });
                } else if (block.type === 'tool_result') {
                    const originalName = toolNameMap.get(block.tool_use_id) ?? block.tool_use_id;
                    parts.push({
                        functionResponse: {
                            name: originalName,
                            response: { content: block.content },
                        },
                    });
                }
            }
        }

        if (parts.length > 0) {
            contents.push({ role, parts });
        }
    }

    const geminiTools: GeminiTool[] = tools.length > 0
        ? [{
            functionDeclarations: tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
            })),
        }]
        : [];

    return {
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
            maxOutputTokens: KODAX_MAX_TOKENS,
        },
        tools: geminiTools.length > 0 ? geminiTools : undefined,
        toolConfig: geminiTools.length > 0 ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
    };
}

// ============== Provider 实现 ==============

export class KodaXGeminiCliProvider extends KodaXBaseProvider {
    readonly name = 'gemini-cli';
    readonly supportsThinking = true;
    protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'GEMINI_CLI_ACCESS_TOKEN', // 仅作为可选覆写
        model: 'gemini-2.5-pro',
        supportsThinking: true,
        contextWindow: 1000000,
    };

    constructor() {
        super();
        // Token 状态会在首次调用 stream() 时懒加载
    }

    /**
     * 判断此 Provider 是否可用：
     * 1. 环境变量中有 access/refresh token，或
     * 2. 本地 ~/.gemini/oauth_creds.json 存在且有效
     */
    override isConfigured(): boolean {
        if (process.env.GEMINI_CLI_ACCESS_TOKEN && process.env.GEMINI_CLI_REFRESH_TOKEN) return true;
        return readGeminiCliCachedTokens() !== null;
    }

    override getModel(): string {
        return process.env.GEMINI_CLI_MODEL ?? this.config.model;
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
            const state = await ensureValidToken();
            const model = this.getModel();

            const requestPayload = convertMessagesToGemini(messages, system, tools);

            // 如果启用 thinking，添加 thinkingConfig
            if (thinking && requestPayload.generationConfig) {
                requestPayload.generationConfig.thinkingConfig = { thinkingBudget: 10000 };
            }

            const body: CloudCodeAssistRequest = {
                project: state.projectId,
                model,
                request: requestPayload,
            };

            const requestHeaders: Record<string, string> = {
                'Authorization': `Bearer ${state.accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                ...GEMINI_CLI_HEADERS,
            };

            const bodyJson = JSON.stringify(body);

            // 带重试的请求逻辑
            let response: Response | undefined;
            let lastError: Error | undefined;

            for (let attempt = 0; attempt <= 3; attempt++) {
                if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');

                const endpointIndex = Math.min(attempt, CODE_ASSIST_ENDPOINTS.length - 1);
                const endpoint = CODE_ASSIST_ENDPOINTS[endpointIndex];
                const requestUrl = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

                try {
                    response = await fetch(requestUrl, {
                        method: 'POST',
                        headers: requestHeaders,
                        body: bodyJson,
                        signal,
                    });

                    if (response.ok) break;

                    const errorText = await response.text();

                    // 403/404 尝试下一个端点
                    if ((response.status === 403 || response.status === 404) && endpointIndex < CODE_ASSIST_ENDPOINTS.length - 1) {
                        continue;
                    }

                    // 可重试的错误
                    if (attempt < 3 && [429, 500, 502, 503, 504].includes(response.status)) {
                        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
                        continue;
                    }

                    throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText.slice(0, 200)}`);
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
                throw lastError ?? new Error('Failed to get response after retries');
            }

            // 解析 SSE 流
            return this.parseSSEStream(response, streamOptions, signal);
        }, signal);
    }

    private async parseSSEStream(
        response: Response,
        streamOptions?: KodaXProviderStreamOptions,
        signal?: AbortSignal
    ): Promise<KodaXStreamResult> {
        if (!response.body) throw new Error('No response body');

        const textBlocks: KodaXTextBlock[] = [];
        const toolBlocks: KodaXToolUseBlock[] = [];
        const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] = [];

        let currentText = '';
        let currentThinking = '';

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');

                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;

                    const jsonStr = line.slice(5).trim();
                    if (!jsonStr) continue;

                    let chunk: CloudCodeAssistResponseChunk;
                    try {
                        chunk = JSON.parse(jsonStr);
                    } catch (e) {
                        console.debug('[GeminiCli] SSE chunk 解析失败:', e instanceof Error ? e.message : e);
                        continue;
                    }

                    const responseData = chunk.response;
                    if (!responseData) continue;

                    const candidate = responseData.candidates?.[0];
                    if (candidate?.content?.parts) {
                        for (const part of candidate.content.parts) {
                            if (part.text !== undefined) {
                                if (part.thought) {
                                    // Thinking
                                    currentThinking += part.text;
                                    streamOptions?.onThinkingDelta?.(part.text);
                                } else {
                                    // Text
                                    currentText += part.text;
                                    streamOptions?.onTextDelta?.(part.text);
                                }
                            }

                            if (part.functionCall) {
                                const toolCallId = part.functionCall.id ?? `toolu_${randomUUID()}`;
                                const toolCall: KodaXToolUseBlock = {
                                    type: 'tool_use',
                                    id: part.functionCall.id ?? toolCallId,
                                    name: part.functionCall.name || '',
                                    input: part.functionCall.args ?? {},
                                };
                                toolBlocks.push(toolCall);
                                streamOptions?.onToolInputDelta?.(toolCall.name, JSON.stringify(toolCall.input));
                            }
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        // 汇总结果
        if (currentThinking) {
            thinkingBlocks.push({ type: 'thinking', thinking: currentThinking });
            streamOptions?.onThinkingEnd?.(currentThinking);
        }
        if (currentText) {
            textBlocks.push({ type: 'text', text: currentText });
        }

        return { textBlocks, toolBlocks, thinkingBlocks };
    }
}
