# 自定义提供商

将 KodaX 接入任意 OpenAI 兼容或 Anthropic 兼容端点。

## 基本自定义提供商

在 `~/.kodax/config.json` 中定义自定义提供商：

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

`"apiKeyEnv": "MY_LLM_API_KEY"` 是对环境变量名称的引用，不是 API Key 本身。将实际 API Key 放到 `MY_LLM_API_KEY` 环境变量中，然后关闭当前终端，重新打开后再运行 `kodax`。

## 原生 Responses API

对于实现了 OpenAI Responses 的端点，在 OpenAI 自定义提供商中添加 `"api": "responses"`。`baseUrl` 保持在 API 根目录，例如 `https://api.openai.com/v1`，选择账号可用的模型。省略 `api`（或设为 `"chat-completions"`）则保持 Chat Completions 行为。内置 `openai` 提供商不受影响。

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

`stream()` 和 `complete()` 均使用 `store:false` 的原生 Responses。在下一条 assistant 消息中保留 `result.contentBlocks` 以保持原始 text/reasoning/tool 顺序。加密推理只回放给原始提供商/API/端点/wire 模型。

## User-Agent 模式

`userAgentMode` 默认为 `"compat"`，发送 `KodaX` 而非官方 SDK 的 User-Agent。仅在网关期望上游 SDK 头部时才切换为 `"sdk"`。

## 推理配置

对于自定义推理模型，`reasoning: { efforts, default }` 是推荐的配置方式；对无思考能力的模型使用 `"reasoning": "none"`。

SDK 宿主应从 `reasoningProfile.supportedEfforts` / `defaultEffort` 渲染强度选择器，而不是假设固定的五选项梯级。

## OpenAI 兼容推理提供商

某些 OpenAI 兼容推理模型需要 KodaX 在后续请求中回放上一条 assistant 消息的 `reasoning_content`。DeepSeek V4 思考模式是已知的关键场景。内置 DeepSeek 已默认启用；自定义提供商需要显式声明：

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

DeepSeek Chat Completions 使用 `max_tokens`；OpenAI 默认使用 `max_completion_tokens`。对于 OpenAI 本身及拒绝未知 assistant 消息字段的网关，保持 `replayReasoningContent` 未设置或为 `false`。

### 按模型覆盖

如果一个网关路由多个混合模型，优先使用按模型覆盖：

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

## 提示缓存亲和性

如果自定义端点确认支持缓存亲和路由，设置 `"promptCacheAffinity": true`。Anthropic 兼容请求将以 `metadata.user_id` 发送不透明的逻辑上下文 Key；OpenAI 兼容请求使用 `prompt_cache_key`。默认为 `false`，因为某些严格的兼容网关会拒绝未知请求字段。

## 视觉 / 图像输入

如果自定义提供商的底层模型支持图像输入，设置 `"imageInput": true`：

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

这是本地托管多模态模型（由 vLLM 或 SGLang 以 OpenAI 兼容端点提供服务的 Qwen-VL 类模型）的典型配置。图像以标准 `image_url` 块发送。

对于纯文本模型，保持 `imageInput` 未设置——图像 artifact 在请求发送前会以 `MODEL_INPUT_UNSUPPORTED` 被拒绝。

内置支持视觉的别名（Anthropic、OpenAI、Kimi、Qwen、Zhipu、MiniMax、MiMo、Ark 以及 Gemini-CLI）已默认启用图像输入。在内置 `deepseek` 别名上，默认 `deepseek-flash`（DeepSeek-V4.1-Flash）原生支持图像；旧版 `deepseek-v4-pro` 和 Codex-CLI 为纯文本；自定义提供商需要显式选择启用。

## 另见

- [提供商](./providers.zh-CN.md) — 内置提供商别名
- [配置文件](./config-files.zh-CN.md) — 完整 config.json 参考
