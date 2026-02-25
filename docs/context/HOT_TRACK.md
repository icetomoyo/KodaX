# 热轨快照

_生成时间: 2026-02-26_
_快照版本: v3_

---

## 1. 项目状态

### 当前目标
代码质量改进 + Issue 修复

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 045 - Spinner 顺序颠倒 | 已修复 | v0.4.4 |
| Issue 010 - 非空断言检查 | 已修复 | v0.4.4 |
| Issue 011 - 命令预览长度 | 已修复 | v0.4.4 |
| 输入框 UX 改进 | 已完成 | 光标位置优化 |

### 当下阻塞
无阻塞问题

---

## 2. 已确定接口（骨架）

### common/utils.ts (PREVIEW_MAX_LENGTH)
```typescript
export const PREVIEW_MAX_LENGTH = 60;
```

### TextInput.tsx (空输入渲染)
```typescript
// 处理空输入 - 光标显示在提示符之后，空一格
if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
  return (
    <Box>
      <Text color={theme.colors.primary}>{prompt} </Text>
      {focus ? (
        <Text backgroundColor={theme.colors.primary}> </Text>
      ) : (
        <Text> </Text>
      )}
      <Text dimColor>{placeholder}</Text>
    </Box>
  );
}
```

### InputPrompt.tsx (默认 placeholder)
```typescript
export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  placeholder = "Type a message...",
  prompt = ">",
  focus = true,
  initialValue = "",
}) => {
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| 50ms 延迟方案 | 临时方案，不能根本解决问题 | 2026-02-25 |
| WebSearch 查询 | API 错误，无法获取信息 | 2026-02-25 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| Issue 045 使用 console.log 捕获方案 | 与 Issue 040 解决方案一致 | 2026-02-25 |
| Issue 010 使用显式 null 检查 | 与 getFeatureByIndex 风格一致 | 2026-02-25 |
| 统一 PREVIEW_MAX_LENGTH 常量 | 共享位置统一管理 | 2026-02-26 |
| 输入框光标位置优化 | 类似 Claude Code 体验 | 2026-02-26 |

---

*Token 数: ~700*
