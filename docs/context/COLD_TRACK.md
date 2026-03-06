# 冷轨归档

_创建时间: 2026-03-06_

---

## 墓碑区

### T01: 在 /compact 后直接调用 clearHistory()

- **失败原因**: clearHistory 的实现会清空 context.messages，导致后续 saveSession 保存的是空数组
- **放弃日期**: 2026-03-06
- **尝试过程**:
  1. 用户报告：compact 后关闭并重启 kodax -c，历史内容全部恢复，摘要没有保存
  2. AI 分析发现问题：/compact 只更新了内存中的 messages，但没有调用 saveSession
  3. AI 添加了 saveSession 调用，但位置在 clearHistory 之后
  4. 另一个 AI review 发现：clearHistory 会清空 context.messages，导致保存的是空数组
  5. 这是一个完全无效的修复

### T02: 最初只添加 saveSession 调用

- **失败原因**: 没有意识到 clearHistory 会清空 messages，导致修复完全无效
- **放弃日期**: 2026-03-06
- **尝试过程**:
  1. AI 在 /compact 命令中添加了 `await callbacks.saveSession()`
  2. 但这行代码在 `callbacks.clearHistory?.()` 之后
  3. clearHistory 会清空 context.messages
  4. 所以 saveSession 保存的是空数组
  5. 正确的做法是：先分离 UI 清空和 messages 清空的职责

---

## 历史记录区

### Session: 2026-03-06

#### Turn 1 - 19:46
**User**: 请你分析一下，compact后，关闭kodax，再打开kodax -c时的现象，我发现历史内容全都在。compact的摘要没有替代老的内容。这个部分我觉得有些问题。

**Assistant**: 我来分析这个问题。让我检查会话持久化相关的代码。
- 搜索 session save/load 相关代码
- 发现 `/compact` 命令只更新了 `context.messages`，但没有调用 `saveSession()`
- 正常对话流程会调用 `storage.save()` 持久化消息
- 但 `/compact` 命令缺少这一步

**Tools**: Grep, Read

#### Turn 2 - 19:48
**User**: 以下是别的AI review你改动效果的结论，请你仔细看下他说的对不对：
[review 内容指出 clearHistory 会清空 messages，导致修复无效]

**Assistant**: 你说得**完全正确**！这是一个严重的 Bug，我的修复完全无效！

问题流程：
1. context.messages = result.messages  ✅
2. clearHistory() → context.messages = []  ❌
3. saveSession() → 保存空数组  ❌

正确修复方案：
- 修改 clearHistory，只清空 UI，不清空 messages
- 修改 /clear 命令，显式清空 messages
- 确保 /compact 的 saveSession 保存压缩后的消息

**Tools**: Grep, Edit, Bash

#### Turn 3 - 19:50
**User**: /context-snapshot

**Assistant**: 执行上下文快照生成
- 创建 docs/context 目录
- 生成热轨快照：项目状态、接口骨架、避坑墓碑、关键决策
- 生成冷轨归档：详细的历史记录和失败过程

**Tools**: Bash, Write

---

## 技术细节

### clearHistory 的错误实现（修复前）

```typescript
clearHistory: () => {
  context.messages = [];  // ❌ 错误地清空 messages
  clearUIHistory();
  console.log(chalk.dim("[Conversation cleared]"));
},
```

### clearHistory 的正确实现（修复后）

```typescript
clearHistory: () => {
  // Only clear UI history, not context.messages
  // context.messages should only be cleared by specific commands like /clear
  clearUIHistory();
},
```

### /clear 命令的正确实现（修复后）

```typescript
handler: async (_args, context, callbacks) => {
  context.messages = [];  // Clear messages first
  callbacks.clearHistory();  // Then clear UI
  console.log(chalk.yellow('\n[Conversation cleared]'));
},
```

### /compact 命令的正确流程（修复后）

```typescript
// Update context with compacted messages
context.messages = result.messages;

// Clear UI history - it will be re-created from the new context.messages
callbacks.clearHistory?.();

// Save compacted messages to session storage
await callbacks.saveSession();

// Display statistics
```

---

## 经验教训

1. **回调函数可能有副作用**：不能假设 clearHistory 只清空 UI，它可能修改共享状态
2. **测试完整流程**：不仅要测试 UI 显示，还要测试持久化和重启后的状态
3. **代码审查很重要**：另一个 AI 的 review 发现了严重的 Bug
4. **分离职责**：UI 清空和数据清空应该是独立的操作
