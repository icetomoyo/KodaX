# Custom Providers

Point KodaX at any OpenAI-compatible or Anthropic-compatible endpoint.

## Basic custom provider

Define a custom provider in `~/.kodax/config.json`:

```json
{
  "provider": "my-openai-compatible",
  "customProviders": [
    {
      "name": "my-openai-compatible",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "model": "my-model",
      "userAgentMode": "compat",
      "reasoning": {
        "efforts": ["off", "low", "medium", "high", "max"],
        "default": "high"
      }
    }
  ]
}
```

`"apiKeyEnv": "MY_LLM_API_KEY"` is a reference to an environment-variable name,
not an API key value. Put the custom provider's actual API key in the
`MY_LLM_API_KEY` environment variable, then close the current terminal and open
a new one before running `kodax`.

## Native Responses API

For an endpoint that implements OpenAI Responses, add `"api": "responses"` to
an OpenAI custom provider. Keep `baseUrl` at the API root, such as
`https://api.openai.com/v1`, and select a model available to your account.
Omitting `api` (or setting `"chat-completions"`) preserves Chat Completions.
The built-in `openai` provider remains unchanged.

```json
{
  "provider": "my-responses",
  "customProviders": [{
    "name": "my-responses",
    "protocol": "openai",
    "api": "responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "your-responses-model"
  }]
}
```

Use the same object with `registerCustomProviders()` or `createCustomProvider()`
from `@kodax-ai/kodax/llm` (or the standalone LLM package). Set `imageInput: true`
only for image-capable models. Declare supported reasoning efforts/defaults when
known; Responses leaves the effort unspecified when neither the caller nor a
declared default selects it. `maxOutputTokens` remains the default request budget;
`outputTokenLimit` is an optional service ceiling. `promptCacheAffinity: true`
enables the existing request `promptCacheKey` option.

Both `stream()` and `complete()` use native Responses with `store:false`.
Preserve `result.contentBlocks` in the next assistant message to retain the
original text/reasoning/tool order. The existing text/thinking/tool arrays remain
available as compatibility projections. Encrypted reasoning is replayed only to
the originating provider/API/endpoint/wire model. Incomplete or malformed tool
arguments never become executable calls. Interrupted streams retain the existing
Host recovery and non-streaming fallback; declared incomplete responses surface
their failure without executing tools.

Each request uses its current tool definitions, including additions, removals and
schema changes. Completed historical calls/results keep their original names and
arguments. A `forcedToolName` absent from the current definitions is rejected
locally. Interrupted imported calls receive an explicit interrupted-result marker;
orphan results are omitted. History projection never re-executes a tool.

When changing models or endpoints, retain the original history. Known foreign
signed/encrypted reasoning is omitted from the native reasoning channel; readable
reasoning is preserved as prior-context text. New Anthropic reasoning records its
source too, so switching back can reuse the original signed history. Legacy
history without provenance retains its prior signature policy.

Responses negotiates declared effort levels after explicit parameter rejection.
Hard-rejection learning is scoped to the endpoint, API, model, declaration and
credential identity. It does not rewrite your configured effort or mark an
accepted level as verified. Old unscoped rejection records do not narrow Responses
choices. Cache affinity and `disablePromptCache` are evaluated on each request.

This slice supports client-defined function tools, text, image input, reasoning
replay and usage. Server-side tools, background tasks, WebSocket, OAuth and broader
cross-protocol history transformations remain later parity work. Validation is
offline contract testing; no live Responses account test is claimed.

## User-Agent mode

`userAgentMode` defaults to `"compat"`, which sends `KodaX` instead of the
official SDK User-Agent. Switch it to `"sdk"` only when your gateway expects the
upstream SDK header.

## Reasoning configuration

For custom reasoning models, `reasoning: { efforts, default }` is the preferred
shape; use `"reasoning": "none"` for models without thinking capability.

SDK hosts should render effort pickers from `reasoningProfile.supportedEfforts`
/ `defaultEffort` rather than assuming a fixed five-option ladder.

## OpenAI-compatible reasoning providers

Some OpenAI-compatible reasoning models require KodaX to replay the previous
assistant turn's `reasoning_content` on later requests. DeepSeek V4 thinking
mode is the known load-bearing case. Built-in DeepSeek already opts in; custom
providers must say so explicitly:

```json
{
  "customProviders": [
    {
      "name": "my-deepseek-v4",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_DEEPSEEK_API_KEY",
      "model": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    }
  ]
}
```

DeepSeek Chat Completions uses `max_tokens`; OpenAI proper defaults to
`max_completion_tokens`. Keep `replayReasoningContent` unset or `false` for
OpenAI proper and gateways that reject unknown assistant-message fields.

### Per-model overrides

If one gateway routes mixed models, prefer per-model overrides:

```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    },
    { "id": "gpt-5", "replayReasoningContent": false }
  ]
}
```

## Prompt cache affinity

If a custom endpoint is confirmed to support cache-affinity routing, set
`"promptCacheAffinity": true`. Anthropic-compatible requests then receive the
opaque logical-context key as `metadata.user_id`; OpenAI-compatible requests
receive `prompt_cache_key`. The default is `false` because some strict
compatible gateways reject unknown request fields.

## Vision / image input

If your custom provider's underlying model accepts image input (vision), set
`"imageInput": true` so KodaX's image routing and the provider-policy gate both
let image artifacts through:

```json
{
  "customProviders": [
    {
      "name": "my-vllm",
      "protocol": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "MY_VLLM_API_KEY",
      "model": "Qwen/Qwen3.8-27B-Instruct",
      "imageInput": true
    }
  ]
}
```

This is the typical shape for self-hosted multimodal models served by vLLM or
SGLang behind an OpenAI-compatible endpoint (Qwen-VL-style models). Images are
sent as standard `image_url` blocks, which those servers consume directly.

`imageInput: true` forces `capabilityProfile.multimodalSupport: "image-input"`
on every KodaX surface (provider instance, capability queries, policy gates),
overriding an explicit `"none"`. An advanced alternative is writing
`capabilityProfile` by hand with `"multimodalSupport": "image-input"` —
it works too, but `imageInput` is the one-field version:

```json
{
  "name": "my-vision-provider",
  "protocol": "openai",
  "baseUrl": "https://example.com/v1",
  "apiKeyEnv": "MY_LLM_API_KEY",
  "model": "my-vision-model",
  "capabilityProfile": {
    "transport": "native-api",
    "conversationSemantics": "full-history",
    "mcpSupport": "none",
    "multimodalSupport": "image-input"
  }
}
```

Leave `imageInput` unset for text-only models — image artifacts are then
rejected with `MODEL_INPUT_UNSUPPORTED` before the request is sent.

Built-in vision-capable aliases (Anthropic, OpenAI, Kimi, Qwen, Zhipu, MiniMax,
MiMo, Ark, plus Gemini-CLI) already ship with image input enabled. On the
built-in `deepseek` alias the default `deepseek-flash` (DeepSeek-V4.1-Flash)
takes images natively; the legacy `deepseek-v4-pro` id and Codex-CLI are
text-only; custom providers need to opt in.

## See also

- [Providers](./providers.md) — Built-in provider aliases
- [Configuration files](./config-files.md) — Full config.json reference
