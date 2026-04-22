# @kodax/ai

独立的 LLM 抽象层，可被其他项目复用。

## 概述

`@kodax/ai` 是 KodaX 的基础层，提供统一的 LLM Provider 抽象。这个包完全独立，可以被其他项目直接使用。

## 安装

```bash
npm install @kodax/ai
```

## 支持的 Provider

| Provider | Environment Variable | Thinking | Default Model |
|----------|---------------------|----------|---------------|
| anthropic | `ANTHROPIC_API_KEY` | Yes | claude-sonnet-4-20250514 |
| openai | `OPENAI_API_KEY` | No | gpt-4o |
| kimi | `KIMI_API_KEY` | Yes | kimi-k2.6 |
| kimi-code | `KIMI_API_KEY` | Yes | K2.6 |
| qwen | `QWEN_API_KEY` | No | qwen-max |
| zhipu | `ZHIPU_API_KEY` | No | glm-4-plus |
| zhipu-coding | `ZHIPU_API_KEY` | Yes | glm-5 |

## 使用示例

### 基本使用

```typescript
import { getProvider, KodaXMessage, KodaXToolDefinition } from '@kodax/ai';

// 获取 Provider 实例
const provider = getProvider('zhipu-coding');

// 检查是否已配置
if (!provider.isConfigured()) {
  throw new Error('请设置 ZHIPU_API_KEY 环境变量');
}

// 流式调用
const messages: KodaXMessage[] = [
  { role: 'user', content: 'Hello, world!' }
];

const tools: KodaXToolDefinition[] = [];

const result = await provider.stream(
  messages,
  tools,
  'You are a helpful assistant.',
  true, // enable thinking
  {
    onTextDelta: (text) => process.stdout.write(text),
    onThinkingDelta: (text) => console.log('[Thinking]', text),
  }
);

console.log(result.text);
```

### 自定义 Provider

```typescript
import { KodaXBaseProvider, registerProvider, KodaXProviderConfig } from '@kodax/ai';

class MyProvider extends KodaXBaseProvider {
  readonly name = 'my-provider';
  readonly supportsThinking = false;

  protected config: KodaXProviderConfig = {
    apiKeyEnv: 'MY_API_KEY',
    model: 'my-model-1',
  };

  async stream(messages, tools, system, thinking, streamOptions) {
    // 实现你的流式调用逻辑
    const response = await fetch('https://api.my-provider.com/v1/chat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        model: this.config.model,
        stream: true,
      }),
    });

    // 处理流式响应...
    return {
      text: '...',
      textBlocks: [],
      thinkingBlocks: [],
      toolBlocks: [],
    };
  }
}

// 注册 Provider
registerProvider('my-provider', () => new MyProvider());
```

## API 导出

```typescript
// Provider 相关
export { getProvider, listProviders, registerProvider, KodaXBaseProvider };

// 类型
export type {
  KodaXMessage,
  KodaXContentBlock,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXStreamResult,
  KodaXProviderStreamOptions,
};

// 错误
export { KodaXProviderError, KodaXStreamError };

// 常量
export { KODAX_PROVIDERS };
```

## 依赖

- `@anthropic-ai/sdk` - Anthropic API SDK
- `openai` - OpenAI API SDK

## License

MIT
