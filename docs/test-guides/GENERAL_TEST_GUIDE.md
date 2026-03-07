# 通用人工测试指导 - KodaX 功能验证

## 功能概述

**功能名称**: KodaX 通用功能测试
**版本**: v0.5.20
**测试日期**: 2026-03-07
**测试人员**: [待填写]

**功能描述**:

KodaX 是一个极致轻量化的 Coding Agent，支持 7 种 LLM 提供商。本测试指南涵盖所有核心功能的验证，包括基本对话、确认机制、流式输出、Thinking Mode、会话管理、长时间运行模式等功能。

**测试覆盖范围**:
- P0: 基本功能（对话、确认、流式输出）
- P1: 多模型支持、Thinking Mode、会话管理、上下文压缩
- P2: 并行执行、Agent Team
- TypeScript 特有功能
- Windows 环境兼容性
- 长时间运行模式

---

## 测试环境

### 前置条件
- ✅ KodaX 已安装（`npm install && npm run build`）
- ✅ Node.js >= 18.0.0
- ✅ 至少一个 AI Provider 已配置：
  - 智谱: `export ZHIPU_API_KEY=your-key`（推荐，便宜）
  - Kimi: `export KIMI_API_KEY=your-key`
  - Anthropic: `export ANTHROPIC_API_KEY=your-key`
- ✅ Git 仓库（用于测试 Git Context 注入）

### 测试账号/配置
- AI Provider: [已配置]
- API Key: [已配置]
- 工作目录: KodaX Git 仓库

### 浏览器/环境要求
- 终端: Windows Terminal / macOS Terminal / iTerm2 / Linux Terminal
- 终端需支持 ANSI 颜色和 Unicode 字符
- 操作系统: Windows / macOS / Linux

---

## P0 功能测试

### TC-001: 基本对话与工具调用

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- AI Provider 已配置
- KodaX CLI 可用

**测试步骤**:
```bash
kodax --provider zhipu-coding "列出当前目录下的文件"
```

**预期效果**:
- [ ] Agent 调用 glob 工具
- [ ] 列出当前目录文件
- [ ] 流式输出结果

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: 确认机制 - 需要确认的操作

**优先级**: 高
**类型**: 正向测试 / 负向测试

**前置条件**:
- 默认权限模式（需要确认 write, edit, bash）

**测试步骤**:
```bash
kodax --provider zhipu-coding "创建一个测试文件 test_hello.txt，内容是 Hello World"
```

**预期效果**:
- [ ] Agent 请求执行 write 工具
- [ ] 显示 `[Confirm]` 提示
- [ ] 输入 `y` 后执行
- [ ] 输入 `n` 取消

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: 确认机制 - 禁用确认

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --no-confirm "删除 test_hello.txt 文件"
```

**预期效果**:
- [ ] 直接执行，无需确认
- [ ] 文件成功删除

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: 流式输出

**优先级**: 高
**类型**: UI测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "写一首关于编程的短诗"
```

**预期效果**:
- [ ] 文字逐字符/逐词显示
- [ ] 非一次性输出
- [ ] 动画效果流畅

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: TypeScript 等待动画

**优先级**: 高
**类型**: UI测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "读取 README.md"
```

**预期效果**:
- [ ] 等待时显示旋转动画 (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
- [ ] 动画会被 `\r` 清除，不在终端留下痕迹
- [ ] 比 Python 版本更整洁

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: Spinner 立即渲染

**优先级**: 中
**类型**: UI测试 / 性能测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --no-confirm "创建一个简单的 test_spinner.txt 文件"
```

**预期效果**:
- [ ] LLM 输出结束后，立即看到 "Processing..." spinner（不等待 80ms）
- [ ] 从 LLM 输出到工具执行之间没有明显的"卡顿"感
- [ ] 任务完成时 spinner 正确停止

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: 任务完成时 Spinner 停止

**优先级**: 中
**类型**: UI测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "你好"
```

**预期效果**:
- [ ] 显示 "[KodaX] Done!"
- [ ] spinner 正确停止，不再继续旋转
- [ ] 程序正常退出

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## P1 功能测试

### TC-008: 多模型支持

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "你好"           # 智谱 Coding (GLM-5)
kodax --provider kimi-code "你好"              # Kimi Code (K2.5)
kodax --provider zhipu "你好"                  # 智谱 OpenAI 兼容 (GLM-4)
kodax --provider kimi "你好"                   # Kimi Moonshot
```

**预期效果**:
- [ ] 不同 Provider 都能正常响应
- [ ] 无报错
- [ ] 输出符合预期

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: Thinking Mode

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 仅 anthropic, kimi-code, zhipu-coding 支持

**测试步骤**:
```bash
kodax --provider zhipu-coding --thinking "计算 123 * 456 并解释步骤"
```

**预期效果**:
- [ ] 显示灰色的 [thinking] 块
- [ ] 包含思考过程
- [ ] 然后显示正常回复

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: 会话管理 - 创建与列出

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
```bash
# 创建新会话
kodax --provider zhipu-coding "记住我的名字是 Alice"

# 列出会话
kodax --session list
```

**预期效果**:
- [ ] 显示会话列表
- [ ] 包含会话 ID 和标题
- [ ] 显示消息数量

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-011: 会话管理 - 恢复会话

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
```bash
# 恢复最近会话
kodax --provider zhipu-coding --session resume "我的名字是什么？"
```

**预期效果**:
- [ ] Agent 能回答 "Alice"
- [ ] 历史消息正确加载

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-012: read 工具 offset/limit 参数

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --no-confirm "读取 package.json 的第 2-5 行"
```

**预期效果**:
- [ ] 只返回第 2-5 行内容
- [ ] 非整个文件内容

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-013: grep output_mode 参数

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
# 测试 output_mode=files_with_matches
kodax --provider zhipu-coding "在 src 目录搜索包含 'Provider' 的文件，只返回文件名"

# 测试 output_mode=count
kodax --provider zhipu-coding "在 packages/coding/src 中搜索 'async' 出现的次数"
```

**预期效果**:
- [ ] files_with_matches 只返回文件名列表
- [ ] count 返回匹配次数

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-014: edit replace_all 参数

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
# 创建测试文件
kodax --provider zhipu-coding --no-confirm "创建 test_replace.txt，内容是：foo bar foo baz foo"

# 测试 replace_all
kodax --provider zhipu-coding --no-confirm "将 test_replace.txt 中所有的 foo 替换为 FOO"
```

**预期效果**:
- [ ] 所有 foo 都被替换（3 处）
- [ ] bar 和 baz 保持不变

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-015: 环境上下文注入

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "告诉我你运行在什么平台上，Node 版本是多少"
```

**预期效果**:
- [ ] Agent 能回答平台（Windows/macOS/Linux）
- [ ] Agent 能回答 Node 版本
- [ ] Context 已注入环境信息

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-016: Git Context 自动注入

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- 在 Git 仓库中测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "告诉我当前的 Git 分支和状态"
```

**预期效果**:
- [ ] Agent 能够直接回答当前分支
- [ ] 上下文已注入 Git 信息

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-017: 简单 Undo

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --no-confirm "
1. 创建 test_undo.txt，内容是 'Original Content'
2. 修改 test_undo.txt 为 'Modified Content'
3. 使用 undo 工具撤销修改
4. 读取 test_undo.txt 确认内容
"
```

**预期效果**:
- [ ] 文件创建成功
- [ ] 内容修改成功
- [ ] undo 执行后恢复为 'Original Content'

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## P2 功能测试

### TC-018: 并行工具执行

**优先级**: 中
**类型**: 正向测试 / 性能测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --parallel "
读取 package.json, tsconfig.json, README.md 这三个文件，
告诉我它们各自的用途
"
```

**预期效果**:
- [ ] 显示 "[Kodax Parallel] Executing tools in parallel..."
- [ ] 工具并行执行
- [ ] 提高效率

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-019: Agent Team

**优先级**: 中
**类型**: 正向测试 / 性能测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --team "
分析 package.json 的依赖配置，
检查 tsconfig.json 的配置，
统计 packages/coding/src 的代码行数
"
```

**预期效果**:
- [ ] 显示 "[Kodax Team] Running parallel agents..."
- [ ] 三个子 Agent 同时工作
- [ ] 最后汇总显示每个任务的结果

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 长时间运行模式测试

### TC-020: --init 初始化

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
```bash
# 创建测试目录
mkdir -p /tmp/kodax-test
cd /tmp/kodax-test

kodax --provider zhipu-coding --init "构建一个简单的 TODO 应用"
```

**预期效果**:
- [ ] Agent 创建 feature_list.json（包含所有功能，每个 passes: false）
- [ ] Agent 创建 PROGRESS.md
- [ ] Agent 执行初始 git commit

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-021: 长运行模式自动检测

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已存在 feature_list.json 的目录

**测试步骤**:
```bash
cd /tmp/kodax-test
kodax --provider zhipu-coding "继续开发"
```

**预期效果**:
- [ ] 显示 "[Kodax] Long-running mode enabled"
- [ ] Agent 自动读取 feature_list.json 和 PROGRESS.md
- [ ] Agent 选择一个未完成的功能开始工作
- [ ] Agent 结束前更新 PROGRESS.md

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-022: --auto-continue 模式

**优先级**: 高
**类型**: 正向测试 / 性能测试

**测试步骤**:
```bash
cd /tmp/kodax-test
kodax --provider zhipu-coding --auto-continue --max-sessions 3 --max-hours 0.5
```

**预期效果**:
- [ ] 显示 "[Kodax] Auto-continue mode enabled"
- [ ] 显示 feature 进度
- [ ] 自动运行多个 session
- [ ] 达到限制时显示停止原因

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-023: Promise 信号系统

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
cd /tmp/kodax-test
kodax --provider zhipu-coding --auto-continue --max-sessions 5
```

**预期效果**:
- [ ] 如果 Agent 输出 `<promise>COMPLETE</promise>`，则显示 "[Kodax Auto-Continue] Agent signaled COMPLETE"
- [ ] 并退出循环
- [ ] 如果输出 `<promise>BLOCKED:原因</promise>`，显示阻止原因

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## Windows 环境兼容性测试

### TC-024: 跨平台命令

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- Windows 环境

**测试步骤**:
```bash
kodax --provider zhipu-coding --no-confirm "
创建一个 test_env.txt 文件，然后移动到 test_folder 文件夹
"
```

**预期效果**:
- [ ] Context 显示 "Platform: Windows" 和 "Node: vx.x.x"
- [ ] Agent 使用 move 命令（而非 mv）
- [ ] 文件成功移动

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-025: mkdir 命令提示

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --no-confirm "
告诉我当前平台应该使用什么命令创建嵌套目录
"
```

**预期效果**:
- [ ] Windows: Agent 知道应该使用 mkdir（不带 -p 参数）
- [ ] Unix/Mac: Agent 知道应该使用 mkdir -p

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-026: UTF-8 编码

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --no-confirm "echo '测试中文输出'"
```

**预期效果**:
- [ ] 输出包含 "测试中文输出"
- [ ] 没有编码错误

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-027: Git 命令顺序执行

**优先级**: 中
**类型**: 正向测试 / 边界测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --parallel --no-confirm "
1. git status
2. git log --oneline -3
"
```

**预期效果**:
- [ ] 没有 ".git/index.lock" 错误
- [ ] bash 命令顺序执行

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-028: Thinking Mode 多轮工具调用

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- kimi-code 或 zhipu-coding provider

**测试步骤**:
```bash
kodax --provider kimi-code --thinking --no-confirm "
1. 读取 README.md
2. 总结主要内容
"
```

**预期效果**:
- [ ] 没有 "thinking is enabled but reasoning_content is missing" 错误
- [ ] 能正常执行多轮工具调用
- [ ] 显示 [thinking] 块

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 错误处理测试

### TC-029: 无效 Provider

**优先级**: 中
**类型**: 负向测试

**测试步骤**:
```bash
kodax --provider invalid "test"
```

**预期效果**:
- [ ] 显示错误 "Unknown provider: invalid"

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-030: 缺少 API Key

**优先级**: 中
**类型**: 负向测试

**测试步骤**:
```bash
# 临时取消环境变量（Unix）
unset ZHIPU_API_KEY
kodax --provider zhipu-coding "test"
```

**预期效果**:
- [ ] 显示初始化错误
- [ ] 错误信息提示缺少 API Key

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-031: 文件不存在

**优先级**: 低
**类型**: 负向测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "读取 /nonexistent/file.txt"
```

**预期效果**:
- [ ] Agent 报告 [Tool Error] read: File not found

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 综合测试场景

### TC-032: 代码分析

**优先级**: 中
**类型**: 集成测试

**测试步骤**:
```bash
kodax --provider zhipu-coding --parallel "
分析 packages/coding/src 的整体结构，
列出所有 Provider 类和它们的功能，
统计代码行数
"
```

**预期效果**:
- [ ] 正确分析代码结构
- [ ] 列出 Provider 类
- [ ] 统计代码行数

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-033: 文件操作

**优先级**: 中
**类型**: 集成测试

**测试步骤**:
```bash
kodax --provider zhipu-coding "
1. 在 /tmp 目录创建 test_kodax 文件夹
2. 在里面创建 3 个测试文件
3. 用 grep 搜索包含特定内容的文件
4. 最后清理这些文件
"
```

**预期效果**:
- [ ] 文件夹创建成功
- [ ] 文件创建成功
- [ ] grep 搜索正确
- [ ] 清理成功

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 性能测试

### TC-034: 响应时间

**优先级**: 低
**类型**: 性能测试

**测试步骤**:
```bash
# 测试首次响应时间
time kodax --provider zhipu-coding "你好"
```

**预期效果**:
- [ ] 首次响应 < 3 秒

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-035: 并行效率

**优先级**: 低
**类型**: 性能测试

**测试步骤**:
```bash
# 串行执行
time kodax --provider zhipu-coding "读取 package.json, tsconfig.json"

# 并行执行
time kodax --provider zhipu-coding --parallel "读取 package.json, tsconfig.json"
```

**预期效果**:
- [ ] 并行执行比串行快

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界用例

### BC-001: 空会话
- **场景**: 没有任何历史消息的会话
- **预期**: 正常初始化，无报错

### BC-002: 大量消息（触发压缩）
- **场景**: 超过 100 条消息
- **预期**: 自动压缩上下文，保留关键信息

### BC-003: 超长 prompt
- **场景**: 输入超长 prompt（> 10000 字符）
- **预期**: 正确处理，可能触发截断警告

### BC-004: 特殊字符文件名
- **场景**: 文件名包含特殊字符
- **预期**: 正确处理和转义

### BC-005: 网络超时
- **场景**: API 请求超时
- **预期**: 显示超时错误，可重试

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 35 + 5 边界 | - | - | - |

**测试覆盖维度**:
- ✅ 正向测试：正常功能流程
- ✅ 负向测试：错误处理、边界情况
- ✅ UI测试：流式输出、动画效果
- ✅ 性能测试：响应时间、并行效率
- ✅ 集成测试：完整工作流
- ✅ 兼容性测试：Windows 环境、多 Provider

**重点测试区域**:
1. 🔴 **确认机制** - 安全性关键
2. 🔴 **长时间运行模式** - 核心功能
3. 🟡 **Thinking Mode** - 重要特性
4. 🟡 **Windows 兼容性** - 跨平台支持

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

---

## 自动化测试覆盖

以下测试用例已有对应的自动化测试覆盖：

| 测试文件 | 测试数 | 覆盖内容 |
|----------|--------|----------|
| `packages/repl/src/interactive/__tests__/fuzzy.test.ts` | 20 | 模糊匹配算法 |
| `packages/repl/src/interactive/__tests__/skill-completer.test.ts` | 12 | 技能补全 |
| `packages/repl/src/interactive/__tests__/argument-completer.test.ts` | 20 | 参数补全 |
| `packages/repl/src/interactive/__tests__/autocomplete-provider.test.ts` | 19 | 自动补全 |

**运行自动化测试**:
```bash
npm test
```

---

## 测试检查清单

| 功能 | 测试命令 | 状态 |
|------|---------|------|
| 基本对话 | `kodax "你好"` | ☐ |
| 确认机制 | `kodax "创建文件"` | ☐ |
| 启用自动模式 | `kodax --no-confirm "..."` | ☐ |
| 流式输出 | 观察输出是否逐步显示 | ☐ |
| 等待动画 | 观察点是否被清除 | ☐ |
| Thinking Mode | `kodax --thinking "..."` | ☐ |
| Session List | `kodax --session list` | ☐ |
| Session Resume | `kodax --session resume "..."` | ☐ |
| 并行执行 | `kodax --parallel "..."` | ☐ |
| Agent Team | `kodax --team "..."` | ☐ |
| read offset/limit | 测试分页读取 | ☐ |
| grep output_mode | 测试输出模式 | ☐ |
| edit replace_all | 测试批量替换 | ☐ |
| Node 版本上下文 | 验证环境信息 | ☐ |
| 多 Provider | 切换不同 --provider 测试 | ☐ |
| Git Context | `kodax "当前分支是什么"` | ☐ |
| Undo | 修改后撤销测试 | ☐ |
| --init | `kodax --init "..."` | ☐ |
| --auto-continue | `kodax --auto-continue` | ☐ |
| Promise 信号 | Agent 发送 COMPLETE/BLOCKED/DECIDE | ☐ |
| Windows UTF-8 编码 | 中文输出测试 | ☐ |
| 环境感知注入 | Agent 知道运行平台 | ☐ |
| Thinking 多轮调用 | kimi-code/zhipu-coding 多工具 | ☐ |
| 跨平台 mkdir | Windows 用 mkdir | ☐ |
| 工作目录路径 | Agent 能识别工作目录 | ☐ |

---

## 测试报告模板

测试完成后，请记录：

```
测试日期：YYYY-MM-DD
测试人员：
KodaX 版本：v0.5.20
测试环境：Windows/macOS/Linux
Node 版本：vx.x.x

测试结果：
- 通过的功能：
- 失败的功能：
- 发现的问题：

建议：
```

---

*测试指导生成时间: 2026-03-07*
*版本: v0.5.20*
