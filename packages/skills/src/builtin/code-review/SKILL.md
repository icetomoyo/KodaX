---
name: code-review
description: 代码审查技能。当用户要求审查代码、code review、检查代码质量、review code 时使用。
user-invocable: true
allowed-tools: "Read, Grep, Glob, Bash(npm:*, node:*, npx:*)"
argument-hint: "[file-or-directory]"
---

# Code Review Skill

对 **$ARGUMENTS** 进行全面的代码审查。

## 审查维度

### 1. 代码质量
- 可读性和命名规范
- 函数复杂度和长度
- 代码重复 (DRY 原则)
- 注释质量

### 2. 潜在问题
- 空值/未定义检查
- 边界条件处理
- 错误处理完整性
- 资源泄漏风险

### 3. 性能考量
- 算法复杂度
- 不必要的循环或重复计算
- 内存使用效率

### 4. 安全性
- 输入验证
- SQL 注入 / XSS 风险
- 敏感信息暴露
- 权限检查

### 5. 最佳实践
- TypeScript/JavaScript 规范
- React 组件模式 (如适用)
- 测试覆盖建议

## 输出格式

```
## 代码审查报告

### 概要
- 审查文件数: X
- 发现问题数: Y (Critical: A, High: B, Medium: C, Low: D)

### 问题详情

#### [Critical/High/Medium/Low] 问题标题
- **文件**: path/to/file.ts:行号
- **问题**: 描述
- **建议**: 修复建议

### 亮点
- 值得肯定的代码实践

### 总体评价
- 综合评分: X/10
- 改进建议
```

## 使用示例

- `/code-review src/auth.ts` - 审查单个文件
- `/code-review packages/core/src/` - 审查目录
- `/code-review` - 审查当前 git 变更
