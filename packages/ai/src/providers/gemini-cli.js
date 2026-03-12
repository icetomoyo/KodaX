import { KodaXAcpProvider } from './acp-base.js';
import { GeminiCLIExecutor } from '../cli-events/gemini-parser.js';
import { createPseudoAcpServer } from '../cli-events/pseudo-acp-server.js';
export class KodaXGeminiCliProvider extends KodaXAcpProvider {
    name = 'gemini-cli';
    supportsThinking = false;
    config = {
        apiKeyEnv: 'GEMINI_CLI_API_KEY', // Dummy, not used but required by base
        model: 'gemini-2.5-pro',
        supportsThinking: false,
        contextWindow: 1048576, // Gemini 1M context
    };
    acpClientOptions;
    constructor() {
        super();
        const executor = new GeminiCLIExecutor();
        this.acpClientOptions = createPseudoAcpServer(executor, this.config.model);
    }
}
//# sourceMappingURL=gemini-cli.js.map