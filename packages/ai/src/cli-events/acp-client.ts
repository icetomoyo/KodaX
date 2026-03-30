import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import process from 'node:process';
import {
    ClientSideConnection,
    PROTOCOL_VERSION,
    ndJsonStream,
    type SessionNotification,
    type PromptResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse
} from '@agentclientprotocol/sdk';

export interface AcpClientOptions {
    /** Command used to launch a native ACP server process. */
    command?: string;
    /** Arguments passed to the native ACP server process. */
    args?: string[];
    /** Readable side of an in-memory pseudo ACP server transport. */
    inputStream?: ReadableStream<Uint8Array>;
    outputStream?: WritableStream<Uint8Array>;
    /** Working directory for spawned native ACP processes. */
    cwd?: string;
    /** Session update callback forwarded from the ACP connection. */
    onSessionUpdate?: (update: SessionNotification) => void;
    /** Cleanup hook used by the in-memory pseudo server transport. */
    abort?: () => void;
    /** Optional executor exposed for install checks in higher layers. */
    executor?: import('./executor.js').CLIExecutor;
}

export class AcpClient {
    private client: ClientSideConnection | null = null;
    private agentProcess: ChildProcess | null = null;
    private options: AcpClientOptions;

    constructor(options: AcpClientOptions) {
        this.options = options;
    }

    async connect(): Promise<void> {
        let inStream: ReadableStream<Uint8Array>;
        let outStream: WritableStream<Uint8Array>;

        if (this.options.inputStream && this.options.outputStream) {
            inStream = this.options.inputStream;
            outStream = this.options.outputStream;
        } else if (this.options.command) {
            const isWin = process.platform === 'win32';
            const cmd = isWin && !this.options.command.endsWith('.cmd') ? `${this.options.command}.cmd` : this.options.command;

            this.agentProcess = spawn(cmd, this.options.args ?? [], {
                cwd: this.options.cwd ?? process.cwd(),
                stdio: ['pipe', 'pipe', 'inherit']
            });

            if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
                throw new Error('Failed to create ACP stdio pipes');
            }

            outStream = Writable.toWeb(this.agentProcess.stdin);
            inStream = Readable.toWeb(this.agentProcess.stdout) as unknown as ReadableStream<Uint8Array>;
        } else {
            throw new Error('AcpClient requires either a command or I/O streams');
        }

        const stream = ndJsonStream(outStream, inStream);

        this.client = new ClientSideConnection(
            () => ({
                sessionUpdate: async (params: SessionNotification) => {
                    this.options.onSessionUpdate?.(params);
                },
                requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
                    const options = params.options ?? [];
                    const allowOption = options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
                    if (allowOption) {
                        return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
                    }
                    return { outcome: { outcome: 'cancelled' } };
                }
            }),
            stream
        );

        await this.client.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: 'kodax-ai-acp-client', version: '1.0.0' }
        });
    }

    async createNewSession(): Promise<string> {
        if (!this.client) throw new Error('Client not connected');

        const session = await this.client.newSession({
            cwd: this.options.cwd ?? process.cwd(),
            mcpServers: []
        });

        return session.sessionId;
    }

    async prompt(
        text: string,
        sessionId: string,
        signal?: AbortSignal,
        options?: { model?: string },
    ): Promise<PromptResponse> {
        if (!this.client) throw new Error('Client not connected');

        const request: {
            sessionId: string;
            prompt: Array<{ type: 'text'; text: string }>;
            model?: string;
        } = {
            sessionId,
            prompt: [{ type: 'text', text }]
        };

        if (options?.model) {
            request.model = options.model;
        }

        let responsePromise = (this.client as unknown as {
            prompt: (params: typeof request) => Promise<PromptResponse>;
        }).prompt(request);

        if (signal) {
            const onAbort = () => {
                this.client?.cancel({ sessionId }).catch(() => { });
            };
            signal.addEventListener('abort', onAbort);
            responsePromise = responsePromise.finally(() => {
                signal.removeEventListener('abort', onAbort);
            });
        }

        return await responsePromise;
    }

    disconnect(): void {
        this.agentProcess?.kill();
        this.options.abort?.();
        try { (this.client as any)?.close?.(); } catch { }
        this.client = null;
    }
}
