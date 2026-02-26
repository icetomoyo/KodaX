# 热轨快照

_生成时间: 2026-02-27 01:35_
_快照版本: v9_

---

## 1. 项目状态

### 当前目标
Issue 047 流式输出界面闪烁修复 (进行中)

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 046 - Session 恢复消息显示 | **已修复** | v0.4.5, commit b524862 |
| Issue 047 - 流式输出闪烁 | **进行中** | 分析完成，待实现 |
| FEATURE_008 - 权限控制体系 | 设计完成 | v0.5.0, 待实现 |

### 当下阻塞
无阻塞问题

---

## 2. 已确定接口（骨架）

### Issue 047 修复方案

#### StreamingContext.tsx 批量更新
```typescript
// 当前: 每个 token 立即更新
appendResponse: (text: string) => {
  state = { ...state, currentResponse: state.currentResponse + text };
  notify();  // 每次触发重渲染
}

// 方案 B: 批量更新（50-100ms 缓冲）
// 在 createStreamingManager() 中添加缓冲机制
```

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

#### MessageList.tsx
```typescript
// maxLines: 20 → 1000 (避免截断)
maxLines = 1000
```

#### InkREPL.tsx
```typescript
// 1. 删除重复 push (line 481)
// 2. 添加空内容过滤 (useEffect, handleSubmit)
// 3. 注意: agent.ts:76 会自动添加用户消息
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
| Issue 047 方案 A+B 组合 | maxFps 限制 + 批量更新双重优化 | 2026-02-27 |
| maxFps: 15 | 终端渲染 15fps 足够流畅，减少重绘 | 2026-02-27 |
| 批量更新 50-100ms | 平衡响应性和性能 | 2026-02-27 |

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

## 6. 当前 Open Issues (10)

| 优先级 | ID | 标题 |
|--------|-----|------|
| Medium | 047 | 流式输出时界面闪烁 (**进行中**) |
| Medium | 036 | React 状态同步潜在问题 |
| Medium | 037 | 两套键盘事件系统冲突 |
| Low | 001-006, 013-015, 017-018, 039 | 代码质量问题 |

---

## 7. Issue 047 待实现任务

- [ ] 添加 `maxFps: 15` 到 InkREPL.tsx render() 选项
- [ ] 在 StreamingContext 实现批量更新（50-100ms 缓冲）
- [ ] 测试闪烁修复效果
- [ ] 更新 KNOWN_ISSUES.md

---

*Token 数: ~900*
