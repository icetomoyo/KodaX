import { TransformStream } from 'node:stream/web';
import { randomUUID } from 'node:crypto';
import type { CLIExecutor } from './executor.js';
import type { CLIEvent } from './types.js';

/**
 * Create an in-memory pseudo ACP server backed by a CLI executor.
 * It accepts ACP JSON-RPC requests, forwards prompts into the executor, and
 * converts emitted CLI events back into ACP session updates.
 */
export function createPseudoAcpServer(executor: CLIExecutor): {
    inputStream: ReadableStream<Uint8Array>;
    outputStream: WritableStream<Uint8Array>;
    abort: () => void;
    executor: CLIExecutor;
} {
    type PromptCompletion = Promise<{
        stopReason: 'end_turn' | 'cancelled';
        usage?: Extract<CLIEvent, { type: 'complete' }>['usage'];
    }>;

    // Client writes to reqStream.writable; server reads from reqStream.readable.
    const reqStream = new TransformStream<Uint8Array, Uint8Array>();

    // Server writes to resStream.writable; client reads from resStream.readable.
    const resStream = new TransformStream<Uint8Array, Uint8Array>();

    const serverReader = reqStream.readable.getReader();
    const serverWriter = resStream.writable.getWriter();

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    let buffer = '';
    let currentSessionId = randomUUID();
    const abortController = new AbortController();
    const activePrompts = new Map<string, AbortController>();

    // Background loop that reads JSON-RPC requests from the client side.
    (async () => {
        try {
            while (true) {
                const { done, value } = await serverReader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const message = JSON.parse(line);
                        void handleRequest(message).catch((error) => {
                            console.error('[PseudoAcpServer] Failed to handle request:', error);
                        });
                    } catch {
                        console.error('[PseudoAcpServer] Failed to parse message:', line);
                    }
                }
            }
        } catch (err) {
            console.error('[PseudoAcpServer] Stream read error:', err);
        }
    })();

    // Send a JSON-RPC message back to the client.
    const sendMsg = async (msg: any) => {
        const payload = JSON.stringify(msg) + '\n';
        await serverWriter.write(encoder.encode(payload));
    };

    // Dispatch incoming ACP requests.
    async function handleRequest(req: any) {
        if (req.method === 'initialize') {
            await sendMsg({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                    protocolVersion: req.params.protocolVersion,
                    serverInfo: { name: 'pseudo-acp-server', version: '1.0.0' },
                    serverCapabilities: {}
                }
            });
        } else if (req.method === 'session/new' || req.method === 'sessions/new') {
            currentSessionId = req.params?.sessionId ?? randomUUID();
            await sendMsg({
                jsonrpc: '2.0',
                id: req.id,
                result: { sessionId: currentSessionId }
            });
        } else if (req.method === 'session/prompt' || req.method === 'chat/prompt') {
            const controller = new AbortController();
            const sessionId = req.params.sessionId;
            activePrompts.set(sessionId, controller);

            // Mirror global aborts into the per-prompt controller.
            const onGlobalAbort = () => controller.abort();
            abortController.signal.addEventListener('abort', onGlobalAbort);

            // Kick off the backing CLI execution and only resolve the ACP prompt
            // request once the backing turn has actually completed.
            const promptCompletion: PromptCompletion = executePrompt(
                sessionId,
                req.params.prompt,
                typeof req.params.model === 'string' ? req.params.model : undefined,
                controller.signal,
            ).finally(() => {
                activePrompts.delete(sessionId);
                abortController.signal.removeEventListener('abort', onGlobalAbort);
            });

            const promptResult = await promptCompletion;
            await sendMsg({
                jsonrpc: '2.0',
                id: req.id,
                result: promptResult.usage
                    ? { stopReason: promptResult.stopReason, usage: promptResult.usage }
                    : { stopReason: promptResult.stopReason },
            });
        } else if (req.method === 'session/cancel' || req.method === 'chat/cancel') {
            const controller = activePrompts.get(req.params.sessionId);
            if (controller) {
                controller.abort();
            }
            if (req.id !== undefined) {
                await sendMsg({ jsonrpc: '2.0', id: req.id, result: {} });
            }
        } else {
            // Silently succeed for unsupported methods so the pseudo server stays
            // permissive enough for our bridge tests and adapters.
            if (req.id !== undefined) {
                await sendMsg({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {}
                });
            }
        }
    }

    // Translate executor events into ACP notifications.
    const executePrompt = async (
        sessionId: string,
        promptBlocks: any[],
        model: string | undefined,
        signal: AbortSignal,
    ): Promise<{ stopReason: 'end_turn' | 'cancelled'; usage?: Extract<CLIEvent, { type: 'complete' }>['usage'] }> => {
        const text = promptBlocks.find((b: any) => b.type === 'text')?.text ?? '';

        try {
            const events = executor.execute({
                prompt: text,
                model,
                sessionId: sessionId === 'default' ? undefined : sessionId,
                signal
            });

            for await (const cliEvent of events) {
                const acpUpdate = mapToAcpNotification(cliEvent);
                if (acpUpdate) {
                    await sendMsg({
                        jsonrpc: '2.0',
                        method: 'session/update',
                        params: {
                            sessionId,
                            update: acpUpdate
                        }
                    });
                }

                if (cliEvent.type === 'complete') {
                    return {
                        stopReason: signal.aborted ? 'cancelled' : 'end_turn',
                        usage: cliEvent.usage,
                    };
                }
            }

            return {
                stopReason: signal.aborted ? 'cancelled' : 'end_turn',
            };
        } catch (err) {
            if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                return { stopReason: 'cancelled' };
            }

            console.error('[PseudoAcpServer] Error executing prompt:', err);
            await sendMsg({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                    sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: `\n[Fatal Error: ${err}]\n` }
                    }
                }
            });
            return { stopReason: 'end_turn' };
        }
    };

    const mapToAcpNotification = (event: CLIEvent): any => {
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
                    arguments: event.parameters,
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
                // We currently rely on stream completion instead of emitting a
                // dedicated ACP completion update.
                break;
        }
        return null;
    };

    return {
        inputStream: resStream.readable,
        outputStream: reqStream.writable,
        abort: () => {
            abortController.abort();
            reqStream.readable.cancel().catch(() => { });
            resStream.writable.abort().catch(() => { });
        },
        executor
    };
}
