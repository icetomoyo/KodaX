# KodaX Known Issues

本目录记录已知但暂不紧急处理的问题。

## 待处理问题列表

| ID | 问题 | 优先级 | 位置 | 状态 | 描述 |
|----|------|--------|------|------|------|
| 1 | 未使用常量 | 低 | `src/cli/plan-mode.ts` | 待处理 | `PLAN_GENERATION_PROMPT` 常量已定义但未被使用 |
| 2 | 未使用参数 | 低 | `src/interactive/commands.ts` | 待处理 | `/plan` 命令 handler 的 `_currentConfig` 参数未使用 |
| 4 | Plan 无版本号 | 中 | `src/cli/plan-storage.ts` | 待处理 | `ExecutionPlan` 接口缺少版本字段，未来格式变更可能导致兼容性问题 |
| 5 | Plan 解析脆弱 | 中 | `src/cli/plan-mode.ts` | 待处理 | 正则表达式对 AI 输出格式要求严格，容错性差 |

---

## 问题详情

### Issue #1: 未使用常量 `PLAN_GENERATION_PROMPT`

**位置**: `src/cli/plan-mode.ts`

**问题描述**:
定义了 `PLAN_GENERATION_PROMPT` 常量作为计划生成的提示词模板，但实际 `generatePlan` 函数中并未使用它，而是通过 `runKodaX` 内部的系统提示词来生成计划。

**影响**:
- 代码维护混淆：开发者可能误以为这个常量是实际使用的
- 死代码占用空间

**建议修复**:
- 选项 A: 删除这个常量
- 选项 B: 将其实际用于 `generatePlan` 函数

---

### Issue #2: `/plan` 命令未使用 `_currentConfig` 参数

**位置**: `src/interactive/commands.ts`

**问题描述**:
```typescript
handler: async (args, _context, callbacks, _currentConfig) => {
  // _currentConfig 从未使用
}
```

**影响**:
- API 一致性问题：所有命令 handler 签名相同
- 下划线前缀已表明"故意不使用"

**建议修复**:
- 保持现状（下划线前缀已足够）
- 或用它来验证 plan mode 与当前 mode 的兼容性

---

### Issue #4: Plan 文件无版本号

**位置**: `src/cli/plan-storage.ts` - `ExecutionPlan` 接口

**问题描述**:
`ExecutionPlan` 接口没有版本字段。如果未来计划格式变更（比如添加新字段、修改步骤结构），旧文件无法正确解析。

**影响**:
- 未来兼容性风险
- 用户升级后保存的计划可能损坏
- 错误信息不友好

**建议修复**:
```typescript
export interface ExecutionPlan {
  version: '1.0';  // 添加版本号
  id: string;
  // ...
}
```

---

### Issue #5: Plan 解析正则表达式脆弱

**位置**: `src/cli/plan-mode.ts`

**问题描述**:
```typescript
const match = line.match(/^\d+\.\s*\[([A-Z]+)\]\s*(.+?)(?:\s+-\s+(.+))?$/);
```

这个正则期望格式：`1. [READ] description - target`

**脆弱点**:
- AI 输出 `1.[READ]` (无空格) → 失败
- AI 输出 `1. [read]` (小写) → 失败
- AI 输出 `1. [ READ ]` (多空格) → 失败

**影响**:
- Plan 生成失败时无提示
- 跨模型兼容性差

**建议修复**:
- 添加更宽松的正则匹配
- 解析失败时给出友好提示
- 添加日志记录原始输出便于调试

---

## 更新日志

- **2025-02-18**: 初始创建，记录代码审查发现的4个待处理问题
