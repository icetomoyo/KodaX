# 热轨快照

_生成时间: 2026-02-27 02:10_
_快照版本: v10_

---

## 1. 项目状态

### 当前目标
Issue 048 Spinner 动画期间消息乱序 (新增分析完成)

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 046 - Session 恢复消息显示 | **已修复** | v0.4.5, commit b524862 |
| Issue 047 - 流式输出闪烁 | 待实现 | 分析完成，方案 A+B |
| Issue 048 - Spinner 期间消息乱序 | **分析完成** | 新增，待实现 |

### 当下阻塞
无阻塞问题

---

## 2. 已确定接口（骨架）

### Issue 048 修复方案

#### 根因分析
```
1. 历史消息未在 Static 组件中
   - InkREPL.tsx:647-659 渲染 history
   - 使用普通 Box，非 Static
   - 每次状态变化触发完整重渲染

2. 三套独立更新系统
   - UIStateContext (history 状态)
   - StreamingContext (streaming 内容，立即 notify())
   - Spinner (80ms interval, 独立 useState)

3. 竞态条件
   - StreamingContext 每个 token 调用 notify()
   - Spinner 80ms 更新一次 frame
   - 两者不同步，导致终端重绘时内容错位
```

#### 方案 A: Static 组件隔离
```typescript
// InkREPL.tsx:647-659 改为:
<Static items={history} keyExtractor={(item) => item.id}>
  {(item) => (
    <Box key={item.id}>
      <MessageList items={[item]} ... />
    </Box>
  )}
</Static>
```

#### 方案 B: 统一更新周期
```typescript
// 在 StreamingContext 中实现批量更新
// 与 Spinner 共享同一更新周期

// 或使用 Ink 的实验性 batchedUpdates
import { batchedUpdates } from 'ink';

appendResponse: (text: string) => {
  batchedUpdates(() => {
    state = { ...state, currentResponse: state.currentResponse + text };
    notify();
  });
}
```

### Issue 047 修复方案

#### InkREPL.tsx render() 选项
```typescript
// 当前 (line 808-813)
render(<InkREPL ... />, {
  stdout: process.stdout,
  stdin: process.stdin,
  exitOnCtrlC: false,
  patchConsole: true,
})

// 方案 A: 添加 maxFps 限制
render(<InkREPL ... />, {
  stdout: process.stdout,
  stdin: process.stdin,
  exitOnCtrlC: false,
  patchConsole: true,
  maxFps: 15,  // 限制渲染频率
})
```

### Issue 046 修复摘要

#### message-utils.ts
```typescript
// extractTextContent: 只提取 text 块
// 忽略: thinking, tool_use, tool_result, redacted_thinking
// 纯非文本消息返回空字符串（允许 UI 过滤）
export function extractTextContent(content: string | unknown[]): string
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| CLI 多余参数设计 | --plan/-y/--allow/--deny/--config 冗余，仅需 --mode | 2026-02-26 |
| extractTextContent 返回 [Complex content] | 纯 tool_result 消息不应显示占位符，应返回空字符串过滤 | 2026-02-27 |
| thinking 块作为正式内容 | thinking 是 AI 内部思考，不应在 session 恢复时显示 | 2026-02-27 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| Issue 048 方案 A+B 组合 | Static 隔离 + 统一更新周期双重优化 | 2026-02-27 |
| Issue 047 方案 A+B 组合 | maxFps 限制 + 批量更新双重优化 | 2026-02-27 |
| maxFps: 15 | 终端渲染 15fps 足够流畅，减少重绘 | 2026-02-27 |

---

## 5. FEATURE_008 权限控制类型定义

```typescript
// packages/core/src/types.ts
export type PermissionMode = 'plan' | 'default' | 'accept-edits' | 'auto-in-project';

export interface KodaXOptions {
  permissionMode?: PermissionMode;
  confirmTools?: Set<string>;  // 向后兼容
  auto?: boolean;
}
```

---

## 6. 当前 Open Issues (11)

| 优先级 | ID | 标题 |
|--------|-----|------|
| Medium | 047 | 流式输出时界面闪烁 (待实现) |
| Medium | 048 | Spinner 动画期间消息乱序 (**新增**) |
| Medium | 036 | React 状态同步潜在问题 |
| Medium | 037 | 两套键盘事件系统冲突 |
| Low | 001-006, 013-015, 017-018, 039 | 代码质量问题 |

---

## 7. 待实现任务

### Issue 048 (优先级: Medium)
- [ ] 方案 A: 将历史消息包装在 Static 组件中
- [ ] 方案 B: 统一 StreamingContext 与 Spinner 更新周期
- [ ] 测试乱序修复效果
- [ ] 更新 KNOWN_ISSUES.md

### Issue 047 (优先级: Medium)
- [ ] 添加 `maxFps: 15` 到 InkREPL.tsx render() 选项
- [ ] 在 StreamingContext 实现批量更新（50-100ms 缓冲）
- [ ] 测试闪烁修复效果
- [ ] 更新 KNOWN_ISSUES.md

---

*Token 数: ~1,100*
