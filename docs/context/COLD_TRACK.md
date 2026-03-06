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
