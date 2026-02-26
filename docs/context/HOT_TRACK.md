# 热轨快照

_生成时间: 2026-02-26 10:15_
_快照版本: v4_

---

## 1. 项目状态

### 当前目标
代码质量改进 + Issue 修复

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 011 - 命令预览长度 | 已修复 | v0.4.4 (状态更新) |
| Issue 012 - ANSI Strip 性能 | 已修复 | v0.4.4 |
| Issue 035 - Backspace 检测 | 已修复 | 状态不一致修正 |
| Issue 016 - InkREPL 过大 | 分析完成 | 待决策 |

### 当下阻塞
无阻塞问题

---

## 2. 已确定接口（骨架）

### status-bar.ts (ANSI_REGEX 缓存)
```typescript
// 模块级常量，避免重复编译
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// 使用时重置 lastIndex
private stripAnsi(str: string): string {
  ANSI_REGEX.lastIndex = 0;
  return str.replace(ANSI_REGEX, '');
}
```

### common/utils.ts (PREVIEW_MAX_LENGTH)
```typescript
export const PREVIEW_MAX_LENGTH = 60;
```

### TextInput.tsx (空输入渲染)
```typescript
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
| Issue 012 缓存正则表达式 | 避免重复编译，性能优化 | 2026-02-26 |
| Issue 035 状态修正 | Index 已是 Resolved，Details 需同步 | 2026-02-26 |

---

## 5. 待决策事项

### Issue 016: InkREPL 组件过大 (994行)

**问题**：组件承担 7+ 个职责，`handleSubmit()` 单函数 300+ 行

**方案 A（保守重构）**：
- 提取 session-storage.ts (~52行)
- 提取 shell-executor.ts (~45行)
- 提取 message-utils.ts (~25行)
- 提取 console-capturer.ts (~30行)
- 删除死代码 printStartupBanner()
- 预期：994 → ~800 行

**方案 B（激进重构）**：
- + 方案 A
- + 提取 hooks: useSessionManager, useCommandHandler, useAgentRunner
- 预期：994 → ~500 行，但风险较高

**建议**：采用方案 A，低风险渐进式改进

---

## 6. 当前 Open Issues (14)

| 优先级 | ID | 标题 |
|--------|-----|------|
| Medium | 016 | InkREPL 组件过大 |
| Medium | 019 | 状态栏 Session ID 显示问题 |
| Medium | 036 | React 状态同步潜在问题 |
| Medium | 037 | 两套键盘事件系统冲突 (Planned v0.5.0+) |
| Low | 001-006, 013-015, 017-018, 039 | 代码质量问题 |

---

*Token 数: ~850*
