# @kodax/coding

KodaX Coding Agent - 完整的 Coding Agent 实现，包含工具和 Prompts。

## 概述

`@kodax/coding` 是 KodaX 的核心 Coding Agent，提供：
- 完整的 Agent 主循环
- 8 个内置工具
- 系统提示词
- KodaXClient 客户端类

## 安装

```bash
npm install @kodax/coding
```

## 内置工具

| Tool | Description |
|------|-------------|
| read | 读取文件内容（支持 offset/limit） |
| write | 写入文件 |
| edit | 精确字符串替换（支持 replace_all） |
| bash | 执行 Shell 命令 |
| glob | 文件模式匹配 |
| grep | 内容搜索（支持 output_mode） |
| undo | 撤销最后修改 |
| diff | 比较文件或显示变更 |

## 使用示例

### 简单模式（runKodaX）

```typescript
import { runKodaX, KodaXEvents } from '@kodax/coding';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onToolResult: (result) => console.log(`[Tool] ${result.name}`),
  onComplete: () => console.log('\nDone!'),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  thinking: true,
  events,
}, '读取 package.json 并总结');

console.log(result.lastText);
```

### 连续会话（KodaXClient）

```typescript
import { KodaXClient } from '@kodax/coding';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  thinking: true,
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
});

// 第一次对话
await client.send('读取 package.json');

// 第二次对话 - 保持上下文
await client.send('作者是谁？');

// 获取会话信息
console.log('Session ID:', client.getSessionId());
console.log('Messages:', client.getMessages().length);
```

### 自定义工具

```typescript
import { registerTool, KodaXToolExecutionContext } from '@kodax/coding';

registerTool('my-tool', async (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext
) => {
  const filePath = input.path as string;

  // 实现工具逻辑
  const result = await doSomething(filePath);

  return result;
});
```

### 自定义会话存储

```typescript
import { runKodaX, KodaXSessionStorage, KodaXMessage } from '@kodax/coding';

class DatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // 保存到数据库
    await db.sessions.upsert({ id, ...data });
  }

  async load(id: string) {
    // 从数据库加载
    const session = await db.sessions.find(id);
    return session || null;
  }

  async list() {
    // 列出所有会话
    return await db.sessions.findAll();
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  session: {
    id: 'my-session',
    storage: new DatabaseStorage(),
  },
}, 'task');
```

## 权限模式

```typescript
import { runKodaX, PermissionMode } from '@kodax/coding';

// 计划模式（只读）
await runKodaX({
  provider: 'zhipu-coding',
  mode: 'plan',
}, '分析代码结构');

// 默认模式（安全）
await runKodaX({
  provider: 'zhipu-coding',
  mode: 'default',
}, '修改代码');

// 自动接受编辑
await runKodaX({
  provider: 'zhipu-coding',
  mode: 'accept-edits',
}, '重构代码');

// 项目内全自动
await runKodaX({
  provider: 'zhipu-coding',
  mode: 'auto-in-project',
}, '完成功能开发');
```

## API 导出

```typescript
// 主函数
export { runKodaX, KodaXClient };

// 工具
export { KODAX_TOOLS, KODAX_TOOL_REQUIRED_PARAMS, executeTool, registerTool };

// 类型
export type {
  KodaXOptions,
  KodaXResult,
  KodaXEvents,
  KodaXMessage,
  KodaXContentBlock,
  KodaXToolDefinition,
  KodaXSessionOptions,
  KodaXSessionStorage,
  KodaXToolExecutionContext,
  PermissionMode,
};

// 错误
export { KodaXError, KodaXToolError, KodaXProviderError };

// 工具函数
export {
  estimateTokens,
  compactMessages,
  getGitRoot,
  getGitContext,
  getEnvContext,
  getProjectSnapshot,
  checkPromiseSignal,
  checkAllFeaturesComplete,
  getFeatureProgress,
};
```

## 依赖

- `@kodax/ai` - LLM 抽象层
- `@kodax/agent` - Agent 框架
- `@kodax/skills` - Skills 系统

## License

MIT
