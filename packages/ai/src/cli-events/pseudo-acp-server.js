import { TransformStream } from 'node:stream/web';
import { randomUUID } from 'node:crypto';
/**
 * 创建一个伪装的 ACP Server 内存流对。
 * 它会在内部拦截客户端发来的 JSON-RPC 请求，
 * 并在收到 `prompt` 时启动传入的 CLIExecutor，将输出转换成 ACP 事件返回。
 */
export function createPseudoAcpServer(executor, executorModel) {
    // Client writes to reqStream.writable
    // Server reads from reqStream.readable
    const reqStream = new TransformStream();
    // Server writes to resStream.writable
    // Client reads from resStream.readable
    const resStream = new TransformStream();
    const serverReader = reqStream.readable.getReader();
    const serverWriter = resStream.writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let currentSessionId = randomUUID();
    const abortController = new AbortController();
    const activePrompts = new Map();
    // 独立循环：接收来自 Client 的请求
    (async () => {
        try {
            while (true) {
                const { done, value } = await serverReader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    try {
                        const message = JSON.parse(line);
                        handleRequest(message);
                    }
                    catch (e) {
                        console.error("[PseudoAcpServer] Failed to parse message:", line);
                    }
                }
            }
        }
        catch (err) {
            console.error("[PseudoAcpServer] Stream read error:", err);
        }
    })();
    // 发送报文给 Client
    const sendMsg = async (msg) => {
        const payload = JSON.stringify(msg) + '\n';
        await serverWriter.write(encoder.encode(payload));
    };
    // 分发请求
    async function handleRequest(req) {
        if (req.method === 'initialize') {
            await sendMsg({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                    protocolVersion: req.params.protocolVersion,
                    serverInfo: { name: "pseudo-acp-server", version: "1.0.0" },
                    serverCapabilities: {}
                }
            });
        }
        else if (req.method === 'sessions/new') {
            currentSessionId = req.params?.sessionId ?? randomUUID();
            await sendMsg({
                jsonrpc: "2.0",
                id: req.id,
                result: { sessionId: currentSessionId }
            });
        }
        else if (req.method === 'chat/prompt') {
            // ACK 请求
            await sendMsg({
                jsonrpc: "2.0",
                id: req.id,
                result: {}
            });
            const controller = new AbortController();
            const sessionId = req.params.sessionId;
            activePrompts.set(sessionId, controller);
            // 监听全局销毁事件
            const onGlobalAbort = () => controller.abort();
            abortController.signal.addEventListener('abort', onGlobalAbort);
            // 启动 Executor 进行真实对话
            executePrompt(sessionId, req.params.prompt, controller.signal).finally(() => {
                activePrompts.delete(sessionId);
                abortController.signal.removeEventListener('abort', onGlobalAbort);
            });
        }
        else if (req.method === 'chat/cancel') {
            const controller = activePrompts.get(req.params.sessionId);
            if (controller) {
                controller.abort();
            }
            if (req.id !== undefined) {
                await sendMsg({ jsonrpc: "2.0", id: req.id, result: {} });
            }
        }
        else {
            // 其他尚未支持的协议调用，静默返回成功或忽略
            if (req.id !== undefined) {
                await sendMsg({
                    jsonrpc: "2.0",
                    id: req.id,
                    result: {}
                });
            }
        }
    }
    ;
    // 核心转换逻辑
    const executePrompt = async (sessionId, promptBlocks, signal) => {
        const text = promptBlocks.find((b) => b.type === 'text')?.text ?? '';
        try {
            const events = executor.execute({
                prompt: text,
                sessionId: sessionId === 'default' ? undefined : sessionId,
                signal
            });
            for await (const cliEvent of events) {
                const acpUpdate = mapToAcpNotification(cliEvent);
                if (acpUpdate) {
                    await sendMsg({
                        jsonrpc: "2.0",
                        method: "notifications/session_update",
                        params: {
                            sessionId: sessionId,
                            update: acpUpdate
                        }
                    });
                }
            }
        }
        catch (err) {
            console.error("[PseudoAcpServer] Error executing prompt:", err);
            await sendMsg({
                jsonrpc: "2.0",
                method: "notifications/session_update",
                params: {
                    sessionId: sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: `\n[Fatal Error: ${err}]\n` }
                    }
                }
            });
        }
    };
    const mapToAcpNotification = (event) => {
        switch (event.type) {
            case 'message':
                if (event.role === 'assistant' && event.content) {
                    return {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: event.content }
                    };
                }
                break;
            case 'tool_use':
                return {
                    sessionUpdate: 'tool_call',
                    title: event.toolName,
                    status: 'running',
                    toolCallId: event.toolId || randomUUID()
                };
            case 'tool_result':
                return {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: event.toolId,
                    status: event.status
                };
            case 'error':
                return {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `\n[Error: ${event.message}]\n` }
                };
            case 'complete':
                // 暂时不映射结束原因，依靠流结束
                break;
        }
        return null;
    };
    return {
        inputStream: reqStream.readable,
        outputStream: resStream.writable,
        abort: () => {
            abortController.abort();
            reqStream.readable.cancel().catch(() => { });
            resStream.writable.abort().catch(() => { });
        },
        executor
    };
}
//# sourceMappingURL=pseudo-acp-server.js.map