# KodaX 手动测试指南

本文档提供 KodaX 所有功能的手动测试步骤。

---

## 前置条件

```bash
# 1. 安装依赖
npm install

# 2. 构建
npm run build

# 3. 配置至少一个 Provider 的 API Key
export ZHIPU_API_KEY=your-key        # 智谱 Coding (推荐，便宜)
export KIMI_API_KEY=your-key          # Kimi Code
export ANTHROPIC_API_KEY=your-key     # Anthropic Claude
```

---

## 自动化测试

```bash
# 运行自动化测试
npm test

# 预期：所有测试通过
```

### 测试文件结构

KodaX 包含 183 个自动化测试，分布在 5 个测试文件中：

```
tests/
├── kodax_core.test.ts     # Core 模块测试 (82 tests)
├── kodax_cli.test.ts      # CLI 层测试 (20 tests)
├── prompts.test.ts        # 提示词内容验证测试 (33 tests)
├── interactive.test.ts    # 交互式模式测试
└── text-buffer.test.ts    # TextBuffer 单元测试 (48 tests)
```

### 测试覆盖范围

#### Core 模块测试 (`kodax_core.test.ts`)

| 测试类别 | 测试数量 | 覆盖内容 |
|---------|---------|---------|
| Core Module Exports | 7 | runKodaX, KodaXClient, KODAX_TOOLS 等 |
| Promise Signal Detection | 6 | COMPLETE, BLOCKED, DECIDE 信号检测 |
| Environment Context | 3 | 平台信息、命令提示 |
| Token Estimation | 3 | Token 估算功能 |
| Incomplete Tool Call Detection | 6 | 不完整工具调用检测 |
| File Operations | 3 | 文件创建、目录操作 |
| Spinner Animation | 6 | 等待动画功能 |
| Tool Definitions | 2 | 工具定义验证 |
| Provider System | 3 | Provider 工厂函数 |
| Constants Export | 9 | 所有常量导出 |
| Tool Execution | 13 | 工具执行功能 |
| Tool Execution Context | 2 | 上下文配置 |
| Session ID Generation | 2 | 会话 ID 生成 |
| Git Root Detection | 1 | Git 根目录检测 |
| Project Snapshot | 2 | 项目快照 |
| Long Running Context | 1 | 长运行上下文 |
| Feature Progress | 2 | Feature 进度 |
| Rate Limited Call | 2 | 速率限制 |
| Token Estimation Detailed | 2 | 详细 Token 估算 |
| Incomplete Tool Call Detailed | 3 | 详细不完整调用检测 |
| Promise Signal Detailed | 3 | 详细信号检测 |

#### CLI 层测试 (`kodax_cli.test.ts`)

| 测试类别 | 测试数量 | 覆盖内容 |
|---------|---------|---------|
| Commands System | 3 | Commands 加载和解析 |
| parseCommandCall | 4 | 命令解析 |
| processCommandCall | 3 | 命令处理 |
| Spinner Animation | 5 | CLI 层 Spinner |
| File Operations | 3 | 文件操作 |
| CLI Entry Point | 2 | 入口点配置 |

#### 提示词验证测试 (`prompts.test.ts`)

| 测试类别 | 测试数量 | 覆盖内容 |
|---------|---------|---------|
| SYSTEM_PROMPT | 9 | 系统提示词完整性 |
| LONG_RUNNING_PROMPT | 6 | 长运行模式提示词 |
| buildInitPrompt | 6 | 初始化提示词 |
| --append Prompt | 4 | 追加功能提示词 |
| toolBash Timeout | 1 | 超时消息 |
| Retry Prompts | 3 | 重试提示词 |
| Source File Consistency | 4 | 源文件一致性 |

### 运行特定测试

```bash
# 只运行 Core 测试
npx vitest run tests/kodax_core.test.ts

# 只运行 CLI 测试
npx vitest run tests/kodax_cli.test.ts

# 只运行提示词测试
npx vitest run tests/prompts.test.ts

# 运行特定测试用例
npx vitest run -t "Promise Signal"
```

---

## P0 功能测试

### 1. 基本功能

```bash
# 测试基本对话和工具调用
node dist/kodax.js --provider zhipu-coding "列出当前目录下的文件"

# 预期：Agent 调用 glob 工具，列出文件，流式输出结果
```

### 1.1 TypeScript 等待动画测试

验证 TypeScript 版本的等待动画不会在终端留下痕迹：

```bash
# 观察等待动画效果
node dist/kodax.js --provider zhipu-coding "读取 README.md"

# 预期：
# 1. 等待时显示旋转动画 (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
# 2. 动画会被 \r 清除，不在终端留下痕迹
# 3. 比 Python 版本更整洁
```

### 1.2 Spinner 立即渲染测试

验证 spinner 在启动时立即渲染第一帧，消除视觉卡顿：

```bash
# 测试 spinner 立即渲染
node dist/kodax.js --provider zhipu-coding --no-confirm "
创建一个简单的 test_spinner.txt 文件
"

# 预期：
# 1. LLM 输出结束后，立即看到 "Processing..." spinner（不等待 80ms）
# 2. 从 LLM 输出到工具执行之间没有明显的"卡顿"感
# 3. 任务完成时 spinner 正确停止
```

### 1.3 任务完成时 Spinner 停止测试

验证任务完成时 spinner 正确停止：

```bash
# 测试任务完成时的 spinner 行为
node dist/kodax.js --provider zhipu-coding "你好"

# 预期：
# 1. 显示 "[KodaX] Done!"
# 2. spinner 正确停止，不再继续旋转
# 3. 程序正常退出
```

### 2. 确认机制

```bash
# 测试需要确认的操作（默认 bash, write, edit 需确认）
node dist/kodax.js --provider zhipu-coding "创建一个测试文件 test_hello.txt，内容是 Hello World"

# 预期：
# 1. Agent 请求执行 write 工具
# 2. 显示 [Confirm] 提示，等待用户输入 y/N
# 3. 输入 y 后执行，输入 n 取消
```

```bash
# 测试禁用确认
node dist/kodax.js --provider zhipu-coding --no-confirm "删除 test_hello.txt 文件"

# 预期：直接执行，无需确认
```

### 3. 流式输出

```bash
# 测试流式输出效果
node dist/kodax.js --provider zhipu-coding "写一首关于编程的短诗"

# 预期：文字逐字符/逐词显示，而非一次性输出
```

---

## P1 功能测试

### 4. 多模型支持

```bash
# 测试不同 Provider
node dist/kodax.js --provider zhipu-coding "你好"           # 智谱 Coding (GLM-5)
node dist/kodax.js --provider kimi-code "你好"              # Kimi Code (K2.5)
node dist/kodax.js --provider zhipu "你好"                  # 智谱 OpenAI 兼容 (GLM-4)
node dist/kodax.js --provider kimi "你好"                   # Kimi Moonshot

# 预期：不同 Provider 都能正常响应
```

### 5. Thinking Mode

```bash
# 测试 Thinking Mode (仅 anthropic, kimi-code, zhipu-coding 支持)
node dist/kodax.js --provider zhipu-coding --thinking "计算 123 * 456 并解释步骤"

# 预期：
# 1. 显示灰色的 [thinking] 块，包含思考过程
# 2. 然后显示正常回复
```

### 6. 会话管理

```bash
# 创建新会话
node dist/kodax.js --provider zhipu-coding "记住我的名字是 Alice"

# 列出会话
node dist/kodax.js --session list

# 预期输出：
# Sessions:
#   20260213_143000  [1 msgs]  记住我的名字是 Alice
```

```bash
# 恢复最近会话
node dist/kodax.js --provider zhipu-coding --session resume "我的名字是什么？"

# 预期：Agent 能回答 "Alice"
```

### 7. TypeScript 特有功能测试

#### 7.1 read 工具 offset/limit 参数

```bash
# 测试 offset 和 limit 参数
node dist/kodax.js --provider zhipu-coding --no-confirm "
读取 package.json 的第 2-5 行
"

# 预期：只返回第 2-5 行内容
```

#### 7.2 grep output_mode 参数

```bash
# 测试 output_mode=files_with_matches
node dist/kodax.js --provider zhipu-coding "
在 src 目录搜索包含 'Provider' 的文件，只返回文件名
"

# 预期：只返回文件名列表，不返回内容

# 测试 output_mode=count
node dist/kodax.js --provider zhipu-coding "
在 src/kodax.ts 中搜索 'async' 出现的次数
"

# 预期：返回匹配次数
```

#### 7.3 edit replace_all 参数

```bash
# 创建测试文件
node dist/kodax.js --provider zhipu-coding --no-confirm "
创建 test_replace.txt，内容是：
foo
bar
foo
baz
foo
"

# 测试 replace_all
node dist/kodax.js --provider zhipu-coding --no-confirm "
将 test_replace.txt 中所有的 foo 替换为 FOO
"

# 预期：所有 foo 都被替换（3 处）
```

#### 7.4 环境上下文（含 Node 版本）

```bash
# 测试环境上下文是否包含 Node 版本
node dist/kodax.js --provider zhipu-coding "
告诉我你运行在什么平台上，Node 版本是多少
"

# 预期：Agent 能回答平台和 Node 版本（TypeScript 版本特有）
```

### 8. 上下文压缩

```bash
# 测试上下文压缩（需要较多消息触发）
node dist/kodax.js --provider zhipu-coding --session compress_test "
请执行以下步骤：
1. 创建文件 step1.txt 内容是 'Step 1 done'
2. 创建文件 step2.txt 内容是 'Step 2 done'
3. 创建文件 step3.txt 内容是 'Step 3 done'
4. 读取所有 step*.txt 文件
5. 总结你做了什么
"

# 预期：Agent 执行多个步骤，当消息过多时自动压缩上下文
```

---

## 上下文增强测试

### 9. Git Context 自动注入

```bash
# 在 Git 仓库中测试
node dist/kodax.js --provider zhipu-coding "告诉我当前的 Git 分支和状态"

# 预期：Agent 能够直接回答当前分支，因为上下文已注入
```

### 10. 简单 Undo

```bash
# 测试 Undo 功能
node dist/kodax.js --provider zhipu-coding --no-confirm "
1. 创建 test_undo.txt，内容是 'Original Content'
2. 修改 test_undo.txt 为 'Modified Content'
3. 使用 undo 工具撤销修改
4. 读取 test_undo.txt 确认内容
"

# 预期：
# 1. 文件创建成功
# 2. 内容修改成功
# 3. undo 执行后恢复为 'Original Content'
```

---

## 长时间运行模式测试

### 11. --init 初始化

```bash
# 测试长运行任务初始化
node dist/kodax.js --provider zhipu-coding --init "构建一个简单的 TODO 应用"

# 预期：
# 1. Agent 创建 feature_list.json（包含所有功能，每个 passes: false）
# 2. Agent 创建 PROGRESS.md
# 3. Agent 执行初始 git commit
```

### 12. 长运行模式自动检测

```bash
# 在有 feature_list.json 的目录运行
node dist/kodax.js --provider zhipu-coding "继续开发"

# 预期：
# 1. 显示 "[Kodax] Long-running mode enabled"
# 2. Agent 自动读取 feature_list.json 和 PROGRESS.md
# 3. Agent 选择一个未完成的功能开始工作
# 4. Agent 结束前更新 PROGRESS.md
```

### 13. --auto-continue 模式

```bash
# 1. 首先初始化长运行项目
node dist/kodax.js --provider zhipu-coding --init "构建简单的 TODO 应用"

# 2. 检查创建的文件
ls feature_list.json PROGRESS.md

# 3. 运行 auto-continue（带限制，防止无限运行）
node dist/kodax.js --provider zhipu-coding --auto-continue --max-sessions 3 --max-hours 0.5

# 预期：
# - 显示 "[Kodax] Auto-continue mode enabled"
# - 显示 feature 进度
# - 自动运行多个 session
# - 达到限制时显示停止原因
```

### 14. Promise 信号系统

```bash
# 测试 Promise 信号
node dist/kodax.js --provider zhipu-coding --auto-continue --max-sessions 5

# 预期：如果 Agent 输出 <promise>COMPLETE</promise>，则显示:
# [Kodax Auto-Continue] Agent signaled COMPLETE
# 并退出循环
```

---

## P2 功能测试

### 15. 并行工具执行

```bash
# 测试并行读取多个文件
node dist/kodax.js --provider zhipu-coding --parallel "
读取 package.json, tsconfig.json, README.md 这三个文件，
告诉我它们各自的用途
"

# 预期：
# 1. 显示 [Kodax Parallel] Executing tools in parallel...
# 2. 工具并行执行，提高效率
```

### 16. Agent Team

```bash
# 测试多个子 Agent 并行执行
node dist/kodax.js --provider zhipu-coding --team "
分析 package.json 的依赖配置,
检查 tsconfig.json 的配置,
统计 src/kodax.ts 的代码行数
"

# 预期：
# 1. 显示 [Kodax Team] Running parallel agents...
# 2. 三个子 Agent 同时工作
# 3. 最后汇总显示每个任务的结果
```

---

## 综合测试场景

### 场景 1：代码分析

```bash
node dist/kodax.js --provider zhipu-coding --parallel "
分析 src/kodax.ts 的整体结构，
列出所有 Provider 类和它们的功能，
统计代码行数
"
```

### 场景 2：文件操作

```bash
node dist/kodax.js --provider zhipu-coding "
1. 在 /tmp 目录创建 test_kodax 文件夹
2. 在里面创建 3 个测试文件
3. 用 grep 搜索包含特定内容的文件
4. 最后清理这些文件
"
```

---

## 错误处理测试

### 1. 无效 Provider

```bash
node dist/kodax.js --provider invalid "test"
# 预期：显示错误 "Unknown provider: invalid"
```

### 2. 缺少 API Key

```bash
# 临时取消环境变量
unset ZHIPU_API_KEY
node dist/kodax.js --provider zhipu-coding "test"
# 预期：显示初始化错误
```

### 3. 文件不存在

```bash
node dist/kodax.js --provider zhipu-coding "读取 /nonexistent/file.txt"
# 预期：Agent 报告 [Tool Error] read: File not found
```

---

## Windows 环境兼容性测试

### 1. 环境感知与跨平台命令测试

```bash
# 测试环境上下文注入（Windows）
node dist/kodax.js --provider zhipu-coding --no-confirm "
创建一个 test_env.txt 文件，然后移动到 test_folder 文件夹
"

# 预期（Windows）：
# 1. Context 显示 "Platform: Windows" 和 "Node: vx.x.x"
# 2. Agent 使用 move 命令（而非 mv）
# 3. 文件成功移动
```

### 1.1 跨平台 mkdir 命令测试

```bash
# 测试 mkdir 命令提示
node dist/kodax.js --provider zhipu-coding --no-confirm "
告诉我当前平台应该使用什么命令创建嵌套目录
"

# 预期（Windows）：
# 1. Agent 知道应该使用 mkdir（不带 -p 参数）
# 2. 不会尝试执行 mkdir -p（Windows 不支持）

# 预期（Unix/Mac）：
# 1. Agent 知道应该使用 mkdir -p
```

### 1.2 工作目录路径注入测试

```bash
# 测试完整工作目录注入
node dist/kodax.js --provider zhipu-coding --no-confirm "
在当前目录创建一个测试文件 test_cwd.txt
"

# 预期：
# 1. Agent 能正确识别当前工作目录
# 2. 文件创建在正确的位置（而非 C:\Users\user\...）
```

### 2. UTF-8 编码测试

```bash
# 测试中文输出
node dist/kodax.js --provider zhipu-coding --no-confirm "echo '测试中文输出'"

# 预期：输出包含 "测试中文输出"，没有编码错误
```

### 3. Git 命令顺序执行测试

```bash
# 测试连续 git 命令不会触发 race condition
node dist/kodax.js --provider zhipu-coding --parallel --no-confirm "
1. git status
2. git log --oneline -3
"

# 预期：
# 1. 没有 ".git/index.lock" 错误
# 2. bash 命令顺序执行
```

### 4. Thinking Mode 多轮测试

```bash
# 测试 kimi-code thinking mode 多轮工具调用
node dist/kodax.js --provider kimi-code --thinking --no-confirm "
1. 读取 README.md
2. 总结主要内容
"

# 预期：
# 1. 没有 "thinking is enabled but reasoning_content is missing" 错误
# 2. 能正常执行多轮工具调用
# 3. 显示 [thinking] 块
```

---

## TypeScript vs Python 功能对比测试

### 1. 等待动画对比

| 版本 | 预期行为 |
|------|---------|
| Python | 终端留下 `...` 痕迹 |
| TypeScript | 点被 `\r` 清除，无痕迹 |

### 2. read 工具对比

| 版本 | 参数支持 |
|------|---------|
| Python | path |
| TypeScript | path, offset, limit |

### 3. grep 工具对比

| 版本 | output_mode |
|------|-------------|
| Python | 无 |
| TypeScript | content, files_with_matches, count |

### 4. edit 工具对比

| 版本 | replace_all |
|------|-------------|
| Python | 无 |
| TypeScript | 支持 |

### 5. Session 元数据对比

| 版本 | 字段 |
|------|------|
| Python | title, id, gitRoot |
| TypeScript | title, id, gitRoot, createdAt |

---

## 测试检查清单

| 功能 | 测试命令 | 状态 |
|------|---------|------|
| 基本对话 | `node dist/kodax.js "你好"` | ☐ |
| 确认机制 | `node dist/kodax.js "创建文件"` | ☐ |
| 启用自动模式 | `node dist/kodax.js --no-confirm "..."` | ☐ |
| 流式输出 | 观察输出是否逐步显示 | ☐ |
| **等待动画** | 观察点是否被清除（TS 特有） | ☐ |
| Thinking Mode | `node dist/kodax.js --thinking "..."` | ☐ |
| Session List | `node dist/kodax.js --session list` | ☐ |
| Session Resume | `node dist/kodax.js --session resume "..."` | ☐ |
| 并行执行 | `node dist/kodax.js --parallel "..."` | ☐ |
| Agent Team | `node dist/kodax.js --team "..."` | ☐ |
| **read offset/limit** | 测试分页读取（TS 特有） | ☐ |
| **grep output_mode** | 测试输出模式（TS 特有） | ☐ |
| **edit replace_all** | 测试批量替换（TS 特有） | ☐ |
| **Node 版本上下文** | 验证环境信息（TS 特有） | ☐ |
| 多 Provider | 切换不同 --provider 测试 | ☐ |
| Git Context | `node dist/kodax.js "当前分支是什么"` | ☐ |
| Undo | 修改后撤销测试 | ☐ |
| --init | `node dist/kodax.js --init "..."` | ☐ |
| --auto-continue | `node dist/kodax.js --auto-continue` | ☐ |
| Promise 信号 | Agent 主动发送 COMPLETE/BLOCKED/DECIDE | ☐ |
| **Windows UTF-8 编码** | 中文输出测试 | ☐ |
| **环境感知注入** | Agent 知道运行平台和 Node 版本 | ☐ |
| **Thinking 多轮调用** | kimi-code/zhipu-coding thinking 多工具 | ☐ |
| **跨平台 mkdir** | Windows 用 mkdir，Unix 用 mkdir -p | ☐ |
| **工作目录路径** | Agent 能识别完整工作目录 | ☐ |

---

## 性能测试

### 响应时间

```bash
# 测试首次响应时间
time node dist/kodax.js --provider zhipu-coding "你好"
# 预期：< 3 秒开始输出

# 测试并行效率
time node dist/kodax.js --provider zhipu-coding --parallel "读取 package.json, tsconfig.json"
time node dist/kodax.js --provider zhipu-coding "读取 package.json, tsconfig.json"
# 对比是否并行更快
```

---

## 测试报告模板

测试完成后，请记录：

```
测试日期：YYYY-MM-DD
测试人员：
KodaX 版本：v1.0.0
测试环境：Windows/macOS/Linux
Node 版本：vx.x.x

测试结果：
- 通过的功能：
- 失败的功能：
- 发现的问题：

TypeScript 特有功能测试：
- 等待动画：
- read offset/limit：
- grep output_mode：
- edit replace_all：
- Node 版本上下文：

建议：
```
