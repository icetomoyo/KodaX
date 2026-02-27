# Feature 009: 架构重构 - AI 层独立 + 权限层分离 - 人工测试指导

## 功能概述

**功能名称**: 架构重构 - AI 层独立 + 权限层分离
**版本**: v0.5.0
**测试日期**: 2026-02-27
**测试人员**: [待填写]

**功能描述**:
将 KodaX 架构重构为 4 层：
1. **@kodax/ai** - 独立的 LLM 抽象层，可被其他项目复用
2. **@kodax/core** - 纯 Agent 逻辑，无权限检查
3. **@kodax/repl** - 权限控制层 + UI 交互
4. **CLI** - 默认 YOLO 模式（无权限检查）

**关键变更**:
- CLI 模式不再有权限确认，直接执行
- REPL 模式保留完整权限控制
- 权限通过 `beforeToolExecute` 钩子实现

---

## 测试环境

### 前置条件
- Node.js >= 18.0.0
- 已运行 `npm install` 安装依赖
- 已运行 `npm run build` 构建项目
- 已运行 `npm link` 创建全局命令（推荐，便于测试）
- 至少配置了一个 LLM Provider 的 API Key

### 测试账号/配置
- 确保 `~/.kodax/config.json` 存在或可以创建
- 至少有一个可用的 API Key（如 `ANTHROPIC_API_KEY`）

### 环境要求
- 终端: 支持交互式输入的终端（REPL 模式需要）
- 操作系统: Windows / macOS / Linux

---

## 测试用例

### TC-001: CLI Print Mode - YOLO 模式验证

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已构建项目 (`npm run build`)
- 已配置 API Key

**测试步骤**:
1. 打开终端，进入项目根目录
2. 执行命令:
   ```bash
   kodax -p "列出当前目录的文件"
   ```
3. 观察输出

**预期效果**:
- [x] 命令直接执行，无权限确认提示
- [x] 显示当前目录文件列表
- [x] 命令执行成功退出

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-002: CLI Print Mode - 文件操作无确认

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已构建项目
- 已配置 API Key
- 当前目录有写入权限

**测试步骤**:
1. 执行命令:
   ```bash
   kodax -p "创建一个测试文件 test_feature_009.txt，内容为 'hello world'"
   ```
2. 等待命令完成
3. 检查是否创建了文件:
   ```bash
   cat test_feature_009.txt
   ```
4. 清理测试文件:
   ```bash
   rm test_feature_009.txt
   ```

**预期效果**:
- [x] 文件创建过程中无权限确认提示
- [x] 文件成功创建
- [x] 文件内容正确
- [x] 清理后文件被删除

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-003: REPL 模式 - 进入交互式界面

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已构建项目
- 已配置 API Key
- 终端支持交互式模式

**测试步骤**:
1. 执行命令:
   ```bash
   kodax
   ```
2. 观察 REPL 界面是否正常显示

**预期效果**:
- [x] 显示 KodaX ASCII Logo
- [x] 显示版本号、Provider、权限模式等信息
- [x] 显示 `>` 提示符等待输入
- [x] 无错误信息

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-004: REPL 模式 - 默认权限模式确认

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已进入 REPL 模式
- 配置文件中 `permissionMode` 为 `default` 或未设置

**测试步骤**:
1. 在 REPL 中输入:
   ```
   创建一个测试文件 test_repl_confirm.txt
   ```
2. 观察是否有确认对话框
3. 按 `y` 确认
4. 清理测试文件

**预期效果**:
- [x] 显示确认对话框，提示 "Write to file? test_repl_confirm.txt"
- [x] 显示选项: "(y) yes, (a) always yes for this tool, (n) no"
- [x] 按 `y` 后文件创建成功
- [x] 操作完成后清理成功

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-005: REPL 模式 - 权限模式切换

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已进入 REPL 模式

**测试步骤**:
1. 在 REPL 中执行:
   ```
   /mode accept-edits
   ```
2. 观察状态栏变化
3. 执行一个文件编辑操作:
   ```
   修改 test_repl_confirm.txt 文件，添加一行 "modified"
   ```
4. 观察是否还需要确认

**预期效果**:
- [x] `/mode` 命令执行成功
- [x] 状态栏显示权限模式变为 `accept-edits`
- [x] 文件编辑操作无确认直接执行（accept-edits 模式下文件操作自动执行）
- [x] bash 命令仍需确认

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-006: REPL 模式 - Plan 模式阻止修改

**优先级**: 高
**类型**: 负向测试

**前置条件**:
- 已进入 REPL 模式

**测试步骤**:
1. 在 REPL 中执行:
   ```
   /mode plan
   ```
2. 尝试执行文件修改操作:
   ```
   创建一个文件 test_plan_block.txt
   ```
3. 观察输出

**预期效果**:
- [x] 状态栏显示权限模式变为 `plan`
- [x] 文件创建被阻止
- [x] 显示类似 "[Blocked] Tool 'write' is not allowed in plan mode (read-only)" 的提示

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-007: REPL 模式 - "Always" 选项功能

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- 已进入 REPL 模式
- 权限模式为 `accept-edits`

**测试步骤**:
1. 执行一个 bash 命令:
   ```
   运行 ls -la 命令
   ```
2. 在确认对话框中按 `a` (always)
3. 再次执行相同的 bash 命令:
   ```
   运行 ls -la 命令
   ```
4. 观察第二次是否还需要确认

**预期效果**:
- [x] 第一次显示确认对话框
- [x] 按 `a` 后命令执行成功
- [x] 第二次相同命令无需确认直接执行
- [x] 配置文件中保存了 `Bash(ls -la:*)` 模式

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-008: REPL 模式 - 拒绝操作

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- 已进入 REPL 模式
- 权限模式为 `default`

**测试步骤**:
1. 执行一个文件操作:
   ```
   创建文件 test_reject.txt
   ```
2. 在确认对话框中按 `n` (no)

**预期效果**:
- [x] 显示确认对话框
- [x] 按 `n` 后操作被取消
- [x] 显示 "[Cancelled] Operation cancelled by user" 提示
- [x] 文件未被创建

**实际结果**: [待填写]
**是否通过**: [x] Pass / [ ] Fail

---

### TC-009: REPL 模式 - 受保护路径确认

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已进入 REPL 模式

**测试步骤**:
1. 尝试修改 `.kodax/` 目录下的文件:
   ```
   创建文件 .kodax/test_protected.txt
   ```
2. 观察确认对话框

**预期效果**:
- [ ] 显示确认对话框
- [ ] 提示包含 "(protected path)" 或类似说明
- [ ] 不显示 "always" 选项（受保护路径不能设置 always）
- [ ] 按 `y` 后操作执行，按 `n` 后操作取消

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: @kodax/ai 包 - 独立导入测试

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- 已构建 `@kodax/ai` 包

**测试步骤**:
1. 创建临时测试文件 `test_ai_import.mjs`:
   ```javascript
   import { KODAX_PROVIDERS, getProviderList } from '@kodax/ai';

   console.log('Available providers:', getProviderList());
   console.log('Provider registry keys:', Object.keys(KODAX_PROVIDERS));
   ```
2. 执行:
   ```bash
   node test_ai_import.mjs
   ```
3. 清理测试文件

**预期效果**:
- [ ] 成功导入 `@kodax/ai` 模块
- [ ] 显示可用的 Provider 列表
- [ ] 无错误信息

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界用例

### BC-001: CLI 无 API Key 时的错误处理
- 执行 `kodax -p "test"` 但未配置任何 API Key
- **预期**: 显示友好的错误提示，告知需要配置 API Key

### BC-002: REPL 中断操作 (Ctrl+C)
- 在 REPL 中执行长时间操作时按 Ctrl+C
- **预期**: 操作被中断，显示 "[Interrupted]" 提示，REPL 仍然可用

### BC-003: REPL 确认对话框中断
- 在确认对话框显示时按 `n`
- **预期**: 当前工具调用被取消，但 Agent 可以继续处理后续操作

### BC-004: 权限模式持久化
- 在 REPL 中切换权限模式后退出
- 再次进入 REPL
- **预期**: 权限模式与上次设置的一致

### BC-005: CLI -y 参数向后兼容
- 执行 `kodax -y -p "test"`
- **预期**: 命令正常执行，无报错（-y 参数现在是无操作）

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 10 + 5 边界 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

---

*测试指导生成时间: 2026-02-27*
*Feature ID: 009*
*Feature 名称: 架构重构 - AI 层独立 + 权限层分离*
