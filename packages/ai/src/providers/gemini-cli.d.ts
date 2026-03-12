import { KodaXAcpProvider } from './acp-base.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';
export declare class KodaXGeminiCliProvider extends KodaXAcpProvider {
    readonly name = "gemini-cli";
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig;
    protected readonly acpClientOptions: AcpClientOptions;
    constructor();
}
//# sourceMappingURL=gemini-cli.d.ts.map