# Feature 010 Phase 3: @kodax/agent 包 - 人工测试指导

> **归档说明（v0.7.27）**：本指南对应 v0.5.3 验收。其中验证 `compactMessages()` 与常量 `KODAX_COMPACT_THRESHOLD` / `KODAX_COMPACT_KEEP_RECENT` 的用例（TC 中涉及压缩与常量导出的部分）已随 FEATURE_086 在 v0.7.27 移除。等价能力请测 `@kodax/core` 的 `DefaultSummaryCompaction` 和 `@kodax/session-lineage` 的 `LineageCompaction`（见 [packages/core/src/compaction.test.ts](../../packages/core/src/compaction.test.ts)、[packages/session-lineage/src/compaction.test.ts](../../packages/session-lineage/src/compaction.test.ts)）。本文档其余部分作为历史记录保留。

## 功能概述

**功能名称**: Agent 包提取
**版本**: 0.5.2 → 0.5.3
**测试日期**: 2026-03-02
**测试人员**: [待填写]

**功能描述**:
从 @kodax/core 提取通用 Agent 功能到独立的 @kodax/agent 包，实现框架层分离。
引入 tiktoken 库实现精确的 token 计算，替代简单的字符估算。

**架构变更**:
- 新增 `@kodax/agent` 包（依赖 @kodax/ai + js-tiktoken）
- 更新 `@kodax/core` 使用 `@kodax/agent` 依赖
- 保留 coding-specific 功能在 @kodax/core
- Token 计算从 char/4 估算升级为 tiktoken 精确计算

---

## 测试环境

### 前置条件
- Node.js >= 18.0.0
- 当前分支: `feature/010-agent-package`
- 已运行 `npm install` 安装依赖

### 构建命令
```bash
npm run build:packages
npm run build
```

---

## 测试用例

### TC-001: @kodax/agent 包构建

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 执行 `npm run build -w @kodax/agent`
2. 检查 `packages/agent/dist/` 目录

**预期效果**:
- [ ] 构建成功，无编译错误
- [ ] `packages/agent/dist/` 目录包含:
  - `index.js`, `index.d.ts`
  - `types.js`, `types.d.ts`
  - `constants.js`, `constants.d.ts`
  - `session.js`, `session.d.ts`
  - `tokenizer.js`, `tokenizer.d.ts`
  - `messages.js`, `messages.d.ts`

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: @kodax/agent 依赖关系验证

**优先级**: 高
**类型**: 验证测试

**测试步骤**:
1. 查看 `packages/agent/package.json`
2. 确认依赖包含 `@kodax/ai` 和 `js-tiktoken`

**预期效果**:
- [ ] `dependencies` 包含 `"@kodax/ai": "*"`
- [ ] `dependencies` 包含 `"js-tiktoken": "^1.0.12"`

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: @kodax/core 依赖关系更新

**优先级**: 高
**类型**: 验证测试

**测试步骤**:
1. 查看 `packages/core/package.json`
2. 确认依赖包含 `@kodax/agent`

**预期效果**:
- [ ] `dependencies` 包含 `"@kodax/agent": "*"`

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: 所有包构建测试

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 执行 `npm run build:packages`

**预期效果**:
- [ ] 所有 5 个包构建成功（ai, agent, core, repl, skills）
- [ ] 无 TypeScript 编译错误

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: CLI 启动测试

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 执行 `npm run build`
2. 执行 `node dist/kodax_cli.js --help`

**预期效果**:
- [ ] CLI 正常启动
- [ ] 显示帮助信息
- [ ] 无模块加载错误

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: REPL 交互模式启动

**优先级**: 高
**类型**: 交互测试

**测试步骤**:
1. 执行 `npm run dev`
2. 观察启动日志

**预期效果**:
- [ ] REPL 正常启动
- [ ] 无模块加载错误
- [ ] 无类型导入错误

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: 会话功能测试

**优先级**: 高
**类型**: 功能测试

**测试步骤**:
1. 启动 REPL: `npm run dev`
2. 输入任意消息进行对话
3. 输入 `/status` 查看会话状态
4. 退出后重新启动，测试会话恢复

**预期效果**:
- [ ] 会话 ID 正确生成（格式: YYYYMMDD_HHMMSS）
- [ ] 会话状态显示正确
- [ ] 会话恢复功能正常

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-008: @kodax/agent 导出验证

**优先级**: 中
**类型**: 验证测试

**测试步骤**:
```bash
node -e "
import('./packages/agent/dist/index.js').then((agent) => {
  console.log('Exports from @kodax/agent:');
  console.log('  generateSessionId:', typeof agent.generateSessionId);
  console.log('  extractTitleFromMessages:', typeof agent.extractTitleFromMessages);
  console.log('  estimateTokens:', typeof agent.estimateTokens);
  console.log('  countTokens:', typeof agent.countTokens);
  console.log('  compactMessages:', typeof agent.compactMessages);
  console.log('  KODAX_COMPACT_THRESHOLD:', agent.KODAX_COMPACT_THRESHOLD);
  console.log('  PROMISE_PATTERN:', agent.PROMISE_PATTERN);
});
"
```

**预期效果**:
- [ ] 所有导出都是正确的类型
- [ ] `generateSessionId`: function
- [ ] `extractTitleFromMessages`: function
- [ ] `estimateTokens`: function
- [ ] `countTokens`: function（新增）
- [ ] `compactMessages`: function
- [ ] `KODAX_COMPACT_THRESHOLD`: number (100000)
- [ ] `PROMISE_PATTERN`: RegExp

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: Tiktoken 精确计算测试

**优先级**: 高
**类型**: 功能测试

**测试步骤**:
```bash
node -e "
import('./packages/agent/dist/tokenizer.js').then((tokenizer) => {
  console.log('=== Tiktoken Token Calculation Test ===');

  // Test 1: 英文文本
  const enText = 'Hello, world!';
  const enTokens = tokenizer.countTokens(enText);
  console.log('English text:', enText);
  console.log('Tokens:', enTokens, '(expected: 4)');

  // Test 2: 中文文本
  const zhText = '你好世界，这是一个测试';
  const zhTokens = tokenizer.countTokens(zhText);
  console.log('Chinese text:', zhText);
  console.log('Tokens:', zhTokens, '(expected: ~10)');

  // Test 3: 代码
  const codeText = 'function test() { return 123; }';
  const codeTokens = tokenizer.countTokens(codeText);
  console.log('Code:', codeText);
  console.log('Tokens:', codeTokens, '(expected: ~9)');

  // Test 4: 消息数组
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' }
  ];
  const msgTokens = tokenizer.estimateTokens(messages);
  console.log('Messages:', JSON.stringify(messages));
  console.log('Tokens:', msgTokens, '(expected: ~12)');
});
"
```

**预期效果**:
- [ ] 英文文本 token 计算准确（"Hello, world!" = 4 tokens）
- [ ] 中文文本 token 计算准确（中文字符约 0.5-1 token/字）
- [ ] 代码 token 计算准确
- [ ] 消息数组包含结构开销（每条约 4 tokens）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: 消息压缩功能测试

**优先级**: 中
**类型**: 功能测试

**测试步骤**:
```bash
node -e "
import('./packages/agent/dist/index.js').then(async (agent) => {
  // 创建大量消息测试压缩
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: 'Test message ' + i + ' '.repeat(100000) });
    messages.push({ role: 'assistant', content: 'Response ' + i + ' '.repeat(100000) });
  }
  console.log('Original messages:', messages.length);
  console.log('Original tokens:', agent.estimateTokens(messages));

  const compacted = agent.compactMessages(messages);
  console.log('Compacted messages:', compacted.length);
  console.log('Compacted tokens:', agent.estimateTokens(compacted));
  console.log('Compression applied:', compacted !== messages);
});
"
```

**预期效果**:
- [ ] 原始消息数: 600
- [ ] 原始 tokens > 100000（触发压缩阈值）
- [ ] 压缩后消息数 < 原始消息数
- [ ] 压缩后 tokens < 原始 tokens

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-011: @kodax/core 重新导出验证

**优先级**: 高
**类型**: 验证测试

**测试步骤**:
```bash
node -e "
import('./packages/core/dist/index.js').then((core) => {
  // 验证从 @kodax/agent 重新导出的功能
  console.log('Re-exports from @kodax/core:');
  console.log('  generateSessionId:', typeof core.generateSessionId);
  console.log('  estimateTokens:', typeof core.estimateTokens);
  console.log('  countTokens:', typeof core.countTokens);
  console.log('  compactMessages:', typeof core.compactMessages);
  console.log('  KODAX_COMPACT_THRESHOLD:', core.KODAX_COMPACT_THRESHOLD);

  // 验证 coding-specific 功能保留
  console.log('Coding-specific:');
  console.log('  checkIncompleteToolCalls:', typeof core.checkIncompleteToolCalls);
  console.log('  KODAX_TOOL_REQUIRED_PARAMS:', typeof core.KODAX_TOOL_REQUIRED_PARAMS);
});
"
```

**预期效果**:
- [ ] 重新导出的功能类型正确
- [ ] `countTokens`: function（新增）
- [ ] `estimateTokens`: function
- [ ] `compactMessages`: function
- [ ] `checkIncompleteToolCalls`: function
- [ ] `KODAX_TOOL_REQUIRED_PARAMS`: object

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界用例

### BC-001: 空 projectRoot 参数
- 传入空消息数组测试 token 估算
- 应返回 0

### BC-002: 短消息不触发压缩
- 创建少量消息（低于阈值）
- compactMessages 应返回原数组（不压缩）

### BC-003: 单条消息标题提取
- 从单条用户消息提取标题
- 应正确截断到 50 字符

---

## 回归测试要点

1. **模块导入**: 所有从 @kodax/core 的导入正常工作
2. **向后兼容**: 原有 API 不变（generateSessionId, estimateTokens, compactMessages）
3. **会话功能**: REPL 会话创建、保存、恢复正常
4. **消息处理**: 长对话压缩功能正常

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 11 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

---

## 包依赖关系图

```
@kodax/ai (AI 抽象层)
    ↑
@kodax/agent (通用 Agent 框架) ← 新增
    ↑
@kodax/core (Coding Agent)
    ↑
@kodax/repl (CLI 应用)

@kodax/skills (Skills 系统)
    ↓
@kodax/repl
```

---

*测试指导生成时间: 2026-03-02*
*Feature ID: 010 Phase 3*
