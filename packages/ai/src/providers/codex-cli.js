import { KodaXAcpProvider } from './acp-base.js';
import { CodexCLIExecutor } from '../cli-events/codex-parser.js';
import { createPseudoAcpServer } from '../cli-events/pseudo-acp-server.js';
export class KodaXCodexCliProvider extends KodaXAcpProvider {
    name = 'codex-cli';
    supportsThinking = false;
    config = {
        apiKeyEnv: 'CODEX_CLI_API_KEY', // Dummy, not used but required by base
        model: 'codex',
        supportsThinking: false,
        contextWindow: 128000,
    };
    acpClientOptions;
    constructor() {
        super();
        const executor = new CodexCLIExecutor();
        this.acpClientOptions = createPseudoAcpServer(executor, this.config.model);
    }
}
//# sourceMappingURL=codex-cli.js.map