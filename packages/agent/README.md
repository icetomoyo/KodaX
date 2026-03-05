# @kodax/agent

通用 Agent 框架，提供会话管理和消息处理能力。

## 概述

`@kodax/agent` 是 KodaX 的 Agent 框架层，提供：
- 会话管理
- 消息处理和压缩
- Token 估算

这个包依赖于 `@kodax/ai`，但不包含具体业务逻辑。

## 安装

```bash
npm install @kodax/agent
```

## 使用示例

### 会话管理

```typescript
import { SessionManager, KodaXMessage } from '@kodax/agent';

const sessionManager = new SessionManager({
  storageDir: './sessions',
});

// 创建新会话
const sessionId = await sessionManager.create();

// 添加消息
await sessionManager.addMessage(sessionId, {
  role: 'user',
  content: 'Hello!',
});

// 获取会话消息
const messages = await sessionManager.getMessages(sessionId);

// 保存会话
await sessionManager.save(sessionId);
```

### Token 估算

```typescript
import { estimateTokens, KodaXMessage } from '@kodax/agent';

const messages: KodaXMessage[] = [
  { role: 'user', content: 'Hello, world!' },
  { role: 'assistant', content: 'Hi there!' },
];

const tokenCount = estimateTokens(messages);
console.log(`Estimated tokens: ${tokenCount}`);
```

### 消息压缩

```typescript
import { compactMessages, KodaXMessage } from '@kodax/agent';

const messages: KodaXMessage[] = [
  // ... 大量消息
];

// 当消息过多时，压缩旧消息
const compacted = compactMessages(messages, {
  maxTokens: 100000,
  preserveRecent: 10,
});

console.log(`Compacted from ${messages.length} to ${compacted.length} messages`);
```

## API 导出

```typescript
// 会话管理
export { SessionManager, KodaXSessionStorage };

// 消息处理
export { compactMessages, extractTextContent };

// Token 估算
export { estimateTokens };

// 类型
export type {
  KodaXMessage,
  KodaXContentBlock,
  KodaXSessionOptions,
  KodaXSessionData,
};

// 常量
export { MAX_CONTEXT_TOKENS, DEFAULT_MAX_ITER };
```

## 依赖

- `@kodax/ai` - LLM 抽象层
- `js-tiktoken` - Token 计数

## License

MIT
