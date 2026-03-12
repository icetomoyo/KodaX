import { KodaXAcpProvider } from './acp-base.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';
export declare class KodaXCodexCliProvider extends KodaXAcpProvider {
    readonly name = "codex-cli";
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig;
    protected readonly acpClientOptions: AcpClientOptions;
    constructor();
}
//# sourceMappingURL=codex-cli.d.ts.map