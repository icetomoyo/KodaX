---
name: tdd
description: TDD 测试驱动开发技能。当用户要求写测试、TDD、test-driven、单元测试、测试覆盖时使用。
user-invocable: true
allowed-tools: "Read, Grep, Glob, Write, Edit, Bash(npm:*, node:*, npx:*, vitest:*, jest:*, pytest:*)"
argument-hint: "[file-or-description]"
---

# TDD (Test-Driven Development) Skill

测试驱动开发辅助，遵循 Red-Green-Refactor 循环。

## TDD 流程

```
┌─────────────────────────────────────────────┐
│                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐ │
│  │  RED    │───▶│  GREEN  │───▶│ REFACTOR│ │
│  │ 写失败测试│    │ 写最小实现│    │  优化代码 │ │
│  └─────────┘    └─────────┘    └─────────┘ │
│       ▲                               │     │
│       └───────────────────────────────┘     │
│                                             │
└─────────────────────────────────────────────┘
```

## 任务分析

$ARGUMENTS

## 执行步骤

### Phase 1: RED - 编写失败测试

1. **理解需求**: 分析要实现的功能
2. **设计接口**: 定义函数/类的公共接口
3. **编写测试**:
   - 正常路径测试
   - 边界条件测试
   - 错误处理测试
4. **运行测试**: 确认测试失败 (RED)

### Phase 2: GREEN - 最小实现

1. **实现功能**: 只写足够让测试通过的代码
2. **运行测试**: 确认测试通过 (GREEN)
3. **不追求完美**: 先让它工作

### Phase 3: REFACTOR - 优化代码

1. **消除重复**: DRY 原则
2. **改善命名**: 提高可读性
3. **简化逻辑**: 减少复杂度
4. **运行测试**: 确保仍然通过

## 测试规范

### 测试文件命名
- TypeScript: `*.spec.ts` 或 `*.test.ts`
- Python: `test_*.py` 或 `*_test.py`

### 测试结构 (AAA 模式)
```typescript
describe('FunctionName', () => {
  it('should do something when condition', () => {
    // Arrange - 准备测试数据
    const input = 'test';

    // Act - 执行被测试的代码
    const result = functionUnderTest(input);

    // Assert - 验证结果
    expect(result).toBe(expected);
  });
});
```

### 覆盖率要求
- 语句覆盖率: ≥ 80%
- 分支覆盖率: ≥ 75%
- 函数覆盖率: ≥ 80%

## 测试框架检测

自动检测项目使用的测试框架：
- `vitest` - 检查 vitest.config.* 或 vite.config.*
- `jest` - 检查 jest.config.* 或 package.json jest 配置
- `pytest` - 检查 pytest.ini 或 pyproject.toml

## 使用示例

- `/tdd src/utils/format.ts` - 为 format.ts 编写测试
- `/tdd add user validation` - 实现用户验证功能 (TDD 方式)
- `/tdd` - 为当前 git 变更编写测试

## 输出格式

```markdown
## TDD Session: [功能名称]

### RED Phase
- 测试文件: path/to/test.spec.ts
- 测试用例: X 个
- 状态: FAIL (预期)

### GREEN Phase
- 实现文件: path/to/source.ts
- 状态: PASS

### REFACTOR Phase
- 优化项: 列出改进
- 最终状态: PASS

### 覆盖率
- Statements: X%
- Branches: X%
- Functions: X%
```
