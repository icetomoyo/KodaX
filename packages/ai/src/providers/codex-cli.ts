import { KodaXAcpProvider } from './acp-base.js';
import { CodexCLIExecutor } from '../cli-events/codex-parser.js';
import { createPseudoAcpServer } from '../cli-events/pseudo-acp-server.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';
import { getCodexCliDefaultModel, getCodexCliKnownModels } from './cli-bridge-models.js';

const DEFAULT_CODEX_MODEL = getCodexCliDefaultModel();
const CODEX_MODELS = getCodexCliKnownModels();

export class KodaXCodexCliProvider extends KodaXAcpProvider {
    readonly name = 'codex-cli';
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig = {
        apiKeyEnv: 'CODEX_CLI_API_KEY', // Dummy, not used but required by base
        model: DEFAULT_CODEX_MODEL,
        models: CODEX_MODELS
            .filter((model) => model !== DEFAULT_CODEX_MODEL)
            .map((model) => ({ id: model, displayName: model })),
        supportsThinking: false,
        reasoningCapability: 'prompt-only',
        contextWindow: 128000,
    };

    protected readonly acpClientOptions: AcpClientOptions;

    constructor() {
        super();
        const executor = new CodexCLIExecutor({ model: DEFAULT_CODEX_MODEL });
        this.acpClientOptions = createPseudoAcpServer(executor);
    }
}
