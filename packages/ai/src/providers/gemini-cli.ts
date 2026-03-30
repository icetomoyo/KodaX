import { KodaXAcpProvider } from './acp-base.js';
import { GeminiCLIExecutor } from '../cli-events/gemini-parser.js';
import { createPseudoAcpServer } from '../cli-events/pseudo-acp-server.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';
import { getGeminiCliDefaultModel, getGeminiCliKnownModels } from './cli-bridge-models.js';

const DEFAULT_GEMINI_MODEL = getGeminiCliDefaultModel();
const GEMINI_MODELS = getGeminiCliKnownModels();

export class KodaXGeminiCliProvider extends KodaXAcpProvider {
    readonly name = 'gemini-cli';
    readonly supportsThinking = false;
    protected readonly config: import('../types.js').KodaXProviderConfig = {
        apiKeyEnv: 'GEMINI_CLI_API_KEY', // Dummy, not used but required by base
        model: DEFAULT_GEMINI_MODEL,
        models: GEMINI_MODELS
            .filter((model) => model !== DEFAULT_GEMINI_MODEL)
            .map((model) => ({ id: model, displayName: model })),
        supportsThinking: false,
        reasoningCapability: 'prompt-only',
        contextWindow: 1048576, // Gemini 1M context
    };

    protected readonly acpClientOptions: AcpClientOptions;

    constructor() {
        super();
        const executor = new GeminiCLIExecutor({ model: DEFAULT_GEMINI_MODEL });
        this.acpClientOptions = createPseudoAcpServer(executor);
    }
}
