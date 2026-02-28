# Pi-Mono Detailed API Reference (with Summaries)

This document provides a highly detailed, file-by-file breakdown of every exported function, interface, class, and type across the four requested packages (`ai`, `agent`, `coding-agent`, and `tui`). Each item includes an extracted JSDoc description or an inferred heuristic explanation.

## Package: `@mariozechner/pi-ai`

### File: `packages/ai/src/api-registry.ts`

#### Exported Functions
- **`registerApiProvider`**: `export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>( 	provider: ApiProvider<TApi, TOptions>, 	sourceId?: string, ): void`
  - *Description*: Executes the logic for `registerApiProvider`.
- **`getApiProvider`**: `export function getApiProvider(api: Api): ApiProviderInternal | undefined`
  - *Description*: Retrieves or computes ApiProvider.
- **`getApiProviders`**: `export function getApiProviders(): ApiProviderInternal[]`
  - *Description*: Retrieves or computes ApiProviders.
- **`unregisterApiProviders`**: `export function unregisterApiProviders(sourceId: string): void`
  - *Description*: Executes the logic for `unregisterApiProviders`.
- **`clearApiProviders`**: `export function clearApiProviders(): void`
  - *Description*: Executes the logic for `clearApiProviders`.

#### Exported Interfaces
- **`ApiProvider`**
  - *Description*: Defines a provider implementation for `Api`.
  - `api: TApi`
  - `stream: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<TApi, TOptions>`
  - `streamSimple: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<TApi, import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").SimpleStreamOptions>`

#### Exported Types
- **`ApiStreamFunction`**: `( 	model: Model<Api>, 	context: Context, 	options?: StreamOptions, ) => AssistantMessageEventStream`
  - *Description*: Type alias for `ApiStreamFunction`.
- **`ApiStreamSimpleFunction`**: `( 	model: Model<Api>, 	context: Context, 	options?: SimpleStreamOptions, ) => AssistantMessageEventStream`
  - *Description*: Type alias for `ApiStreamSimpleFunction`.

### File: `packages/ai/src/env-api-keys.ts`

#### Exported Functions
- **`getEnvApiKey`**: `export function getEnvApiKey(provider: any): string | undefined`
  - *Description*: Retrieves or computes EnvApiKey.

### File: `packages/ai/src/models.ts`

#### Exported Functions
- **`getModel`**: `export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>( 	provider: TProvider, 	modelId: TModelId, ): Model<ModelApi<TProvider, TModelId>>`
  - *Description*: Retrieves or computes Model.
- **`getProviders`**: `export function getProviders(): KnownProvider[]`
  - *Description*: Retrieves or computes Providers.
- **`getModels`**: `export function getModels<TProvider extends KnownProvider>( 	provider: TProvider, ): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]`
  - *Description*: Retrieves or computes Models.
- **`calculateCost`**: `export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"]`
  - *Description*: Executes the logic for `calculateCost`.
- **`supportsXhigh`**: `export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean`
  - *Description*: Check if a model supports xhigh thinking level.  Supported today: - GPT-5.2 / GPT-5.3 model families - Anthropic Messages API Opus 4.6 models (xhigh maps to adaptive effort "max")
- **`modelsAreEqual`**: `export function modelsAreEqual<TApi extends Api>( 	a: Model<TApi> | null | undefined, 	b: Model<TApi> | null | undefined, ): boolean`
  - *Description*: Check if two models are equal by comparing both their id and provider. Returns false if either model is null or undefined.

### File: `packages/ai/src/providers/amazon-bedrock.ts`

#### Exported Functions
- **`streamBedrock`**: `streamBedrock: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"bedrock-converse-stream", import("c:/Works/GitWorks/pi-mono/packages/ai/src/...`
  - *Description*: Executes the logic for `streamBedrock`.
- **`streamSimpleBedrock`**: `streamSimpleBedrock: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"bedrock-converse-stream", import("c:/Works/GitWorks/pi-mono/packages/ai/src/...`
  - *Description*: Executes the logic for `streamSimpleBedrock`.

#### Exported Interfaces
- **`BedrockOptions`**
  - *Description*: Configuration options for `Bedrock`.
  - `region?: string`
  - `profile?: string`
  - `toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string; }`
  - `reasoning?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").ThinkingLevel`
  - `thinkingBudgets?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").ThinkingBudgets`
  - `interleavedThinking?: boolean`

### File: `packages/ai/src/providers/anthropic.ts`

#### Exported Functions
- **`streamAnthropic`**: `streamAnthropic: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"anthropic-messages", import("c:/Works/GitWorks/pi-mono/packages/ai/src/provi...`
  - *Description*: Executes the logic for `streamAnthropic`.
- **`streamSimpleAnthropic`**: `streamSimpleAnthropic: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"anthropic-messages", import("c:/Works/GitWorks/pi-mono/packages/ai/src/types...`
  - *Description*: Executes the logic for `streamSimpleAnthropic`.

#### Exported Interfaces
- **`AnthropicOptions`**
  - *Description*: Configuration options for `Anthropic`.
  - `thinkingEnabled?: boolean`
  - `thinkingBudgetTokens?: number`
  - `effort?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/providers/anthropic").AnthropicEffort`
  - `interleavedThinking?: boolean`
  - `toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string; }`

#### Exported Types
- **`AnthropicEffort`**: `"low" | "medium" | "high" | "max"`
  - *Description*: Type alias for `AnthropicEffort`.

### File: `packages/ai/src/providers/azure-openai-responses.ts`

#### Exported Functions
- **`streamAzureOpenAIResponses`**: `streamAzureOpenAIResponses: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"azure-openai-responses", import("c:/Works/GitWorks/pi-mono/packages/ai/src/p...`
  - *Description*: Executes the logic for `streamAzureOpenAIResponses`.
- **`streamSimpleAzureOpenAIResponses`**: `streamSimpleAzureOpenAIResponses: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"azure-openai-responses", import("c:/Works/GitWorks/pi-mono/packages/ai/src/t...`
  - *Description*: Executes the logic for `streamSimpleAzureOpenAIResponses`.

#### Exported Interfaces
- **`AzureOpenAIResponsesOptions`**
  - *Description*: Configuration options for `AzureOpenAIResponses`.
  - `reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `reasoningSummary?: "auto" | "detailed" | "concise"`
  - `azureApiVersion?: string`
  - `azureResourceName?: string`
  - `azureBaseUrl?: string`
  - `azureDeploymentName?: string`

### File: `packages/ai/src/providers/github-copilot-headers.ts`

#### Exported Functions
- **`inferCopilotInitiator`**: `export function inferCopilotInitiator(messages: Message[]): "user" | "agent"`
  - *Description*: Executes the logic for `inferCopilotInitiator`.
- **`hasCopilotVisionInput`**: `export function hasCopilotVisionInput(messages: Message[]): boolean`
  - *Description*: Checks if the condition 'hasCopilotVisionInput' is true.
- **`buildCopilotDynamicHeaders`**: `export function buildCopilotDynamicHeaders(params:`
  - *Description*: Instantiates or constructs a new opilotDynamicHeaders.

### File: `packages/ai/src/providers/google-gemini-cli.ts`

#### Exported Functions
- **`extractRetryDelay`**: `export function extractRetryDelay(errorText: string, response?: Response | Headers): number | undefined`
  - *Description*: Extract retry delay from Gemini error response (in milliseconds). Checks headers first (Retry-After, x-ratelimit-reset, x-ratelimit-reset-after), then parses body patterns like: - "Your quota will reset after 39s" - "Your quota will reset after 18h31m10s" - "Please retry in Xs" or "Please retry in Xms" - "retryDelay": "34.074824224s" (JSON field)
- **`buildRequest`**: `export function buildRequest( 	model: Model<"google-gemini-cli">, 	context: Context, 	projectId: string, 	options: GoogleGeminiCliOptions =`
  - *Description*: Instantiates or constructs a new equest.
- **`streamGoogleGeminiCli`**: `streamGoogleGeminiCli: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"google-gemini-cli", import("c:/Works/GitWorks/pi-mono/packages/ai/src/provid...`
  - *Description*: Executes the logic for `streamGoogleGeminiCli`.
- **`streamSimpleGoogleGeminiCli`**: `streamSimpleGoogleGeminiCli: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"google-gemini-cli", import("c:/Works/GitWorks/pi-mono/packages/ai/src/types"...`
  - *Description*: Executes the logic for `streamSimpleGoogleGeminiCli`.

#### Exported Interfaces
- **`GoogleGeminiCliOptions`**
  - *Description*: Configuration options for `GoogleGeminiCli`.
  - `toolChoice?: "auto" | "any" | "none"`
  - `thinking?: { enabled: boolean; budgetTokens?: number; level?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/providers/google-gemini-cli").GoogleThinkingLevel; }`
  - `projectId?: string`

#### Exported Types
- **`GoogleThinkingLevel`**: `"THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`
  - *Description*: Thinking level for Gemini 3 models. Mirrors Google's ThinkingLevel enum values.

### File: `packages/ai/src/providers/google-shared.ts`

#### Exported Functions
- **`isThinkingPart`**: `export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean`
  - *Description*: Determines whether a streamed Gemini `Part` should be treated as "thinking".  Protocol note (Gemini / Vertex AI thought signatures): - `thought: true` is the definitive marker for thinking content (thought summaries). - `thoughtSignature` is an encrypted representation of the model's internal thought process   used to preserve reasoning context across multi-turn interactions. - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT   indicate the part itself is thinking content. - For non-functionCall responses, the signature appears on the last part for context replay. - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;   do not merge/move signatures across parts.  See: https://ai.google.dev/gemini-api/docs/thought-signatures
- **`retainThoughtSignature`**: `export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined`
  - *Description*: Retain thought signatures during streaming.  Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it. This helper preserves the last non-empty signature for the current block.  Note: this does NOT merge or move signatures across distinct response parts. It only prevents a signature from being overwritten with `undefined` within the same streamed block.
- **`requiresToolCallId`**: `export function requiresToolCallId(modelId: string): boolean`
  - *Description*: Models via Google APIs that require explicit tool call IDs in function calls/responses.
- **`convertMessages`**: `export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[]`
  - *Description*: Convert internal messages to Gemini Content[] format.
- **`convertTools`**: `export function convertTools( 	tools: Tool[], 	useParameters = false, ):`
  - *Description*: Convert tools to Gemini function declarations format.  By default uses `parametersJsonSchema` which supports full JSON Schema (including anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters` field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude models, where the API translates `parameters` into Anthropic's `input_schema`.
- **`mapToolChoice`**: `export function mapToolChoice(choice: string): FunctionCallingConfigMode`
  - *Description*: Map tool choice string to Gemini FunctionCallingConfigMode.
- **`mapStopReason`**: `export function mapStopReason(reason: FinishReason): StopReason`
  - *Description*: Map Gemini FinishReason to our StopReason.
- **`mapStopReasonString`**: `export function mapStopReasonString(reason: string): StopReason`
  - *Description*: Map string finish reason to our StopReason (for raw API responses).

### File: `packages/ai/src/providers/google-vertex.ts`

#### Exported Functions
- **`streamGoogleVertex`**: `streamGoogleVertex: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"google-vertex", import("c:/Works/GitWorks/pi-mono/packages/ai/src/providers/...`
  - *Description*: Executes the logic for `streamGoogleVertex`.
- **`streamSimpleGoogleVertex`**: `streamSimpleGoogleVertex: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"google-vertex", import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").Si...`
  - *Description*: Executes the logic for `streamSimpleGoogleVertex`.

#### Exported Interfaces
- **`GoogleVertexOptions`**
  - *Description*: Configuration options for `GoogleVertex`.
  - `toolChoice?: "auto" | "any" | "none"`
  - `thinking?: { enabled: boolean; budgetTokens?: number; level?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/providers/google-gemini-cli").GoogleThinkingLevel; }`
  - `project?: string`
  - `location?: string`

### File: `packages/ai/src/providers/google.ts`

#### Exported Functions
- **`streamGoogle`**: `streamGoogle: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"google-generative-ai", import("c:/Works/GitWorks/pi-mono/packages/ai/src/pro...`
  - *Description*: Executes the logic for `streamGoogle`.
- **`streamSimpleGoogle`**: `streamSimpleGoogle: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"google-generative-ai", import("c:/Works/GitWorks/pi-mono/packages/ai/src/typ...`
  - *Description*: Executes the logic for `streamSimpleGoogle`.

#### Exported Interfaces
- **`GoogleOptions`**
  - *Description*: Configuration options for `Google`.
  - `toolChoice?: "auto" | "any" | "none"`
  - `thinking?: { enabled: boolean; budgetTokens?: number; level?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/providers/google-gemini-cli").GoogleThinkingLevel; }`

### File: `packages/ai/src/providers/openai-codex-responses.ts`

#### Exported Functions
- **`streamOpenAICodexResponses`**: `streamOpenAICodexResponses: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"openai-codex-responses", import("c:/Works/GitWorks/pi-mono/packages/ai/src/p...`
  - *Description*: Executes the logic for `streamOpenAICodexResponses`.
- **`streamSimpleOpenAICodexResponses`**: `streamSimpleOpenAICodexResponses: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"openai-codex-responses", import("c:/Works/GitWorks/pi-mono/packages/ai/src/t...`
  - *Description*: Executes the logic for `streamSimpleOpenAICodexResponses`.

#### Exported Interfaces
- **`OpenAICodexResponsesOptions`**
  - *Description*: Configuration options for `OpenAICodexResponses`.
  - `reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `reasoningSummary?: "auto" | "detailed" | "concise" | "off" | "on"`
  - `textVerbosity?: "low" | "medium" | "high"`

### File: `packages/ai/src/providers/openai-completions.ts`

#### Exported Functions
- **`convertMessages`**: `export function convertMessages( 	model: Model<"openai-completions">, 	context: Context, 	compat: Required<OpenAICompletionsCompat>, ): ChatCompletionMessageParam[]`
  - *Description*: Executes the logic for `convertMessages`.
- **`streamOpenAICompletions`**: `streamOpenAICompletions: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"openai-completions", import("c:/Works/GitWorks/pi-mono/packages/ai/src/provi...`
  - *Description*: Executes the logic for `streamOpenAICompletions`.
- **`streamSimpleOpenAICompletions`**: `streamSimpleOpenAICompletions: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"openai-completions", import("c:/Works/GitWorks/pi-mono/packages/ai/src/types...`
  - *Description*: Executes the logic for `streamSimpleOpenAICompletions`.

#### Exported Interfaces
- **`OpenAICompletionsOptions`**
  - *Description*: Configuration options for `OpenAICompletions`.
  - `toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string; }; }`
  - `reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"`

### File: `packages/ai/src/providers/openai-responses-shared.ts`

#### Exported Functions
- **`convertResponsesMessages`**: `export function convertResponsesMessages<TApi extends Api>( 	model: Model<TApi>, 	context: Context, 	allowedToolCallProviders: ReadonlySet<string>, 	options?: ConvertResponsesMessagesOptions, ): ResponseInput`
  - *Description*: Executes the logic for `convertResponsesMessages`.
- **`convertResponsesTools`**: `export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[]`
  - *Description*: Executes the logic for `convertResponsesTools`.
- **`processResponsesStream`**: `export async function processResponsesStream<TApi extends Api>( 	openaiStream: AsyncIterable<ResponseStreamEvent>, 	output: AssistantMessage, 	stream: AssistantMessageEventStream, 	model: Model<TApi>, 	options?: OpenAIResponsesStreamOptions, ): Promise<void>`
  - *Description*: Executes the logic for `processResponsesStream`.

#### Exported Interfaces
- **`OpenAIResponsesStreamOptions`**
  - *Description*: Configuration options for `OpenAIResponsesStream`.
  - `serviceTier?: ResponseCreateParamsStreaming`
  - `applyServiceTierPricing?: (usage: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").Usage, serviceTier: any) => void`
- **`ConvertResponsesMessagesOptions`**
  - *Description*: Configuration options for `ConvertResponsesMessages`.
  - `includeSystemPrompt?: boolean`
- **`ConvertResponsesToolsOptions`**
  - *Description*: Configuration options for `ConvertResponsesTools`.
  - `strict?: boolean`

### File: `packages/ai/src/providers/openai-responses.ts`

#### Exported Functions
- **`streamOpenAIResponses`**: `streamOpenAIResponses: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"openai-responses", import("c:/Works/GitWorks/pi-mono/packages/ai/src/provide...`
  - *Description*: Executes the logic for `streamOpenAIResponses`.
- **`streamSimpleOpenAIResponses`**: `streamSimpleOpenAIResponses: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StreamFunction<"openai-responses", import("c:/Works/GitWorks/pi-mono/packages/ai/src/types")...`
  - *Description*: Executes the logic for `streamSimpleOpenAIResponses`.

#### Exported Interfaces
- **`OpenAIResponsesOptions`**
  - *Description*: Configuration options for `OpenAIResponses`.
  - `reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `reasoningSummary?: "auto" | "detailed" | "concise"`
  - `serviceTier?: ResponseCreateParamsStreaming`

### File: `packages/ai/src/providers/register-builtins.ts`

#### Exported Functions
- **`registerBuiltInApiProviders`**: `export function registerBuiltInApiProviders(): void`
  - *Description*: Executes the logic for `registerBuiltInApiProviders`.
- **`resetApiProviders`**: `export function resetApiProviders(): void`
  - *Description*: Executes the logic for `resetApiProviders`.

### File: `packages/ai/src/providers/simple-options.ts`

#### Exported Functions
- **`buildBaseOptions`**: `export function buildBaseOptions(model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions`
  - *Description*: Instantiates or constructs a new aseOptions.
- **`clampReasoning`**: `export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined`
  - *Description*: Executes the logic for `clampReasoning`.
- **`adjustMaxTokensForThinking`**: `export function adjustMaxTokensForThinking( 	baseMaxTokens: number, 	modelMaxTokens: number, 	reasoningLevel: ThinkingLevel, 	customBudgets?: ThinkingBudgets, ):`
  - *Description*: Executes the logic for `adjustMaxTokensForThinking`.

### File: `packages/ai/src/providers/transform-messages.ts`

#### Exported Functions
- **`transformMessages`**: `export function transformMessages<TApi extends Api>( 	messages: Message[], 	model: Model<TApi>, 	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string, ): Message[]`
  - *Description*: Normalize tool call ID for cross-provider compatibility. OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`. Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).

### File: `packages/ai/src/stream.ts`

#### Exported Functions
- **`stream`**: `export function stream<TApi extends Api>( 	model: Model<TApi>, 	context: Context, 	options?: ProviderStreamOptions, ): AssistantMessageEventStream`
  - *Description*: Executes the logic for `stream`.
- **`complete`**: `export async function complete<TApi extends Api>( 	model: Model<TApi>, 	context: Context, 	options?: ProviderStreamOptions, ): Promise<AssistantMessage>`
  - *Description*: Executes the logic for `complete`.
- **`streamSimple`**: `export function streamSimple<TApi extends Api>( 	model: Model<TApi>, 	context: Context, 	options?: SimpleStreamOptions, ): AssistantMessageEventStream`
  - *Description*: Executes the logic for `streamSimple`.
- **`completeSimple`**: `export async function completeSimple<TApi extends Api>( 	model: Model<TApi>, 	context: Context, 	options?: SimpleStreamOptions, ): Promise<AssistantMessage>`
  - *Description*: Executes the logic for `completeSimple`.

### File: `packages/ai/src/types.ts`

#### Exported Interfaces
- **`ThinkingBudgets`**
  - *Description*: Token budgets for each thinking level (token-based providers only)
  - `minimal?: number`
  - `low?: number`
  - `medium?: number`
  - `high?: number`
- **`StreamOptions`**
  - *Description*: Configuration options for `Stream`.
  - `temperature?: number`
  - `maxTokens?: number`
  - `signal?: AbortSignal`
  - `apiKey?: string`
  - `transport?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").Transport`
  - `cacheRetention?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").CacheRetention`
  - `sessionId?: string`
  - `onPayload?: (payload: unknown) => void`
  - `headers?: Record<string, string>`
  - `maxRetryDelayMs?: number`
  - `metadata?: Record<string, unknown>`
- **`SimpleStreamOptions`**
  - *Description*: Configuration options for `SimpleStream`.
  - `reasoning?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").ThinkingLevel`
  - `thinkingBudgets?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").ThinkingBudgets`
- **`TextContent`**
  - *Description*: Data structure or object model representing `TextContent`.
  - `type: "text"`
  - `text: string`
  - `textSignature?: string`
- **`ThinkingContent`**
  - *Description*: Data structure or object model representing `ThinkingContent`.
  - `type: "thinking"`
  - `thinking: string`
  - `thinkingSignature?: string`
  - `redacted?: boolean`
- **`ImageContent`**
  - *Description*: Data structure or object model representing `ImageContent`.
  - `type: "image"`
  - `data: string`
  - `mimeType: string`
- **`ToolCall`**
  - *Description*: Data structure or object model representing `ToolCall`.
  - `type: "toolCall"`
  - `id: string`
  - `name: string`
  - `arguments: Record<string, any>`
  - `thoughtSignature?: string`
- **`Usage`**
  - *Description*: Data structure or object model representing `Usage`.
  - `input: number`
  - `output: number`
  - `cacheRead: number`
  - `cacheWrite: number`
  - `totalTokens: number`
  - `cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }`
- **`UserMessage`**
  - *Description*: Data structure or object model representing `UserMessage`.
  - `role: "user"`
  - `content: string | (import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").TextContent | import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").ImageContent)[]`
  - `timestamp: number`
- **`AssistantMessage`**
  - *Description*: Data structure or object model representing `AssistantMessage`.
  - `role: "assistant"`
  - `content: (import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").TextContent | import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").ThinkingContent | import("c:/Works/GitWorks/pi-mono/packages/ai/src/t...`
  - `api: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").Api`
  - `provider: string`
  - `model: string`
  - `usage: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").Usage`
  - `stopReason: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").StopReason`
  - `errorMessage?: string`
  - `timestamp: number`
- **`ToolResultMessage`**
  - *Description*: Data structure or object model representing `ToolResultMessage`.
  - `role: "toolResult"`
  - `toolCallId: string`
  - `toolName: string`
  - `content: (import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").TextContent | import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").ImageContent)[]`
  - `details?: TDetails`
  - `isError: boolean`
  - `timestamp: number`
- **`Tool`**
  - *Description*: Data structure or object model representing `Tool`.
  - `name: string`
  - `description: string`
  - `parameters: TParameters`
- **`Context`**
  - *Description*: Data structure or object model representing `Context`.
  - `systemPrompt?: string`
  - `messages: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").Message[]`
  - `tools?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").Tool<TSchema>[]`
- **`OpenAICompletionsCompat`**
  - *Description*: Compatibility settings for OpenAI-compatible completions APIs. Use this to override URL-based auto-detection for custom providers.
  - `supportsStore?: boolean`
  - `supportsDeveloperRole?: boolean`
  - `supportsReasoningEffort?: boolean`
  - `supportsUsageInStreaming?: boolean`
  - `maxTokensField?: "max_completion_tokens" | "max_tokens"`
  - `requiresToolResultName?: boolean`
  - `requiresAssistantAfterToolResult?: boolean`
  - `requiresThinkingAsText?: boolean`
  - `requiresMistralToolIds?: boolean`
  - `thinkingFormat?: "openai" | "zai" | "qwen"`
  - `openRouterRouting?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").OpenRouterRouting`
  - `vercelGatewayRouting?: import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").VercelGatewayRouting`
  - `supportsStrictMode?: boolean`
- **`OpenAIResponsesCompat`**
  - *Description*: Compatibility settings for OpenAI Responses APIs.
- **`OpenRouterRouting`**
  - *Description*: OpenRouter provider routing preferences. Controls which upstream providers OpenRouter routes requests to. @see https://openrouter.ai/docs/provider-routing
  - `only?: string[]`
  - `order?: string[]`
- **`VercelGatewayRouting`**
  - *Description*: Vercel AI Gateway routing preferences. Controls which upstream providers the gateway routes requests to. @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
  - `only?: string[]`
  - `order?: string[]`
- **`Model`**
  - *Description*: Data structure or object model representing `Model`.
  - `id: string`
  - `name: string`
  - `api: TApi`
  - `provider: string`
  - `baseUrl: string`
  - `reasoning: boolean`
  - `input: ("text" | "image")[]`
  - `cost: { input: number; output: number; cacheRead: number; cacheWrite: number; }`
  - `contextWindow: number`
  - `maxTokens: number`
  - `headers?: Record<string, string>`
  - `compat?: TApi extends "openai-completions" ? import("c:/Works/GitWorks/pi-mono/packages/ai/src/types").OpenAICompletionsCompat : TApi extends "openai-responses" ? import("c:/Works/GitWorks/pi-mono/packages/ai/...`

#### Exported Types
- **`KnownApi`**: `| "openai-completions" 	| "openai-responses" 	| "azure-openai-responses" 	| "openai-codex-responses" 	| "anthropic-messages" 	| "bedrock-converse-stream" 	| "google-generative-ai" 	| "google-gemini-cl...`
  - *Description*: Type alias for `KnownApi`.
- **`Api`**: `KnownApi | (string & {})`
  - *Description*: Type alias for `Api`.
- **`KnownProvider`**: `| "amazon-bedrock" 	| "anthropic" 	| "google" 	| "google-gemini-cli" 	| "google-antigravity" 	| "google-vertex" 	| "openai" 	| "azure-openai-responses" 	| "openai-codex" 	| "github-copilot" 	| "xai" 	...`
  - *Description*: Type alias for `KnownProvider`.
- **`Provider`**: `KnownProvider | string`
  - *Description*: Type alias for `Provider`.
- **`ThinkingLevel`**: `"minimal" | "low" | "medium" | "high" | "xhigh"`
  - *Description*: Type alias for `ThinkingLevel`.
- **`CacheRetention`**: `"none" | "short" | "long"`
  - *Description*: Type alias for `CacheRetention`.
- **`Transport`**: `"sse" | "websocket" | "auto"`
  - *Description*: Type alias for `Transport`.
- **`ProviderStreamOptions`**: `StreamOptions & Record<string, unknown>`
  - *Description*: Type alias for `ProviderStreamOptions`.
- **`StreamFunction`**: `( 	model: Model<TApi>, 	context: Context, 	options?: TOptions, ) => AssistantMessageEventStream`
  - *Description*: Type alias for `StreamFunction`.
- **`StopReason`**: `"stop" | "length" | "toolUse" | "error" | "aborted"`
  - *Description*: Type alias for `StopReason`.
- **`Message`**: `UserMessage | AssistantMessage | ToolResultMessage`
  - *Description*: Type alias for `Message`.
- **`AssistantMessageEvent`**: `| { type: "start"; partial: AssistantMessage } 	| { type: "text_start"; contentIndex: number; partial: AssistantMessage } 	| { type: "text_delta"; contentIndex: number; delta: string; partial: Assista...`
  - *Description*: Type alias for `AssistantMessageEvent`.

### File: `packages/ai/src/utils/event-stream.ts`

#### Exported Functions
- **`createAssistantMessageEventStream`**: `export function createAssistantMessageEventStream(): AssistantMessageEventStream`
  - *Description*: Factory function for AssistantMessageEventStream (for use in extensions)

#### Exported Classes
- **`EventStream`**
  - *Description*: Data structure or object model representing `EventStream`.
  - `push(event: T): void`
  - `end(result?: R): void`
  - `async *[Symbol.asyncIterator](): AsyncIterator<T>`
  - `result(): Promise<R>`
- **`AssistantMessageEventStream`**
  - *Description*: Data structure or object model representing `AssistantMessageEventStream`.

### File: `packages/ai/src/utils/json-parse.ts`

#### Exported Functions
- **`parseStreamingJson`**: `export function parseStreamingJson<T = any>(partialJson: string | undefined): T`
  - *Description*: Attempts to parse potentially incomplete JSON during streaming. Always returns a valid object, even if the JSON is incomplete.  @param partialJson The partial JSON string from streaming @returns Parsed object or empty object if parsing fails

### File: `packages/ai/src/utils/oauth/anthropic.ts`

#### Exported Functions
- **`loginAnthropic`**: `export async function loginAnthropic( 	onAuthUrl: (url: string) => void, 	onPromptCode: () => Promise<string>, ): Promise<OAuthCredentials>`
  - *Description*: Login with Anthropic OAuth (device code flow)  @param onAuthUrl - Callback to handle the authorization URL (e.g., open browser) @param onPromptCode - Callback to prompt user for the authorization code
- **`refreshAnthropicToken`**: `export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials>`
  - *Description*: Refresh Anthropic OAuth token

### File: `packages/ai/src/utils/oauth/github-copilot.ts`

#### Exported Functions
- **`normalizeDomain`**: `export function normalizeDomain(input: string): string | null`
  - *Description*: Executes the logic for `normalizeDomain`.
- **`getGitHubCopilotBaseUrl`**: `export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string`
  - *Description*: Retrieves or computes GitHubCopilotBaseUrl.
- **`refreshGitHubCopilotToken`**: `export async function refreshGitHubCopilotToken( 	refreshToken: string, 	enterpriseDomain?: string, ): Promise<OAuthCredentials>`
  - *Description*: Refresh GitHub Copilot token
- **`loginGitHubCopilot`**: `export async function loginGitHubCopilot(options:`
  - *Description*: Login with GitHub Copilot OAuth (device code flow)  @param options.onAuth - Callback with URL and optional instructions (user code) @param options.onPrompt - Callback to prompt user for input @param options.onProgress - Optional progress callback @param options.signal - Optional AbortSignal for cancellation

### File: `packages/ai/src/utils/oauth/google-antigravity.ts`

#### Exported Functions
- **`refreshAntigravityToken`**: `export async function refreshAntigravityToken(refreshToken: string, projectId: string): Promise<OAuthCredentials>`
  - *Description*: Refresh Antigravity token
- **`loginAntigravity`**: `export async function loginAntigravity( 	onAuth: (info:`
  - *Description*: Login with Antigravity OAuth  @param onAuth - Callback with URL and optional instructions @param onProgress - Optional progress callback @param onManualCodeInput - Optional promise that resolves with user-pasted redirect URL.                            Races with browser callback - whichever completes first wins.

### File: `packages/ai/src/utils/oauth/google-gemini-cli.ts`

#### Exported Functions
- **`refreshGoogleCloudToken`**: `export async function refreshGoogleCloudToken(refreshToken: string, projectId: string): Promise<OAuthCredentials>`
  - *Description*: Refresh Google Cloud Code Assist token
- **`loginGeminiCli`**: `export async function loginGeminiCli( 	onAuth: (info:`
  - *Description*: Login with Gemini CLI (Google Cloud Code Assist) OAuth  @param onAuth - Callback with URL and optional instructions @param onProgress - Optional progress callback @param onManualCodeInput - Optional promise that resolves with user-pasted redirect URL.                            Races with browser callback - whichever completes first wins.

### File: `packages/ai/src/utils/oauth/index.ts`

#### Exported Functions
- **`getOAuthProvider`**: `export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined`
  - *Description*: Get an OAuth provider by ID
- **`registerOAuthProvider`**: `export function registerOAuthProvider(provider: OAuthProviderInterface): void`
  - *Description*: Register a custom OAuth provider
- **`unregisterOAuthProvider`**: `export function unregisterOAuthProvider(id: string): void`
  - *Description*: Unregister an OAuth provider.  If the provider is built-in, restores the built-in implementation. Custom providers are removed completely.
- **`resetOAuthProviders`**: `export function resetOAuthProviders(): void`
  - *Description*: Reset OAuth providers to built-ins.
- **`getOAuthProviders`**: `export function getOAuthProviders(): OAuthProviderInterface[]`
  - *Description*: Get all registered OAuth providers
- **`getOAuthProviderInfoList`**: `export function getOAuthProviderInfoList(): OAuthProviderInfo[]`
  - *Description*: @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
- **`refreshOAuthToken`**: `export async function refreshOAuthToken( 	providerId: OAuthProviderId, 	credentials: OAuthCredentials, ): Promise<OAuthCredentials>`
  - *Description*: Refresh token for any OAuth provider. @deprecated Use getOAuthProvider(id).refreshToken() instead
- **`getOAuthApiKey`**: `export async function getOAuthApiKey( 	providerId: OAuthProviderId, 	credentials: Record<string, OAuthCredentials>, ): Promise<`
  - *Description*: Get API key for a provider from OAuth credentials. Automatically refreshes expired tokens.  @returns API key string and updated credentials, or null if no credentials @throws Error if refresh fails

### File: `packages/ai/src/utils/oauth/openai-codex.ts`

#### Exported Functions
- **`loginOpenAICodex`**: `export async function loginOpenAICodex(options:`
  - *Description*: Login with OpenAI Codex OAuth  @param options.onAuth - Called with URL and instructions when auth starts @param options.onPrompt - Called to prompt user for manual code paste (fallback if no onManualCodeInput) @param options.onProgress - Optional progress messages @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.                                    Races with browser callback - whichever completes first wins.                                    Useful for showing paste input immediately alongside browser flow. @param options.originator - OAuth originator parameter (defaults to "pi")
- **`refreshOpenAICodexToken`**: `export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials>`
  - *Description*: Refresh OpenAI Codex OAuth token

### File: `packages/ai/src/utils/oauth/pkce.ts`

#### Exported Functions
- **`generatePKCE`**: `export async function generatePKCE(): Promise<`
  - *Description*: Generate PKCE code verifier and challenge. Uses Web Crypto API for cross-platform compatibility.

### File: `packages/ai/src/utils/oauth/types.ts`

#### Exported Interfaces
- **`OAuthLoginCallbacks`**
  - *Description*: Data structure or object model representing `OAuthLoginCallbacks`.
  - `onAuth: (info: import("c:/Works/GitWorks/pi-mono/packages/ai/src/utils/oauth/types").OAuthAuthInfo) => void`
  - `onPrompt: (prompt: import("c:/Works/GitWorks/pi-mono/packages/ai/src/utils/oauth/types").OAuthPrompt) => Promise<string>`
  - `onProgress?: (message: string) => void`
  - `onManualCodeInput?: () => Promise<string>`
  - `signal?: AbortSignal`
- **`OAuthProviderInterface`**
  - *Description*: Data structure or object model representing `OAuthProviderInterface`.
  - `id: string`
  - `name: string`
  - `usesCallbackServer?: boolean`
- **`OAuthProviderInfo`**
  - *Description*: @deprecated Use OAuthProviderInterface instead
  - `id: string`
  - `name: string`
  - `available: boolean`

#### Exported Types
- **`OAuthCredentials`**: `{ 	refresh: string; 	access: string; 	expires: number; 	[key: string]: unknown; }`
  - *Description*: Type alias for `OAuthCredentials`.
- **`OAuthProviderId`**: `string`
  - *Description*: Type alias for `OAuthProviderId`.
- **`OAuthProvider`**: `OAuthProviderId`
  - *Description*: @deprecated Use OAuthProviderId instead
- **`OAuthPrompt`**: `{ 	message: string; 	placeholder?: string; 	allowEmpty?: boolean; }`
  - *Description*: Type alias for `OAuthPrompt`.
- **`OAuthAuthInfo`**: `{ 	url: string; 	instructions?: string; }`
  - *Description*: Type alias for `OAuthAuthInfo`.

### File: `packages/ai/src/utils/overflow.ts`

#### Exported Functions
- **`isContextOverflow`**: `export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean`
  - *Description*: Check if an assistant message represents a context overflow error.  This handles two cases: 1. Error-based overflow: Most providers return stopReason "error" with a    specific error message pattern. 2. Silent overflow: Some providers accept overflow requests and return    successfully. For these, we check if usage.input exceeds the context window.  ## Reliability by Provider  **Reliable detection (returns error with detectable message):** - Anthropic: "prompt is too long: X tokens > Y maximum" - OpenAI (Completions & Responses): "exceeds the context window" - Google Gemini: "input token count exceeds the maximum" - xAI (Grok): "maximum prompt length is X but request contains Y" - Groq: "reduce the length of the messages" - Cerebras: 400/413 status code (no body) - Mistral: 400/413 status code (no body) - OpenRouter (all backends): "maximum context length is X tokens" - llama.cpp: "exceeds the available context size" - LM Studio: "greater than the context length" - Kimi For Coding: "exceeded model token limit: X (requested: Y)"  **Unreliable detection:** - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),   sometimes returns rate limit errors. Pass contextWindow param to detect silent overflow. - Ollama: Silently truncates input without error. Cannot be detected via this function.   The response will have usage.input < expected, but we don't know the expected value.  ## Custom Providers  If you've added custom models via settings.json, this function may not detect overflow errors from those providers. To add support:  1. Send a request that exceeds the model's context window 2. Check the errorMessage in the response 3. Create a regex pattern that matches the error 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or    check the errorMessage yourself before calling this function  @param message - The assistant message to check @param contextWindow - Optional context window size for detecting silent overflow (z.ai) @returns true if the message indicates a context overflow
- **`getOverflowPatterns`**: `export function getOverflowPatterns(): RegExp[]`
  - *Description*: Get the overflow patterns for testing purposes.

### File: `packages/ai/src/utils/sanitize-unicode.ts`

#### Exported Functions
- **`sanitizeSurrogates`**: `export function sanitizeSurrogates(text: string): string`
  - *Description*: Removes unpaired Unicode surrogate characters from a string.  Unpaired surrogates (high surrogates 0xD800-0xDBFF without matching low surrogates 0xDC00-0xDFFF, or vice versa) cause JSON serialization errors in many API providers.  Valid emoji and other characters outside the Basic Multilingual Plane use properly paired surrogates and will NOT be affected by this function.  @param text - The text to sanitize @returns The sanitized text with unpaired surrogates removed  @example // Valid emoji (properly paired surrogates) are preserved sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"  // Unpaired high surrogate is removed const unpaired = String.fromCharCode(0xD83D); // high surrogate without low sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"

### File: `packages/ai/src/utils/typebox-helpers.ts`

#### Exported Functions
- **`StringEnum`**: `export function StringEnum<T extends readonly string[]>( 	values: T, 	options?:`
  - *Description*: Creates a string enum schema compatible with Google's API and other providers that don't support anyOf/const patterns.  @example const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {   description: "The operation to perform" });  type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"

### File: `packages/ai/src/utils/validation.ts`

#### Exported Functions
- **`validateToolCall`**: `export function validateToolCall(tools: Tool[], toolCall: ToolCall): any`
  - *Description*: Finds a tool by name and validates the tool call arguments against its TypeBox schema @param tools Array of tool definitions @param toolCall The tool call from the LLM @returns The validated arguments @throws Error if tool is not found or validation fails
- **`validateToolArguments`**: `export function validateToolArguments(tool: Tool, toolCall: ToolCall): any`
  - *Description*: Validates tool call arguments against the tool's TypeBox schema @param tool The tool definition with TypeBox schema @param toolCall The tool call from the LLM @returns The validated (and potentially coerced) arguments @throws Error with formatted message if validation fails

## Package: `@mariozechner/pi-agent-core`

### File: `packages/agent/src/agent-loop.ts`

#### Exported Functions
- **`agentLoop`**: `export function agentLoop( 	prompts: AgentMessage[], 	context: AgentContext, 	config: AgentLoopConfig, 	signal?: AbortSignal, 	streamFn?: StreamFn, ): EventStream<AgentEvent, AgentMessage[]>`
  - *Description*: Start an agent loop with a new prompt message. The prompt is added to the context and events are emitted for it.
- **`agentLoopContinue`**: `export function agentLoopContinue( 	context: AgentContext, 	config: AgentLoopConfig, 	signal?: AbortSignal, 	streamFn?: StreamFn, ): EventStream<AgentEvent, AgentMessage[]>`
  - *Description*: Continue an agent loop from the current context without adding a new message. Used for retries - context already has user message or tool results.  **Important:** The last message in context must convert to a `user` or `toolResult` message via `convertToLlm`. If it doesn't, the LLM provider will reject the request. This cannot be validated here since `convertToLlm` is only called once per turn.

### File: `packages/agent/src/agent.ts`

#### Exported Interfaces
- **`AgentOptions`**
  - *Description*: Configuration options for `Agent`.
  - `initialState?: Partial<import("c:/Works/GitWorks/pi-mono/packages/agent/src/types").AgentState>`
  - `convertToLlm?: (messages: any[]) => Message[] | Promise<Message[]>`
  - `transformContext?: (messages: any[], signal?: AbortSignal) => Promise<any[]>`
  - `steeringMode?: "all" | "one-at-a-time"`
  - `followUpMode?: "all" | "one-at-a-time"`
  - `streamFn?: import("c:/Works/GitWorks/pi-mono/packages/agent/src/types").StreamFn`
  - `sessionId?: string`
  - `getApiKey?: (provider: string) => string | Promise<string>`
  - `thinkingBudgets?: ThinkingBudgets`
  - `transport?: Transport`
  - `maxRetryDelayMs?: number`

#### Exported Classes
- **`Agent`**
  - *Description*: Data structure or object model representing `Agent`.
  - `setTransport(value: Transport)`
  - `subscribe(fn: (e: AgentEvent) => void): () => void`
  - `setSystemPrompt(v: string)`
  - `setModel(m: Model<any>)`
  - `setThinkingLevel(l: ThinkingLevel)`
  - `setSteeringMode(mode: "all" | "one-at-a-time")`
  - `getSteeringMode(): "all" | "one-at-a-time"`
  - `setFollowUpMode(mode: "all" | "one-at-a-time")`
  - `getFollowUpMode(): "all" | "one-at-a-time"`
  - `setTools(t: AgentTool<any>[])`
  - `replaceMessages(ms: AgentMessage[])`
  - `appendMessage(m: AgentMessage)`
  - `steer(m: AgentMessage)`
  - `followUp(m: AgentMessage)`
  - `clearSteeringQueue()`
  - `clearFollowUpQueue()`
  - `clearAllQueues()`
  - `hasQueuedMessages(): boolean`
  - `clearMessages()`
  - `abort()`
  - `waitForIdle(): Promise<void>`
  - `reset()`
  - `async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[])`
  - `async continue()`

### File: `packages/agent/src/proxy.ts`

#### Exported Functions
- **`streamProxy`**: `export function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream`
  - *Description*: Stream function that proxies through a server instead of calling LLM providers directly. The server strips the partial field from delta events to reduce bandwidth. We reconstruct the partial message client-side.  Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.  @example ```typescript const agent = new Agent({   streamFn: (model, context, options) =>     streamProxy(model, context, {       ...options,       authToken: await getAuthToken(),       proxyUrl: "https://genai.example.com",     }), }); ```

#### Exported Interfaces
- **`ProxyStreamOptions`**
  - *Description*: Configuration options for `ProxyStream`.
  - `authToken: string`
  - `proxyUrl: string`

#### Exported Types
- **`ProxyAssistantMessageEvent`**: `| { type: "start" } 	| { type: "text_start"; contentIndex: number } 	| { type: "text_delta"; contentIndex: number; delta: string } 	| { type: "text_end"; contentIndex: number; contentSignature?: st...`
  - *Description*: Proxy event types - server sends these with partial field stripped to reduce bandwidth.

### File: `packages/agent/src/types.ts`

#### Exported Interfaces
- **`AgentLoopConfig`**
  - *Description*: Configuration for the agent loop.
  - `model: Model<any>`
  - `convertToLlm: (messages: any[]) => Message[] | Promise<Message[]>`
  - `transformContext?: (messages: any[], signal?: AbortSignal) => Promise<any[]>`
  - `getApiKey?: (provider: string) => string | Promise<string>`
  - `getSteeringMessages?: () => Promise<any[]>`
  - `getFollowUpMessages?: () => Promise<any[]>`
- **`CustomAgentMessages`**
  - *Description*: Extensible interface for custom app messages. Apps can extend via declaration merging:  @example ```typescript declare module "@mariozechner/agent" {   interface CustomAgentMessages {     artifact: ArtifactMessage;     notification: NotificationMessage;   } } ```
- **`AgentState`**
  - *Description*: Agent state containing all configuration and conversation data.
  - `systemPrompt: string`
  - `model: Model<any>`
  - `thinkingLevel: import("c:/Works/GitWorks/pi-mono/packages/agent/src/types").ThinkingLevel`
  - `tools: import("c:/Works/GitWorks/pi-mono/packages/agent/src/types").AgentTool<any, any>[]`
  - `messages: any[]`
  - `isStreaming: boolean`
  - `streamMessage: any`
  - `pendingToolCalls: Set<string>`
  - `error?: string`
- **`AgentToolResult`**
  - *Description*: Data structure or object model representing `AgentToolResult`.
  - `content: any[]`
  - `details: T`
- **`AgentTool`**
  - *Description*: Data structure or object model representing `AgentTool`.
  - `label: string`
  - `execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal, onUpdate?: import("c:/Works/GitWorks/pi-mono/packages/agent/src/types").AgentToolUpdateCallback<TDetails>) => Promise<import("c:...`
- **`AgentContext`**
  - *Description*: Data structure or object model representing `AgentContext`.
  - `systemPrompt: string`
  - `messages: any[]`
  - `tools?: import("c:/Works/GitWorks/pi-mono/packages/agent/src/types").AgentTool<any, any>[]`

#### Exported Types
- **`StreamFn`**: `( 	...args: Parameters<typeof streamSimple> ) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>`
  - *Description*: Stream function - can return sync or Promise for async config lookup
- **`ThinkingLevel`**: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - *Description*: Thinking/reasoning level for models that support it. Note: "xhigh" is only supported by OpenAI gpt-5.1-codex-max, gpt-5.2, gpt-5.2-codex, gpt-5.3, and gpt-5.3-codex models.
- **`AgentMessage`**: `Message | CustomAgentMessages[keyof CustomAgentMessages]`
  - *Description*: AgentMessage: Union of LLM messages + custom messages. This abstraction allows apps to add custom message types while maintaining type safety and compatibility with the base LLM messages.
- **`AgentToolUpdateCallback`**: `(partialResult: AgentToolResult<T>) => void`
  - *Description*: Type alias for `AgentToolUpdateCallback`.
- **`AgentEvent`**: `| { type: "agent_start" } 	| { type: "agent_end"; messages: AgentMessage[] } 	// Turn lifecycle - a turn is one assistant response + any tool calls/results 	| { type: "turn_start" } 	| { type: "tu...`
  - *Description*: Events emitted by the Agent for UI updates. These events provide fine-grained lifecycle information for messages, turns, and tool executions.

## Package: `@mariozechner/pi-coding-agent`

### File: `packages/coding-agent/src/cli/args.ts`

#### Exported Functions
- **`isValidThinkingLevel`**: `export function isValidThinkingLevel(level: string): level is ThinkingLevel`
  - *Description*: Checks if the condition 'isValidThinkingLevel' is true.
- **`parseArgs`**: `export function parseArgs(args: string[], extensionFlags?: Map<string,`
  - *Description*: Parses input data to generate Args.
- **`printHelp`**: `export function printHelp(): void`
  - *Description*: Executes the logic for `printHelp`.

#### Exported Interfaces
- **`Args`**
  - *Description*: Data structure or object model representing `Args`.
  - `provider?: string`
  - `model?: string`
  - `apiKey?: string`
  - `systemPrompt?: string`
  - `appendSystemPrompt?: string`
  - `thinking?: ThinkingLevel`
  - `continue?: boolean`
  - `resume?: boolean`
  - `help?: boolean`
  - `version?: boolean`
  - `mode?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/cli/args").Mode`
  - `noSession?: boolean`
  - `session?: string`
  - `sessionDir?: string`
  - `models?: string[]`
  - `tools?: ("read" | "bash" | "edit" | "write" | "grep" | "find" | "ls")[]`
  - `noTools?: boolean`
  - `extensions?: string[]`
  - `noExtensions?: boolean`
  - `print?: boolean`
  - `export?: string`
  - `noSkills?: boolean`
  - `skills?: string[]`
  - `promptTemplates?: string[]`
  - `noPromptTemplates?: boolean`
  - `themes?: string[]`
  - `noThemes?: boolean`
  - `listModels?: string | true`
  - `offline?: boolean`
  - `verbose?: boolean`
  - `messages: string[]`
  - `fileArgs: string[]`
  - `unknownFlags: Map<string, string | boolean>`

#### Exported Types
- **`Mode`**: `"text" | "json" | "rpc"`
  - *Description*: Type alias for `Mode`.

### File: `packages/coding-agent/src/cli/config-selector.ts`

#### Exported Functions
- **`selectConfig`**: `export async function selectConfig(options: ConfigSelectorOptions): Promise<void>`
  - *Description*: Show TUI config selector and return when closed

#### Exported Interfaces
- **`ConfigSelectorOptions`**
  - *Description*: Configuration options for `ConfigSelector`.
  - `resolvedPaths: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").ResolvedPaths`
  - `settingsManager: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").SettingsManager`
  - `cwd: string`
  - `agentDir: string`

### File: `packages/coding-agent/src/cli/file-processor.ts`

#### Exported Functions
- **`processFileArguments`**: `export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles>`
  - *Description*: Process @file arguments into text content and image attachments

#### Exported Interfaces
- **`ProcessedFiles`**
  - *Description*: Data structure or object model representing `ProcessedFiles`.
  - `text: string`
  - `images: ImageContent[]`
- **`ProcessFileOptions`**
  - *Description*: Configuration options for `ProcessFile`.
  - `autoResizeImages?: boolean`

### File: `packages/coding-agent/src/cli/list-models.ts`

#### Exported Functions
- **`listModels`**: `export async function listModels(modelRegistry: ModelRegistry, searchPattern?: string): Promise<void>`
  - *Description*: List available models, optionally filtered by search pattern

### File: `packages/coding-agent/src/cli/session-picker.ts`

#### Exported Functions
- **`selectSession`**: `export async function selectSession( 	currentSessionsLoader: SessionsLoader, 	allSessionsLoader: SessionsLoader, ): Promise<string | null>`
  - *Description*: Show TUI session selector and return selected session path or null if cancelled

### File: `packages/coding-agent/src/config.ts`

#### Exported Functions
- **`detectInstallMethod`**: `export function detectInstallMethod(): InstallMethod`
  - *Description*: Executes the logic for `detectInstallMethod`.
- **`getUpdateInstruction`**: `export function getUpdateInstruction(packageName: string): string`
  - *Description*: Retrieves or computes UpdateInstruction.
- **`getPackageDir`**: `export function getPackageDir(): string`
  - *Description*: Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md). - For Bun binary: returns the directory containing the executable - For Node.js (dist/): returns __dirname (the dist/ directory) - For tsx (src/): returns parent directory (the package root)
- **`getThemesDir`**: `export function getThemesDir(): string`
  - *Description*: Get path to built-in themes directory (shipped with package) - For Bun binary: theme/ next to executable - For Node.js (dist/): dist/modes/interactive/theme/ - For tsx (src/): src/modes/interactive/theme/
- **`getExportTemplateDir`**: `export function getExportTemplateDir(): string`
  - *Description*: Get path to HTML export template directory (shipped with package) - For Bun binary: export-html/ next to executable - For Node.js (dist/): dist/core/export-html/ - For tsx (src/): src/core/export-html/
- **`getPackageJsonPath`**: `export function getPackageJsonPath(): string`
  - *Description*: Get path to package.json
- **`getReadmePath`**: `export function getReadmePath(): string`
  - *Description*: Get path to README.md
- **`getDocsPath`**: `export function getDocsPath(): string`
  - *Description*: Get path to docs directory
- **`getExamplesPath`**: `export function getExamplesPath(): string`
  - *Description*: Get path to examples directory
- **`getChangelogPath`**: `export function getChangelogPath(): string`
  - *Description*: Get path to CHANGELOG.md
- **`getShareViewerUrl`**: `export function getShareViewerUrl(gistId: string): string`
  - *Description*: Get the share viewer URL for a gist ID
- **`getAgentDir`**: `export function getAgentDir(): string`
  - *Description*: Get the agent config directory (e.g., ~/.pi/agent/)
- **`getCustomThemesDir`**: `export function getCustomThemesDir(): string`
  - *Description*: Get path to user's custom themes directory
- **`getModelsPath`**: `export function getModelsPath(): string`
  - *Description*: Get path to models.json
- **`getAuthPath`**: `export function getAuthPath(): string`
  - *Description*: Get path to auth.json
- **`getSettingsPath`**: `export function getSettingsPath(): string`
  - *Description*: Get path to settings.json
- **`getToolsDir`**: `export function getToolsDir(): string`
  - *Description*: Get path to tools directory
- **`getBinDir`**: `export function getBinDir(): string`
  - *Description*: Get path to managed binaries directory (fd, rg)
- **`getPromptsDir`**: `export function getPromptsDir(): string`
  - *Description*: Get path to prompt templates directory
- **`getSessionsDir`**: `export function getSessionsDir(): string`
  - *Description*: Get path to sessions directory
- **`getDebugLogPath`**: `export function getDebugLogPath(): string`
  - *Description*: Get path to debug log file

#### Exported Types
- **`InstallMethod`**: `"bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown"`
  - *Description*: Type alias for `InstallMethod`.

### File: `packages/coding-agent/src/core/agent-session.ts`

#### Exported Functions
- **`parseSkillBlock`**: `export function parseSkillBlock(text: string): ParsedSkillBlock | null`
  - *Description*: Parse a skill block from message text. Returns null if the text doesn't contain a skill block.

#### Exported Interfaces
- **`ParsedSkillBlock`**
  - *Description*: Parsed skill block from a user message
  - `name: string`
  - `location: string`
  - `content: string`
  - `userMessage: string`
- **`AgentSessionConfig`**
  - *Description*: Configuration options for `AgentSession`.
  - `agent: Agent`
  - `sessionManager: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionManager`
  - `settingsManager: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").SettingsManager`
  - `cwd: string`
  - `scopedModels?: { model: Model<any>; thinkingLevel: ThinkingLevel; }[]`
  - `resourceLoader: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/resource-loader").ResourceLoader`
  - `customTools?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ToolDefinition<TSchema, unknown>[]`
  - `modelRegistry: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/model-registry").ModelRegistry`
  - `initialActiveToolNames?: string[]`
  - `baseToolsOverride?: Record<string, AgentTool>`
  - `extensionRunnerRef?: { current?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/runner").ExtensionRunner; }`
- **`ExtensionBindings`**
  - *Description*: Data structure or object model representing `ExtensionBindings`.
  - `uiContext?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionUIContext`
  - `commandContextActions?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionCommandContextActions`
  - `shutdownHandler?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/runner").ShutdownHandler`
  - `onError?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/runner").ExtensionErrorListener`
- **`PromptOptions`**
  - *Description*: Options for AgentSession.prompt()
  - `expandPromptTemplates?: boolean`
  - `images?: ImageContent[]`
  - `streamingBehavior?: "steer" | "followUp"`
  - `source?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").InputSource`
- **`ModelCycleResult`**
  - *Description*: Result from cycleModel()
  - `model: Model<any>`
  - `thinkingLevel: ThinkingLevel`
  - `isScoped: boolean`
- **`SessionStats`**
  - *Description*: Session statistics for /session command
  - `sessionFile: string`
  - `sessionId: string`
  - `userMessages: number`
  - `assistantMessages: number`
  - `toolCalls: number`
  - `toolResults: number`
  - `totalMessages: number`
  - `tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }`
  - `cost: number`

#### Exported Classes
- **`AgentSession`**
  - *Description*: Data structure or object model representing `AgentSession`.
  - `subscribe(listener: AgentSessionEventListener): () => void`
  - `dispose(): void`
  - `getActiveToolNames(): string[]`
  - `getAllTools(): ToolInfo[]`
  - `setActiveToolsByName(toolNames: string[]): void`
  - `setScopedModels(scopedModels: Array<`
  - `async prompt(text: string, options?: PromptOptions): Promise<void>`
  - `async steer(text: string, images?: ImageContent[]): Promise<void>`
  - `async followUp(text: string, images?: ImageContent[]): Promise<void>`
  - `async sendCustomMessage<T = unknown>( 		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, 		options?:`
  - `async sendUserMessage( 		content: string | (TextContent | ImageContent)[], 		options?:`
  - `clearQueue():`
  - `getSteeringMessages(): readonly string[]`
  - `getFollowUpMessages(): readonly string[]`
  - `async abort(): Promise<void>`
  - `async newSession(options?:`
  - `async setModel(model: Model<any>): Promise<void>`
  - `async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined>`
  - `setThinkingLevel(level: ThinkingLevel): void`
  - `cycleThinkingLevel(): ThinkingLevel | undefined`
  - `getAvailableThinkingLevels(): ThinkingLevel[]`
  - `supportsXhighThinking(): boolean`
  - `supportsThinking(): boolean`
  - `setSteeringMode(mode: "all" | "one-at-a-time"): void`
  - `setFollowUpMode(mode: "all" | "one-at-a-time"): void`
  - `async compact(customInstructions?: string): Promise<CompactionResult>`
  - `abortCompaction(): void`
  - `abortBranchSummary(): void`
  - `setAutoCompactionEnabled(enabled: boolean): void`
  - `async bindExtensions(bindings: ExtensionBindings): Promise<void>`
  - `async reload(): Promise<void>`
  - `abortRetry(): void`
  - `setAutoRetryEnabled(enabled: boolean): void`
  - `async executeBash( 		command: string, 		onChunk?: (chunk: string) => void, 		options?:`
  - `recordBashResult(command: string, result: BashResult, options?:`
  - `abortBash(): void`
  - `async switchSession(sessionPath: string): Promise<boolean>`
  - `setSessionName(name: string): void`
  - `async fork(entryId: string): Promise<`
  - `async navigateTree( 		targetId: string, 		options:`
  - `getUserMessagesForForking(): Array<`
  - `getSessionStats(): SessionStats`
  - `getContextUsage(): ContextUsage | undefined`
  - `async exportToHtml(outputPath?: string): Promise<string>`
  - `getLastAssistantText(): string | undefined`
  - `hasExtensionHandlers(eventType: string): boolean`

#### Exported Types
- **`AgentSessionEvent`**: `| AgentEvent 	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" } 	| { 			type: "auto_compaction_end"; 			result: CompactionResult | undefined; 			aborted: boolean; 			willRetry: boo...`
  - *Description*: Session-specific events that extend the core AgentEvent
- **`AgentSessionEventListener`**: `(event: AgentSessionEvent) => void`
  - *Description*: Listener function for agent session events

### File: `packages/coding-agent/src/core/auth-storage.ts`

#### Exported Interfaces
- **`AuthStorageBackend`**
  - *Description*: Data structure or object model representing `AuthStorageBackend`.

#### Exported Classes
- **`FileAuthStorageBackend`**
  - *Description*: Data structure or object model representing `FileAuthStorageBackend`.
  - `withLock<T>(fn: (current: string | undefined) => LockResult<T>): T`
  - `async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>`
- **`InMemoryAuthStorageBackend`**
  - *Description*: Data structure or object model representing `InMemoryAuthStorageBackend`.
  - `withLock<T>(fn: (current: string | undefined) => LockResult<T>): T`
  - `async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>`
- **`AuthStorage`**
  - *Description*: Credential storage backed by a JSON file.
  - `static create(authPath?: string): AuthStorage`
  - `static fromStorage(storage: AuthStorageBackend): AuthStorage`
  - `static inMemory(data: AuthStorageData =`
  - `setRuntimeApiKey(provider: string, apiKey: string): void`
  - `removeRuntimeApiKey(provider: string): void`
  - `setFallbackResolver(resolver: (provider: string) => string | undefined): void`
  - `reload(): void`
  - `get(provider: string): AuthCredential | undefined`
  - `set(provider: string, credential: AuthCredential): void`
  - `remove(provider: string): void`
  - `list(): string[]`
  - `has(provider: string): boolean`
  - `hasAuth(provider: string): boolean`
  - `getAll(): AuthStorageData`
  - `drainErrors(): Error[]`
  - `async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void>`
  - `logout(provider: string): void`
  - `async getApiKey(providerId: string): Promise<string | undefined>`
  - `getOAuthProviders()`

#### Exported Types
- **`ApiKeyCredential`**: `{ 	type: "api_key"; 	key: string; }`
  - *Description*: Type alias for `ApiKeyCredential`.
- **`OAuthCredential`**: `{ 	type: "oauth"; } & OAuthCredentials`
  - *Description*: Type alias for `OAuthCredential`.
- **`AuthCredential`**: `ApiKeyCredential | OAuthCredential`
  - *Description*: Type alias for `AuthCredential`.
- **`AuthStorageData`**: `Record<string, AuthCredential>`
  - *Description*: Type alias for `AuthStorageData`.

### File: `packages/coding-agent/src/core/bash-executor.ts`

#### Exported Functions
- **`executeBash`**: `export function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult>`
  - *Description*: Execute a bash command with optional streaming and cancellation support.  Features: - Streams sanitized output via onChunk callback - Writes large output to temp file for later retrieval - Supports cancellation via AbortSignal - Sanitizes output (strips ANSI, removes binary garbage, normalizes newlines) - Truncates output if it exceeds the default max bytes  @param command - The bash command to execute @param options - Optional streaming callback and abort signal @returns Promise resolving to execution result
- **`executeBashWithOperations`**: `export async function executeBashWithOperations( 	command: string, 	cwd: string, 	operations: BashOperations, 	options?: BashExecutorOptions, ): Promise<BashResult>`
  - *Description*: Execute a bash command using custom BashOperations. Used for remote execution (SSH, containers, etc.).

#### Exported Interfaces
- **`BashExecutorOptions`**
  - *Description*: Configuration options for `BashExecutor`.
  - `onChunk?: (chunk: string) => void`
  - `signal?: AbortSignal`
- **`BashResult`**
  - *Description*: Data structure or object model representing `BashResult`.
  - `output: string`
  - `exitCode: number`
  - `cancelled: boolean`
  - `truncated: boolean`
  - `fullOutputPath?: string`

### File: `packages/coding-agent/src/core/compaction/branch-summarization.ts`

#### Exported Functions
- **`collectEntriesForBranchSummary`**: `export function collectEntriesForBranchSummary( 	session: ReadonlySessionManager, 	oldLeafId: string | null, 	targetId: string, ): CollectEntriesResult`
  - *Description*: Collect entries that should be summarized when navigating from one position to another.  Walks from oldLeafId back to the common ancestor with targetId, collecting entries along the way. Does NOT stop at compaction boundaries - those are included and their summaries become context.  @param session - Session manager (read-only access) @param oldLeafId - Current position (where we're navigating from) @param targetId - Target position (where we're navigating to) @returns Entries to summarize and the common ancestor
- **`prepareBranchEntries`**: `export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation`
  - *Description*: Prepare entries for summarization with token budget.  Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget. This ensures we keep the most recent context when the branch is too long.  Also collects file operations from: - Tool calls in assistant messages - Existing branch_summary entries' details (for cumulative tracking)  @param entries - Entries in chronological order @param tokenBudget - Maximum tokens to include (0 = no limit)
- **`generateBranchSummary`**: `export async function generateBranchSummary( 	entries: SessionEntry[], 	options: GenerateBranchSummaryOptions, ): Promise<BranchSummaryResult>`
  - *Description*: Generate a summary of abandoned branch entries.  @param entries - Session entries to summarize (chronological order) @param options - Generation options

#### Exported Interfaces
- **`BranchSummaryResult`**
  - *Description*: Data structure or object model representing `BranchSummaryResult`.
  - `summary?: string`
  - `readFiles?: string[]`
  - `modifiedFiles?: string[]`
  - `aborted?: boolean`
  - `error?: string`
- **`BranchSummaryDetails`**
  - *Description*: Details stored in BranchSummaryEntry.details for file tracking
  - `readFiles: string[]`
  - `modifiedFiles: string[]`
- **`BranchPreparation`**
  - *Description*: Data structure or object model representing `BranchPreparation`.
  - `messages: AgentMessage[]`
  - `fileOps: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/compaction/utils").FileOperations`
  - `totalTokens: number`
- **`CollectEntriesResult`**
  - *Description*: Data structure or object model representing `CollectEntriesResult`.
  - `entries: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionEntry[]`
  - `commonAncestorId: string`
- **`GenerateBranchSummaryOptions`**
  - *Description*: Configuration options for `GenerateBranchSummary`.
  - `model: Model<any>`
  - `apiKey: string`
  - `signal: AbortSignal`
  - `customInstructions?: string`
  - `replaceInstructions?: boolean`
  - `reserveTokens?: number`

### File: `packages/coding-agent/src/core/compaction/compaction.ts`

#### Exported Functions
- **`calculateContextTokens`**: `export function calculateContextTokens(usage: Usage): number`
  - *Description*: Calculate total context tokens from usage. Uses the native totalTokens field when available, falls back to computing from components.
- **`getLastAssistantUsage`**: `export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined`
  - *Description*: Find the last non-aborted assistant message usage from session entries.
- **`estimateContextTokens`**: `export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate`
  - *Description*: Estimate context tokens from messages, using the last assistant usage when available. If there are messages after the last usage, estimate their tokens with estimateTokens.
- **`shouldCompact`**: `export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean`
  - *Description*: Check if compaction should trigger based on context usage.
- **`estimateTokens`**: `export function estimateTokens(message: AgentMessage): number`
  - *Description*: Estimate token count for a message using chars/4 heuristic. This is conservative (overestimates tokens).
- **`findTurnStartIndex`**: `export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number`
  - *Description*: Find the user message (or bashExecution) that starts the turn containing the given entry index. Returns -1 if no turn start found before the index. BashExecutionMessage is treated like a user message for turn boundaries.
- **`findCutPoint`**: `export function findCutPoint( 	entries: SessionEntry[], 	startIndex: number, 	endIndex: number, 	keepRecentTokens: number, ): CutPointResult`
  - *Description*: Find the cut point in session entries that keeps approximately `keepRecentTokens`.  Algorithm: Walk backwards from newest, accumulating estimated message sizes. Stop when we've accumulated >= keepRecentTokens. Cut at that point.  Can cut at user OR assistant messages (never tool results). When cutting at an assistant message with tool calls, its tool results come after and will be kept.  Returns CutPointResult with: - firstKeptEntryIndex: the entry index to start keeping from - turnStartIndex: if cutting mid-turn, the user message that started that turn - isSplitTurn: whether we're cutting in the middle of a turn  Only considers entries between `startIndex` and `endIndex` (exclusive).
- **`generateSummary`**: `export async function generateSummary( 	currentMessages: AgentMessage[], 	model: Model<any>, 	reserveTokens: number, 	apiKey: string, 	signal?: AbortSignal, 	customInstructions?: string, 	previousSummary?: string, ): Promise<string>`
  - *Description*: Generate a summary of the conversation using the LLM. If previousSummary is provided, uses the update prompt to merge.
- **`prepareCompaction`**: `export function prepareCompaction( 	pathEntries: SessionEntry[], 	settings: CompactionSettings, ): CompactionPreparation | undefined`
  - *Description*: Executes the logic for `prepareCompaction`.
- **`compact`**: `export async function compact( 	preparation: CompactionPreparation, 	model: Model<any>, 	apiKey: string, 	customInstructions?: string, 	signal?: AbortSignal, ): Promise<CompactionResult>`
  - *Description*: Generate summaries for compaction using prepared data. Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.  @param preparation - Pre-calculated preparation from prepareCompaction() @param customInstructions - Optional custom focus for the summary

#### Exported Interfaces
- **`CompactionDetails`**
  - *Description*: Details stored in CompactionEntry.details for file tracking
  - `readFiles: string[]`
  - `modifiedFiles: string[]`
- **`CompactionResult`**
  - *Description*: Result from compact() - SessionManager adds uuid/parentUuid when saving
  - `summary: string`
  - `firstKeptEntryId: string`
  - `tokensBefore: number`
  - `details?: T`
- **`CompactionSettings`**
  - *Description*: Data structure or object model representing `CompactionSettings`.
  - `enabled: boolean`
  - `reserveTokens: number`
  - `keepRecentTokens: number`
- **`ContextUsageEstimate`**
  - *Description*: Data structure or object model representing `ContextUsageEstimate`.
  - `tokens: number`
  - `usageTokens: number`
  - `trailingTokens: number`
  - `lastUsageIndex: number`
- **`CutPointResult`**
  - *Description*: Data structure or object model representing `CutPointResult`.
  - `firstKeptEntryIndex: number`
  - `turnStartIndex: number`
  - `isSplitTurn: boolean`
- **`CompactionPreparation`**
  - *Description*: Data structure or object model representing `CompactionPreparation`.
  - `firstKeptEntryId: string`
  - `messagesToSummarize: AgentMessage[]`
  - `turnPrefixMessages: AgentMessage[]`
  - `isSplitTurn: boolean`
  - `tokensBefore: number`
  - `previousSummary?: string`
  - `fileOps: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/compaction/utils").FileOperations`
  - `settings: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/compaction/compaction").CompactionSettings`

### File: `packages/coding-agent/src/core/compaction/utils.ts`

#### Exported Functions
- **`createFileOps`**: `export function createFileOps(): FileOperations`
  - *Description*: Instantiates or constructs a new FileOps.
- **`extractFileOpsFromMessage`**: `export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void`
  - *Description*: Extract file operations from tool calls in an assistant message.
- **`computeFileLists`**: `export function computeFileLists(fileOps: FileOperations):`
  - *Description*: Compute final file lists from file operations. Returns readFiles (files only read, not modified) and modifiedFiles.
- **`formatFileOperations`**: `export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string`
  - *Description*: Format file operations as XML tags for summary.
- **`serializeConversation`**: `export function serializeConversation(messages: Message[]): string`
  - *Description*: Serialize LLM messages to text for summarization. This prevents the model from treating it as a conversation to continue. Call convertToLlm() first to handle custom message types.

#### Exported Interfaces
- **`FileOperations`**
  - *Description*: Data structure or object model representing `FileOperations`.
  - `read: Set<string>`
  - `written: Set<string>`
  - `edited: Set<string>`

### File: `packages/coding-agent/src/core/diagnostics.ts`

#### Exported Interfaces
- **`ResourceCollision`**
  - *Description*: Data structure or object model representing `ResourceCollision`.
  - `resourceType: "extension" | "skill" | "prompt" | "theme"`
  - `name: string`
  - `winnerPath: string`
  - `loserPath: string`
  - `winnerSource?: string`
  - `loserSource?: string`
- **`ResourceDiagnostic`**
  - *Description*: Data structure or object model representing `ResourceDiagnostic`.
  - `type: "warning" | "error" | "collision"`
  - `message: string`
  - `path?: string`
  - `collision?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/diagnostics").ResourceCollision`

### File: `packages/coding-agent/src/core/event-bus.ts`

#### Exported Functions
- **`createEventBus`**: `export function createEventBus(): EventBusController`
  - *Description*: Instantiates or constructs a new EventBus.

#### Exported Interfaces
- **`EventBus`**
  - *Description*: Data structure or object model representing `EventBus`.
- **`EventBusController`**
  - *Description*: Data structure or object model representing `EventBusController`.

### File: `packages/coding-agent/src/core/exec.ts`

#### Exported Functions
- **`execCommand`**: `export async function execCommand( 	command: string, 	args: string[], 	cwd: string, 	options?: ExecOptions, ): Promise<ExecResult>`
  - *Description*: Execute a shell command and return stdout/stderr/code. Supports timeout and abort signal.

#### Exported Interfaces
- **`ExecOptions`**
  - *Description*: Options for executing shell commands.
  - `signal?: AbortSignal`
  - `timeout?: number`
  - `cwd?: string`
- **`ExecResult`**
  - *Description*: Result of executing a shell command.
  - `stdout: string`
  - `stderr: string`
  - `code: number`
  - `killed: boolean`

### File: `packages/coding-agent/src/core/export-html/ansi-to-html.ts`

#### Exported Functions
- **`ansiToHtml`**: `export function ansiToHtml(text: string): string`
  - *Description*: Convert ANSI-escaped text to HTML with inline styles.
- **`ansiLinesToHtml`**: `export function ansiLinesToHtml(lines: string[]): string`
  - *Description*: Convert array of ANSI-escaped lines to HTML. Each line is wrapped in a div element.

### File: `packages/coding-agent/src/core/export-html/index.ts`

#### Exported Functions
- **`exportSessionToHtml`**: `export async function exportSessionToHtml( 	sm: SessionManager, 	state?: AgentState, 	options?: ExportOptions | string, ): Promise<string>`
  - *Description*: Export session to HTML using SessionManager and AgentState. Used by TUI's /export command.
- **`exportFromFile`**: `export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string>`
  - *Description*: Export session file to HTML (standalone, without AgentState). Used by CLI for exporting arbitrary session files.

#### Exported Interfaces
- **`ToolHtmlRenderer`**
  - *Description*: Interface for rendering custom tools to HTML. Used by agent-session to pre-render extension tool output.
- **`ExportOptions`**
  - *Description*: Configuration options for `Export`.
  - `outputPath?: string`
  - `themeName?: string`
  - `toolRenderer?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/export-html/index").ToolHtmlRenderer`

### File: `packages/coding-agent/src/core/export-html/tool-renderer.ts`

#### Exported Functions
- **`createToolHtmlRenderer`**: `export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer`
  - *Description*: Create a tool HTML renderer.  The renderer looks up tool definitions and invokes their renderCall/renderResult methods, converting the resulting TUI Component output (ANSI) to HTML.

#### Exported Interfaces
- **`ToolHtmlRendererDeps`**
  - *Description*: Data structure or object model representing `ToolHtmlRendererDeps`.
  - `getToolDefinition: (name: string) => import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ToolDefinition<TSchema, unknown>`
  - `theme: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/modes/interactive/theme/theme").Theme`
  - `width?: number`
- **`ToolHtmlRenderer`**
  - *Description*: Data structure or object model representing `ToolHtmlRenderer`.

### File: `packages/coding-agent/src/core/extensions/loader.ts`

#### Exported Functions
- **`createExtensionRuntime`**: `export function createExtensionRuntime(): ExtensionRuntime`
  - *Description*: Create a runtime with throwing stubs for action methods. Runner.bindCore() replaces these with real implementations.
- **`loadExtensionFromFactory`**: `export async function loadExtensionFromFactory( 	factory: ExtensionFactory, 	cwd: string, 	eventBus: EventBus, 	runtime: ExtensionRuntime, 	extensionPath = "<inline>", ): Promise<Extension>`
  - *Description*: Create an Extension from an inline factory function.
- **`loadExtensions`**: `export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult>`
  - *Description*: Load extensions from paths.
- **`discoverAndLoadExtensions`**: `export async function discoverAndLoadExtensions( 	configuredPaths: string[], 	cwd: string, 	agentDir: string = getAgentDir(), 	eventBus?: EventBus, ): Promise<LoadExtensionsResult>`
  - *Description*: Discover and load extensions from standard locations.

### File: `packages/coding-agent/src/core/extensions/runner.ts`

#### Exported Functions
- **`emitSessionShutdownEvent`**: `export async function emitSessionShutdownEvent(extensionRunner: ExtensionRunner | undefined): Promise<boolean>`
  - *Description*: Helper function to emit session_shutdown event to extensions. Returns true if the event was emitted, false if there were no handlers.

#### Exported Classes
- **`ExtensionRunner`**
  - *Description*: Data structure or object model representing `ExtensionRunner`.
  - `bindCore(actions: ExtensionActions, contextActions: ExtensionContextActions): void`
  - `bindCommandContext(actions?: ExtensionCommandContextActions): void`
  - `setUIContext(uiContext?: ExtensionUIContext): void`
  - `getUIContext(): ExtensionUIContext`
  - `hasUI(): boolean`
  - `getExtensionPaths(): string[]`
  - `getAllRegisteredTools(): RegisteredTool[]`
  - `getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined`
  - `getFlags(): Map<string, ExtensionFlag>`
  - `setFlagValue(name: string, value: boolean | string): void`
  - `getFlagValues(): Map<string, boolean | string>`
  - `getShortcuts(effectiveKeybindings: Required<KeybindingsConfig>): Map<KeyId, ExtensionShortcut>`
  - `getShortcutDiagnostics(): ResourceDiagnostic[]`
  - `onError(listener: ExtensionErrorListener): () => void`
  - `emitError(error: ExtensionError): void`
  - `hasHandlers(eventType: string): boolean`
  - `getMessageRenderer(customType: string): MessageRenderer | undefined`
  - `getRegisteredCommands(reserved?: Set<string>): RegisteredCommand[]`
  - `getCommandDiagnostics(): ResourceDiagnostic[]`
  - `getRegisteredCommandsWithPaths(): Array<`
  - `getCommand(name: string): RegisteredCommand | undefined`
  - `shutdown(): void`
  - `createContext(): ExtensionContext`
  - `createCommandContext(): ExtensionCommandContext`
  - `async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>>`
  - `async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined>`
  - `async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>`
  - `async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined>`
  - `async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]>`
  - `async emitBeforeAgentStart( 		prompt: string, 		images: ImageContent[] | undefined, 		systemPrompt: string, 	): Promise<BeforeAgentStartCombinedResult | undefined>`
  - `async emitResourcesDiscover( 		cwd: string, 		reason: ResourcesDiscoverEvent["reason"], 	): Promise<`
  - `async emitInput(text: string, images: ImageContent[] | undefined, source: InputSource): Promise<InputEventResult>`

#### Exported Types
- **`ExtensionErrorListener`**: `(error: ExtensionError) => void`
  - *Description*: Type alias for `ExtensionErrorListener`.
- **`NewSessionHandler`**: `(options?: { 	parentSession?: string; 	setup?: (sessionManager: SessionManager) => Promise<void>; }) => Promise<{ cancelled: boolean }>`
  - *Description*: Type alias for `NewSessionHandler`.
- **`ForkHandler`**: `(entryId: string) => Promise<{ cancelled: boolean }>`
  - *Description*: Type alias for `ForkHandler`.
- **`NavigateTreeHandler`**: `( 	targetId: string, 	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }, ) => Promise<{ cancelled: boolean }>`
  - *Description*: Type alias for `NavigateTreeHandler`.
- **`SwitchSessionHandler`**: `(sessionPath: string) => Promise<{ cancelled: boolean }>`
  - *Description*: Type alias for `SwitchSessionHandler`.
- **`ReloadHandler`**: `() => Promise<void>`
  - *Description*: Type alias for `ReloadHandler`.
- **`ShutdownHandler`**: `() => void`
  - *Description*: Type alias for `ShutdownHandler`.

### File: `packages/coding-agent/src/core/extensions/types.ts`

#### Exported Functions
- **`isBashToolResult`**: `export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent`
  - *Description*: Checks if the condition 'isBashToolResult' is true.
- **`isReadToolResult`**: `export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent`
  - *Description*: Checks if the condition 'isReadToolResult' is true.
- **`isEditToolResult`**: `export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent`
  - *Description*: Checks if the condition 'isEditToolResult' is true.
- **`isWriteToolResult`**: `export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent`
  - *Description*: Checks if the condition 'isWriteToolResult' is true.
- **`isGrepToolResult`**: `export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent`
  - *Description*: Checks if the condition 'isGrepToolResult' is true.
- **`isFindToolResult`**: `export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent`
  - *Description*: Checks if the condition 'isFindToolResult' is true.
- **`isLsToolResult`**: `export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent`
  - *Description*: Checks if the condition 'isLsToolResult' is true.
- **`isToolCallEventType`**: `export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean`
  - *Description*: Checks if the condition 'isToolCallEventType' is true.

#### Exported Interfaces
- **`ExtensionUIDialogOptions`**
  - *Description*: Options for extension UI dialogs.
  - `signal?: AbortSignal`
  - `timeout?: number`
- **`ExtensionWidgetOptions`**
  - *Description*: Options for extension widgets.
  - `placement?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").WidgetPlacement`
- **`ExtensionUIContext`**
  - *Description*: UI context for extensions to request interactive UI. Each mode (interactive, RPC, print) provides its own implementation.
  - `theme: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/modes/interactive/theme/theme").Theme`
- **`ContextUsage`**
  - *Description*: Data structure or object model representing `ContextUsage`.
  - `tokens: number`
  - `contextWindow: number`
  - `percent: number`
- **`CompactOptions`**
  - *Description*: Configuration options for `Compact`.
  - `customInstructions?: string`
  - `onComplete?: (result: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/compaction/compaction").CompactionResult<unknown>) => void`
  - `onError?: (error: Error) => void`
- **`ExtensionContext`**
  - *Description*: Context passed to extension event handlers.
  - `ui: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionUIContext`
  - `hasUI: boolean`
  - `cwd: string`
  - `sessionManager: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").ReadonlySessionManager`
  - `modelRegistry: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/model-registry").ModelRegistry`
  - `model: any`
- **`ExtensionCommandContext`**
  - *Description*: Extended context for command handlers. Includes session control methods only safe in user-initiated commands.
- **`ToolRenderResultOptions`**
  - *Description*: Rendering options for tool results
  - `expanded: boolean`
  - `isPartial: boolean`
- **`ToolDefinition`**
  - *Description*: Tool definition for registerTool().
  - `name: string`
  - `label: string`
  - `description: string`
  - `parameters: TParams`
  - `renderCall?: (args: Static<TParams>, theme: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/modes/interactive/theme/theme").Theme) => Component`
  - `renderResult?: (result: AgentToolResult<TDetails>, options: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ToolRenderResultOptions, theme: import("c:/Works/GitWorks/pi-mono/packa...`
- **`ResourcesDiscoverEvent`**
  - *Description*: Fired after session_start to allow extensions to provide additional resource paths.
  - `type: "resources_discover"`
  - `cwd: string`
  - `reason: "startup" | "reload"`
- **`ResourcesDiscoverResult`**
  - *Description*: Result from resources_discover event handler
  - `skillPaths?: string[]`
  - `promptPaths?: string[]`
  - `themePaths?: string[]`
- **`SessionStartEvent`**
  - *Description*: Fired on initial session load
  - `type: "session_start"`
- **`SessionBeforeSwitchEvent`**
  - *Description*: Fired before switching to another session (can be cancelled)
  - `type: "session_before_switch"`
  - `reason: "new" | "resume"`
  - `targetSessionFile?: string`
- **`SessionSwitchEvent`**
  - *Description*: Fired after switching to another session
  - `type: "session_switch"`
  - `reason: "new" | "resume"`
  - `previousSessionFile: string`
- **`SessionBeforeForkEvent`**
  - *Description*: Fired before forking a session (can be cancelled)
  - `type: "session_before_fork"`
  - `entryId: string`
- **`SessionForkEvent`**
  - *Description*: Fired after forking a session
  - `type: "session_fork"`
  - `previousSessionFile: string`
- **`SessionBeforeCompactEvent`**
  - *Description*: Fired before context compaction (can be cancelled or customized)
  - `type: "session_before_compact"`
  - `preparation: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/compaction/compaction").CompactionPreparation`
  - `branchEntries: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionEntry[]`
  - `customInstructions?: string`
  - `signal: AbortSignal`
- **`SessionCompactEvent`**
  - *Description*: Fired after context compaction
  - `type: "session_compact"`
  - `compactionEntry: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").CompactionEntry<unknown>`
  - `fromExtension: boolean`
- **`SessionShutdownEvent`**
  - *Description*: Fired on process exit
  - `type: "session_shutdown"`
- **`TreePreparation`**
  - *Description*: Preparation data for tree navigation
  - `targetId: string`
  - `oldLeafId: string`
  - `commonAncestorId: string`
  - `entriesToSummarize: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionEntry[]`
  - `userWantsSummary: boolean`
  - `customInstructions?: string`
  - `replaceInstructions?: boolean`
  - `label?: string`
- **`SessionBeforeTreeEvent`**
  - *Description*: Fired before navigating in the session tree (can be cancelled)
  - `type: "session_before_tree"`
  - `preparation: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").TreePreparation`
  - `signal: AbortSignal`
- **`SessionTreeEvent`**
  - *Description*: Fired after navigating in the session tree
  - `type: "session_tree"`
  - `newLeafId: string`
  - `oldLeafId: string`
  - `summaryEntry?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").BranchSummaryEntry<unknown>`
  - `fromExtension?: boolean`
- **`ContextEvent`**
  - *Description*: Fired before each LLM call. Can modify messages.
  - `type: "context"`
  - `messages: AgentMessage[]`
- **`BeforeAgentStartEvent`**
  - *Description*: Fired after user submits prompt but before agent loop.
  - `type: "before_agent_start"`
  - `prompt: string`
  - `images?: ImageContent[]`
  - `systemPrompt: string`
- **`AgentStartEvent`**
  - *Description*: Fired when an agent loop starts
  - `type: "agent_start"`
- **`AgentEndEvent`**
  - *Description*: Fired when an agent loop ends
  - `type: "agent_end"`
  - `messages: AgentMessage[]`
- **`TurnStartEvent`**
  - *Description*: Fired at the start of each turn
  - `type: "turn_start"`
  - `turnIndex: number`
  - `timestamp: number`
- **`TurnEndEvent`**
  - *Description*: Fired at the end of each turn
  - `type: "turn_end"`
  - `turnIndex: number`
  - `message: AgentMessage`
  - `toolResults: ToolResultMessage[]`
- **`MessageStartEvent`**
  - *Description*: Fired when a message starts (user, assistant, or toolResult)
  - `type: "message_start"`
  - `message: AgentMessage`
- **`MessageUpdateEvent`**
  - *Description*: Fired during assistant message streaming with token-by-token updates
  - `type: "message_update"`
  - `message: AgentMessage`
  - `assistantMessageEvent: AssistantMessageEvent`
- **`MessageEndEvent`**
  - *Description*: Fired when a message ends
  - `type: "message_end"`
  - `message: AgentMessage`
- **`ToolExecutionStartEvent`**
  - *Description*: Fired when a tool starts executing
  - `type: "tool_execution_start"`
  - `toolCallId: string`
  - `toolName: string`
  - `args: any`
- **`ToolExecutionUpdateEvent`**
  - *Description*: Fired during tool execution with partial/streaming output
  - `type: "tool_execution_update"`
  - `toolCallId: string`
  - `toolName: string`
  - `args: any`
  - `partialResult: any`
- **`ToolExecutionEndEvent`**
  - *Description*: Fired when a tool finishes executing
  - `type: "tool_execution_end"`
  - `toolCallId: string`
  - `toolName: string`
  - `result: any`
  - `isError: boolean`
- **`ModelSelectEvent`**
  - *Description*: Fired when a new model is selected
  - `type: "model_select"`
  - `model: Model<any>`
  - `previousModel: any`
  - `source: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ModelSelectSource`
- **`UserBashEvent`**
  - *Description*: Fired when user executes a bash command via ! or !! prefix
  - `type: "user_bash"`
  - `command: string`
  - `excludeFromContext: boolean`
  - `cwd: string`
- **`InputEvent`**
  - *Description*: Fired when user input is received, before agent processing
  - `type: "input"`
  - `text: string`
  - `images?: ImageContent[]`
  - `source: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").InputSource`
- **`BashToolCallEvent`**
  - *Description*: Data structure or object model representing `BashToolCallEvent`.
  - `toolName: "bash"`
  - `input: Static<any>`
- **`ReadToolCallEvent`**
  - *Description*: Data structure or object model representing `ReadToolCallEvent`.
  - `toolName: "read"`
  - `input: Static<any>`
- **`EditToolCallEvent`**
  - *Description*: Data structure or object model representing `EditToolCallEvent`.
  - `toolName: "edit"`
  - `input: Static<any>`
- **`WriteToolCallEvent`**
  - *Description*: Data structure or object model representing `WriteToolCallEvent`.
  - `toolName: "write"`
  - `input: Static<any>`
- **`GrepToolCallEvent`**
  - *Description*: Data structure or object model representing `GrepToolCallEvent`.
  - `toolName: "grep"`
  - `input: Static<any>`
- **`FindToolCallEvent`**
  - *Description*: Data structure or object model representing `FindToolCallEvent`.
  - `toolName: "find"`
  - `input: Static<any>`
- **`LsToolCallEvent`**
  - *Description*: Data structure or object model representing `LsToolCallEvent`.
  - `toolName: "ls"`
  - `input: Static<any>`
- **`CustomToolCallEvent`**
  - *Description*: Data structure or object model representing `CustomToolCallEvent`.
  - `toolName: string`
  - `input: Record<string, unknown>`
- **`BashToolResultEvent`**
  - *Description*: Data structure or object model representing `BashToolResultEvent`.
  - `toolName: "bash"`
  - `details: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/bash").BashToolDetails`
- **`ReadToolResultEvent`**
  - *Description*: Data structure or object model representing `ReadToolResultEvent`.
  - `toolName: "read"`
  - `details: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/read").ReadToolDetails`
- **`EditToolResultEvent`**
  - *Description*: Data structure or object model representing `EditToolResultEvent`.
  - `toolName: "edit"`
  - `details: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/edit").EditToolDetails`
- **`WriteToolResultEvent`**
  - *Description*: Data structure or object model representing `WriteToolResultEvent`.
  - `toolName: "write"`
  - `details: undefined`
- **`GrepToolResultEvent`**
  - *Description*: Data structure or object model representing `GrepToolResultEvent`.
  - `toolName: "grep"`
  - `details: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/grep").GrepToolDetails`
- **`FindToolResultEvent`**
  - *Description*: Data structure or object model representing `FindToolResultEvent`.
  - `toolName: "find"`
  - `details: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/find").FindToolDetails`
- **`LsToolResultEvent`**
  - *Description*: Data structure or object model representing `LsToolResultEvent`.
  - `toolName: "ls"`
  - `details: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/ls").LsToolDetails`
- **`CustomToolResultEvent`**
  - *Description*: Data structure or object model representing `CustomToolResultEvent`.
  - `toolName: string`
  - `details: unknown`
- **`ContextEventResult`**
  - *Description*: Data structure or object model representing `ContextEventResult`.
  - `messages?: AgentMessage[]`
- **`ToolCallEventResult`**
  - *Description*: Data structure or object model representing `ToolCallEventResult`.
  - `block?: boolean`
  - `reason?: string`
- **`UserBashEventResult`**
  - *Description*: Result from user_bash event handler
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/bash").BashOperations`
  - `result?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/bash-executor").BashResult`
- **`ToolResultEventResult`**
  - *Description*: Data structure or object model representing `ToolResultEventResult`.
  - `content?: any[]`
  - `details?: unknown`
  - `isError?: boolean`
- **`BeforeAgentStartEventResult`**
  - *Description*: Data structure or object model representing `BeforeAgentStartEventResult`.
  - `message?: Pick<import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/messages").CustomMessage<unknown>, "customType" | "content" | "display" | "details">`
  - `systemPrompt?: string`
- **`SessionBeforeSwitchResult`**
  - *Description*: Data structure or object model representing `SessionBeforeSwitchResult`.
  - `cancel?: boolean`
- **`SessionBeforeForkResult`**
  - *Description*: Data structure or object model representing `SessionBeforeForkResult`.
  - `cancel?: boolean`
  - `skipConversationRestore?: boolean`
- **`SessionBeforeCompactResult`**
  - *Description*: Data structure or object model representing `SessionBeforeCompactResult`.
  - `cancel?: boolean`
  - `compaction?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/compaction/compaction").CompactionResult<unknown>`
- **`SessionBeforeTreeResult`**
  - *Description*: Data structure or object model representing `SessionBeforeTreeResult`.
  - `cancel?: boolean`
  - `summary?: { summary: string; details?: unknown; }`
  - `customInstructions?: string`
  - `replaceInstructions?: boolean`
  - `label?: string`
- **`MessageRenderOptions`**
  - *Description*: Configuration options for `MessageRender`.
  - `expanded: boolean`
- **`RegisteredCommand`**
  - *Description*: Data structure or object model representing `RegisteredCommand`.
  - `name: string`
  - `description?: string`
  - `getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[]`
  - `handler: (args: string, ctx: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionCommandContext) => Promise<void>`
- **`ExtensionAPI`**
  - *Description*: ExtensionAPI passed to extension factory functions.
  - `events: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/event-bus").EventBus`
- **`ProviderConfig`**
  - *Description*: Configuration for registering a provider via pi.registerProvider().
  - `baseUrl?: string`
  - `apiKey?: string`
  - `api?: Api`
  - `streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream`
  - `headers?: Record<string, string>`
  - `authHeader?: boolean`
  - `models?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ProviderModelConfig[]`
  - `oauth?: { name: string; login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>; refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>; getApiKey(credentials: OAuthCredentials): stri...`
- **`ProviderModelConfig`**
  - *Description*: Configuration for a model within a provider.
  - `id: string`
  - `name: string`
  - `api?: Api`
  - `reasoning: boolean`
  - `input: ("text" | "image")[]`
  - `cost: { input: number; output: number; cacheRead: number; cacheWrite: number; }`
  - `contextWindow: number`
  - `maxTokens: number`
  - `headers?: Record<string, string>`
  - `compat?: Model<Api>`
- **`RegisteredTool`**
  - *Description*: Data structure or object model representing `RegisteredTool`.
  - `definition: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ToolDefinition<TSchema, unknown>`
  - `extensionPath: string`
- **`ExtensionFlag`**
  - *Description*: Data structure or object model representing `ExtensionFlag`.
  - `name: string`
  - `description?: string`
  - `type: "string" | "boolean"`
  - `default?: string | boolean`
  - `extensionPath: string`
- **`ExtensionShortcut`**
  - *Description*: Data structure or object model representing `ExtensionShortcut`.
  - `shortcut: KeyId`
  - `description?: string`
  - `handler: (ctx: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionContext) => void | Promise<void>`
  - `extensionPath: string`
- **`ExtensionRuntimeState`**
  - *Description*: Shared state created by loader, used during registration and runtime. Contains flag values (defaults set during registration, CLI values set after).
  - `flagValues: Map<string, string | boolean>`
  - `pendingProviderRegistrations: { name: string; config: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ProviderConfig; }[]`
  - `registerProvider: (name: string, config: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ProviderConfig) => void`
  - `unregisterProvider: (name: string) => void`
- **`ExtensionActions`**
  - *Description*: Action implementations for pi.* API methods. Provided to runner.initialize(), copied into the shared runtime.
  - `sendMessage: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").SendMessageHandler`
  - `sendUserMessage: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").SendUserMessageHandler`
  - `appendEntry: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").AppendEntryHandler`
  - `setSessionName: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").SetSessionNameHandler`
  - `getSessionName: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").GetSessionNameHandler`
  - `setLabel: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").SetLabelHandler`
  - `getActiveTools: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").GetActiveToolsHandler`
  - `getAllTools: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").GetAllToolsHandler`
  - `setActiveTools: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").SetActiveToolsHandler`
  - `getCommands: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").GetCommandsHandler`
  - `setModel: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").SetModelHandler`
  - `getThinkingLevel: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").GetThinkingLevelHandler`
  - `setThinkingLevel: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").SetThinkingLevelHandler`
- **`ExtensionContextActions`**
  - *Description*: Actions for ExtensionContext (ctx.* in event handlers). Required by all modes.
  - `getModel: () => any`
  - `isIdle: () => boolean`
  - `abort: () => void`
  - `hasPendingMessages: () => boolean`
  - `shutdown: () => void`
  - `getContextUsage: () => import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ContextUsage`
  - `compact: (options?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").CompactOptions) => void`
  - `getSystemPrompt: () => string`
- **`ExtensionCommandContextActions`**
  - *Description*: Actions for ExtensionCommandContext (ctx.* in command handlers). Only needed for interactive mode where extension commands are invokable.
  - `waitForIdle: () => Promise<void>`
  - `newSession: (options?: { parentSession?: string; setup?: (sessionManager: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionManager) => Promise<void>; }) => Promise<{ cance...`
  - `fork: (entryId: string) => Promise<{ cancelled: boolean; }>`
  - `navigateTree: (targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string; }) => Promise<{ cancelled: boolean; }>`
  - `switchSession: (sessionPath: string) => Promise<{ cancelled: boolean; }>`
  - `reload: () => Promise<void>`
- **`ExtensionRuntime`**
  - *Description*: Full runtime = state + actions. Created by loader with throwing action stubs, completed by runner.initialize().
- **`Extension`**
  - *Description*: Loaded extension with all registered items.
  - `path: string`
  - `resolvedPath: string`
  - `handlers: Map<string, HandlerFn[]>`
  - `tools: Map<string, import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").RegisteredTool>`
  - `messageRenderers: Map<string, import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").MessageRenderer<unknown>>`
  - `commands: Map<string, import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").RegisteredCommand>`
  - `flags: Map<string, import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionFlag>`
  - `shortcuts: Map<KeyId, import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionShortcut>`
- **`LoadExtensionsResult`**
  - *Description*: Result of loading extensions.
  - `extensions: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").Extension[]`
  - `errors: { path: string; error: string; }[]`
  - `runtime: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionRuntime`
- **`ExtensionError`**
  - *Description*: Custom error type for `ExtensionError`.
  - `extensionPath: string`
  - `event: string`
  - `error: string`
  - `stack?: string`

#### Exported Types
- **`WidgetPlacement`**: `"aboveEditor" | "belowEditor"`
  - *Description*: Placement for extension widgets.
- **`TerminalInputHandler`**: `(data: string) => { consume?: boolean; data?: string } | undefined`
  - *Description*: Raw terminal input listener for extensions.
- **`SessionEvent`**: `| SessionStartEvent 	| SessionBeforeSwitchEvent 	| SessionSwitchEvent 	| SessionBeforeForkEvent 	| SessionForkEvent 	| SessionBeforeCompactEvent 	| SessionCompactEvent 	| SessionShutdownEvent 	| Sessi...`
  - *Description*: Type alias for `SessionEvent`.
- **`ModelSelectSource`**: `"set" | "cycle" | "restore"`
  - *Description*: Type alias for `ModelSelectSource`.
- **`InputSource`**: `"interactive" | "rpc" | "extension"`
  - *Description*: Source of user input
- **`InputEventResult`**: `| { action: "continue" } 	| { action: "transform"; text: string; images?: ImageContent[] } 	| { action: "handled" }`
  - *Description*: Result from input event handler
- **`ToolCallEvent`**: `| BashToolCallEvent 	| ReadToolCallEvent 	| EditToolCallEvent 	| WriteToolCallEvent 	| GrepToolCallEvent 	| FindToolCallEvent 	| LsToolCallEvent 	| CustomToolCallEvent`
  - *Description*: Fired before a tool executes. Can block.
- **`ToolResultEvent`**: `| BashToolResultEvent 	| ReadToolResultEvent 	| EditToolResultEvent 	| WriteToolResultEvent 	| GrepToolResultEvent 	| FindToolResultEvent 	| LsToolResultEvent 	| CustomToolResultEvent`
  - *Description*: Fired after a tool executes. Can modify result.
- **`ExtensionEvent`**: `| ResourcesDiscoverEvent 	| SessionEvent 	| ContextEvent 	| BeforeAgentStartEvent 	| AgentStartEvent 	| AgentEndEvent 	| TurnStartEvent 	| TurnEndEvent 	| MessageStartEvent 	| MessageUpdateEvent 	| Me...`
  - *Description*: Union of all event types
- **`MessageRenderer`**: `( 	message: CustomMessage<T>, 	options: MessageRenderOptions, 	theme: Theme, ) => Component | undefined`
  - *Description*: Type alias for `MessageRenderer`.
- **`ExtensionHandler`**: `(event: E, ctx: ExtensionContext) => Promise<R | void> | R | void`
  - *Description*: Handler function type for events
- **`ExtensionFactory`**: `(pi: ExtensionAPI) => void | Promise<void>`
  - *Description*: Extension factory function type. Supports both sync and async initialization.
- **`SendMessageHandler`**: `<T = unknown>( 	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, 	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }, ) => void`
  - *Description*: Type alias for `SendMessageHandler`.
- **`SendUserMessageHandler`**: `( 	content: string | (TextContent | ImageContent)[], 	options?: { deliverAs?: "steer" | "followUp" }, ) => void`
  - *Description*: Type alias for `SendUserMessageHandler`.
- **`AppendEntryHandler`**: `<T = unknown>(customType: string, data?: T) => void`
  - *Description*: Type alias for `AppendEntryHandler`.
- **`SetSessionNameHandler`**: `(name: string) => void`
  - *Description*: Type alias for `SetSessionNameHandler`.
- **`GetSessionNameHandler`**: `() => string | undefined`
  - *Description*: Type alias for `GetSessionNameHandler`.
- **`GetActiveToolsHandler`**: `() => string[]`
  - *Description*: Type alias for `GetActiveToolsHandler`.
- **`ToolInfo`**: `Pick<ToolDefinition, "name" | "description" | "parameters">`
  - *Description*: Tool info with name, description, and parameter schema
- **`GetAllToolsHandler`**: `() => ToolInfo[]`
  - *Description*: Type alias for `GetAllToolsHandler`.
- **`GetCommandsHandler`**: `() => SlashCommandInfo[]`
  - *Description*: Type alias for `GetCommandsHandler`.
- **`SetActiveToolsHandler`**: `(toolNames: string[]) => void`
  - *Description*: Type alias for `SetActiveToolsHandler`.
- **`SetModelHandler`**: `(model: Model<any>) => Promise<boolean>`
  - *Description*: Type alias for `SetModelHandler`.
- **`GetThinkingLevelHandler`**: `() => ThinkingLevel`
  - *Description*: Type alias for `GetThinkingLevelHandler`.
- **`SetThinkingLevelHandler`**: `(level: ThinkingLevel) => void`
  - *Description*: Type alias for `SetThinkingLevelHandler`.
- **`SetLabelHandler`**: `(entryId: string, label: string | undefined) => void`
  - *Description*: Type alias for `SetLabelHandler`.

### File: `packages/coding-agent/src/core/extensions/wrapper.ts`

#### Exported Functions
- **`wrapRegisteredTool`**: `export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool`
  - *Description*: Wrap a RegisteredTool into an AgentTool. Uses the runner's createContext() for consistent context across tools and event handlers.
- **`wrapRegisteredTools`**: `export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[]`
  - *Description*: Wrap all registered tools into AgentTools. Uses the runner's createContext() for consistent context across tools and event handlers.
- **`wrapToolWithExtensions`**: `export function wrapToolWithExtensions<T>(tool: AgentTool<any, T>, runner: ExtensionRunner): AgentTool<any, T>`
  - *Description*: Wrap a tool with extension callbacks for interception. - Emits tool_call event before execution (can block) - Emits tool_result event after execution (can modify result)
- **`wrapToolsWithExtensions`**: `export function wrapToolsWithExtensions<T>(tools: AgentTool<any, T>[], runner: ExtensionRunner): AgentTool<any, T>[]`
  - *Description*: Wrap all tools with extension callbacks.

### File: `packages/coding-agent/src/core/footer-data-provider.ts`

#### Exported Classes
- **`FooterDataProvider`**
  - *Description*: Provides git branch and extension statuses - data not otherwise accessible to extensions. Token stats, model info available via ctx.sessionManager and ctx.model.
  - `getGitBranch(): string | null`
  - `getExtensionStatuses(): ReadonlyMap<string, string>`
  - `onBranchChange(callback: () => void): () => void`
  - `setExtensionStatus(key: string, text: string | undefined): void`
  - `clearExtensionStatuses(): void`
  - `getAvailableProviderCount(): number`
  - `setAvailableProviderCount(count: number): void`
  - `dispose(): void`

#### Exported Types
- **`ReadonlyFooterDataProvider`**: `Pick< 	FooterDataProvider, 	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange" >`
  - *Description*: Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose

### File: `packages/coding-agent/src/core/keybindings.ts`

#### Exported Classes
- **`KeybindingsManager`**
  - *Description*: Manages all keybindings (app + editor).
  - `static create(agentDir: string = getAgentDir()): KeybindingsManager`
  - `static inMemory(config: KeybindingsConfig =`
  - `matches(data: string, action: AppAction): boolean`
  - `getKeys(action: AppAction): KeyId[]`
  - `getEffectiveConfig(): Required<KeybindingsConfig>`

#### Exported Types
- **`AppAction`**: `| "interrupt" 	| "clear" 	| "exit" 	| "suspend" 	| "cycleThinkingLevel" 	| "cycleModelForward" 	| "cycleModelBackward" 	| "selectModel" 	| "expandTools" 	| "toggleThinking" 	| "toggleSessionNamedFilte...`
  - *Description*: Application-level actions (coding agent specific).
- **`KeyAction`**: `AppAction | EditorAction`
  - *Description*: All configurable actions.
- **`KeybindingsConfig`**: `{ 	[K in KeyAction]?: KeyId | KeyId[]; }`
  - *Description*: Full keybindings configuration (app + editor actions).

### File: `packages/coding-agent/src/core/messages.ts`

#### Exported Functions
- **`bashExecutionToText`**: `export function bashExecutionToText(msg: BashExecutionMessage): string`
  - *Description*: Convert a BashExecutionMessage to user message text for LLM context.
- **`createBranchSummaryMessage`**: `export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage`
  - *Description*: Instantiates or constructs a new BranchSummaryMessage.
- **`createCompactionSummaryMessage`**: `export function createCompactionSummaryMessage( 	summary: string, 	tokensBefore: number, 	timestamp: string, ): CompactionSummaryMessage`
  - *Description*: Instantiates or constructs a new CompactionSummaryMessage.
- **`createCustomMessage`**: `export function createCustomMessage( 	customType: string, 	content: string | (TextContent | ImageContent)[], 	display: boolean, 	details: unknown | undefined, 	timestamp: string, ): CustomMessage`
  - *Description*: Convert CustomMessageEntry to AgentMessage format
- **`convertToLlm`**: `export function convertToLlm(messages: AgentMessage[]): Message[]`
  - *Description*: Transform AgentMessages (including custom types) to LLM-compatible Messages.  This is used by: - Agent's transormToLlm option (for prompt calls and queued messages) - Compaction's generateSummary (for summarization) - Custom extensions and tools

#### Exported Interfaces
- **`BashExecutionMessage`**
  - *Description*: Message type for bash executions via the ! command.
  - `role: "bashExecution"`
  - `command: string`
  - `output: string`
  - `exitCode: number`
  - `cancelled: boolean`
  - `truncated: boolean`
  - `fullOutputPath?: string`
  - `timestamp: number`
  - `excludeFromContext?: boolean`
- **`CustomMessage`**
  - *Description*: Message type for extension-injected messages via sendMessage(). These are custom messages that extensions can inject into the conversation.
  - `role: "custom"`
  - `customType: string`
  - `content: string | any[]`
  - `display: boolean`
  - `details?: T`
  - `timestamp: number`
- **`BranchSummaryMessage`**
  - *Description*: Data structure or object model representing `BranchSummaryMessage`.
  - `role: "branchSummary"`
  - `summary: string`
  - `fromId: string`
  - `timestamp: number`
- **`CompactionSummaryMessage`**
  - *Description*: Data structure or object model representing `CompactionSummaryMessage`.
  - `role: "compactionSummary"`
  - `summary: string`
  - `tokensBefore: number`
  - `timestamp: number`

### File: `packages/coding-agent/src/core/model-registry.ts`

#### Exported Functions
- **`clearApiKeyCache`**: `clearApiKeyCache: typeof import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/resolve-config-value").clearConfigValueCache`
  - *Description*: Executes the logic for `clearApiKeyCache`.

#### Exported Interfaces
- **`ProviderConfigInput`**
  - *Description*: Input type for registerProvider API.
  - `baseUrl?: string`
  - `apiKey?: string`
  - `api?: Api`
  - `streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream`
  - `headers?: Record<string, string>`
  - `authHeader?: boolean`
  - `oauth?: Omit<OAuthProviderInterface, "id">`
  - `models?: { id: string; name: string; api?: Api; reasoning: boolean; input: ("text" | "image")[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; }; contextWindow: number; maxToken...`

#### Exported Classes
- **`ModelRegistry`**
  - *Description*: Model registry - loads and manages models, resolves API keys via AuthStorage.
  - `refresh(): void`
  - `getError(): string | undefined`
  - `getAll(): Model<Api>[]`
  - `getAvailable(): Model<Api>[]`
  - `find(provider: string, modelId: string): Model<Api> | undefined`
  - `async getApiKey(model: Model<Api>): Promise<string | undefined>`
  - `async getApiKeyForProvider(provider: string): Promise<string | undefined>`
  - `isUsingOAuth(model: Model<Api>): boolean`
  - `registerProvider(providerName: string, config: ProviderConfigInput): void`
  - `unregisterProvider(providerName: string): void`

### File: `packages/coding-agent/src/core/model-resolver.ts`

#### Exported Functions
- **`parseModelPattern`**: `export function parseModelPattern( 	pattern: string, 	availableModels: Model<Api>[], 	options?:`
  - *Description*: Parse a pattern to extract model and thinking level. Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).  Algorithm: 1. Try to match full pattern as a model 2. If found, return it with "off" thinking level 3. If not found and has colons, split on last colon:    - If suffix is valid thinking level, use it and recurse on prefix    - If suffix is invalid, warn and recurse on prefix with "off"  @internal Exported for testing
- **`resolveModelScope`**: `export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]>`
  - *Description*: Resolve model patterns to actual Model objects with optional thinking levels Format: "pattern:level" where :level is optional For each pattern, finds all matching models and picks the best version: 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929) 2. If no alias, pick the latest dated version  Supports models with colons in their IDs (e.g., OpenRouter's model:exacto). The algorithm tries to match the full pattern first, then progressively strips colon-suffixes to find a match.
- **`resolveCliModel`**: `export function resolveCliModel(options:`
  - *Description*: Resolve a single model from CLI flags.  Supports: - --provider <provider> --model <pattern> - --model <provider>/<pattern> - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)  Note: This does not apply the thinking level by itself, but it may *parse* and return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
- **`findInitialModel`**: `export async function findInitialModel(options:`
  - *Description*: Find the initial model to use based on priority: 1. CLI args (provider + model) 2. First model from scoped models (if not continuing/resuming) 3. Restored from session (if continuing/resuming) 4. Saved default from settings 5. First available model with valid API key
- **`restoreModelFromSession`**: `export async function restoreModelFromSession( 	savedProvider: string, 	savedModelId: string, 	currentModel: Model<Api> | undefined, 	shouldPrintMessages: boolean, 	modelRegistry: ModelRegistry, ): Promise<`
  - *Description*: Restore model from session, with fallback to available models

#### Exported Interfaces
- **`ScopedModel`**
  - *Description*: Data structure or object model representing `ScopedModel`.
  - `model: Model<Api>`
  - `thinkingLevel?: ThinkingLevel`
- **`ParsedModelResult`**
  - *Description*: Data structure or object model representing `ParsedModelResult`.
  - `model: any`
  - `thinkingLevel?: ThinkingLevel`
  - `warning: string`
- **`ResolveCliModelResult`**
  - *Description*: Data structure or object model representing `ResolveCliModelResult`.
  - `model: any`
  - `thinkingLevel?: ThinkingLevel`
  - `warning: string`
  - `error: string`
- **`InitialModelResult`**
  - *Description*: Data structure or object model representing `InitialModelResult`.
  - `model: any`
  - `thinkingLevel: ThinkingLevel`
  - `fallbackMessage: string`

### File: `packages/coding-agent/src/core/package-manager.ts`

#### Exported Interfaces
- **`PathMetadata`**
  - *Description*: Data structure or object model representing `PathMetadata`.
  - `source: string`
  - `scope: SourceScope`
  - `origin: "package" | "top-level"`
  - `baseDir?: string`
- **`ResolvedResource`**
  - *Description*: Data structure or object model representing `ResolvedResource`.
  - `path: string`
  - `enabled: boolean`
  - `metadata: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").PathMetadata`
- **`ResolvedPaths`**
  - *Description*: Data structure or object model representing `ResolvedPaths`.
  - `extensions: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").ResolvedResource[]`
  - `skills: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").ResolvedResource[]`
  - `prompts: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").ResolvedResource[]`
  - `themes: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").ResolvedResource[]`
- **`ProgressEvent`**
  - *Description*: Data structure or object model representing `ProgressEvent`.
  - `type: "error" | "start" | "progress" | "complete"`
  - `action: "install" | "remove" | "update" | "clone" | "pull"`
  - `source: string`
  - `message?: string`
- **`PackageManager`**
  - *Description*: Manages state and lifecycle for `Package`.

#### Exported Classes
- **`DefaultPackageManager`**
  - *Description*: Manages state and lifecycle for `DefaultPackage`.
  - `setProgressCallback(callback: ProgressCallback | undefined): void`
  - `addSourceToSettings(source: string, options?:`
  - `removeSourceFromSettings(source: string, options?:`
  - `getInstalledPath(source: string, scope: "user" | "project"): string | undefined`
  - `async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>`
  - `async resolveExtensionSources( 		sources: string[], 		options?:`
  - `async install(source: string, options?:`
  - `async remove(source: string, options?:`
  - `async update(source?: string): Promise<void>`

#### Exported Types
- **`MissingSourceAction`**: `"install" | "skip" | "error"`
  - *Description*: Type alias for `MissingSourceAction`.
- **`ProgressCallback`**: `(event: ProgressEvent) => void`
  - *Description*: Type alias for `ProgressCallback`.

### File: `packages/coding-agent/src/core/prompt-templates.ts`

#### Exported Functions
- **`parseCommandArgs`**: `export function parseCommandArgs(argsString: string): string[]`
  - *Description*: Parse command arguments respecting quoted strings (bash-style) Returns array of arguments
- **`substituteArgs`**: `export function substituteArgs(content: string, args: string[]): string`
  - *Description*: Substitute argument placeholders in template content Supports: - $1, $2, ... for positional args - $@ and $ARGUMENTS for all args - ${@:N} for args from Nth onwards (bash-style slicing) - ${@:N:L} for L args starting from Nth  Note: Replacement happens on the template string only. Argument values containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
- **`loadPromptTemplates`**: `export function loadPromptTemplates(options: LoadPromptTemplatesOptions =`
  - *Description*: Load all prompt templates from: 1. Global: agentDir/prompts/ 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/ 3. Explicit prompt paths
- **`expandPromptTemplate`**: `export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string`
  - *Description*: Expand a prompt template if it matches a template name. Returns the expanded content or the original text if not a template.

#### Exported Interfaces
- **`PromptTemplate`**
  - *Description*: Represents a prompt template loaded from a markdown file
  - `name: string`
  - `description: string`
  - `content: string`
  - `source: string`
  - `filePath: string`
- **`LoadPromptTemplatesOptions`**
  - *Description*: Configuration options for `LoadPromptTemplates`.
  - `cwd?: string`
  - `agentDir?: string`
  - `promptPaths?: string[]`
  - `includeDefaults?: boolean`

### File: `packages/coding-agent/src/core/resolve-config-value.ts`

#### Exported Functions
- **`resolveConfigValue`**: `export function resolveConfigValue(config: string): string | undefined`
  - *Description*: Resolve a config value (API key, header value, etc.) to an actual value. - If starts with "!", executes the rest as a shell command and uses stdout (cached) - Otherwise checks environment variable first, then treats as literal (not cached)
- **`resolveHeaders`**: `export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined`
  - *Description*: Resolve all header values using the same resolution logic as API keys.
- **`clearConfigValueCache`**: `export function clearConfigValueCache(): void`
  - *Description*: Clear the config value command cache. Exported for testing.

### File: `packages/coding-agent/src/core/resource-loader.ts`

#### Exported Interfaces
- **`ResourceExtensionPaths`**
  - *Description*: Data structure or object model representing `ResourceExtensionPaths`.
  - `skillPaths?: { path: string; metadata: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").PathMetadata; }[]`
  - `promptPaths?: { path: string; metadata: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").PathMetadata; }[]`
  - `themePaths?: { path: string; metadata: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/package-manager").PathMetadata; }[]`
- **`ResourceLoader`**
  - *Description*: Data structure or object model representing `ResourceLoader`.
- **`DefaultResourceLoaderOptions`**
  - *Description*: Configuration options for `DefaultResourceLoader`.
  - `cwd?: string`
  - `agentDir?: string`
  - `settingsManager?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").SettingsManager`
  - `eventBus?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/event-bus").EventBus`
  - `additionalExtensionPaths?: string[]`
  - `additionalSkillPaths?: string[]`
  - `additionalPromptTemplatePaths?: string[]`
  - `additionalThemePaths?: string[]`
  - `extensionFactories?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ExtensionFactory[]`
  - `noExtensions?: boolean`
  - `noSkills?: boolean`
  - `noPromptTemplates?: boolean`
  - `noThemes?: boolean`
  - `systemPrompt?: string`
  - `appendSystemPrompt?: string`
  - `extensionsOverride?: (base: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").LoadExtensionsResult) => import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types")....`
  - `skillsOverride?: (base: { skills: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/skills").Skill[]; diagnostics: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/diagnostics").Resource...`
  - `promptsOverride?: (base: { prompts: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/prompt-templates").PromptTemplate[]; diagnostics: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/di...`
  - `themesOverride?: (base: { themes: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/modes/interactive/theme/theme").Theme[]; diagnostics: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/diag...`
  - `agentsFilesOverride?: (base: { agentsFiles: { path: string; content: string; }[]; }) => { agentsFiles: { path: string; content: string; }[]; }`
  - `systemPromptOverride?: (base: string) => string`
  - `appendSystemPromptOverride?: (base: string[]) => string[]`

#### Exported Classes
- **`DefaultResourceLoader`**
  - *Description*: Data structure or object model representing `DefaultResourceLoader`.
  - `getExtensions(): LoadExtensionsResult`
  - `getSkills():`
  - `getPrompts():`
  - `getThemes():`
  - `getAgentsFiles():`
  - `getSystemPrompt(): string | undefined`
  - `getAppendSystemPrompt(): string[]`
  - `getPathMetadata(): Map<string, PathMetadata>`
  - `extendResources(paths: ResourceExtensionPaths): void`
  - `async reload(): Promise<void>`

### File: `packages/coding-agent/src/core/sdk.ts`

#### Exported Functions
- **`createAgentSession`**: `export async function createAgentSession(options: CreateAgentSessionOptions =`
  - *Description*: Create an AgentSession with the specified options.  @example ```typescript // Minimal - uses defaults const { session } = await createAgentSession();  // With explicit model import { getModel } from '@mariozechner/pi-ai'; const { session } = await createAgentSession({   model: getModel('anthropic', 'claude-opus-4-5'),   thinkingLevel: 'high', });  // Continue previous session const { session, modelFallbackMessage } = await createAgentSession({   continueSession: true, });  // Full control const loader = new DefaultResourceLoader({   cwd: process.cwd(),   agentDir: getAgentDir(),   settingsManager: SettingsManager.create(), }); await loader.reload(); const { session } = await createAgentSession({   model: myModel,   tools: [readTool, bashTool],   resourceLoader: loader,   sessionManager: SessionManager.inMemory(), }); ```

#### Exported Interfaces
- **`CreateAgentSessionOptions`**
  - *Description*: Configuration options for `CreateAgentSession`.
  - `cwd?: string`
  - `agentDir?: string`
  - `authStorage?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/auth-storage").AuthStorage`
  - `modelRegistry?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/model-registry").ModelRegistry`
  - `model?: Model<any>`
  - `thinkingLevel?: ThinkingLevel`
  - `scopedModels?: { model: Model<any>; thinkingLevel: ThinkingLevel; }[]`
  - `tools?: AgentTool<any>[]`
  - `customTools?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").ToolDefinition<TSchema, unknown>[]`
  - `resourceLoader?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/resource-loader").ResourceLoader`
  - `sessionManager?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionManager`
  - `settingsManager?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").SettingsManager`
- **`CreateAgentSessionResult`**
  - *Description*: Result from createAgentSession
  - `session: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/agent-session").AgentSession`
  - `extensionsResult: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/extensions/types").LoadExtensionsResult`
  - `modelFallbackMessage?: string`

### File: `packages/coding-agent/src/core/session-manager.ts`

#### Exported Functions
- **`migrateSessionEntries`**: `export function migrateSessionEntries(entries: FileEntry[]): void`
  - *Description*: Exported for testing
- **`parseSessionEntries`**: `export function parseSessionEntries(content: string): FileEntry[]`
  - *Description*: Exported for compaction.test.ts
- **`getLatestCompactionEntry`**: `export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null`
  - *Description*: Retrieves or computes LatestCompactionEntry.
- **`buildSessionContext`**: `export function buildSessionContext( 	entries: SessionEntry[], 	leafId?: string | null, 	byId?: Map<string, SessionEntry>, ): SessionContext`
  - *Description*: Build the session context from entries using tree traversal. If leafId is provided, walks from that entry to root. Handles compaction and branch summaries along the path.
- **`loadEntriesFromFile`**: `export function loadEntriesFromFile(filePath: string): FileEntry[]`
  - *Description*: Exported for testing
- **`findMostRecentSession`**: `export function findMostRecentSession(sessionDir: string): string | null`
  - *Description*: Exported for testing

#### Exported Interfaces
- **`SessionHeader`**
  - *Description*: Data structure or object model representing `SessionHeader`.
  - `type: "session"`
  - `version?: number`
  - `id: string`
  - `timestamp: string`
  - `cwd: string`
  - `parentSession?: string`
- **`NewSessionOptions`**
  - *Description*: Configuration options for `NewSession`.
  - `parentSession?: string`
- **`SessionEntryBase`**
  - *Description*: Data structure or object model representing `SessionEntryBase`.
  - `type: string`
  - `id: string`
  - `parentId: string`
  - `timestamp: string`
- **`SessionMessageEntry`**
  - *Description*: Data structure or object model representing `SessionMessageEntry`.
  - `type: "message"`
  - `message: AgentMessage`
- **`ThinkingLevelChangeEntry`**
  - *Description*: Data structure or object model representing `ThinkingLevelChangeEntry`.
  - `type: "thinking_level_change"`
  - `thinkingLevel: string`
- **`ModelChangeEntry`**
  - *Description*: Data structure or object model representing `ModelChangeEntry`.
  - `type: "model_change"`
  - `provider: string`
  - `modelId: string`
- **`CompactionEntry`**
  - *Description*: Data structure or object model representing `CompactionEntry`.
  - `type: "compaction"`
  - `summary: string`
  - `firstKeptEntryId: string`
  - `tokensBefore: number`
  - `details?: T`
  - `fromHook?: boolean`
- **`BranchSummaryEntry`**
  - *Description*: Data structure or object model representing `BranchSummaryEntry`.
  - `type: "branch_summary"`
  - `fromId: string`
  - `summary: string`
  - `details?: T`
  - `fromHook?: boolean`
- **`CustomEntry`**
  - *Description*: Custom entry for extensions to store extension-specific data in the session. Use customType to identify your extension's entries.  Purpose: Persist extension state across session reloads. On reload, extensions can scan entries for their customType and reconstruct internal state.  Does NOT participate in LLM context (ignored by buildSessionContext). For injecting content into context, see CustomMessageEntry.
  - `type: "custom"`
  - `customType: string`
  - `data?: T`
- **`LabelEntry`**
  - *Description*: Label entry for user-defined bookmarks/markers on entries.
  - `type: "label"`
  - `targetId: string`
  - `label: string`
- **`SessionInfoEntry`**
  - *Description*: Session metadata entry (e.g., user-defined display name).
  - `type: "session_info"`
  - `name?: string`
- **`CustomMessageEntry`**
  - *Description*: Custom message entry for extensions to inject messages into LLM context. Use customType to identify your extension's entries.  Unlike CustomEntry, this DOES participate in LLM context. The content is converted to a user message in buildSessionContext(). Use details for extension-specific metadata (not sent to LLM).  display controls TUI rendering: - false: hidden entirely - true: rendered with distinct styling (different from user messages)
  - `type: "custom_message"`
  - `customType: string`
  - `content: string | any[]`
  - `details?: T`
  - `display: boolean`
- **`SessionTreeNode`**
  - *Description*: Tree node for getTree() - defensive copy of session structure
  - `entry: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionEntry`
  - `children: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/session-manager").SessionTreeNode[]`
  - `label?: string`
- **`SessionContext`**
  - *Description*: Data structure or object model representing `SessionContext`.
  - `messages: AgentMessage[]`
  - `thinkingLevel: string`
  - `model: { provider: string; modelId: string; }`
- **`SessionInfo`**
  - *Description*: Data structure or object model representing `SessionInfo`.
  - `path: string`
  - `id: string`
  - `cwd: string`
  - `name?: string`
  - `parentSessionPath?: string`
  - `created: Date`
  - `modified: Date`
  - `messageCount: number`
  - `firstMessage: string`
  - `allMessagesText: string`

#### Exported Classes
- **`SessionManager`**
  - *Description*: Manages conversation sessions as append-only trees stored in JSONL files.  Each session entry has an id and parentId forming a tree structure. The "leaf" pointer tracks the current position. Appending creates a child of the current leaf. Branching moves the leaf to an earlier entry, allowing new branches without modifying history.  Use buildSessionContext() to get the resolved message list for the LLM, which handles compaction summaries and follows the path from root to current leaf.
  - `setSessionFile(sessionFile: string): void`
  - `newSession(options?: NewSessionOptions): string | undefined`
  - `isPersisted(): boolean`
  - `getCwd(): string`
  - `getSessionDir(): string`
  - `getSessionId(): string`
  - `getSessionFile(): string | undefined`
  - `_persist(entry: SessionEntry): void`
  - `appendMessage(message: Message | CustomMessage | BashExecutionMessage): string`
  - `appendThinkingLevelChange(thinkingLevel: string): string`
  - `appendModelChange(provider: string, modelId: string): string`
  - `appendCompaction<T = unknown>( 		summary: string, 		firstKeptEntryId: string, 		tokensBefore: number, 		details?: T, 		fromHook?: boolean, 	): string`
  - `appendCustomEntry(customType: string, data?: unknown): string`
  - `appendSessionInfo(name: string): string`
  - `getSessionName(): string | undefined`
  - `appendCustomMessageEntry<T = unknown>( 		customType: string, 		content: string | (TextContent | ImageContent)[], 		display: boolean, 		details?: T, 	): string`
  - `getLeafId(): string | null`
  - `getLeafEntry(): SessionEntry | undefined`
  - `getEntry(id: string): SessionEntry | undefined`
  - `getChildren(parentId: string): SessionEntry[]`
  - `getLabel(id: string): string | undefined`
  - `appendLabelChange(targetId: string, label: string | undefined): string`
  - `getBranch(fromId?: string): SessionEntry[]`
  - `buildSessionContext(): SessionContext`
  - `getHeader(): SessionHeader | null`
  - `getEntries(): SessionEntry[]`
  - `getTree(): SessionTreeNode[]`
  - `branch(branchFromId: string): void`
  - `resetLeaf(): void`
  - `branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string`
  - `createBranchedSession(leafId: string): string | undefined`
  - `static create(cwd: string, sessionDir?: string): SessionManager`
  - `static open(path: string, sessionDir?: string): SessionManager`
  - `static continueRecent(cwd: string, sessionDir?: string): SessionManager`
  - `static inMemory(cwd: string = process.cwd()): SessionManager`
  - `static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager`
  - `static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>`
  - `static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>`

#### Exported Types
- **`SessionEntry`**: `| SessionMessageEntry 	| ThinkingLevelChangeEntry 	| ModelChangeEntry 	| CompactionEntry 	| BranchSummaryEntry 	| CustomEntry 	| CustomMessageEntry 	| LabelEntry 	| SessionInfoEntry`
  - *Description*: Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager)
- **`FileEntry`**: `SessionHeader | SessionEntry`
  - *Description*: Raw file entry (includes header)
- **`ReadonlySessionManager`**: `Pick< 	SessionManager, 	| "getCwd" 	| "getSessionDir" 	| "getSessionId" 	| "getSessionFile" 	| "getLeafId" 	| "getLeafEntry" 	| "getEntry" 	| "getLabel" 	| "getBranch" 	| "getHeader" 	| "getEntries" 	...`
  - *Description*: Type alias for `ReadonlySessionManager`.
- **`SessionListProgress`**: `(loaded: number, total: number) => void`
  - *Description*: Type alias for `SessionListProgress`.

### File: `packages/coding-agent/src/core/settings-manager.ts`

#### Exported Interfaces
- **`CompactionSettings`**
  - *Description*: Data structure or object model representing `CompactionSettings`.
  - `enabled?: boolean`
  - `reserveTokens?: number`
  - `keepRecentTokens?: number`
- **`BranchSummarySettings`**
  - *Description*: Data structure or object model representing `BranchSummarySettings`.
  - `reserveTokens?: number`
- **`RetrySettings`**
  - *Description*: Data structure or object model representing `RetrySettings`.
  - `enabled?: boolean`
  - `maxRetries?: number`
  - `baseDelayMs?: number`
  - `maxDelayMs?: number`
- **`TerminalSettings`**
  - *Description*: Data structure or object model representing `TerminalSettings`.
  - `showImages?: boolean`
  - `clearOnShrink?: boolean`
- **`ImageSettings`**
  - *Description*: Data structure or object model representing `ImageSettings`.
  - `autoResize?: boolean`
  - `blockImages?: boolean`
- **`ThinkingBudgetsSettings`**
  - *Description*: Data structure or object model representing `ThinkingBudgetsSettings`.
  - `minimal?: number`
  - `low?: number`
  - `medium?: number`
  - `high?: number`
- **`MarkdownSettings`**
  - *Description*: Data structure or object model representing `MarkdownSettings`.
  - `codeBlockIndent?: string`
- **`Settings`**
  - *Description*: Data structure or object model representing `Settings`.
  - `lastChangelogVersion?: string`
  - `defaultProvider?: string`
  - `defaultModel?: string`
  - `defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `transport?: Transport`
  - `steeringMode?: "all" | "one-at-a-time"`
  - `followUpMode?: "all" | "one-at-a-time"`
  - `theme?: string`
  - `compaction?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").CompactionSettings`
  - `branchSummary?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").BranchSummarySettings`
  - `retry?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").RetrySettings`
  - `hideThinkingBlock?: boolean`
  - `shellPath?: string`
  - `quietStartup?: boolean`
  - `shellCommandPrefix?: string`
  - `collapseChangelog?: boolean`
  - `packages?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").PackageSource[]`
  - `extensions?: string[]`
  - `skills?: string[]`
  - `prompts?: string[]`
  - `themes?: string[]`
  - `enableSkillCommands?: boolean`
  - `terminal?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").TerminalSettings`
  - `images?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").ImageSettings`
  - `enabledModels?: string[]`
  - `doubleEscapeAction?: "tree" | "fork" | "none"`
  - `thinkingBudgets?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").ThinkingBudgetsSettings`
  - `editorPaddingX?: number`
  - `autocompleteMaxVisible?: number`
  - `showHardwareCursor?: boolean`
  - `markdown?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").MarkdownSettings`
- **`SettingsStorage`**
  - *Description*: Data structure or object model representing `SettingsStorage`.
- **`SettingsError`**
  - *Description*: Custom error type for `SettingsError`.
  - `scope: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/settings-manager").SettingsScope`
  - `error: Error`

#### Exported Classes
- **`FileSettingsStorage`**
  - *Description*: Data structure or object model representing `FileSettingsStorage`.
  - `withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void`
- **`InMemorySettingsStorage`**
  - *Description*: Data structure or object model representing `InMemorySettingsStorage`.
  - `withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void`
- **`SettingsManager`**
  - *Description*: Manages state and lifecycle for `Settings`.
  - `static create(cwd: string = process.cwd(), agentDir: string = getAgentDir()): SettingsManager`
  - `static fromStorage(storage: SettingsStorage): SettingsManager`
  - `static inMemory(settings: Partial<Settings> =`
  - `getGlobalSettings(): Settings`
  - `getProjectSettings(): Settings`
  - `reload(): void`
  - `applyOverrides(overrides: Partial<Settings>): void`
  - `async flush(): Promise<void>`
  - `drainErrors(): SettingsError[]`
  - `getLastChangelogVersion(): string | undefined`
  - `setLastChangelogVersion(version: string): void`
  - `getDefaultProvider(): string | undefined`
  - `getDefaultModel(): string | undefined`
  - `setDefaultProvider(provider: string): void`
  - `setDefaultModel(modelId: string): void`
  - `setDefaultModelAndProvider(provider: string, modelId: string): void`
  - `getSteeringMode(): "all" | "one-at-a-time"`
  - `setSteeringMode(mode: "all" | "one-at-a-time"): void`
  - `getFollowUpMode(): "all" | "one-at-a-time"`
  - `setFollowUpMode(mode: "all" | "one-at-a-time"): void`
  - `getTheme(): string | undefined`
  - `setTheme(theme: string): void`
  - `getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined`
  - `setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void`
  - `getTransport(): TransportSetting`
  - `setTransport(transport: TransportSetting): void`
  - `getCompactionEnabled(): boolean`
  - `setCompactionEnabled(enabled: boolean): void`
  - `getCompactionReserveTokens(): number`
  - `getCompactionKeepRecentTokens(): number`
  - `getCompactionSettings():`
  - `getBranchSummarySettings():`
  - `getRetryEnabled(): boolean`
  - `setRetryEnabled(enabled: boolean): void`
  - `getRetrySettings():`
  - `getHideThinkingBlock(): boolean`
  - `setHideThinkingBlock(hide: boolean): void`
  - `getShellPath(): string | undefined`
  - `setShellPath(path: string | undefined): void`
  - `getQuietStartup(): boolean`
  - `setQuietStartup(quiet: boolean): void`
  - `getShellCommandPrefix(): string | undefined`
  - `setShellCommandPrefix(prefix: string | undefined): void`
  - `getCollapseChangelog(): boolean`
  - `setCollapseChangelog(collapse: boolean): void`
  - `getPackages(): PackageSource[]`
  - `setPackages(packages: PackageSource[]): void`
  - `setProjectPackages(packages: PackageSource[]): void`
  - `getExtensionPaths(): string[]`
  - `setExtensionPaths(paths: string[]): void`
  - `setProjectExtensionPaths(paths: string[]): void`
  - `getSkillPaths(): string[]`
  - `setSkillPaths(paths: string[]): void`
  - `setProjectSkillPaths(paths: string[]): void`
  - `getPromptTemplatePaths(): string[]`
  - `setPromptTemplatePaths(paths: string[]): void`
  - `setProjectPromptTemplatePaths(paths: string[]): void`
  - `getThemePaths(): string[]`
  - `setThemePaths(paths: string[]): void`
  - `setProjectThemePaths(paths: string[]): void`
  - `getEnableSkillCommands(): boolean`
  - `setEnableSkillCommands(enabled: boolean): void`
  - `getThinkingBudgets(): ThinkingBudgetsSettings | undefined`
  - `getShowImages(): boolean`
  - `setShowImages(show: boolean): void`
  - `getClearOnShrink(): boolean`
  - `setClearOnShrink(enabled: boolean): void`
  - `getImageAutoResize(): boolean`
  - `setImageAutoResize(enabled: boolean): void`
  - `getBlockImages(): boolean`
  - `setBlockImages(blocked: boolean): void`
  - `getEnabledModels(): string[] | undefined`
  - `setEnabledModels(patterns: string[] | undefined): void`
  - `getDoubleEscapeAction(): "fork" | "tree" | "none"`
  - `setDoubleEscapeAction(action: "fork" | "tree" | "none"): void`
  - `getShowHardwareCursor(): boolean`
  - `setShowHardwareCursor(enabled: boolean): void`
  - `getEditorPaddingX(): number`
  - `setEditorPaddingX(padding: number): void`
  - `getAutocompleteMaxVisible(): number`
  - `setAutocompleteMaxVisible(maxVisible: number): void`
  - `getCodeBlockIndent(): string`

#### Exported Types
- **`TransportSetting`**: `Transport`
  - *Description*: Type alias for `TransportSetting`.
- **`PackageSource`**: `| string 	| { 			source: string; 			extensions?: string[]; 			skills?: string[]; 			prompts?: string[]; 			themes?: string[]; 	  }`
  - *Description*: Package source for npm/git packages. - String form: load all resources from the package - Object form: filter which resources to load
- **`SettingsScope`**: `"global" | "project"`
  - *Description*: Type alias for `SettingsScope`.

### File: `packages/coding-agent/src/core/skills.ts`

#### Exported Functions
- **`loadSkillsFromDir`**: `export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult`
  - *Description*: Load skills from a directory.  Discovery rules: - direct .md children in the root - recursive SKILL.md under subdirectories
- **`formatSkillsForPrompt`**: `export function formatSkillsForPrompt(skills: Skill[]): string`
  - *Description*: Format skills for inclusion in a system prompt. Uses XML format per Agent Skills standard. See: https://agentskills.io/integrate-skills  Skills with disableModelInvocation=true are excluded from the prompt (they can only be invoked explicitly via /skill:name commands).
- **`loadSkills`**: `export function loadSkills(options: LoadSkillsOptions =`
  - *Description*: Load skills from all configured locations. Returns skills and any validation diagnostics.

#### Exported Interfaces
- **`SkillFrontmatter`**
  - *Description*: Data structure or object model representing `SkillFrontmatter`.
  - `name?: string`
  - `description?: string`
  - `"disable-model-invocation"?: boolean`
- **`Skill`**
  - *Description*: Data structure or object model representing `Skill`.
  - `name: string`
  - `description: string`
  - `filePath: string`
  - `baseDir: string`
  - `source: string`
  - `disableModelInvocation: boolean`
- **`LoadSkillsResult`**
  - *Description*: Data structure or object model representing `LoadSkillsResult`.
  - `skills: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/skills").Skill[]`
  - `diagnostics: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/diagnostics").ResourceDiagnostic[]`
- **`LoadSkillsFromDirOptions`**
  - *Description*: Configuration options for `LoadSkillsFromDir`.
  - `dir: string`
  - `source: string`
- **`LoadSkillsOptions`**
  - *Description*: Configuration options for `LoadSkills`.
  - `cwd?: string`
  - `agentDir?: string`
  - `skillPaths?: string[]`
  - `includeDefaults?: boolean`

### File: `packages/coding-agent/src/core/slash-commands.ts`

#### Exported Interfaces
- **`SlashCommandInfo`**
  - *Description*: Data structure or object model representing `SlashCommandInfo`.
  - `name: string`
  - `description?: string`
  - `source: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/slash-commands").SlashCommandSource`
  - `location?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/slash-commands").SlashCommandLocation`
  - `path?: string`
- **`BuiltinSlashCommand`**
  - *Description*: Data structure or object model representing `BuiltinSlashCommand`.
  - `name: string`
  - `description: string`

#### Exported Types
- **`SlashCommandSource`**: `"extension" | "prompt" | "skill"`
  - *Description*: Type alias for `SlashCommandSource`.
- **`SlashCommandLocation`**: `"user" | "project" | "path"`
  - *Description*: Type alias for `SlashCommandLocation`.

### File: `packages/coding-agent/src/core/system-prompt.ts`

#### Exported Functions
- **`buildSystemPrompt`**: `export function buildSystemPrompt(options: BuildSystemPromptOptions =`
  - *Description*: Build the system prompt with tools, guidelines, and context

#### Exported Interfaces
- **`BuildSystemPromptOptions`**
  - *Description*: Configuration options for `BuildSystemPrompt`.
  - `customPrompt?: string`
  - `selectedTools?: string[]`
  - `appendSystemPrompt?: string`
  - `cwd?: string`
  - `contextFiles?: { path: string; content: string; }[]`
  - `skills?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/skills").Skill[]`

### File: `packages/coding-agent/src/core/timings.ts`

#### Exported Functions
- **`time`**: `export function time(label: string): void`
  - *Description*: Executes the logic for `time`.
- **`printTimings`**: `export function printTimings(): void`
  - *Description*: Executes the logic for `printTimings`.

### File: `packages/coding-agent/src/core/tools/bash.ts`

#### Exported Functions
- **`createBashTool`**: `export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema>`
  - *Description*: Instantiates or constructs a new BashTool.

#### Exported Interfaces
- **`BashToolDetails`**
  - *Description*: Data structure or object model representing `BashToolDetails`.
  - `truncation?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/truncate").TruncationResult`
  - `fullOutputPath?: string`
- **`BashOperations`**
  - *Description*: Pluggable operations for the bash tool. Override these to delegate command execution to remote systems (e.g., SSH).
  - `exec: (command: string, cwd: string, options: { onData: (data: Buffer<ArrayBufferLike>) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv; }) => Promise<{ exitCode: number; }>`
- **`BashSpawnContext`**
  - *Description*: Data structure or object model representing `BashSpawnContext`.
  - `command: string`
  - `cwd: string`
  - `env: NodeJS.ProcessEnv`
- **`BashToolOptions`**
  - *Description*: Configuration options for `BashTool`.
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/bash").BashOperations`
  - `commandPrefix?: string`
  - `spawnHook?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/bash").BashSpawnHook`

#### Exported Types
- **`BashToolInput`**: `Static<typeof bashSchema>`
  - *Description*: Type alias for `BashToolInput`.
- **`BashSpawnHook`**: `(context: BashSpawnContext) => BashSpawnContext`
  - *Description*: Type alias for `BashSpawnHook`.

### File: `packages/coding-agent/src/core/tools/edit-diff.ts`

#### Exported Functions
- **`detectLineEnding`**: `export function detectLineEnding(content: string): "\r\n" | "\n"`
  - *Description*: Executes the logic for `detectLineEnding`.
- **`normalizeToLF`**: `export function normalizeToLF(text: string): string`
  - *Description*: Executes the logic for `normalizeToLF`.
- **`restoreLineEndings`**: `export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string`
  - *Description*: Executes the logic for `restoreLineEndings`.
- **`normalizeForFuzzyMatch`**: `export function normalizeForFuzzyMatch(text: string): string`
  - *Description*: Normalize text for fuzzy matching. Applies progressive transformations: - Strip trailing whitespace from each line - Normalize smart quotes to ASCII equivalents - Normalize Unicode dashes/hyphens to ASCII hyphen - Normalize special Unicode spaces to regular space
- **`fuzzyFindText`**: `export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult`
  - *Description*: Find oldText in content, trying exact match first, then fuzzy match. When fuzzy matching is used, the returned contentForReplacement is the fuzzy-normalized version of the content (trailing whitespace stripped, Unicode quotes/dashes normalized to ASCII).
- **`stripBom`**: `export function stripBom(content: string):`
  - *Description*: Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it
- **`generateDiffString`**: `export function generateDiffString( 	oldContent: string, 	newContent: string, 	contextLines = 4, ):`
  - *Description*: Generate a unified diff string with line numbers and context. Returns both the diff string and the first changed line number (in the new file).
- **`computeEditDiff`**: `export async function computeEditDiff( 	path: string, 	oldText: string, 	newText: string, 	cwd: string, ): Promise<EditDiffResult | EditDiffError>`
  - *Description*: Compute the diff for an edit operation without applying it. Used for preview rendering in the TUI before the tool executes.

#### Exported Interfaces
- **`FuzzyMatchResult`**
  - *Description*: Data structure or object model representing `FuzzyMatchResult`.
  - `found: boolean`
  - `index: number`
  - `matchLength: number`
  - `usedFuzzyMatch: boolean`
  - `contentForReplacement: string`
- **`EditDiffResult`**
  - *Description*: Data structure or object model representing `EditDiffResult`.
  - `diff: string`
  - `firstChangedLine: number`
- **`EditDiffError`**
  - *Description*: Custom error type for `EditDiffError`.
  - `error: string`

### File: `packages/coding-agent/src/core/tools/edit.ts`

#### Exported Functions
- **`createEditTool`**: `export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema>`
  - *Description*: Instantiates or constructs a new EditTool.

#### Exported Interfaces
- **`EditToolDetails`**
  - *Description*: Data structure or object model representing `EditToolDetails`.
  - `diff: string`
  - `firstChangedLine?: number`
- **`EditOperations`**
  - *Description*: Pluggable operations for the edit tool. Override these to delegate file editing to remote systems (e.g., SSH).
  - `readFile: (absolutePath: string) => Promise<Buffer<ArrayBufferLike>>`
  - `writeFile: (absolutePath: string, content: string) => Promise<void>`
  - `access: (absolutePath: string) => Promise<void>`
- **`EditToolOptions`**
  - *Description*: Configuration options for `EditTool`.
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/edit").EditOperations`

#### Exported Types
- **`EditToolInput`**: `Static<typeof editSchema>`
  - *Description*: Type alias for `EditToolInput`.

### File: `packages/coding-agent/src/core/tools/find.ts`

#### Exported Functions
- **`createFindTool`**: `export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema>`
  - *Description*: Instantiates or constructs a new FindTool.

#### Exported Interfaces
- **`FindToolDetails`**
  - *Description*: Data structure or object model representing `FindToolDetails`.
  - `truncation?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/truncate").TruncationResult`
  - `resultLimitReached?: number`
- **`FindOperations`**
  - *Description*: Pluggable operations for the find tool. Override these to delegate file search to remote systems (e.g., SSH).
  - `exists: (absolutePath: string) => boolean | Promise<boolean>`
  - `glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number; }) => string[] | Promise<string[]>`
- **`FindToolOptions`**
  - *Description*: Configuration options for `FindTool`.
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/find").FindOperations`

#### Exported Types
- **`FindToolInput`**: `Static<typeof findSchema>`
  - *Description*: Type alias for `FindToolInput`.

### File: `packages/coding-agent/src/core/tools/grep.ts`

#### Exported Functions
- **`createGrepTool`**: `export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema>`
  - *Description*: Instantiates or constructs a new GrepTool.

#### Exported Interfaces
- **`GrepToolDetails`**
  - *Description*: Data structure or object model representing `GrepToolDetails`.
  - `truncation?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/truncate").TruncationResult`
  - `matchLimitReached?: number`
  - `linesTruncated?: boolean`
- **`GrepOperations`**
  - *Description*: Pluggable operations for the grep tool. Override these to delegate search to remote systems (e.g., SSH).
  - `isDirectory: (absolutePath: string) => boolean | Promise<boolean>`
  - `readFile: (absolutePath: string) => string | Promise<string>`
- **`GrepToolOptions`**
  - *Description*: Configuration options for `GrepTool`.
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/grep").GrepOperations`

#### Exported Types
- **`GrepToolInput`**: `Static<typeof grepSchema>`
  - *Description*: Type alias for `GrepToolInput`.

### File: `packages/coding-agent/src/core/tools/index.ts`

#### Exported Functions
- **`createCodingTools`**: `export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[]`
  - *Description*: Create coding tools configured for a specific working directory.
- **`createReadOnlyTools`**: `export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[]`
  - *Description*: Create read-only tools configured for a specific working directory.
- **`createAllTools`**: `export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool>`
  - *Description*: Create all tools configured for a specific working directory.

#### Exported Interfaces
- **`ToolsOptions`**
  - *Description*: Configuration options for `Tools`.
  - `read?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/read").ReadToolOptions`
  - `bash?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/bash").BashToolOptions`

#### Exported Types
- **`Tool`**: `AgentTool<any>`
  - *Description*: Tool type (AgentTool from pi-ai)
- **`ToolName`**: `keyof typeof allTools`
  - *Description*: Type alias for `ToolName`.

### File: `packages/coding-agent/src/core/tools/ls.ts`

#### Exported Functions
- **`createLsTool`**: `export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema>`
  - *Description*: Instantiates or constructs a new LsTool.

#### Exported Interfaces
- **`LsToolDetails`**
  - *Description*: Data structure or object model representing `LsToolDetails`.
  - `truncation?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/truncate").TruncationResult`
  - `entryLimitReached?: number`
- **`LsOperations`**
  - *Description*: Pluggable operations for the ls tool. Override these to delegate directory listing to remote systems (e.g., SSH).
  - `exists: (absolutePath: string) => boolean | Promise<boolean>`
  - `stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean; }> | { isDirectory: () => boolean; }`
  - `readdir: (absolutePath: string) => string[] | Promise<string[]>`
- **`LsToolOptions`**
  - *Description*: Configuration options for `LsTool`.
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/ls").LsOperations`

#### Exported Types
- **`LsToolInput`**: `Static<typeof lsSchema>`
  - *Description*: Type alias for `LsToolInput`.

### File: `packages/coding-agent/src/core/tools/path-utils.ts`

#### Exported Functions
- **`expandPath`**: `export function expandPath(filePath: string): string`
  - *Description*: Executes the logic for `expandPath`.
- **`resolveToCwd`**: `export function resolveToCwd(filePath: string, cwd: string): string`
  - *Description*: Resolve a path relative to the given cwd. Handles ~ expansion and absolute paths.
- **`resolveReadPath`**: `export function resolveReadPath(filePath: string, cwd: string): string`
  - *Description*: Executes the logic for `resolveReadPath`.

### File: `packages/coding-agent/src/core/tools/read.ts`

#### Exported Functions
- **`createReadTool`**: `export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema>`
  - *Description*: Instantiates or constructs a new ReadTool.

#### Exported Interfaces
- **`ReadToolDetails`**
  - *Description*: Data structure or object model representing `ReadToolDetails`.
  - `truncation?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/truncate").TruncationResult`
- **`ReadOperations`**
  - *Description*: Pluggable operations for the read tool. Override these to delegate file reading to remote systems (e.g., SSH).
  - `readFile: (absolutePath: string) => Promise<Buffer<ArrayBufferLike>>`
  - `access: (absolutePath: string) => Promise<void>`
  - `detectImageMimeType?: (absolutePath: string) => Promise<string>`
- **`ReadToolOptions`**
  - *Description*: Configuration options for `ReadTool`.
  - `autoResizeImages?: boolean`
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/read").ReadOperations`

#### Exported Types
- **`ReadToolInput`**: `Static<typeof readSchema>`
  - *Description*: Type alias for `ReadToolInput`.

### File: `packages/coding-agent/src/core/tools/truncate.ts`

#### Exported Functions
- **`formatSize`**: `export function formatSize(bytes: number): string`
  - *Description*: Format bytes as human-readable size.
- **`truncateHead`**: `export function truncateHead(content: string, options: TruncationOptions =`
  - *Description*: Truncate content from the head (keep first N lines/bytes). Suitable for file reads where you want to see the beginning.  Never returns partial lines. If first line exceeds byte limit, returns empty content with firstLineExceedsLimit=true.
- **`truncateTail`**: `export function truncateTail(content: string, options: TruncationOptions =`
  - *Description*: Truncate content from the tail (keep last N lines/bytes). Suitable for bash output where you want to see the end (errors, final results).  May return partial first line if the last line of original content exceeds byte limit.
- **`truncateLine`**: `export function truncateLine( 	line: string, 	maxChars: number = GREP_MAX_LINE_LENGTH, ):`
  - *Description*: Truncate a single line to max characters, adding [truncated] suffix. Used for grep match lines.

#### Exported Interfaces
- **`TruncationResult`**
  - *Description*: Data structure or object model representing `TruncationResult`.
  - `content: string`
  - `truncated: boolean`
  - `truncatedBy: "lines" | "bytes"`
  - `totalLines: number`
  - `totalBytes: number`
  - `outputLines: number`
  - `outputBytes: number`
  - `lastLinePartial: boolean`
  - `firstLineExceedsLimit: boolean`
  - `maxLines: number`
  - `maxBytes: number`
- **`TruncationOptions`**
  - *Description*: Configuration options for `Truncation`.
  - `maxLines?: number`
  - `maxBytes?: number`

### File: `packages/coding-agent/src/core/tools/write.ts`

#### Exported Functions
- **`createWriteTool`**: `export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema>`
  - *Description*: Instantiates or constructs a new WriteTool.

#### Exported Interfaces
- **`WriteOperations`**
  - *Description*: Pluggable operations for the write tool. Override these to delegate file writing to remote systems (e.g., SSH).
  - `writeFile: (absolutePath: string, content: string) => Promise<void>`
  - `mkdir: (dir: string) => Promise<void>`
- **`WriteToolOptions`**
  - *Description*: Configuration options for `WriteTool`.
  - `operations?: import("c:/Works/GitWorks/pi-mono/packages/coding-agent/src/core/tools/write").WriteOperations`

#### Exported Types
- **`WriteToolInput`**: `Static<typeof writeSchema>`
  - *Description*: Type alias for `WriteToolInput`.

### File: `packages/coding-agent/src/main.ts`

#### Exported Functions
- **`main`**: `export async function main(args: string[])`
  - *Description*: Executes the logic for `main`.

### File: `packages/coding-agent/src/migrations.ts`

#### Exported Functions
- **`migrateAuthToAuthJson`**: `export function migrateAuthToAuthJson(): string[]`
  - *Description*: Migrate legacy oauth.json and settings.json apiKeys to auth.json.  @returns Array of provider names that were migrated
- **`migrateSessionsFromAgentRoot`**: `export function migrateSessionsFromAgentRoot(): void`
  - *Description*: Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.  Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them to the correct location based on the cwd in their session header.  See: https://github.com/badlogic/pi-mono/issues/320
- **`showDeprecationWarnings`**: `export async function showDeprecationWarnings(warnings: string[]): Promise<void>`
  - *Description*: Print deprecation warnings and wait for keypress.
- **`runMigrations`**: `export function runMigrations(cwd: string = process.cwd()):`
  - *Description*: Run all migrations. Called once on startup.  @returns Object with migration results and deprecation warnings

### File: `packages/coding-agent/src/modes/interactive/components/armin.ts`

#### Exported Classes
- **`ArminComponent`**
  - *Description*: Data structure or object model representing `ArminComponent`.
  - `invalidate(): void`
  - `render(width: number): string[]`
  - `dispose(): void`

### File: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`

#### Exported Classes
- **`AssistantMessageComponent`**
  - *Description*: Component that renders a complete assistant message
  - `override invalidate(): void`
  - `setHideThinkingBlock(hide: boolean): void`
  - `updateContent(message: AssistantMessage): void`

### File: `packages/coding-agent/src/modes/interactive/components/bash-execution.ts`

#### Exported Classes
- **`BashExecutionComponent`**
  - *Description*: Data structure or object model representing `BashExecutionComponent`.
  - `setExpanded(expanded: boolean): void`
  - `override invalidate(): void`
  - `appendOutput(chunk: string): void`
  - `setComplete( 		exitCode: number | undefined, 		cancelled: boolean, 		truncationResult?: TruncationResult, 		fullOutputPath?: string, 	): void`
  - `getOutput(): string`
  - `getCommand(): string`

### File: `packages/coding-agent/src/modes/interactive/components/bordered-loader.ts`

#### Exported Classes
- **`BorderedLoader`**
  - *Description*: Loader wrapped with borders for extension UI
  - `handleInput(data: string): void`
  - `dispose(): void`

### File: `packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts`

#### Exported Classes
- **`BranchSummaryMessageComponent`**
  - *Description*: Component that renders a branch summary message with collapsed/expanded state. Uses same background color as custom messages for visual consistency.
  - `setExpanded(expanded: boolean): void`
  - `override invalidate(): void`

### File: `packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts`

#### Exported Classes
- **`CompactionSummaryMessageComponent`**
  - *Description*: Component that renders a compaction message with collapsed/expanded state. Uses same background color as custom messages for visual consistency.
  - `setExpanded(expanded: boolean): void`
  - `override invalidate(): void`

### File: `packages/coding-agent/src/modes/interactive/components/config-selector.ts`

#### Exported Classes
- **`ConfigSelectorComponent`**
  - *Description*: Data structure or object model representing `ConfigSelectorComponent`.
  - `getResourceList(): ResourceList`

### File: `packages/coding-agent/src/modes/interactive/components/countdown-timer.ts`

#### Exported Classes
- **`CountdownTimer`**
  - *Description*: Data structure or object model representing `CountdownTimer`.
  - `dispose(): void`

### File: `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`

#### Exported Classes
- **`CustomEditor`**
  - *Description*: Custom editor that handles app-level keybindings for coding-agent.
  - `onAction(action: AppAction, handler: () => void): void`
  - `handleInput(data: string): void`

### File: `packages/coding-agent/src/modes/interactive/components/custom-message.ts`

#### Exported Classes
- **`CustomMessageComponent`**
  - *Description*: Component that renders a custom message entry from extensions. Uses distinct styling to differentiate from user messages.
  - `setExpanded(expanded: boolean): void`
  - `override invalidate(): void`

### File: `packages/coding-agent/src/modes/interactive/components/daxnuts.ts`

#### Exported Classes
- **`DaxnutsComponent`**
  - *Description*: Data structure or object model representing `DaxnutsComponent`.
  - `invalidate(): void`
  - `render(width: number): string[]`
  - `dispose(): void`

### File: `packages/coding-agent/src/modes/interactive/components/diff.ts`

#### Exported Functions
- **`renderDiff`**: `export function renderDiff(diffText: string, _options: RenderDiffOptions =`
  - *Description*: Render a diff string with colored lines and intra-line change highlighting. - Context lines: dim/gray - Removed lines: red, with inverse on changed tokens - Added lines: green, with inverse on changed tokens

#### Exported Interfaces
- **`RenderDiffOptions`**
  - *Description*: Configuration options for `RenderDiff`.
  - `filePath?: string`

### File: `packages/coding-agent/src/modes/interactive/components/dynamic-border.ts`

#### Exported Classes
- **`DynamicBorder`**
  - *Description*: Dynamic border component that adjusts to viewport width.  Note: When used from extensions loaded via jiti, the global `theme` may be undefined because jiti creates a separate module cache. Always pass an explicit color function when using DynamicBorder in components exported for extension use.
  - `invalidate(): void`
  - `render(width: number): string[]`

### File: `packages/coding-agent/src/modes/interactive/components/extension-editor.ts`

#### Exported Classes
- **`ExtensionEditorComponent`**
  - *Description*: Data structure or object model representing `ExtensionEditorComponent`.
  - `handleInput(keyData: string): void`

### File: `packages/coding-agent/src/modes/interactive/components/extension-input.ts`

#### Exported Interfaces
- **`ExtensionInputOptions`**
  - *Description*: Configuration options for `ExtensionInput`.
  - `tui?: TUI`
  - `timeout?: number`

#### Exported Classes
- **`ExtensionInputComponent`**
  - *Description*: Data structure or object model representing `ExtensionInputComponent`.
  - `handleInput(keyData: string): void`
  - `dispose(): void`

### File: `packages/coding-agent/src/modes/interactive/components/extension-selector.ts`

#### Exported Interfaces
- **`ExtensionSelectorOptions`**
  - *Description*: Configuration options for `ExtensionSelector`.
  - `tui?: TUI`
  - `timeout?: number`

#### Exported Classes
- **`ExtensionSelectorComponent`**
  - *Description*: Data structure or object model representing `ExtensionSelectorComponent`.
  - `handleInput(keyData: string): void`
  - `dispose(): void`

### File: `packages/coding-agent/src/modes/interactive/components/footer.ts`

#### Exported Classes
- **`FooterComponent`**
  - *Description*: Footer component that shows pwd, token stats, and context usage. Computes token/context stats from session, gets git branch and extension statuses from provider.
  - `setAutoCompactEnabled(enabled: boolean): void`
  - `invalidate(): void`
  - `dispose(): void`
  - `render(width: number): string[]`

### File: `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts`

#### Exported Functions
- **`editorKey`**: `export function editorKey(action: EditorAction): string`
  - *Description*: Get display string for an editor action.
- **`appKey`**: `export function appKey(keybindings: KeybindingsManager, action: AppAction): string`
  - *Description*: Get display string for an app action.
- **`keyHint`**: `export function keyHint(action: EditorAction, description: string): string`
  - *Description*: Format a keybinding hint with consistent styling: dim key, muted description. Looks up the key from editor keybindings automatically.  @param action - Editor action name (e.g., "selectConfirm", "expandTools") @param description - Description text (e.g., "to expand", "cancel") @returns Formatted string with dim key and muted description
- **`appKeyHint`**: `export function appKeyHint(keybindings: KeybindingsManager, action: AppAction, description: string): string`
  - *Description*: Format a keybinding hint for app-level actions. Requires the KeybindingsManager instance.  @param keybindings - KeybindingsManager instance @param action - App action name (e.g., "interrupt", "externalEditor") @param description - Description text @returns Formatted string with dim key and muted description
- **`rawKeyHint`**: `export function rawKeyHint(key: string, description: string): string`
  - *Description*: Format a raw key string with description (for non-configurable keys like ↑↓).  @param key - Raw key string @param description - Description text @returns Formatted string with dim key and muted description

### File: `packages/coding-agent/src/modes/interactive/components/login-dialog.ts`

#### Exported Classes
- **`LoginDialogComponent`**
  - *Description*: Login dialog component - replaces editor during OAuth login flow
  - `showAuth(url: string, instructions?: string): void`
  - `showManualInput(prompt: string): Promise<string>`
  - `showPrompt(message: string, placeholder?: string): Promise<string>`
  - `showWaiting(message: string): void`
  - `showProgress(message: string): void`
  - `handleInput(data: string): void`

### File: `packages/coding-agent/src/modes/interactive/components/model-selector.ts`

#### Exported Classes
- **`ModelSelectorComponent`**
  - *Description*: Component that renders a model selector with search
  - `handleInput(keyData: string): void`
  - `getSearchInput(): Input`

### File: `packages/coding-agent/src/modes/interactive/components/oauth-selector.ts`

#### Exported Classes
- **`OAuthSelectorComponent`**
  - *Description*: Component that renders an OAuth provider selector
  - `handleInput(keyData: string): void`

### File: `packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts`

#### Exported Interfaces
- **`ModelsConfig`**
  - *Description*: Configuration options for `Models`.
  - `allModels: Model<any>[]`
  - `enabledModelIds: Set<string>`
  - `hasEnabledModelsFilter: boolean`
- **`ModelsCallbacks`**
  - *Description*: Data structure or object model representing `ModelsCallbacks`.
  - `onModelToggle: (modelId: string, enabled: boolean) => void`
  - `onPersist: (enabledModelIds: string[]) => void`
  - `onEnableAll: (allModelIds: string[]) => void`
  - `onClearAll: () => void`
  - `onToggleProvider: (provider: string, modelIds: string[], enabled: boolean) => void`
  - `onCancel: () => void`

#### Exported Classes
- **`ScopedModelsSelectorComponent`**
  - *Description*: Component for enabling/disabling models for Ctrl+P cycling. Changes are session-only until explicitly persisted with Ctrl+S.
  - `handleInput(data: string): void`
  - `getSearchInput(): Input`

### File: `packages/coding-agent/src/modes/interactive/components/session-selector-search.ts`

#### Exported Functions
- **`hasSessionName`**: `export function hasSessionName(session: SessionInfo): boolean`
  - *Description*: Checks if the condition 'hasSessionName' is true.
- **`parseSearchQuery`**: `export function parseSearchQuery(query: string): ParsedSearchQuery`
  - *Description*: Parses input data to generate SearchQuery.
- **`matchSession`**: `export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult`
  - *Description*: Executes the logic for `matchSession`.
- **`filterAndSortSessions`**: `export function filterAndSortSessions( 	sessions: SessionInfo[], 	query: string, 	sortMode: SortMode, 	nameFilter: NameFilter = "all", ): SessionInfo[]`
  - *Description*: Executes the logic for `filterAndSortSessions`.

#### Exported Interfaces
- **`ParsedSearchQuery`**
  - *Description*: Data structure or object model representing `ParsedSearchQuery`.
  - `mode: "tokens" | "regex"`
  - `tokens: { kind: "fuzzy" | "phrase"; value: string; }[]`
  - `regex: RegExp`
  - `error?: string`
- **`MatchResult`**
  - *Description*: Data structure or object model representing `MatchResult`.
  - `matches: boolean`
  - `score: number`

#### Exported Types
- **`SortMode`**: `"threaded" | "recent" | "relevance"`
  - *Description*: Type alias for `SortMode`.
- **`NameFilter`**: `"all" | "named"`
  - *Description*: Type alias for `NameFilter`.

### File: `packages/coding-agent/src/modes/interactive/components/session-selector.ts`

#### Exported Classes
- **`SessionSelectorComponent`**
  - *Description*: Component that renders a session selector
  - `handleInput(data: string): void`
  - `getSessionList(): SessionList`

### File: `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`

#### Exported Interfaces
- **`SettingsConfig`**
  - *Description*: Configuration options for `Settings`.
  - `autoCompact: boolean`
  - `showImages: boolean`
  - `autoResizeImages: boolean`
  - `blockImages: boolean`
  - `enableSkillCommands: boolean`
  - `steeringMode: "all" | "one-at-a-time"`
  - `followUpMode: "all" | "one-at-a-time"`
  - `transport: Transport`
  - `thinkingLevel: ThinkingLevel`
  - `availableThinkingLevels: ThinkingLevel[]`
  - `currentTheme: string`
  - `availableThemes: string[]`
  - `hideThinkingBlock: boolean`
  - `collapseChangelog: boolean`
  - `doubleEscapeAction: "tree" | "fork" | "none"`
  - `showHardwareCursor: boolean`
  - `editorPaddingX: number`
  - `autocompleteMaxVisible: number`
  - `quietStartup: boolean`
  - `clearOnShrink: boolean`
- **`SettingsCallbacks`**
  - *Description*: Data structure or object model representing `SettingsCallbacks`.
  - `onAutoCompactChange: (enabled: boolean) => void`
  - `onShowImagesChange: (enabled: boolean) => void`
  - `onAutoResizeImagesChange: (enabled: boolean) => void`
  - `onBlockImagesChange: (blocked: boolean) => void`
  - `onEnableSkillCommandsChange: (enabled: boolean) => void`
  - `onSteeringModeChange: (mode: "all" | "one-at-a-time") => void`
  - `onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void`
  - `onTransportChange: (transport: Transport) => void`
  - `onThinkingLevelChange: (level: ThinkingLevel) => void`
  - `onThemeChange: (theme: string) => void`
  - `onThemePreview?: (theme: string) => void`
  - `onHideThinkingBlockChange: (hidden: boolean) => void`
  - `onCollapseChangelogChange: (collapsed: boolean) => void`
  - `onDoubleEscapeActionChange: (action: "tree" | "fork" | "none") => void`
  - `onShowHardwareCursorChange: (enabled: boolean) => void`
  - `onEditorPaddingXChange: (padding: number) => void`
  - `onAutocompleteMaxVisibleChange: (maxVisible: number) => void`
  - `onQuietStartupChange: (enabled: boolean) => void`
  - `onClearOnShrinkChange: (enabled: boolean) => void`
  - `onCancel: () => void`

#### Exported Classes
- **`SettingsSelectorComponent`**
  - *Description*: Main settings selector component.
  - `getSettingsList(): SettingsList`

### File: `packages/coding-agent/src/modes/interactive/components/show-images-selector.ts`

#### Exported Classes
- **`ShowImagesSelectorComponent`**
  - *Description*: Component that renders a show images selector with borders
  - `getSelectList(): SelectList`

### File: `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts`

#### Exported Classes
- **`SkillInvocationMessageComponent`**
  - *Description*: Component that renders a skill invocation message with collapsed/expanded state. Uses same background color as custom messages for visual consistency. Only renders the skill block itself - user message is rendered separately.
  - `setExpanded(expanded: boolean): void`
  - `override invalidate(): void`

### File: `packages/coding-agent/src/modes/interactive/components/theme-selector.ts`

#### Exported Classes
- **`ThemeSelectorComponent`**
  - *Description*: Component that renders a theme selector
  - `getSelectList(): SelectList`

### File: `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts`

#### Exported Classes
- **`ThinkingSelectorComponent`**
  - *Description*: Component that renders a thinking level selector with borders
  - `getSelectList(): SelectList`

### File: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

#### Exported Interfaces
- **`ToolExecutionOptions`**
  - *Description*: Configuration options for `ToolExecution`.
  - `showImages?: boolean`

#### Exported Classes
- **`ToolExecutionComponent`**
  - *Description*: Component that renders a tool call with its result (updateable)
  - `updateArgs(args: any): void`
  - `setArgsComplete(): void`
  - `updateResult( 		result:`
  - `setExpanded(expanded: boolean): void`
  - `setShowImages(show: boolean): void`
  - `override invalidate(): void`

### File: `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`

#### Exported Classes
- **`TreeSelectorComponent`**
  - *Description*: Component that renders a session tree selector for navigation
  - `handleInput(keyData: string): void`
  - `getTreeList(): TreeList`

### File: `packages/coding-agent/src/modes/interactive/components/user-message-selector.ts`

#### Exported Classes
- **`UserMessageSelectorComponent`**
  - *Description*: Component that renders a user message selector for branching
  - `getMessageList(): UserMessageList`

### File: `packages/coding-agent/src/modes/interactive/components/user-message.ts`

#### Exported Classes
- **`UserMessageComponent`**
  - *Description*: Component that renders a user message

### File: `packages/coding-agent/src/modes/interactive/components/visual-truncate.ts`

#### Exported Functions
- **`truncateToVisualLines`**: `export function truncateToVisualLines( 	text: string, 	maxVisualLines: number, 	width: number, 	paddingX: number = 0, ): VisualTruncateResult`
  - *Description*: Truncate text to a maximum number of visual lines (from the end). This accounts for line wrapping based on terminal width.  @param text - The text content (may contain newlines) @param maxVisualLines - Maximum number of visual lines to show @param width - Terminal/render width @param paddingX - Horizontal padding for Text component (default 0).                   Use 0 when result will be placed in a Box (Box adds its own padding).                   Use 1 when result will be placed in a plain Container. @returns The truncated visual lines and count of skipped lines

#### Exported Interfaces
- **`VisualTruncateResult`**
  - *Description*: Data structure or object model representing `VisualTruncateResult`.
  - `visualLines: string[]`
  - `skippedCount: number`

### File: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

#### Exported Interfaces
- **`InteractiveModeOptions`**
  - *Description*: Options for InteractiveMode initialization.
  - `migratedProviders?: string[]`
  - `modelFallbackMessage?: string`
  - `initialMessage?: string`
  - `initialImages?: ImageContent[]`
  - `initialMessages?: string[]`
  - `verbose?: boolean`

#### Exported Classes
- **`InteractiveMode`**
  - *Description*: Data structure or object model representing `InteractiveMode`.
  - `async init(): Promise<void>`
  - `async run(): Promise<void>`
  - `renderInitialMessages(): void`
  - `async getUserInput(): Promise<string>`
  - `clearEditor(): void`
  - `showError(errorMessage: string): void`
  - `showWarning(warningMessage: string): void`
  - `showNewVersionNotification(newVersion: string): void`
  - `stop(): void`

### File: `packages/coding-agent/src/modes/interactive/theme/theme.ts`

#### Exported Functions
- **`getAvailableThemes`**: `export function getAvailableThemes(): string[]`
  - *Description*: Retrieves or computes AvailableThemes.
- **`getAvailableThemesWithPaths`**: `export function getAvailableThemesWithPaths(): ThemeInfo[]`
  - *Description*: Retrieves or computes AvailableThemesWithPaths.
- **`loadThemeFromPath`**: `export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme`
  - *Description*: Executes the logic for `loadThemeFromPath`.
- **`getThemeByName`**: `export function getThemeByName(name: string): Theme | undefined`
  - *Description*: Retrieves or computes ThemeByName.
- **`setRegisteredThemes`**: `export function setRegisteredThemes(themes: Theme[]): void`
  - *Description*: Updates or assigns RegisteredThemes.
- **`initTheme`**: `export function initTheme(themeName?: string, enableWatcher: boolean = false): void`
  - *Description*: Executes the logic for `initTheme`.
- **`setTheme`**: `export function setTheme(name: string, enableWatcher: boolean = false):`
  - *Description*: Updates or assigns Theme.
- **`setThemeInstance`**: `export function setThemeInstance(themeInstance: Theme): void`
  - *Description*: Updates or assigns ThemeInstance.
- **`onThemeChange`**: `export function onThemeChange(callback: () => void): void`
  - *Description*: Event handler for onThemeChange.
- **`stopThemeWatcher`**: `export function stopThemeWatcher(): void`
  - *Description*: Executes the logic for `stopThemeWatcher`.
- **`getResolvedThemeColors`**: `export function getResolvedThemeColors(themeName?: string): Record<string, string>`
  - *Description*: Get resolved theme colors as CSS-compatible hex strings. Used by HTML export to generate CSS custom properties.
- **`isLightTheme`**: `export function isLightTheme(themeName?: string): boolean`
  - *Description*: Check if a theme is a "light" theme (for CSS that needs light/dark variants).
- **`getThemeExportColors`**: `export function getThemeExportColors(themeName?: string):`
  - *Description*: Get explicit export colors from theme JSON, if specified. Returns undefined for each color that isn't explicitly set.
- **`highlightCode`**: `export function highlightCode(code: string, lang?: string): string[]`
  - *Description*: Highlight code with syntax coloring based on file extension or language. Returns array of highlighted lines.
- **`getLanguageFromPath`**: `export function getLanguageFromPath(filePath: string): string | undefined`
  - *Description*: Get language identifier from file path extension.
- **`getMarkdownTheme`**: `export function getMarkdownTheme(): MarkdownTheme`
  - *Description*: Retrieves or computes MarkdownTheme.
- **`getSelectListTheme`**: `export function getSelectListTheme(): SelectListTheme`
  - *Description*: Retrieves or computes SelectListTheme.
- **`getEditorTheme`**: `export function getEditorTheme(): EditorTheme`
  - *Description*: Retrieves or computes EditorTheme.
- **`getSettingsListTheme`**: `export function getSettingsListTheme(): import("@mariozechner/pi-tui").SettingsListTheme`
  - *Description*: Retrieves or computes SettingsListTheme.

#### Exported Interfaces
- **`ThemeInfo`**
  - *Description*: Data structure or object model representing `ThemeInfo`.
  - `name: string`
  - `path: string`

#### Exported Classes
- **`Theme`**
  - *Description*: Data structure or object model representing `Theme`.
  - `fg(color: ThemeColor, text: string): string`
  - `bg(color: ThemeBg, text: string): string`
  - `bold(text: string): string`
  - `italic(text: string): string`
  - `underline(text: string): string`
  - `inverse(text: string): string`
  - `strikethrough(text: string): string`
  - `getFgAnsi(color: ThemeColor): string`
  - `getBgAnsi(color: ThemeBg): string`
  - `getColorMode(): ColorMode`
  - `getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): (str: string) => string`
  - `getBashModeBorderColor(): (str: string) => string`

#### Exported Types
- **`ThemeColor`**: `| "accent" 	| "border" 	| "borderAccent" 	| "borderMuted" 	| "success" 	| "error" 	| "warning" 	| "muted" 	| "dim" 	| "text" 	| "thinkingText" 	| "userMessageText" 	| "customMessageText" ...`
  - *Description*: Type alias for `ThemeColor`.
- **`ThemeBg`**: `| "selectedBg" 	| "userMessageBg" 	| "customMessageBg" 	| "toolPendingBg" 	| "toolSuccessBg" 	| "toolErrorBg"`
  - *Description*: Type alias for `ThemeBg`.

### File: `packages/coding-agent/src/modes/print-mode.ts`

#### Exported Functions
- **`runPrintMode`**: `export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void>`
  - *Description*: Run in print (single-shot) mode. Sends prompts to the agent and outputs the result.

#### Exported Interfaces
- **`PrintModeOptions`**
  - *Description*: Options for print mode.
  - `mode: "text" | "json"`
  - `messages?: string[]`
  - `initialMessage?: string`
  - `initialImages?: ImageContent[]`

### File: `packages/coding-agent/src/modes/rpc/rpc-client.ts`

#### Exported Interfaces
- **`RpcClientOptions`**
  - *Description*: Configuration options for `RpcClient`.
  - `cliPath?: string`
  - `cwd?: string`
  - `env?: Record<string, string>`
  - `provider?: string`
  - `model?: string`
  - `args?: string[]`
- **`ModelInfo`**
  - *Description*: Data structure or object model representing `ModelInfo`.
  - `provider: string`
  - `id: string`
  - `contextWindow: number`
  - `reasoning: boolean`

#### Exported Classes
- **`RpcClient`**
  - *Description*: Data structure or object model representing `RpcClient`.
  - `async start(): Promise<void>`
  - `async stop(): Promise<void>`
  - `onEvent(listener: RpcEventListener): () => void`
  - `getStderr(): string`
  - `async prompt(message: string, images?: ImageContent[]): Promise<void>`
  - `async steer(message: string, images?: ImageContent[]): Promise<void>`
  - `async followUp(message: string, images?: ImageContent[]): Promise<void>`
  - `async abort(): Promise<void>`
  - `async newSession(parentSession?: string): Promise<`
  - `async getState(): Promise<RpcSessionState>`
  - `async setModel(provider: string, modelId: string): Promise<`
  - `async cycleModel(): Promise<`
  - `async getAvailableModels(): Promise<ModelInfo[]>`
  - `async setThinkingLevel(level: ThinkingLevel): Promise<void>`
  - `async cycleThinkingLevel(): Promise<`
  - `async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>`
  - `async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>`
  - `async compact(customInstructions?: string): Promise<CompactionResult>`
  - `async setAutoCompaction(enabled: boolean): Promise<void>`
  - `async setAutoRetry(enabled: boolean): Promise<void>`
  - `async abortRetry(): Promise<void>`
  - `async bash(command: string): Promise<BashResult>`
  - `async abortBash(): Promise<void>`
  - `async getSessionStats(): Promise<SessionStats>`
  - `async exportHtml(outputPath?: string): Promise<`
  - `async switchSession(sessionPath: string): Promise<`
  - `async fork(entryId: string): Promise<`
  - `async getForkMessages(): Promise<Array<`
  - `async getLastAssistantText(): Promise<string | null>`
  - `async setSessionName(name: string): Promise<void>`
  - `async getMessages(): Promise<AgentMessage[]>`
  - `async getCommands(): Promise<RpcSlashCommand[]>`
  - `waitForIdle(timeout = 60000): Promise<void>`
  - `collectEvents(timeout = 60000): Promise<AgentEvent[]>`
  - `async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]>`

#### Exported Types
- **`RpcEventListener`**: `(event: AgentEvent) => void`
  - *Description*: Type alias for `RpcEventListener`.

### File: `packages/coding-agent/src/modes/rpc/rpc-mode.ts`

#### Exported Functions
- **`runRpcMode`**: `export async function runRpcMode(session: AgentSession): Promise<never>`
  - *Description*: Run in RPC mode. Listens for JSON commands on stdin, outputs events and responses on stdout.

### File: `packages/coding-agent/src/modes/rpc/rpc-types.ts`

#### Exported Interfaces
- **`RpcSlashCommand`**
  - *Description*: A command available for invocation via prompt
  - `name: string`
  - `description?: string`
  - `source: "extension" | "skill" | "prompt"`
  - `location?: "user" | "project" | "path"`
  - `path?: string`
- **`RpcSessionState`**
  - *Description*: State representation for `RpcSession`.
  - `model?: Model<any>`
  - `thinkingLevel: ThinkingLevel`
  - `isStreaming: boolean`
  - `isCompacting: boolean`
  - `steeringMode: "all" | "one-at-a-time"`
  - `followUpMode: "all" | "one-at-a-time"`
  - `sessionFile?: string`
  - `sessionId: string`
  - `sessionName?: string`
  - `autoCompactionEnabled: boolean`
  - `messageCount: number`
  - `pendingMessageCount: number`

#### Exported Types
- **`RpcCommand`**: `| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" } 	| { id?: string; type: "steer"; message: string; images?: ImageContent[] } 	| {...`
  - *Description*: Type alias for `RpcCommand`.
- **`RpcResponse`**: `| { id?: string; type: "response"; command: "prompt"; success: true } 	| { id?: string; type: "response"; command: "steer"; success: true } 	| { id?: string; type: "response"; command: "follow_up"; ...`
  - *Description*: Type alias for `RpcResponse`.
- **`RpcExtensionUIRequest`**: `| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number } 	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; m...`
  - *Description*: Emitted when an extension needs user input
- **`RpcExtensionUIResponse`**: `| { type: "extension_ui_response"; id: string; value: string } 	| { type: "extension_ui_response"; id: string; confirmed: boolean } 	| { type: "extension_ui_response"; id: string; cancelled: true }`
  - *Description*: Response to an extension UI request
- **`RpcCommandType`**: `RpcCommand["type"]`
  - *Description*: Type alias for `RpcCommandType`.

### File: `packages/coding-agent/src/utils/changelog.ts`

#### Exported Functions
- **`parseChangelog`**: `export function parseChangelog(changelogPath: string): ChangelogEntry[]`
  - *Description*: Parse changelog entries from CHANGELOG.md Scans for ## lines and collects content until next ## or EOF
- **`compareVersions`**: `export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number`
  - *Description*: Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
- **`getNewEntries`**: `export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[]`
  - *Description*: Get entries newer than lastVersion

#### Exported Interfaces
- **`ChangelogEntry`**
  - *Description*: Data structure or object model representing `ChangelogEntry`.
  - `major: number`
  - `minor: number`
  - `patch: number`
  - `content: string`

### File: `packages/coding-agent/src/utils/clipboard-image.ts`

#### Exported Functions
- **`isWaylandSession`**: `export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean`
  - *Description*: Checks if the condition 'isWaylandSession' is true.
- **`extensionForImageMimeType`**: `export function extensionForImageMimeType(mimeType: string): string | null`
  - *Description*: Executes the logic for `extensionForImageMimeType`.
- **`readClipboardImage`**: `export async function readClipboardImage(options?:`
  - *Description*: Executes the logic for `readClipboardImage`.

#### Exported Types
- **`ClipboardImage`**: `{ 	bytes: Uint8Array; 	mimeType: string; }`
  - *Description*: Type alias for `ClipboardImage`.

### File: `packages/coding-agent/src/utils/clipboard-native.ts`

#### Exported Types
- **`ClipboardModule`**: `{ 	hasImage: () => boolean; 	getImageBinary: () => Promise<Array<number>>; }`
  - *Description*: Type alias for `ClipboardModule`.

### File: `packages/coding-agent/src/utils/clipboard.ts`

#### Exported Functions
- **`copyToClipboard`**: `export function copyToClipboard(text: string): void`
  - *Description*: Executes the logic for `copyToClipboard`.

### File: `packages/coding-agent/src/utils/frontmatter.ts`

#### Exported Functions
- **`parseFrontmatter`**: `parseFrontmatter: <T extends Record<string, unknown> = Record<string, unknown>>(content: string) => ParsedFrontmatter<T>`
  - *Description*: Parses input data to generate Frontmatter.
- **`stripFrontmatter`**: `stripFrontmatter: (content: string) => string`
  - *Description*: Executes the logic for `stripFrontmatter`.

### File: `packages/coding-agent/src/utils/git.ts`

#### Exported Functions
- **`parseGitUrl`**: `export function parseGitUrl(source: string): GitSource | null`
  - *Description*: Parse git source into a GitSource.  Rules: - With git: prefix, accept all historical shorthand forms. - Without git: prefix, only accept explicit protocol URLs.

#### Exported Types
- **`GitSource`**: `{ 	/** Always "git" for git sources */ 	type: "git"; 	/** Clone URL (always valid for git clone, without ref suffix) */ 	repo: string; 	/** Git host domain (e.g., "github.com") */ 	host: string; 	/** ...`
  - *Description*: Parsed git URL information.

### File: `packages/coding-agent/src/utils/image-convert.ts`

#### Exported Functions
- **`convertToPng`**: `export async function convertToPng( 	base64Data: string, 	mimeType: string, ): Promise<`
  - *Description*: Convert image to PNG format for terminal display. Kitty graphics protocol requires PNG format (f=100).

### File: `packages/coding-agent/src/utils/image-resize.ts`

#### Exported Functions
- **`resizeImage`**: `export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage>`
  - *Description*: Resize an image to fit within the specified max dimensions and file size. Returns the original image if it already fits within the limits.  Uses Photon (Rust/WASM) for image processing. If Photon is not available, returns the original image unchanged.  Strategy for staying under maxBytes: 1. First resize to maxWidth/maxHeight 2. Try both PNG and JPEG formats, pick the smaller one 3. If still too large, try JPEG with decreasing quality 4. If still too large, progressively reduce dimensions
- **`formatDimensionNote`**: `export function formatDimensionNote(result: ResizedImage): string | undefined`
  - *Description*: Format a dimension note for resized images. This helps the model understand the coordinate mapping.

#### Exported Interfaces
- **`ImageResizeOptions`**
  - *Description*: Configuration options for `ImageResize`.
  - `maxWidth?: number`
  - `maxHeight?: number`
  - `maxBytes?: number`
  - `jpegQuality?: number`
- **`ResizedImage`**
  - *Description*: Data structure or object model representing `ResizedImage`.
  - `data: string`
  - `mimeType: string`
  - `originalWidth: number`
  - `originalHeight: number`
  - `width: number`
  - `height: number`
  - `wasResized: boolean`

### File: `packages/coding-agent/src/utils/mime.ts`

#### Exported Functions
- **`detectSupportedImageMimeTypeFromFile`**: `export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null>`
  - *Description*: Executes the logic for `detectSupportedImageMimeTypeFromFile`.

### File: `packages/coding-agent/src/utils/photon.ts`

#### Exported Functions
- **`loadPhoton`**: `export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null>`
  - *Description*: Load the photon module asynchronously. Returns cached module on subsequent calls.

### File: `packages/coding-agent/src/utils/shell.ts`

#### Exported Functions
- **`getShellConfig`**: `export function getShellConfig():`
  - *Description*: Get shell configuration based on platform. Resolution order: 1. User-specified shellPath in settings.json 2. On Windows: Git Bash in known locations, then bash on PATH 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
- **`getShellEnv`**: `export function getShellEnv(): NodeJS.ProcessEnv`
  - *Description*: Retrieves or computes ShellEnv.
- **`sanitizeBinaryOutput`**: `export function sanitizeBinaryOutput(str: string): string`
  - *Description*: Sanitize binary output for display/storage. Removes characters that crash string-width or cause display issues: - Control characters (except tab, newline, carriage return) - Lone surrogates - Unicode Format characters (crash string-width due to a bug) - Characters with undefined code points
- **`killProcessTree`**: `export function killProcessTree(pid: number): void`
  - *Description*: Kill a process and all its children (cross-platform)

### File: `packages/coding-agent/src/utils/sleep.ts`

#### Exported Functions
- **`sleep`**: `export function sleep(ms: number, signal?: AbortSignal): Promise<void>`
  - *Description*: Sleep helper that respects abort signal.

### File: `packages/coding-agent/src/utils/tools-manager.ts`

#### Exported Functions
- **`getToolPath`**: `export function getToolPath(tool: "fd" | "rg"): string | null`
  - *Description*: Retrieves or computes ToolPath.
- **`ensureTool`**: `export async function ensureTool(tool: "fd" | "rg", silent: boolean = false): Promise<string | undefined>`
  - *Description*: Executes the logic for `ensureTool`.

## Package: `@mariozechner/pi-tui`

### File: `packages/tui/src/autocomplete.ts`

#### Exported Interfaces
- **`AutocompleteItem`**
  - *Description*: Data structure or object model representing `AutocompleteItem`.
  - `value: string`
  - `label: string`
  - `description?: string`
- **`SlashCommand`**
  - *Description*: Data structure or object model representing `SlashCommand`.
  - `name: string`
  - `description?: string`
- **`AutocompleteProvider`**
  - *Description*: Defines a provider implementation for `Autocomplete`.

#### Exported Classes
- **`CombinedAutocompleteProvider`**
  - *Description*: Defines a provider implementation for `CombinedAutocomplete`.
  - `getSuggestions( 		lines: string[], 		cursorLine: number, 		cursorCol: number, 	):`
  - `applyCompletion( 		lines: string[], 		cursorLine: number, 		cursorCol: number, 		item: AutocompleteItem, 		prefix: string, 	):`
  - `getForceFileSuggestions( 		lines: string[], 		cursorLine: number, 		cursorCol: number, 	):`
  - `shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean`

### File: `packages/tui/src/components/box.ts`

#### Exported Classes
- **`Box`**
  - *Description*: Box component - a container that applies padding and background to all children
  - `addChild(component: Component): void`
  - `removeChild(component: Component): void`
  - `clear(): void`
  - `setBgFn(bgFn?: (text: string) => string): void`
  - `invalidate(): void`
  - `render(width: number): string[]`

### File: `packages/tui/src/components/cancellable-loader.ts`

#### Exported Classes
- **`CancellableLoader`**
  - *Description*: Loader that can be cancelled with Escape. Extends Loader with an AbortSignal for cancelling async operations.  @example const loader = new CancellableLoader(tui, cyan, dim, "Working..."); loader.onAbort = () => done(null); doWork(loader.signal).then(done);
  - `handleInput(data: string): void`
  - `dispose(): void`

### File: `packages/tui/src/components/editor.ts`

#### Exported Functions
- **`wordWrapLine`**: `export function wordWrapLine(line: string, maxWidth: number): TextChunk[]`
  - *Description*: Split a line into word-wrapped chunks. Wraps at word boundaries when possible, falling back to character-level wrapping for words longer than the available width.  @param line - The text line to wrap @param maxWidth - Maximum visible width per chunk @returns Array of chunks with text and position information

#### Exported Interfaces
- **`TextChunk`**
  - *Description*: Represents a chunk of text for word-wrap layout. Tracks both the text content and its position in the original line.
  - `text: string`
  - `startIndex: number`
  - `endIndex: number`
- **`EditorTheme`**
  - *Description*: Data structure or object model representing `EditorTheme`.
  - `borderColor: (str: string) => string`
  - `selectList: import("c:/Works/GitWorks/pi-mono/packages/tui/src/components/select-list").SelectListTheme`
- **`EditorOptions`**
  - *Description*: Configuration options for `Editor`.
  - `paddingX?: number`
  - `autocompleteMaxVisible?: number`

#### Exported Classes
- **`Editor`**
  - *Description*: Data structure or object model representing `Editor`.
  - `getPaddingX(): number`
  - `setPaddingX(padding: number): void`
  - `getAutocompleteMaxVisible(): number`
  - `setAutocompleteMaxVisible(maxVisible: number): void`
  - `setAutocompleteProvider(provider: AutocompleteProvider): void`
  - `addToHistory(text: string): void`
  - `invalidate(): void`
  - `render(width: number): string[]`
  - `handleInput(data: string): void`
  - `getText(): string`
  - `getExpandedText(): string`
  - `getLines(): string[]`
  - `getCursor():`
  - `setText(text: string): void`
  - `insertTextAtCursor(text: string): void`
  - `public isShowingAutocomplete(): boolean`

### File: `packages/tui/src/components/image.ts`

#### Exported Interfaces
- **`ImageTheme`**
  - *Description*: Data structure or object model representing `ImageTheme`.
  - `fallbackColor: (str: string) => string`
- **`ImageOptions`**
  - *Description*: Configuration options for `Image`.
  - `maxWidthCells?: number`
  - `maxHeightCells?: number`
  - `filename?: string`
  - `imageId?: number`

#### Exported Classes
- **`Image`**
  - *Description*: Data structure or object model representing `Image`.
  - `getImageId(): number | undefined`
  - `invalidate(): void`
  - `render(width: number): string[]`

### File: `packages/tui/src/components/input.ts`

#### Exported Classes
- **`Input`**
  - *Description*: Input component - single-line text input with horizontal scrolling
  - `getValue(): string`
  - `setValue(value: string): void`
  - `handleInput(data: string): void`
  - `invalidate(): void`
  - `render(width: number): string[]`

### File: `packages/tui/src/components/loader.ts`

#### Exported Classes
- **`Loader`**
  - *Description*: Loader component that updates every 80ms with spinning animation
  - `render(width: number): string[]`
  - `start()`
  - `stop()`
  - `setMessage(message: string)`

### File: `packages/tui/src/components/markdown.ts`

#### Exported Interfaces
- **`DefaultTextStyle`**
  - *Description*: Default text styling for markdown content. Applied to all text unless overridden by markdown formatting.
  - `color?: (text: string) => string`
  - `bgColor?: (text: string) => string`
  - `bold?: boolean`
  - `italic?: boolean`
  - `strikethrough?: boolean`
  - `underline?: boolean`
- **`MarkdownTheme`**
  - *Description*: Theme functions for markdown elements. Each function takes text and returns styled text with ANSI codes.
  - `heading: (text: string) => string`
  - `link: (text: string) => string`
  - `linkUrl: (text: string) => string`
  - `code: (text: string) => string`
  - `codeBlock: (text: string) => string`
  - `codeBlockBorder: (text: string) => string`
  - `quote: (text: string) => string`
  - `quoteBorder: (text: string) => string`
  - `hr: (text: string) => string`
  - `listBullet: (text: string) => string`
  - `bold: (text: string) => string`
  - `italic: (text: string) => string`
  - `strikethrough: (text: string) => string`
  - `underline: (text: string) => string`
  - `highlightCode?: (code: string, lang?: string) => string[]`
  - `codeBlockIndent?: string`

#### Exported Classes
- **`Markdown`**
  - *Description*: Data structure or object model representing `Markdown`.
  - `setText(text: string): void`
  - `invalidate(): void`
  - `render(width: number): string[]`

### File: `packages/tui/src/components/select-list.ts`

#### Exported Interfaces
- **`SelectItem`**
  - *Description*: Data structure or object model representing `SelectItem`.
  - `value: string`
  - `label: string`
  - `description?: string`
- **`SelectListTheme`**
  - *Description*: Data structure or object model representing `SelectListTheme`.
  - `selectedPrefix: (text: string) => string`
  - `selectedText: (text: string) => string`
  - `description: (text: string) => string`
  - `scrollInfo: (text: string) => string`
  - `noMatch: (text: string) => string`

#### Exported Classes
- **`SelectList`**
  - *Description*: Data structure or object model representing `SelectList`.
  - `setFilter(filter: string): void`
  - `setSelectedIndex(index: number): void`
  - `invalidate(): void`
  - `render(width: number): string[]`
  - `handleInput(keyData: string): void`
  - `getSelectedItem(): SelectItem | null`

### File: `packages/tui/src/components/settings-list.ts`

#### Exported Interfaces
- **`SettingItem`**
  - *Description*: Data structure or object model representing `SettingItem`.
  - `id: string`
  - `label: string`
  - `description?: string`
  - `currentValue: string`
  - `values?: string[]`
  - `submenu?: (currentValue: string, done: (selectedValue?: string) => void) => import("c:/Works/GitWorks/pi-mono/packages/tui/src/tui").Component`
- **`SettingsListTheme`**
  - *Description*: Data structure or object model representing `SettingsListTheme`.
  - `label: (text: string, selected: boolean) => string`
  - `value: (text: string, selected: boolean) => string`
  - `description: (text: string) => string`
  - `cursor: string`
  - `hint: (text: string) => string`
- **`SettingsListOptions`**
  - *Description*: Configuration options for `SettingsList`.
  - `enableSearch?: boolean`

#### Exported Classes
- **`SettingsList`**
  - *Description*: Data structure or object model representing `SettingsList`.
  - `updateValue(id: string, newValue: string): void`
  - `invalidate(): void`
  - `render(width: number): string[]`
  - `handleInput(data: string): void`

### File: `packages/tui/src/components/spacer.ts`

#### Exported Classes
- **`Spacer`**
  - *Description*: Spacer component that renders empty lines
  - `setLines(lines: number): void`
  - `invalidate(): void`
  - `render(_width: number): string[]`

### File: `packages/tui/src/components/text.ts`

#### Exported Classes
- **`Text`**
  - *Description*: Text component - displays multi-line text with word wrapping
  - `setText(text: string): void`
  - `setCustomBgFn(customBgFn?: (text: string) => string): void`
  - `invalidate(): void`
  - `render(width: number): string[]`

### File: `packages/tui/src/components/truncated-text.ts`

#### Exported Classes
- **`TruncatedText`**
  - *Description*: Text component that truncates to fit viewport width
  - `invalidate(): void`
  - `render(width: number): string[]`

### File: `packages/tui/src/editor-component.ts`

#### Exported Interfaces
- **`EditorComponent`**
  - *Description*: Interface for custom editor components.  This allows extensions to provide their own editor implementation (e.g., vim mode, emacs mode, custom keybindings) while maintaining compatibility with the core application.
  - `onSubmit?: (text: string) => void`
  - `onChange?: (text: string) => void`
  - `borderColor?: (str: string) => string`

### File: `packages/tui/src/fuzzy.ts`

#### Exported Functions
- **`fuzzyMatch`**: `export function fuzzyMatch(query: string, text: string): FuzzyMatch`
  - *Description*: Executes the logic for `fuzzyMatch`.
- **`fuzzyFilter`**: `export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[]`
  - *Description*: Filter and sort items by fuzzy match quality (best matches first). Supports space-separated tokens: all tokens must match.

#### Exported Interfaces
- **`FuzzyMatch`**
  - *Description*: Fuzzy matching utilities. Matches if all query characters appear in order (not necessarily consecutive). Lower score = better match.
  - `matches: boolean`
  - `score: number`

### File: `packages/tui/src/keybindings.ts`

#### Exported Functions
- **`getEditorKeybindings`**: `export function getEditorKeybindings(): EditorKeybindingsManager`
  - *Description*: Retrieves or computes EditorKeybindings.
- **`setEditorKeybindings`**: `export function setEditorKeybindings(manager: EditorKeybindingsManager): void`
  - *Description*: Updates or assigns EditorKeybindings.

#### Exported Classes
- **`EditorKeybindingsManager`**
  - *Description*: Manages keybindings for the editor.
  - `matches(data: string, action: EditorAction): boolean`
  - `getKeys(action: EditorAction): KeyId[]`
  - `setConfig(config: EditorKeybindingsConfig): void`

#### Exported Types
- **`EditorAction`**: `| "cursorUp" 	| "cursorDown" 	| "cursorLeft" 	| "cursorRight" 	| "cursorWordLeft" 	| "cursorWordRight" 	| "cursorLineStart" 	| "cursorLineEnd" 	| "jumpForward" 	| "jumpBackward" 	| "pageUp"...`
  - *Description*: Editor actions that can be bound to keys.
- **`EditorKeybindingsConfig`**: `{ 	[K in EditorAction]?: KeyId | KeyId[]; }`
  - *Description*: Editor keybindings configuration.

### File: `packages/tui/src/keys.ts`

#### Exported Functions
- **`setKittyProtocolActive`**: `export function setKittyProtocolActive(active: boolean): void`
  - *Description*: Set the global Kitty keyboard protocol state. Called by ProcessTerminal after detecting protocol support.
- **`isKittyProtocolActive`**: `export function isKittyProtocolActive(): boolean`
  - *Description*: Query whether Kitty keyboard protocol is currently active.
- **`isKeyRelease`**: `export function isKeyRelease(data: string): boolean`
  - *Description*: Check if the last parsed key event was a key release. Only meaningful when Kitty keyboard protocol with flag 2 is active.
- **`isKeyRepeat`**: `export function isKeyRepeat(data: string): boolean`
  - *Description*: Check if the last parsed key event was a key repeat. Only meaningful when Kitty keyboard protocol with flag 2 is active.
- **`matchesKey`**: `export function matchesKey(data: string, keyId: KeyId): boolean`
  - *Description*: Match input data against a key identifier string.  Supported key identifiers: - Single keys: "escape", "tab", "enter", "backspace", "delete", "home", "end", "space" - Arrow keys: "up", "down", "left", "right" - Ctrl combinations: "ctrl+c", "ctrl+z", etc. - Shift combinations: "shift+tab", "shift+enter" - Alt combinations: "alt+enter", "alt+backspace" - Combined modifiers: "shift+ctrl+p", "ctrl+alt+x"  Use the Key helper for autocomplete: Key.ctrl("c"), Key.escape, Key.ctrlShift("p")  @param data - Raw input data from terminal @param keyId - Key identifier (e.g., "ctrl+c", "escape", Key.ctrl("c"))
- **`parseKey`**: `export function parseKey(data: string): string | undefined`
  - *Description*: Parse input data and return the key identifier if recognized.  @param data - Raw input data from terminal @returns Key identifier string (e.g., "ctrl+c") or undefined

#### Exported Types
- **`KeyId`**: `| BaseKey 	| `ctrl+${BaseKey}` 	| `shift+${BaseKey}` 	| `alt+${BaseKey}` 	| `ctrl+shift+${BaseKey}` 	| `shift+ctrl+${BaseKey}` 	| `ctrl+alt+${BaseKey}` 	| `alt+ctrl+${BaseKey}` 	| `shift+alt+$...`
  - *Description*: Union type of all valid key identifiers. Provides autocomplete and catches typos at compile time.
- **`KeyEventType`**: `"press" | "repeat" | "release"`
  - *Description*: Event types from Kitty keyboard protocol (flag 2) 1 = key press, 2 = key repeat, 3 = key release

### File: `packages/tui/src/kill-ring.ts`

#### Exported Classes
- **`KillRing`**
  - *Description*: Ring buffer for Emacs-style kill/yank operations.  Tracks killed (deleted) text entries. Consecutive kills can accumulate into a single entry. Supports yank (paste most recent) and yank-pop (cycle through older entries).
  - `push(text: string, opts:`
  - `peek(): string | undefined`
  - `rotate(): void`

### File: `packages/tui/src/stdin-buffer.ts`

#### Exported Classes
- **`StdinBuffer`**
  - *Description*: Buffers stdin input and emits complete sequences via the 'data' event. Handles partial escape sequences that arrive across multiple chunks.
  - `public process(data: string | Buffer): void`
  - `flush(): string[]`
  - `clear(): void`
  - `getBuffer(): string`
  - `destroy(): void`

#### Exported Types
- **`StdinBufferOptions`**: `{ 	/** 	 * Maximum time to wait for sequence completion (default: 10ms) 	 * After this time, the buffer is flushed even if incomplete 	 */ 	timeout?: number; }`
  - *Description*: Type alias for `StdinBufferOptions`.
- **`StdinBufferEventMap`**: `{ 	data: [string]; 	paste: [string]; }`
  - *Description*: Type alias for `StdinBufferEventMap`.

### File: `packages/tui/src/terminal-image.ts`

#### Exported Functions
- **`getCellDimensions`**: `export function getCellDimensions(): CellDimensions`
  - *Description*: Retrieves or computes CellDimensions.
- **`setCellDimensions`**: `export function setCellDimensions(dims: CellDimensions): void`
  - *Description*: Updates or assigns CellDimensions.
- **`detectCapabilities`**: `export function detectCapabilities(): TerminalCapabilities`
  - *Description*: Executes the logic for `detectCapabilities`.
- **`getCapabilities`**: `export function getCapabilities(): TerminalCapabilities`
  - *Description*: Retrieves or computes Capabilities.
- **`resetCapabilitiesCache`**: `export function resetCapabilitiesCache(): void`
  - *Description*: Executes the logic for `resetCapabilitiesCache`.
- **`isImageLine`**: `export function isImageLine(line: string): boolean`
  - *Description*: Checks if the condition 'isImageLine' is true.
- **`allocateImageId`**: `export function allocateImageId(): number`
  - *Description*: Generate a random image ID for Kitty graphics protocol. Uses random IDs to avoid collisions between different module instances (e.g., main app vs extensions).
- **`encodeKitty`**: `export function encodeKitty( 	base64Data: string, 	options:`
  - *Description*: Executes the logic for `encodeKitty`.
- **`deleteKittyImage`**: `export function deleteKittyImage(imageId: number): string`
  - *Description*: Delete a Kitty graphics image by ID. Uses uppercase 'I' to also free the image data.
- **`deleteAllKittyImages`**: `export function deleteAllKittyImages(): string`
  - *Description*: Delete all visible Kitty graphics images. Uses uppercase 'A' to also free the image data.
- **`encodeITerm2`**: `export function encodeITerm2( 	base64Data: string, 	options:`
  - *Description*: Executes the logic for `encodeITerm2`.
- **`calculateImageRows`**: `export function calculateImageRows( 	imageDimensions: ImageDimensions, 	targetWidthCells: number, 	cellDimensions: CellDimensions =`
  - *Description*: Executes the logic for `calculateImageRows`.
- **`getPngDimensions`**: `export function getPngDimensions(base64Data: string): ImageDimensions | null`
  - *Description*: Retrieves or computes PngDimensions.
- **`getJpegDimensions`**: `export function getJpegDimensions(base64Data: string): ImageDimensions | null`
  - *Description*: Retrieves or computes JpegDimensions.
- **`getGifDimensions`**: `export function getGifDimensions(base64Data: string): ImageDimensions | null`
  - *Description*: Retrieves or computes GifDimensions.
- **`getWebpDimensions`**: `export function getWebpDimensions(base64Data: string): ImageDimensions | null`
  - *Description*: Retrieves or computes WebpDimensions.
- **`getImageDimensions`**: `export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null`
  - *Description*: Retrieves or computes ImageDimensions.
- **`renderImage`**: `export function renderImage( 	base64Data: string, 	imageDimensions: ImageDimensions, 	options: ImageRenderOptions =`
  - *Description*: Executes the logic for `renderImage`.
- **`imageFallback`**: `export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string`
  - *Description*: Executes the logic for `imageFallback`.

#### Exported Interfaces
- **`TerminalCapabilities`**
  - *Description*: Data structure or object model representing `TerminalCapabilities`.
  - `images: import("c:/Works/GitWorks/pi-mono/packages/tui/src/terminal-image").ImageProtocol`
  - `trueColor: boolean`
  - `hyperlinks: boolean`
- **`CellDimensions`**
  - *Description*: Data structure or object model representing `CellDimensions`.
  - `widthPx: number`
  - `heightPx: number`
- **`ImageDimensions`**
  - *Description*: Data structure or object model representing `ImageDimensions`.
  - `widthPx: number`
  - `heightPx: number`
- **`ImageRenderOptions`**
  - *Description*: Configuration options for `ImageRender`.
  - `maxWidthCells?: number`
  - `maxHeightCells?: number`
  - `preserveAspectRatio?: boolean`
  - `imageId?: number`

#### Exported Types
- **`ImageProtocol`**: `"kitty" | "iterm2" | null`
  - *Description*: Type alias for `ImageProtocol`.

### File: `packages/tui/src/terminal.ts`

#### Exported Interfaces
- **`Terminal`**
  - *Description*: Minimal terminal interface for TUI

#### Exported Classes
- **`ProcessTerminal`**
  - *Description*: Real terminal using process.stdin/stdout
  - `start(onInput: (data: string) => void, onResize: () => void): void`
  - `async drainInput(maxMs = 1000, idleMs = 50): Promise<void>`
  - `stop(): void`
  - `write(data: string): void`
  - `moveBy(lines: number): void`
  - `hideCursor(): void`
  - `showCursor(): void`
  - `clearLine(): void`
  - `clearFromCursor(): void`
  - `clearScreen(): void`
  - `setTitle(title: string): void`

### File: `packages/tui/src/tui.ts`

#### Exported Functions
- **`isFocusable`**: `export function isFocusable(component: Component | null): component is Component & Focusable`
  - *Description*: Type guard to check if a component implements Focusable

#### Exported Interfaces
- **`Component`**
  - *Description*: Component interface - all components must implement this
  - `wantsKeyRelease?: boolean`
- **`Focusable`**
  - *Description*: Interface for components that can receive focus and display a hardware cursor. When focused, the component should emit CURSOR_MARKER at the cursor position in its render output. TUI will find this marker and position the hardware cursor there for proper IME candidate window positioning.
  - `focused: boolean`
- **`OverlayMargin`**
  - *Description*: Margin configuration for overlays
  - `top?: number`
  - `right?: number`
  - `bottom?: number`
  - `left?: number`
- **`OverlayOptions`**
  - *Description*: Options for overlay positioning and sizing. Values can be absolute numbers or percentage strings (e.g., "50%").
  - `width?: import("c:/Works/GitWorks/pi-mono/packages/tui/src/tui").SizeValue`
  - `minWidth?: number`
  - `maxHeight?: import("c:/Works/GitWorks/pi-mono/packages/tui/src/tui").SizeValue`
  - `anchor?: import("c:/Works/GitWorks/pi-mono/packages/tui/src/tui").OverlayAnchor`
  - `offsetX?: number`
  - `offsetY?: number`
  - `row?: import("c:/Works/GitWorks/pi-mono/packages/tui/src/tui").SizeValue`
  - `col?: import("c:/Works/GitWorks/pi-mono/packages/tui/src/tui").SizeValue`
  - `margin?: number | import("c:/Works/GitWorks/pi-mono/packages/tui/src/tui").OverlayMargin`
  - `visible?: (termWidth: number, termHeight: number) => boolean`
- **`OverlayHandle`**
  - *Description*: Handle returned by showOverlay for controlling the overlay

#### Exported Classes
- **`Container`**
  - *Description*: Container - a component that contains other components
  - `addChild(component: Component): void`
  - `removeChild(component: Component): void`
  - `clear(): void`
  - `invalidate(): void`
  - `render(width: number): string[]`
- **`TUI`**
  - *Description*: TUI - Main class for managing terminal UI with differential rendering
  - `getShowHardwareCursor(): boolean`
  - `setShowHardwareCursor(enabled: boolean): void`
  - `getClearOnShrink(): boolean`
  - `setClearOnShrink(enabled: boolean): void`
  - `setFocus(component: Component | null): void`
  - `showOverlay(component: Component, options?: OverlayOptions): OverlayHandle`
  - `hideOverlay(): void`
  - `hasOverlay(): boolean`
  - `override invalidate(): void`
  - `start(): void`
  - `addInputListener(listener: InputListener): () => void`
  - `removeInputListener(listener: InputListener): void`
  - `stop(): void`
  - `requestRender(force = false): void`

#### Exported Types
- **`OverlayAnchor`**: `| "center" 	| "top-left" 	| "top-right" 	| "bottom-left" 	| "bottom-right" 	| "top-center" 	| "bottom-center" 	| "left-center" 	| "right-center"`
  - *Description*: Anchor position for overlays
- **`SizeValue`**: `number | `${number}%``
  - *Description*: Value that can be absolute (number) or percentage (string like "50%")

### File: `packages/tui/src/undo-stack.ts`

#### Exported Classes
- **`UndoStack`**
  - *Description*: Generic undo stack with clone-on-push semantics.  Stores deep clones of state snapshots. Popped snapshots are returned directly (no re-cloning) since they are already detached.
  - `push(state: S): void`
  - `pop(): S | undefined`
  - `clear(): void`

### File: `packages/tui/src/utils.ts`

#### Exported Functions
- **`getSegmenter`**: `export function getSegmenter(): Intl.Segmenter`
  - *Description*: Get the shared grapheme segmenter instance.
- **`visibleWidth`**: `export function visibleWidth(str: string): number`
  - *Description*: Calculate the visible width of a string in terminal columns.
- **`extractAnsiCode`**: `export function extractAnsiCode(str: string, pos: number):`
  - *Description*: Extract ANSI escape sequences from a string at the given position.
- **`wrapTextWithAnsi`**: `export function wrapTextWithAnsi(text: string, width: number): string[]`
  - *Description*: Wrap text with ANSI codes preserved.  ONLY does word wrapping - NO padding, NO background colors. Returns lines where each line is <= width visible chars. Active ANSI codes are preserved across line breaks.  @param text - Text to wrap (may contain ANSI codes and newlines) @param width - Maximum visible width per line @returns Array of wrapped lines (NOT padded to width)
- **`isWhitespaceChar`**: `export function isWhitespaceChar(char: string): boolean`
  - *Description*: Check if a character is whitespace.
- **`isPunctuationChar`**: `export function isPunctuationChar(char: string): boolean`
  - *Description*: Check if a character is punctuation.
- **`applyBackgroundToLine`**: `export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string`
  - *Description*: Apply background color to a line, padding to full width.  @param line - Line of text (may contain ANSI codes) @param width - Total width to pad to @param bgFn - Background color function @returns Line with background applied and padded to width
- **`truncateToWidth`**: `export function truncateToWidth( 	text: string, 	maxWidth: number, 	ellipsis: string = "...", 	pad: boolean = false, ): string`
  - *Description*: Truncate text to fit within a maximum visible width, adding ellipsis if needed. Optionally pad with spaces to reach exactly maxWidth. Properly handles ANSI escape codes (they don't count toward width).  @param text - Text to truncate (may contain ANSI codes) @param maxWidth - Maximum visible width @param ellipsis - Ellipsis string to append when truncating (default: "...") @param pad - If true, pad result with spaces to exactly maxWidth (default: false) @returns Truncated text, optionally padded to exactly maxWidth
- **`sliceByColumn`**: `export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string`
  - *Description*: Extract a range of visible columns from a line. Handles ANSI codes and wide chars. @param strict - If true, exclude wide chars at boundary that would extend past the range
- **`sliceWithWidth`**: `export function sliceWithWidth( 	line: string, 	startCol: number, 	length: number, 	strict = false, ):`
  - *Description*: Like sliceByColumn but also returns the actual visible width of the result.
- **`extractSegments`**: `export function extractSegments( 	line: string, 	beforeEnd: number, 	afterStart: number, 	afterLen: number, 	strictAfter = false, ):`
  - *Description*: Extract "before" and "after" segments from a line in a single pass. Used for overlay compositing where we need content before and after the overlay region. Preserves styling from before the overlay that should affect content after it.

