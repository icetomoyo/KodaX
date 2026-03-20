# Feature 016: CLI-Based OAuth Providers - 人工测试指导

## 功能概述

**功能名称**: CLI-Based OAuth Providers
**版本**: v0.5.22
**测试日期**: 2026-03-08
**测试人员**: [待填写]

**功能描述**:
为 KodaX 添加两个新的 CLI-based Provider，采用 **CLI 命令包装模式**：
- 将 `codex exec` 和 `gemini -p` 作为子进程执行
- 解析其 JSON Lines 输出
- 实现零维护、完全合规的 Provider 实现

**核心特性**:
1. **Gemini CLI Provider** - 通过 `gemini -p --output-format stream-json` 调用
2. **Codex CLI Provider** - 通过 `codex exec --json --full-auto` 调用
3. **流式输出** - 解析 JSON Lines 实现实时响应
4. **多轮对话** - 通过 Session Resume 支持上下文
5. **工具调用** - 使用 CLI 内置工具（Delegate 模式）

---

## 测试环境

### 前置条件

#### 共同条件
- [ ] Node.js 18+ 已安装
- [ ] pnpm 已安装
- [ ] KodaX 项目已克隆并安装依赖

#### Gemini CLI 测试条件
- [ ] Gemini CLI 已全局安装: `npm install -g geminicli`
- [ ] 已执行 `gemini login` 完成登录
- [ ] 验证登录成功: `gemini -p "hello"` 能正常响应

#### Codex CLI 测试条件
- [ ] Codex CLI 已全局安装: `npm install -g @openai/codex`
- [ ] 已执行 `codex login` 完成登录
- [ ] 验证登录成功: `codex exec "hello"` 能正常响应

### 测试环境配置

```bash
# 克隆并安装
git clone <repo-url>
cd KodaX
pnpm install

# 构建 AI 包
pnpm -C packages/ai build
```

### 测试账号

| Provider | 安装命令 | 登录命令 |
|----------|----------|----------|
| Gemini CLI | `npm install -g geminicli` | `gemini login` |
| Codex CLI | `npm install -g @openai/codex` | `codex login` |

---

## 测试用例

### TC-001: Gemini CLI Provider - 基础调用

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- [ ] Gemini CLI 已安装并登录
- [ ] KodaX 已构建

**测试步骤**:
1. 运行命令:
   ```bash
   node packages/repl/dist/index.js --provider gemini-cli "你好，请介绍一下你自己"
   ```
2. 观察输出

**预期效果**:
- [ ] CLI 正常启动，无报错
- [ ] 收到 Gemini 的响应文本
- [ ] 响应内容合理（自我介绍）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: Codex CLI Provider - 基础调用

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- [ ] Codex CLI 已安装并登录
- [ ] KodaX 已构建

**测试步骤**:
1. 运行命令:
   ```bash
   node packages/repl/dist/index.js --provider codex-cli "Hello, what can you help me with?"
   ```
2. 观察输出

**预期效果**:
- [ ] CLI 正常启动，无报错
- [ ] 收到 Codex 的响应文本
- [ ] 响应内容合理

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: Gemini CLI Provider - 多轮对话

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- [ ] Gemini CLI 已安装并登录
- [ ] KodaX 已构建

**测试步骤**:
1. 启动交互模式:
   ```bash
   node packages/repl/dist/index.js --provider gemini-cli
   ```
2. 发送第一轮消息: `我的名字叫小明`
3. 等待响应
4. 发送第二轮消息: `你还记得我叫什么名字吗？`
5. 观察响应

**预期效果**:
- [ ] 第一轮响应正常
- [ ] 第二轮响应能正确记住名字"小明"
- [ ] Session 恢复机制正常工作

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: Codex CLI Provider - 多轮对话

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- [ ] Codex CLI 已安装并登录
- [ ] KodaX 已构建

**测试步骤**:
1. 启动交互模式:
   ```bash
   node packages/repl/dist/index.js --provider codex-cli
   ```
2. 发送第一轮消息: `Let's discuss TypeScript`
3. 等待响应
4. 发送第二轮消息: `What are its main advantages?`
5. 观察响应

**预期效果**:
- [ ] 第一轮响应正常
- [ ] 第二轮响应能关联 TypeScript 主题
- [ ] Session 恢复机制正常工作

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: Gemini CLI Provider - 工具调用（Delegate 模式）

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- [ ] Gemini CLI 已安装并登录
- [ ] KodaX 已构建
- [ ] 在一个有文件的项目目录中测试

**测试步骤**:
1. 启动 KodaX:
   ```bash
   node packages/repl/dist/index.js --provider gemini-cli
   ```
2. 发送需要工具调用的请求: `请列出当前目录下的所有文件`
3. 观察输出

**预期效果**:
- [ ] CLI 执行工具调用（Bash/Read）
- [ ] 输出中包含工具调用日志: `> [Tool Use] ...`
- [ ] 输出中包含工具结果: `> [Tool Result] ...`
- [ ] KodaX **不** 在本地执行工具（Delegate 模式）
- [ ] 最终返回正确的文件列表

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: Codex CLI Provider - 工具调用（Delegate 模式）

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- [ ] Codex CLI 已安装并登录
- [ ] KodaX 已构建
- [ ] 在一个有文件的项目目录中测试

**测试步骤**:
1. 启动 KodaX:
   ```bash
   node packages/repl/dist/index.js --provider codex-cli
   ```
2. 发送需要工具调用的请求: `Read the package.json file and summarize it`
3. 观察输出

**预期效果**:
- [ ] CLI 执行工具调用
- [ ] 输出中包含工具调用日志
- [ ] 输出中包含工具结果
- [ ] KodaX **不** 在本地执行工具（Delegate 模式）
- [ ] 返回正确的 package.json 摘要

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: CLI 未安装 - 错误处理

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- [ ] Gemini CLI **未** 安装（或临时重命名）

**测试步骤**:
1. 确保 Gemini CLI 未安装或不可用
2. 运行命令:
   ```bash
   node packages/repl/dist/index.js --provider gemini-cli "hello"
   ```
3. 观察错误提示

**预期效果**:
- [ ] 显示友好的错误提示
- [ ] 错误信息包含安装指南:
  ```
  Gemini CLI 未安装。
  请运行:
    npm install -g geminicli
    gemini login
  ```
- [ ] 程序正常退出，无崩溃

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-008: 用户取消 - Abort 处理

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- [ ] Gemini CLI 已安装并登录
- [ ] KodaX 已构建

**测试步骤**:
1. 启动 KodaX:
   ```bash
   node packages/repl/dist/index.js --provider gemini-cli
   ```
2. 发送一个需要较长响应的消息: `请详细解释量子计算的原理`
3. 在响应过程中按 `Ctrl+C` 取消

**预期效果**:
- [ ] 程序正常响应取消信号
- [ ] 无异常崩溃
- [ ] 子进程被正确清理

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: 流式输出 - 打字机效果

**优先级**: 中
**类型**: UI测试

**前置条件**:
- [ ] Gemini CLI 或 Codex CLI 已安装并登录
- [ ] KodaX 已构建

**测试步骤**:
1. 启动 KodaX:
   ```bash
   node packages/repl/dist/index.js --provider gemini-cli
   ```
2. 发送消息: `请写一首关于春天的诗`
3. 观察输出是否逐字显示

**预期效果**:
- [ ] 文本逐步显示（打字机效果）
- [ ] 无大段延迟后突然输出
- [ ] 输出流畅，无卡顿

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: Provider 切换

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- [ ] Gemini CLI 和 Codex CLI 均已安装并登录
- [ ] KodaX 已构建

**测试步骤**:
1. 使用 gemini-cli 发送消息:
   ```bash
   node packages/repl/dist/index.js --provider gemini-cli "1+1=?"
   ```
2. 记录响应
3. 使用 codex-cli 发送相同消息:
   ```bash
   node packages/repl/dist/index.js --provider codex-cli "1+1=?"
   ```
4. 比较响应

**预期效果**:
- [ ] 两个 Provider 均正常工作
- [ ] 响应格式一致（都是文本）
- [ ] 无串扰或状态混乱

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-011: Provider Registry 集成

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- [ ] KodaX 已构建

**测试步骤**:
1. 检查 Provider 列表中是否包含新 Providers:
   ```bash
   node -e "
   const { getProviderList } = require('./packages/ai/dist/providers/registry.js');
   const list = getProviderList();
   console.log(list.filter(p => p.name.includes('cli')));
   "
   ```

**预期效果**:
- [ ] 列表中包含 `gemini-cli`
- [ ] 列表中包含 `codex-cli`
- [ ] `configured` 字段反映 CLI 安装状态

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界用例

### BC-001: 空消息处理

**测试步骤**:
```bash
node packages/repl/dist/index.js --provider gemini-cli ""
```

**预期效果**: CLI 正确处理空输入，返回合理提示或错误

---

### BC-002: 超长消息处理

**测试步骤**:
```bash
node packages/repl/dist/index.js --provider gemini-cli "$(python3 -c 'print("a" * 100000)')"
```

**预期效果**: 不会崩溃，可能截断或返回错误提示

---

### BC-003: 特殊字符处理

**测试步骤**:
```bash
node packages/repl/dist/index.js --provider gemini-cli "请处理这些特殊字符: <>&\"'\\n\\t"
```

**预期效果**: 特殊字符正确传递，无编码问题

---

### BC-004: 中文消息处理

**测试步骤**:
```bash
node packages/repl/dist/index.js --provider gemini-cli "请用中文解释什么是递归"
```

**预期效果**: 中文正确处理，返回中文响应

---

### BC-005: Session 持久性

**测试步骤**:
1. 启动交互会话
2. 发送消息并获取响应
3. 保持会话打开 5 分钟
4. 再次发送消息

**预期效果**: Session 仍然有效，上下文保持

---

## 性能测试

### PF-001: 响应延迟

**测试步骤**:
1. 测量从发送消息到收到第一个字符的时间
2. 测量完整响应时间

**预期效果**:
- [ ] 首字符延迟 < 3 秒
- [ ] 流式输出无长时间停顿

---

### PF-002: 内存使用

**测试步骤**:
1. 启动 KodaX，记录初始内存
2. 进行 10 轮对话
3. 检查内存增长

**预期效果**:
- [ ] 内存无明显泄漏
- [ ] 子进程正确退出

---

## 兼容性测试

### CP-001: Windows 兼容性

**测试平台**: Windows 10/11

**测试步骤**:
- 验证 `.cmd` 后缀自动添加
- 验证路径分隔符处理

**预期效果**: 所有功能正常工作

---

### CP-002: macOS/Linux 兼容性

**测试平台**: macOS / Linux

**测试步骤**:
- 验证无需 `.cmd` 后缀
- 验证权限处理

**预期效果**: 所有功能正常工作

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 11 + 5 边界 + 2 性能 + 2 兼容性 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

| 编号 | 问题描述 | 严重程度 | 状态 |
|------|----------|----------|------|
| - | - | - | - |

---

## 附录：测试命令速查

```bash
# 构建
pnpm -C packages/ai build

# Gemini CLI 测试
node packages/repl/dist/index.js --provider gemini-cli "hello"

# Codex CLI 测试
node packages/repl/dist/index.js --provider codex-cli "hello"

# 检查 Provider 列表
node -e "console.log(require('./packages/ai/dist/providers/registry.js').getProviderList())"
```

---

*测试指导生成时间: 2026-03-08*
*Feature ID: 016*
*版本: v0.5.22*
