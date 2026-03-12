import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import process from 'node:process';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
export class AcpClient {
    client = null;
    agentProcess = null;
    options;
    constructor(options) {
        this.options = options;
    }
    async connect() {
        let inStream;
        let outStream;
        if (this.options.inputStream && this.options.outputStream) {
            inStream = this.options.inputStream;
            outStream = this.options.outputStream;
        }
        else if (this.options.command) {
            const isWin = process.platform === 'win32';
            const cmd = isWin && !this.options.command.endsWith('.cmd') ? `${this.options.command}.cmd` : this.options.command;
            this.agentProcess = spawn(cmd, this.options.args ?? [], {
                cwd: this.options.cwd ?? process.cwd(),
                stdio: ['pipe', 'pipe', 'inherit']
            });
            if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
                throw new Error("Failed to create ACP stdio pipes");
            }
            outStream = Writable.toWeb(this.agentProcess.stdin);
            inStream = Readable.toWeb(this.agentProcess.stdout);
        }
        else {
            throw new Error("AcpClient requires either a command or I/O streams");
        }
        const stream = ndJsonStream(outStream, inStream);
        this.client = new ClientSideConnection(() => ({
            sessionUpdate: async (params) => {
                this.options.onSessionUpdate?.(params);
            },
            requestPermission: async (_params) => {
                const options = _params.options ?? [];
                const allowOption = options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
                if (allowOption) {
                    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
                }
                return { outcome: { outcome: 'cancelled' } };
            }
        }), stream);
        await this.client.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "kodax-ai-acp-client", version: "1.0.0" }
        });
    }
    async createNewSession() {
        if (!this.client)
            throw new Error("Client not connected");
        const session = await this.client.newSession({
            cwd: this.options.cwd ?? process.cwd(),
            mcpServers: []
        });
        return session.sessionId;
    }
    async prompt(text, sessionId, signal) {
        if (!this.client)
            throw new Error("Client not connected");
        let responsePromise = this.client.prompt({
            sessionId,
            prompt: [{ type: "text", text }]
        });
        if (signal) {
            const onAbort = () => {
                this.client?.cancel({ sessionId }).catch(() => { });
            };
            signal.addEventListener('abort', onAbort);
            responsePromise = responsePromise.finally(() => {
                signal.removeEventListener('abort', onAbort);
            });
        }
        await responsePromise;
    }
    disconnect() {
        this.agentProcess?.kill();
        this.options.abort?.(); // triggering cleanup in pseudo server
        try {
            this.client?.close?.();
        }
        catch (e) { }
        this.client = null;
    }
}
//# sourceMappingURL=acp-client.js.map