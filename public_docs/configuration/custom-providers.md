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
MiMo, Ark, plus Gemini-CLI) already ship with image input enabled. DeepSeek V4's
default models (`deepseek-v4-flash` / `deepseek-v4-pro`) and Codex-CLI are
text-only — on the built-in `deepseek` alias only `deepseek-v4-flash-vision-exp`
takes images; custom providers need to opt in.

## See also

- [Providers](./providers.md) — Built-in provider aliases
- [Configuration files](./config-files.md) — Full config.json reference
