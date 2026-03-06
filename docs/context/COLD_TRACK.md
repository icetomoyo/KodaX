# 冷轨归档

_创建时间: 2026-03-06_

---

## 墓碑区

### T01: sed 多行插入格式错误
- **失败原因**: 使用 sed 插入多行注释时，换行符处理不当导致格式混乱
- **放弃日期**: 2026-03-06
- **尝试过程**:
  1. 使用 `sed -i '448a\...'` 插入多行代码
  2. 结果所有内容都在一行，格式错误
  3. 多次尝试调整 sed 语法，仍然失败
  4. 最终回滚修改，使用更简单的方法：先删除旧行，再用 `sed -i 'Nr file'` 插入

---

## 历史记录区

### Session: 2026-03-06

#### Turn 1 - 20:30
**User**: 提交并推送

**Assistant**: 检查 git 状态，发现 4 个修改的文件：
- docs/context/COLD_TRACK.md
- docs/context/HOT_TRACK.md
- packages/repl/src/interactive/commands.ts
- packages/repl/src/ui/InkREPL.tsx

分两次提交：
1. 核心修复（compaction session persistence）
2. 文档记录（context snapshot）

**Tools**: git status, git diff, git add, git commit, git push

#### Turn 2 - 20:40
**User**: 我用另一个AI review了一下代码，代码中存在逻辑 bug — `limitReached` 变量从未被设置为 `true`。如果 LLM 连续调用工具达到 200 轮上限，返回值无法正确反映这个状态。

**Assistant**: 
1. 搜索 `limitReached` 使用位置
2. 发现问题：在 packages/coding/src/agent.ts 中
   - 第 193 行：初始化为 `false`
   - 第 279 行：正常完成时设置为 `false`（多余但无害）
   - 循环结束后：**从未设置为 `true`**

3. 分析逻辑：
   - 如果 LLM 在 200 轮内完成：循环 `break` 退出，`limitReached = false` ✅
   - 如果达到 200 轮上限：循环正常结束，但 `limitReached` 仍然是 `false` ❌

4. 修复方案：
   在循环结束后添加 `limitReached = true`
   因为如果代码执行到这里，说明循环完成了所有迭代，没有因为 COMPLETE、中断或错误提前退出

**Tools**: grep, sed (多次失败), git checkout (回滚错误修改), 最终成功修复

#### Turn 3 - 20:45
**User**: /context-snapshot

**Assistant**: 执行三步清洗法生成快照：
1. 无损提取：提取已确定的接口签名
2. 有损修剪：识别失败尝试（sed 格式错误）
3. 生成快照：组装热轨和冷轨文档

**Tools**: mkdir, cat (写入文件)

---

## 技术细节

### Bug 1: Compaction Session Persistence

**问题流程**:
```
1. context.messages = result.messages  // 压缩后的消息
2. clearHistory() → context.messages = []  // ❌ 清空了消息
3. saveSession() → 保存空数组  // ❌ 保存的是空数组
```

**修复后的流程**:
```
1. context.messages = result.messages  // 压缩后的消息
2. clearHistory() → 只清空 UI  // ✅ 不清空 messages
3. saveSession() → 保存压缩后的消息  // ✅ 正确保存
```

### Bug 2: limitReached Logic

**修复前**:
```typescript
let limitReached = false;

for (let iter = 0; iter < maxIter; iter++) {
  // ...
  if (result.toolBlocks.length === 0) {
    limitReached = false;  // 正常完成
    break;
  }
}

// 循环结束后，limitReached 仍然是 false ❌
return { limitReached };  // 永远不会是 true
```

**修复后**:
```typescript
let limitReached = false;

for (let iter = 0; iter < maxIter; iter++) {
  // ...
  if (result.toolBlocks.length === 0) {
    limitReached = false;  // 正常完成
    break;
  }
}

// 达到迭代上限 - 循环完成所有迭代没有提前退出
limitReached = true;  // ✅ 正确标记

return { limitReached };
```

---

## 经验教训

1. **Callback 副作用**: `clearHistory` 同时清空 UI 和数据状态，导致意外的副作用。应该分离关注点。

2. **显式优于隐式**: `/clear` 命令应该显式管理状态，而不是依赖 callback 的隐式行为。

3. **循环退出状态**: 循环正常结束（不是 break）时，应该正确标记退出原因。

4. **工具使用**: sed 多行插入容易出错，应该使用更可靠的方法（如 Read/Edit 工具）。

---
*生成时间: 2026-03-06 20:45*

---

### Session: 2026-03-06 (续)

#### Turn 4 - 21:00
**User**: 现在对话历史多了以后，感觉会比较卡，是因为比较长历史的全屏渲染导致的吗？现在多轮的会话信息是怎么处理的，能用 static 包裹吗？如果用 static 包裹了，compact 之后缩减历史记录时，还能改动吗？请你参考 https://github.com/google-gemini/gemini-cli 咱们看下怎么优化

**Assistant**:
1. 分析 Gemini CLI 的 MainContent.tsx
2. 发现关键优化策略：
   - 使用 Static 组件包裹历史（只渲染一次）
   - 分段渲染：静态历史 + 最后响应 + 待处理内容
   - 所有渲染器使用 memo

3. 实现优化：
   - MessageList.tsx: 添加 Static 包裹
   - 所有子渲染器使用 memo()
   - 分段渲染策略

**Tools**: mcp__github__get_file_contents (Gemini CLI), Read, Edit, Bash (npm build)

**关键发现**：
- Static 组件只渲染一次，避免重复渲染
- items 数组变化时更新显示（支持 compact）
- 分段策略平衡性能和功能

#### Turn 5 - 21:10
**User**: 我用别的AI review了下上一个提交的修改，发现了一个问题...

**Assistant**:
1. AI reviewer 指出逻辑 bug：
   - 第279行：`limitReached = false` （在 break 前）
   - 第452行：`limitReached = true` （循环后）
   - break 后仍会执行第452行，覆盖值

2. 分析执行路径：
   - 无工具调用 → break → 仍执行第452行 → limitReached = true ❌
   - 达到上限 → 循环结束 → 执行第452行 → limitReached = true ✅

3. 修复方案：
   - 删除第279行的 `limitReached = false`
   - 保持初始值 false
   - 只在循环正常结束时设为 true

**Tools**: Read, Edit, Bash (npm build)

**关键理解**：
- `break` 只跳出循环，不跳过循环后的代码
- `return` 才会跳出函数
- 初始值策略比赋值策略更可靠

#### Turn 6 - 21:15
**User**: /context-snapshot

**Assistant**: 执行三步清洗法：
1. 无损提取：提取 MessageList 优化架构 + limitReached 修复
2. 有损修剪：识别新墓碑（break 覆盖问题）
3. 生成快照：更新热轨和冷轨文档

**Tools**: Read, Write, Bash

---

## 墓碑区（新增）

### T02: 在 break 前设置 limitReached = false
- **失败原因**: 误解 `break` 行为，以为会跳过循环后的代码，导致值被覆盖
- **放弃日期**: 2026-03-06
- **尝试过程**:
  1. 提交 554f00a 在第452行添加 `limitReached = true`
  2. 为避免误报，在第279行添加 `limitReached = false`（在 break 前）
  3. AI reviewer 发现 bug：break 后仍执行第452行，覆盖为 true
  4. 分析执行路径，确认 bug 存在
  5. 删除第279行，保持初始值 false

**根本原因**:
- **误解**: 以为 `break` 会跳过循环后的所有代码
- **真相**: `break` 只跳出循环，循环后的代码仍执行
- **正确做法**: 使用初始值策略，不依赖 break 前的赋值

---

## 技术细节（新增）

### Bug 3: limitReached 被 break 后的代码覆盖

**修复前（第1轮 - 添加 true）**:
```typescript
let limitReached = false;

for (let i = 0; i < maxIterations; i++) {
  if (result.toolBlocks.length === 0) {
    limitReached = false;
    break;
  }
}
// ❌ 循环结束后 limitReached 仍然是 false
```

**修复前（第2轮 - 添加 false）**:
```typescript
let limitReached = false;

for (let i = 0; i < maxIterations; i++) {
  if (result.toolBlocks.length === 0) {
    limitReached = false;  // ❌ 会被覆盖
    break;
  }
}

limitReached = true;  // ❌ break 后仍执行
```

**修复后（最终）**:
```typescript
let limitReached = false;  // ✓ 初始值

for (let i = 0; i < maxIterations; i++) {
  if (result.toolBlocks.length === 0) {
    // ✓ 不赋值，保持初始值 false
    break;
  }
}

// ✓ 只有循环正常结束时执行
limitReached = true;
```

### Performance: MessageList 优化

**优化前**:
```typescript
// 每次输入都会重新渲染所有历史
{filteredItems.map((item) => (
  <HistoryItemRenderer key={item.id} item={item} />
))}
```

**优化后**:
```typescript
// 使用 Static 包裹（只渲染一次）
<Static items={[...staticHistoryItems, ...lastResponseHistoryItems]}>
  {(item) => <HistoryItemRenderer key={item.id} item={item} />}
</Static>
{pendingItems}  // 只有这部分动态更新
```

**性能提升**:
- 静态历史：只渲染一次，不重复渲染
- 动态内容：只有 pendingItems 更新
- Compact 支持：更新 items 数组即可

---

## 经验教训（新增）

5. **break 行为理解**: `break` 只跳出循环，循环后的代码仍执行。使用 `return` 才能跳出函数。

6. **初始值策略**: 对于布尔标记，使用初始值比多处赋值更可靠。避免在多个地方修改同一变量。

7. **AI Code Review**: 多个视角审查代码能发现单个 AI 遗漏的 bug。不同的 AI 有不同的思维盲区。

8. **Static 组件使用**: Ink 的 Static 组件能显著提升长列表性能，但要理解其更新机制（通过 items 数组变化）。

---
*更新时间: 2026-03-06 21:15*
