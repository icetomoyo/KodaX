import { KodaXBaseProvider } from './base.js';
import { AcpClient } from '../cli-events/acp-client.js';
import { CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE, cloneCapabilityProfile } from './capability-profile.js';
/**
 * 通用的 ACP Provider 基类。
 * 通过传入 Client Options，它可以连接原生的 CLI 命令，
 * 也可以连接我们在内存中伪造的 PseudoAcpServer。
 */
export class KodaXAcpProvider extends KodaXBaseProvider {
    _client = null;
    _sessionMap = new Map();
    _activeStreams = new Map();
    // 我们暂时不需要依赖真实的 API key，除非伪装层需要
    isConfigured() {
        return true;
    }
    getCapabilityProfile() {
        return cloneCapabilityProfile(CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE);
    }
    async stream(messages, tools, system, thinking, streamOptions, signal) {
        // 如果我们使用的是 Pseudo Server，在这里检查对应的 CLI 是否安装
        if (this.acpClientOptions.executor && typeof this.acpClientOptions.executor.isInstalled === 'function') {
            if (!await this.acpClientOptions.executor.isInstalled()) {
                throw new Error(`${this.name} 所需的 CLI 环境未正确安装或配置，请检查终端日志或手册。`);
            }
        }
        const textBlocks = [];
        const toolBlocks = [];
        // Flatten the KodaXMessages into a single string prompt since ACP `prompt`
        // primarily takes an array of prompt blocks.
        // For ACP session resumption, KodaX expects the CLI to maintain context via sessionId.
        // We will send the LAST user message if streamOptions.sessionId matches our active session.
        const latestMessage = messages[messages.length - 1];
        let promptText = '';
        if (latestMessage && typeof latestMessage.content === 'string') {
            promptText = latestMessage.content;
        }
        else if (latestMessage && Array.isArray(latestMessage.content)) {
            promptText = latestMessage.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n');
        }
        // 构造 Client 监听事件 (只需要初始化一次)
        const options = {
            ...this.acpClientOptions,
            onSessionUpdate: (notification) => {
                const update = notification.update;
                const sessionId = notification.sessionId; // ACP SDK includes sessionId at root for session notifications
                if (!('sessionUpdate' in update))
                    return;
                const activeCtx = sessionId ? this._activeStreams.get(sessionId) : undefined;
                if (!activeCtx)
                    return;
                switch (update.sessionUpdate) {
                    case 'agent_message_chunk':
                        if (update.content?.type === 'text') {
                            const chunk = update.content.text;
                            activeCtx.output.text += chunk;
                            activeCtx.streamOptions?.onTextDelta?.(chunk);
                        }
                        break;
                    case 'tool_call':
                        let toolArgs = "{}";
                        const rawArgs = update.arguments;
                        if (rawArgs) {
                            toolArgs = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
                        }
                        activeCtx.streamOptions?.onToolInputDelta?.(update.title, toolArgs);
                        const logEntry = `\n> [Tool Use] ${update.title}: ${toolArgs}\n`;
                        activeCtx.output.text += logEntry;
                        activeCtx.streamOptions?.onTextDelta?.(logEntry);
                        break;
                    case 'tool_call_update':
                        if (update.status) {
                            const resEntry = `> [Tool Result] ${update.status}\n\n`;
                            activeCtx.output.text += resEntry;
                            activeCtx.streamOptions?.onTextDelta?.(resEntry);
                        }
                        break;
                }
            }
        };
        const kodaxSessionId = streamOptions?.sessionId ?? 'default';
        if (!this._client) {
            this._client = new AcpClient(options);
            await this._client.connect();
        }
        let acpSessionId = this._sessionMap.get(kodaxSessionId);
        if (!acpSessionId) {
            acpSessionId = await this._client.createNewSession();
            this._sessionMap.set(kodaxSessionId, acpSessionId);
        }
        const localOutput = { text: '' };
        this._activeStreams.set(acpSessionId, {
            streamOptions,
            output: localOutput
        });
        try {
            await this._client.prompt(promptText, acpSessionId, signal);
        }
        catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                // User aborted, this is fine
            }
            else {
                throw err;
            }
        }
        finally {
            this._activeStreams.delete(acpSessionId);
        }
        if (localOutput.text) {
            textBlocks.push({ type: 'text', text: localOutput.text });
        }
        return {
            textBlocks,
            toolBlocks,
            thinkingBlocks: []
        };
    }
    /**
     * 手动关闭并清理当前 Provider 维护的 ACP 连接
     */
    disconnect() {
        if (this._client) {
            this._client.disconnect();
            this._client = null;
        }
        this._sessionMap.clear();
    }
}
//# sourceMappingURL=acp-base.js.map
