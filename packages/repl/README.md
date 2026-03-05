# @kodax/repl

KodaX REPL - 完整的交互式终端体验。

## 概述

`@kodax/repl` 是 KodaX 的交互式终端层，提供：
- 基于 Ink/React 的 UI 组件
- 权限控制
- 命令系统
- 主题系统

## 安装

```bash
npm install @kodax/repl
```

## 使用示例

### 启动 REPL

```typescript
import { runREPL, REPLOptions } from '@kodax/repl';

const options: REPLOptions = {
  provider: 'zhipu-coding',
  thinking: true,
  session: {
    resume: true,
  },
};

await runREPL(options);
```

### 自定义主题

```typescript
import { setTheme, getTheme, Theme } from '@kodax/repl';

// 使用内置主题
setTheme('warp');
setTheme('dark');

// 获取当前主题
const current = getTheme();
console.log(current.name);
```

### 权限控制

```typescript
import { PermissionController, PermissionMode } from '@kodax/repl';

const controller = new PermissionController();

// 获取当前模式
const mode = controller.getMode();

// 切换模式
controller.setMode('accept-edits');

// 检查工具是否需要确认
const needsConfirm = controller.needsConfirmation('write', { path: '/test.txt' });
```

## UI 组件

`@kodax/repl` 提供了多个可复用的 Ink 组件：

### MessageList

显示对话消息列表：

```tsx
import { MessageList } from '@kodax/repl';

<MessageList
  messages={messages}
  isLoading={isLoading}
  theme={theme}
/>
```

### TextInput

多行文本输入组件：

```tsx
import { TextInput } from '@kodax/repl';

<TextInput
  value={value}
  onChange={setValue}
  onSubmit={handleSubmit}
  placeholder="输入消息..."
  multiline={true}
/>
```

### StatusBar

状态栏组件：

```tsx
import { StatusBar } from '@kodax/repl';

<StatusBar
  provider="zhipu-coding"
  sessionId="20260304_001"
  mode="default"
  thinking={true}
/>
```

### LoadingIndicator

加载指示器：

```tsx
import { LoadingIndicator } from '@kodax/repl';

<LoadingIndicator
  type="thinking"
  message="思考中..."
/>
```

## 命令系统

REPL 支持内置命令和自定义命令：

```typescript
import { CommandRegistry, registerCommand } from '@kodax/repl';

// 注册自定义命令
registerCommand('my-cmd', {
  description: 'My custom command',
  handler: async (args, context) => {
    console.log('Executed my-cmd with args:', args);
    return { success: true };
  },
});

// 获取所有命令
const commands = CommandRegistry.getAll();
```

### 内置命令

| Command | Description |
|---------|-------------|
| `/help` | 显示帮助 |
| `/mode [mode]` | 切换权限模式 |
| `/theme [name]` | 切换主题 |
| `/clear` | 清空屏幕 |
| `/session [id]` | 会话管理 |
| `/exit` | 退出 REPL |

## API 导出

```typescript
// REPL 入口
export { runREPL, REPLOptions };

// UI 组件
export {
  MessageList,
  TextInput,
  StatusBar,
  LoadingIndicator,
  InputPrompt,
  ToolGroup,
  SuggestionsDisplay,
};

// 主题
export { setTheme, getTheme, themes, Theme };

// 权限
export { PermissionController, PermissionMode };

// 命令
export { CommandRegistry, registerCommand, Command };

// Hooks
export { useInputHistory, useKeypress, useTextBuffer };

// Contexts
export { StreamingContext, KeypressContext, UIStateContext };

// 类型
export type {
  REPLOptions,
  REPLContext,
  ThemeConfig,
  MessageBlock,
};
```

## 依赖

- `@kodax/coding` - Coding Agent
- `@kodax/skills` - Skills 系统
- `ink` - React 终端 UI
- `react` - React
- `chalk` - 终端颜色

## License

MIT
