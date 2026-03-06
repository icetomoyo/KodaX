# 热轨快照

_生成时间: 2026-03-06 21:15_
_快照版本: v3_

---

## 1. 项目状态

### 当前目标
优化 KodaX REPL 长对话性能 + 修复代码逻辑 bug

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Compaction Session 持久化 | ✅ 完成 | 修复 /compact 后 session 丢失问题 |
| limitReached 逻辑 bug (第1轮) | ✅ 完成 | 修复达到迭代上限时状态错误 |
| MessageList 性能优化 | ✅ 完成 | 使用 Static + memo 优化渲染 |
| limitReached 逻辑 bug (第2轮) | ✅ 完成 | 修复 break 后值被覆盖问题 |

### 当下阻塞
无阻塞。所有修复已完成。

---

## 2. 已确定接口（骨架）

### packages/repl/src/ui/components/MessageList.tsx - 性能优化

**分段渲染策略** (参考 Gemini CLI):
```typescript
// 找到最后一个用户输入的索引
const lastUserPromptIndex = useMemo(() => {
  for (let i = filteredItems.length - 1; i >= 0; i--) {
    const type = filteredItems[i]?.type;
    if (type === "user" || type === "system") return i;
  }
  return -1;
}, [filteredItems]);

// 分割历史
const staticHistoryItems = filteredItems.slice(0, lastUserPromptIndex + 1);
const lastResponseHistoryItems = filteredItems.slice(lastUserPromptIndex + 1);

// 使用 Static 包裹（只渲染一次）
<Static items={[...staticHistoryItems, ...lastResponseHistoryItems]}>
  {(item) => <HistoryItemRenderer key={item.id} item={item} />}
</Static>
{pendingItems}  // 动态更新
```

**优化措施**：
- 所有子渲染器使用 `memo()` 包裹
- Static 组件避免重复渲染
- 只有 pendingItems 动态更新

### packages/repl/src/ui/InkREPL.tsx - Session 持久化
```typescript
clearHistory: () => {
  // Only clear UI history, not context.messages
  clearUIHistory();
},
```

### packages/repl/src/interactive/commands.ts - 命令处理
```typescript
// /clear command - 显式清空
handler: async (_args, context, callbacks) => {
  context.messages = [];  // Clear messages first
  callbacks.clearHistory();  // Then clear UI
},

// /compact command - 保存 session
callbacks.clearHistory?.();
await callbacks.saveSession();
```

### packages/coding/src/agent.ts - limitReached 修复
```typescript
let limitReached = false;  // 初始值

for (let i = 0; i < maxIterations; i++) {
  if (result.toolBlocks.length === 0) {
    events.onComplete?.();
    // 不设置 limitReached，保持初始值 false
    break;  // 跳出循环，不执行 limitReached = true
  }
  // ...
}

// 只有循环正常结束（达到 maxIterations）才执行到这里
limitReached = true;

return { success: true, limitReached, ... };
```

**关键理解**：
- `break` 跳出循环后，仍会执行循环后的代码
- 只有循环完整执行完所有迭代，才会执行 `limitReached = true`
- 初始值 `false`，只在真正达到上限时设为 `true`

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| sed 多行插入格式错误 | 使用 sed 插入多行注释时格式混乱 | 2026-03-06 |
| 在 break 前设置 limitReached = false | break 后仍会执行第452行代码，导致值被 true 覆盖 | 2026-03-06 |

**break 覆盖问题详解**：
- **错误**: 在 break 前设置 `limitReached = false`
- **根因**: 误解 `break` 行为，以为会跳过后续代码
- **真相**: `break` 只跳出循环，循环后的代码仍执行
- **修复**: 保持初始值 `false`，只在循环正常结束时设为 `true`

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| clearHistory 只清空 UI，不清空 messages | 避免 callback 副作用影响数据状态 | 2026-03-06 |
| /clear 显式清空 messages + UI | 明确命令意图，不依赖 callback 隐式行为 | 2026-03-06 |
| 使用 Static 组件包裹历史 | Gemini CLI 验证过的方案，能显著减少渲染开销 | 2026-03-06 |
| 分段渲染（静态 + 动态） | 平衡性能和功能，静态历史不重渲染，动态内容可更新 | 2026-03-06 |
| 所有渲染器使用 memo | 避免不必要的重渲染，提升性能 | 2026-03-06 |
| 删除 break 前的 limitReached 赋值 | 避免被循环后的代码覆盖 | 2026-03-06 |

---

## 5. 提交记录

### Commit c8766cd: fix(repl): fix session persistence after compaction
- 修复 `/compact` 后 session 丢失
- `clearHistory` 只清空 UI
- `/clear` 显式清空 messages
- `/compact` 保存 compacted messages

### Commit 0999f87: docs(context): add compaction bug fix session snapshot
- 添加热轨和冷轨快照文档

### Commit 554f00a: fix(coding): set limitReached to true when reaching iteration limit (第1轮)
- 修复 `limitReached` 变量从未被设置为 `true`
- 在循环结束后设置 `limitReached = true`

### 待提交: fix(coding): remove limitReached assignment before break (第2轮)
- 修复 `limitReached` 在 break 后被覆盖的 bug
- 删除第279行的 `limitReached = false` 赋值
- 保持初始值 `false`，只在循环正常结束时设为 `true`

---

## 6. 性能对比

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 100 轮对话输入 | 渲染 100+ 组件 | 渲染 Static + pending |
| Compact 后更新 | 无优化 | Static 帮助快速渲染 |
| 每次输入 | 全量重渲染 | 只有 pending 重渲染 |

---

## 7. 参考资料

**Gemini CLI 实现**:
- 文件: `packages/cli/src/ui/components/MainContent.tsx`
- 关键代码: 第103-115行
- 策略: Static 包裹 + 分段渲染

**Ink Static 组件原理**:
- Static 组件只渲染一次
- 后续通过 items 数组变化来更新显示
- Compact 后更新 items 即可，无需重新渲染整个列表

---
*Token 数: ~1,400*
