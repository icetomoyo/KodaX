# Feature 011 - 智能上下文压缩 (Compact) - 人工测试指导

## 功能概述

**功能名称**: 智能上下文压缩 (Intelligent Context Compaction)
**版本**: v0.5.13
**Feature ID**: 011
**测试日期**: 2026-03-06
**测试人员**: [待填写]

**功能描述**:
实现智能上下文压缩系统，通过 LLM 生成结构化摘要来压缩对话历史，而不是简单的截断。系统会追踪文件操作（read/write/edit），并在压缩后保留这些信息。支持自动触发和手动触发（/compact 命令）。

**核心模块**:
1. 文件追踪 (file-tracker.ts) - 从消息中提取文件操作
2. 消息序列化 (utils.ts) - 将消息转换为结构化文本（**不截断，保留完整上下文**）
3. LLM 摘要生成 (summary-generator.ts) - 使用 Haiku 生成结构化摘要，支持多轮压缩
4. 核心压缩逻辑 (compaction.ts) - 检测并执行压缩，智能切割点选择
5. 配置加载 (compaction-config.ts) - 从 ~/.kodax/config.json 加载配置
6. REPL /compact 命令 (commands.ts) - 手动触发压缩
7. agent.ts 集成 - 自动压缩逻辑，错误回退

**最新改进 (v0.5.13)**:
1. ✅ **百分比配置**: 使用 `triggerPercent` 和 `keepRecentPercent` 替代绝对 token 值
2. ✅ **动态 Context Window**: 从 Provider 自动获取，支持不同模型
3. ✅ **用户级配置**: 移除项目级配置，简化配置管理
4. ✅ **UI 历史清理**: 压缩时自动清理 UI 历史记录，减少渲染负担
5. ✅ **System Role 摘要**: 摘要消息使用 'system' role，语义更准确，不会与用户输入混淆
6. ✅ **多轮压缩支持**: 使用 previousSummary 迭代更新摘要，保留关键历史信息不丢失
7. ✅ **智能切割逻辑**: 永不在 tool_result 处切割，只在 user/assistant 消息处切割，参考 pi-mono 实现
8. ✅ **完整序列化**: 不截断内容，使用 JSON.stringify 保留完整上下文，让 LLM 决定重点
9. ✅ **改进错误回退**: LLM 失败时删除最老 10% 消息，而非使用旧压缩系统，保证语义完整性

---

## 测试环境

### 前置条件
- ✅ 已安装 Node.js 18+ 和 npm/pnpm
- ✅ 已克隆 KodaX 仓库并安装依赖
- ✅ 已配置至少一个 LLM Provider (Anthropic/OpenAI/Kimi/Qwen/Zhipu/MiniMax)
- ✅ 已构建项目 (`npm run build` 或 `pnpm build`)
- ✅ 终端支持 ANSI 颜色输出

### 测试配置文件

**用户级配置** (`~/.kodax/config.json`):
```json
{
  "compaction": {
    "enabled": true,
    "triggerPercent": 75,
    "keepRecentPercent": 10,
    "contextWindow": 200000
  }
}
```

**配置字段说明**:
| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用自动压缩 |
| `triggerPercent` | number | `75` | 触发阈值百分比（0-100），如 75 表示使用 75% 上下文时触发 |
| `keepRecentPercent` | number | `10` | 保留最近消息百分比（0-100），如 10 表示保留最近 10% |
| `contextWindow` | number? | - | 覆盖 Provider 的上下文窗口（可选） |

**Context Window 获取优先级**:
```
用户配置 contextWindow > Provider 定义 > 默认值 200k
```

**各 Provider Context Window**:
| Provider | Model | Context Window |
|----------|-------|----------------|
| anthropic | Claude Sonnet 4.6 | 200,000 |
| openai | GPT-5.3 Codex | 400,000 |
| kimi-code | Kimi K2.5 | 256,000 |
| qwen | Qwen3.5 Plus | 256,000 |
| zhipu | GLM-5 | 200,000 |
| zhipu-coding | GLM-5 | 200,000 |
| minimax-coding | MiniMax-M2.7 | 204,800 |
| kimi | Moonshot V1 | 128,000 |

### 测试账号
- Provider: Anthropic Claude / OpenAI / Kimi / Qwen / Zhipu / MiniMax (需有 API Key)
- 模型: Haiku (用于摘要生成)

---

## 测试用例

### TC-001: /compact 命令基础功能 - 手动触发压缩

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL (`kodax` 或 `npm run repl`)
- 已有对话历史（至少 10 轮交互）

**测试步骤**:
1. 启动 KodaX REPL
   ```bash
   kodax
   ```
2. 输入一些消息创建历史
   ```
   你好，请帮我读取 package.json 文件
   ```
3. 继续对话，触发更多工具调用
   ```
   请修改 package.json，将版本号改为 1.0.0
   ```
4. 重复步骤 3，累积更多消息（至少 5 轮）
5. 执行 `/compact` 命令
   ```
   /compact
   ```

**预期效果**:
- [ ] 显示 `[Compacting conversation...]` 提示
- [ ] 显示压缩统计信息：
  - [ ] Tokens: 显示压缩前后 token 数（如 `120,000 → 45,000 (62% reduction)`）
  - [ ] Messages: 显示移除的消息数（如 `Removed 8 messages`）
  - [ ] Files: 显示追踪的文件数（如 `Tracked 3 files (2 read, 1 modified)`）
- [ ] 显示摘要预览（前 300 字符）
- [ ] 显示 UI 历史清理提示：`💡 Compacted context: ~X tokens compressed`
- [ ] 无错误信息

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: /compact 命令带自定义指令

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL
- 已有对话历史

**测试步骤**:
1. 累积对话历史（同 TC-001）
2. 执行带自定义指令的压缩
   ```
   /compact 重点保留关于文件修改的内容
   ```

**预期效果**:
- [ ] 显示压缩统计信息
- [ ] 摘要内容应侧重于文件修改相关内容
- [ ] 压缩成功完成

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: /compact 命令 - 禁用状态

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- 用户级配置设置 `"enabled": false`
  ```json
  {
    "compaction": {
      "enabled": false
    }
  }
  ```
- 已启动 KodaX REPL
- 已有对话历史

**测试步骤**:
1. 修改配置文件禁用压缩
2. 启动 KodaX REPL
3. 尝试执行 `/compact` 命令

**预期效果**:
- [ ] 显示 `[Compaction is disabled in config]`
- [ ] 提示在配置文件中启用
- [ ] **不执行压缩**

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: /compact 命令 - 无需压缩

**优先级**: 低
**类型**: 边界测试

**前置条件**:
- 已启动 KodaX REPL
- 对话历史很短（< 5 轮）

**测试步骤**:
1. 启动 KodaX REPL
2. 只输入 2-3 条消息
3. 执行 `/compact` 命令

**预期效果**:
- [ ] 显示 `[No compaction needed]`
- [ ] 显示当前 token 使用量
- [ ] **不执行压缩**

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: /compact 命令 - 错误处理

**优先级**: 高
**类型**: 负向测试

**前置条件**:
- Provider API Key 无效或网络异常
- 已启动 KodaX REPL
- 已有对话历史

**测试步骤**:
1. 设置无效的 API Key（或断开网络）
2. 累积对话历史
3. 执行 `/compact` 命令

**预期效果**:
- [ ] 显示错误信息：`[Compaction failed: ...]`
- [ ] **不崩溃**
- [ ] 错误信息清晰易懂

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: 配置加载 - 百分比配置

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 用户级配置文件存在 (`~/.kodax/config.json`)
- 配置使用百分比参数

**测试步骤**:
1. 创建/修改 `~/.kodax/config.json`：
   ```json
   {
     "compaction": {
       "enabled": true,
       "triggerPercent": 80,
       "keepRecentPercent": 15
     }
   }
   ```
2. 启动 KodaX REPL
3. 累积足够多的对话（触发压缩）
4. 观察压缩行为

**预期效果**:
- [ ] 压缩在 token 数接近 `contextWindow * 80%` 时触发
  - Claude (200k): 160,000 tokens
  - GPT (400k): 320,000 tokens
- [ ] 保留最近的 `contextWindow * 15%` tokens
  - Claude (200k): 30,000 tokens
  - GPT (400k): 60,000 tokens
- [ ] 配置生效

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: 配置加载 - Context Window 覆盖

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- 用户级配置包含 `contextWindow` 字段

**测试步骤**:
1. 创建配置：
   ```json
   {
     "compaction": {
       "triggerPercent": 75,
       "contextWindow": 256000
     }
   }
   ```
2. 启动 KodaX REPL (使用 Claude，默认 200k)
3. 累积对话触发压缩

**预期效果**:
- [ ] **用户配置优先**，使用 `256000` 作为 contextWindow
- [ ] 触发阈值: 256000 * 75% = 192,000 tokens
- [ ] 压缩行为符合配置的 contextWindow

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-008: 配置加载 - 默认值

**优先级**: 低
**类型**: 边界测试

**前置条件**:
- **无** 配置文件存在
- 或配置文件不包含 `compaction` 字段

**测试步骤**:
1. 删除或重命名配置文件
2. 启动 KodaX REPL
3. 执行 `/compact` 命令

**预期效果**:
- [ ] 使用默认配置：
  - [ ] `enabled: true`
  - [ ] `triggerPercent: 75`
  - [ ] `keepRecentPercent: 10`
  - [ ] `contextWindow`: 从 Provider 获取
- [ ] 压缩正常工作

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: 文件追踪 - Read 操作

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL

**测试步骤**:
1. 请求读取多个文件：
   ```
   请读取 package.json、tsconfig.json 和 README.md
   ```
2. 累积更多对话
3. 执行 `/compact`
4. 观察统计信息中的 "Files" 部分

**预期效果**:
- [ ] 显示 `Tracked X files (3 read, 0 modified)`
- [ ] 文件追踪准确

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: 文件追踪 - Write/Edit 操作

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL

**测试步骤**:
1. 请求修改文件：
   ```
   请修改 package.json，添加一个新的 script
   ```
2. 请求创建文件：
   ```
   请创建 test.txt，内容为 "Hello World"
   ```
3. 执行 `/compact`

**预期效果**:
- [ ] 显示 `Tracked X files (Y read, Z modified)`
- [ ] modified 计数 ≥ 2
- [ ] 文件追踪准确

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-011: 文件追踪 - 混合操作

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL

**测试步骤**:
1. 执行混合操作：
   ```
   请读取 package.json
   ```
   ```
   请修改 tsconfig.json
   ```
   ```
   请读取 README.md
   ```
   ```
   请创建 new-file.txt
   ```
2. 执行 `/compact`

**预期效果**:
- [ ] 显示 `Tracked X files (2 read, 2 modified)`
- [ ] 读写分类准确

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-012: 自动压缩 - 触发条件（百分比）

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 配置 `enabled: true`
- 配置 `triggerPercent: 75`

**测试步骤**:
1. 启动 KodaX REPL
2. 持续对话，累积消息（不使用 /compact）
3. 观察何时自动触发压缩

**预期效果**:
- [ ] 当 token 数接近 `contextWindow * 75%` 时自动压缩
  - Claude (200k): 150,000 tokens
  - GPT (400k): 300,000 tokens
  - Kimi (256k): 192,000 tokens
- [ ] 显示压缩统计信息
- [ ] 压缩后继续正常工作

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-013: 压缩完整性 - Tool Result 不丢失

**优先级**: **关键**
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL
- 已有包含工具调用的对话

**测试步骤**:
1. 创建对话历史：
   ```
   请读取 package.json
   ```
   （等待工具执行完成）
   ```
   请修改 tsconfig.json
   ```
   （等待工具执行完成）
2. 累积足够多的消息触发压缩
3. 执行 `/compact`
4. 检查压缩后的对话：
   ```
   之前读取的 package.json 内容是什么？
   ```

**预期效果**:
- [ ] 压缩成功
- [ ] **所有 tool_result 都在摘要中提及**
- [ ] Assistant 可以回答关于之前工具结果的问题（基于摘要）
- [ ] **没有 API 错误** (`tool_call_id not found`)

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-014: 压缩后功能正常

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已执行压缩
- 有压缩后的摘要消息

**测试步骤**:
1. 执行 `/compact`
2. 继续对话：
   ```
   请再帮我读取一下 tsconfig.json
   ```
3. 继续交互，测试功能

**预期效果**:
- [ ] 压缩后对话功能正常
- [ ] 新的工具调用正常执行
- [ ] 无错误或异常

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-015: UI 历史清理 - 压缩时清理历史记录 ⭐ 新增

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL
- 已有对话历史（至少 30 轮）

**测试步骤**:
1. 累积大量对话（30+ 轮）
2. 观察终端滚动条或历史消息数量
3. 执行 `/compact`
4. 检查 UI 历史是否被清理

**预期效果**:
- [ ] 显示 `💡 Compacted context: ~X tokens compressed`
- [ ] UI 历史记录被清理
- [ ] 只显示压缩后的消息 + 最近的消息
- [ ] 终端滚动区域明显减少
- [ ] 渲染性能提升（更流畅）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-016: 不同 Provider - Context Window 适配 ⭐ 新增

**优先级**: 中
**类型**: 兼容性测试

**前置条件**:
- 已配置多个 Provider

**测试步骤**:
1. 切换到 Claude (200k context)
   ```
   /provider anthropic
   ```
2. 累积对话，触发压缩，记录阈值
3. 清空会话
4. 切换到 GPT (400k context)
   ```
   /provider openai
   ```
5. 累积对话，触发压缩，记录阈值

**预期效果**:
- [ ] Claude 在 ~150,000 tokens 时触发（75%）
- [ ] GPT 在 ~300,000 tokens 时触发（75%）
- [ ] 不同 Provider 自动使用不同的 contextWindow
- [ ] 配置的百分比正确应用于不同 contextWindow

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-017: /help compact 查看帮助

**优先级**: 低
**类型**: UI测试

**前置条件**:
- 已启动 KodaX REPL

**测试步骤**:
1. 执行 `/help compact`

**预期效果**:
- [ ] 显示详细的帮助信息
- [ ] 包含 Usage、Description、Configuration、Examples 部分
- [ ] 格式清晰易读

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-018: 多轮压缩 - previousSummary 迭代更新 ⭐ 新增

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL
- 已有对话历史并已压缩过一次

**测试步骤**:
1. 累积对话历史
2. 执行第一次 `/compact`
3. 观察生成的摘要内容
4. 继续累积更多对话（20+ 轮）
5. 触发第二次压缩（或手动 `/compact`）
6. 观察第二次摘要内容

**预期效果**:
- [ ] 第一次压缩生成初始摘要
- [ ] 第二次压缩使用 previousSummary 更新摘要
- [ ] 新摘要包含之前的关键信息（不会丢失）
- [ ] 新摘要添加了新的对话内容
- [ ] 摘要使用 `<previous-summary>` 标签格式
- [ ] 无错误或异常

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-019: System Role 摘要消息 ⭐ 新增

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL
- 已有对话历史

**测试步骤**:
1. 累积对话历史
2. 执行 `/compact`
3. 检查压缩后的消息列表

**预期效果**:
- [ ] 摘要消息的 role 为 'system'
- [ ] 摘要内容以 `[对话历史摘要]` 开头
- [ ] System message 不会被视为用户输入
- [ ] Assistant 能正确理解这是历史摘要
- [ ] 无 API 错误

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-020: 智能切割逻辑 - tool_use/tool_result 配对 ⭐ 新增

**优先级**: **关键**
**类型**: 正向测试

**前置条件**:
- 已启动 KodaX REPL
- 对话历史包含多个工具调用

**测试步骤**:
1. 创建对话历史，包含工具调用：
   ```
   请读取 package.json
   （等待工具执行完成，返回 tool_result）
   请修改 tsconfig.json
   （等待工具执行完成，返回 tool_result）
   ```
2. 累积足够多的消息触发压缩
3. 执行 `/compact`
4. 检查压缩后的消息列表

**预期效果**:
- [ ] 压缩成功完成
- [ ] **没有 API 错误** (`tool_call_id not found`)
- [ ] 所有 tool_result 都与对应的 tool_use 在一起
- [ ] 没有孤立的 tool_result
- [ ] 切割点只在 user 或 assistant 消息处
- [ ] 摘要中提及了工具调用的结果

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-021: 错误回退 - 删除最老 10% 消息 ⭐ 新增

**优先级**: 高
**类型**: 负向测试

**前置条件**:
- Provider API Key 无效或网络异常
- 已启动 KodaX REPL
- 已有足够多的对话历史（至少 20 轮）

**测试步骤**:
1. 设置无效的 API Key（或断开网络）
2. 累积对话历史（20+ 轮）
3. 执行 `/compact` 命令

**预期效果**:
- [ ] 显示错误信息：`[Compaction Error] LLM摘要失败，回退到简单截断: ...`
- [ ] 显示回退提示：`[Compaction Fallback] 删除了最老 X 条消息`
- [ ] **删除的消息数约为总消息数的 10%**
- [ ] **不崩溃**
- [ ] **不使用旧的压缩系统**
- [ ] 对话可以继续进行

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界用例

### BC-001: 空对话压缩
- 执行 `/compact` 时无对话历史
- **预期**: 显示 "No compaction needed"

### BC-002: 单条消息压缩
- 只有一条 user 消息时执行 `/compact`
- **预期**: 显示 "No compaction needed"

### BC-003: 超长对话压缩
- 对话历史超过 150,000 tokens 时压缩
- **预期**: 大幅压缩（> 50%），无崩溃

### BC-004: 配置文件格式错误
- `~/.kodax/config.json` 格式错误（如缺少 `}`）
- **预期**: 忽略配置，使用默认值，不崩溃

### BC-005: 配置值无效
- 配置 `triggerPercent: 150` 或 `keepRecentPercent: "abc"`
- **预期**: 使用默认值或报错（不崩溃）

### BC-006: Provider 不可用
- 执行 `/compact` 时 Provider API 不可用
- **预期**: 显示错误，回退到旧压缩系统

### BC-007: 连续多次压缩
- 连续执行 3 次 `/compact`
- **预期**: 第一次压缩，后续显示 "No compaction needed"

### BC-008: Unicode 和特殊字符
- 对话包含中文、日文、emoji 等 Unicode 字符
- **预期**: 压缩正常，摘要包含这些字符

### BC-009: 大量文件追踪
- 对话中读取/修改超过 50 个文件
- **预期**: 文件追踪正常，统计准确

### BC-010: Tool Use/Tool Result 跨越切割点 ⭐ 更新
- 压缩时切割点正好在 tool_use 和 tool_result 之间
- **预期**: 切割点自动调整到最近的 user/assistant 消息处，不破坏配对
- **验证**: 无 API 错误，所有 tool_result 都与 tool_use 配对

### BC-011: 百分比边界值 ⭐ 新增
- 配置 `triggerPercent: 100` 或 `triggerPercent: 0`
- **预期**: 0 = 永不触发，100 = 接近上限才触发

### BC-012: Context Window 最小值 ⭐ 新增
- 使用 Kimi Provider (128k context) + 高 triggerPercent (90%)
- **预期**: 正确计算阈值 115,200 tokens

---

## 性能测试

### PT-001: 压缩性能 - 小对话
- 对话: < 10 轮
- **预期**: < 2 秒完成

### PT-002: 压缩性能 - 中等对话
- 对话: 20-50 轮
- **预期**: < 5 秒完成

### PT-003: 压缩性能 - 大对话
- 对话: > 100 轮
- **预期**: < 15 秒完成

### PT-004: UI 渲染性能 ⭐ 新增
- 压缩前: 50+ 轮对话
- 压缩后: UI 历史清理
- **预期**: 滚动更流畅，渲染更快

---

## 兼容性测试

### CT-001: 不同 Provider
- 测试 Anthropic Claude (200k)
- 测试 OpenAI GPT (400k)
- 测试 Kimi (256k)
- 测试 Qwen (256k)
- 测试 Zhipu (200k)
- **预期**: 所有 Provider 都正常工作，使用各自的 contextWindow

### CT-002: 旧系统兼容
- 配置 `enabled: false`
- **预期**: 使用旧的简单截断系统，无错误

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 31 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

---

## 测试优先级建议

**必须测试（P0）**:
- TC-001: /compact 命令基础功能
- TC-003: /compact 命令 - 禁用状态
- TC-005: /compact 命令 - 错误处理
- TC-006: 配置加载 - 百分比配置 ⭐ 新增
- TC-012: 自动压缩 - 触发条件（百分比）⭐ 更新
- TC-013: 压缩完整性 - Tool Result 不丢失 ⭐ **最关键**
- TC-014: 压缩后功能正常
- TC-015: UI 历史清理 ⭐ **新增，重要**
- TC-016: 不同 Provider - Context Window 适配 ⭐ **新增，重要**
- TC-018: 多轮压缩 - previousSummary 迭代更新 ⭐ **新增，关键**
- TC-019: System Role 摘要消息 ⭐ **新增，重要**
- TC-020: 智能切割逻辑 - tool_use/tool_result 配对 ⭐ **新增，最关键**
- TC-021: 错误回退 - 删除最老 10% 消息 ⭐ **新增，重要**

**应该测试（P1）**:
- TC-002: /compact 命令带自定义指令
- TC-007: 配置加载 - Context Window 覆盖 ⭐ 更新
- TC-009: 文件追踪 - Read 操作
- TC-010: 文件追踪 - Write/Edit 操作

**可选测试（P2）**:
- TC-004: /compact 命令 - 无需压缩
- TC-008: 配置加载 - 默认值
- TC-017: /help compact 查看帮助
- 边界用例
- 性能测试

---

## 测试数据准备

### 生成大量对话的脚本

```bash
# 在 REPL 中依次输入以下命令来生成对话历史：

1. 请读取 package.json
2. 请读取 tsconfig.json
3. 请读取 README.md
4. 请修改 package.json，在 scripts 中添加 "test": "echo test"
5. 请创建 test-1.txt，内容为 "Test file 1"
6. 请读取 test-1.txt
7. 请修改 test-1.txt，内容改为 "Modified test file 1"
8. 请创建 test-2.txt，内容为 "Test file 2"
9. 请列出当前目录的文件
10. 请删除 test-2.txt

# 重复以上步骤多次，累积足够的消息
```

---

## 测试报告模板

```markdown
## 测试执行报告

**测试人员**: [姓名]
**测试日期**: [日期]
**测试环境**:
- OS: [Windows/macOS/Linux]
- Node.js: [版本]
- Provider: [Anthropic/OpenAI/Kimi/Qwen/Zhipu/MiniMax]
- Context Window: [200k/400k/256k/128k]

### 测试结果

| TC ID | 测试项 | 状态 | 备注 |
|-------|--------|------|------|
| TC-001 | /compact 命令基础功能 | ✅ Pass | 压缩率 65% |
| TC-006 | 百分比配置 | ✅ Pass | 75% 触发正常 |
| TC-015 | UI 历史清理 | ✅ Pass | 历史被清理 |
| TC-016 | Provider 适配 | ✅ Pass | 不同 contextWindow 正常 |
| ... | ... | ... | ... |

### 发现的问题

1. [问题描述]
   - 严重程度: [高/中/低]
   - 复现步骤: ...
   - 预期: ...
   - 实际: ...

### 建议

- [建议1]
- [建议2]
```

---

## 新特性验证清单 ⭐

### 百分比配置
- [ ] triggerPercent 正确触发（不同 contextWindow）
- [ ] keepRecentPercent 正确保留消息
- [ ] 配置优先级正确（用户配置 > Provider > 默认）

### Context Window 动态获取
- [ ] 从 Provider 正确获取 contextWindow
- [ ] 用户可覆盖 contextWindow
- [ ] 200k 默认值正确使用

### UI 历史清理
- [ ] 压缩时清理 UI 历史记录
- [ ] 显示清理提示
- [ ] 渲染性能提升

### 用户级配置
- [ ] 只从 ~/.kodax/config.json 加载
- [ ] 不再有项目级配置
- [ ] 配置加载错误不影响系统运行

### System Role 摘要 ⭐ 新增
- [ ] 摘要消息使用 'system' role
- [ ] 摘要以 `[对话历史摘要]` 开头
- [ ] System message 不被误认为用户输入
- [ ] Assistant 正确理解历史摘要语义

### 多轮压缩支持 ⭐ 新增
- [ ] 提取之前的摘要（previousSummary）
- [ ] 使用 UPDATE_SUMMARY_PROMPT 迭代更新
- [ ] 新摘要包含历史关键信息
- [ ] 摘要不会无限增长（只保留最新）
- [ ] 使用 `<previous-summary>` 标签格式

### 智能切割逻辑 ⭐ 新增
- [ ] 只在 user 或 assistant 消息处切割
- [ ] 永不在 tool_result 处切割
- [ ] tool_use 和 tool_result 保持配对
- [ ] 无 API 错误（tool_call_id not found）

### 完整序列化 ⭐ 新增
- [ ] 序列化时不截断内容
- [ ] 使用 JSON.stringify 保留完整参数
- [ ] LLM 能从完整上下文中提取重点
- [ ] 不丢失关键信息

### 改进错误回退 ⭐ 新增
- [ ] LLM 失败时删除最老 10% 消息
- [ ] 不使用旧的压缩系统
- [ ] 显示清晰的错误提示
- [ ] 系统不崩溃，可继续对话

---

*测试指导生成时间: 2026-03-06*
*Feature ID: 011*
*测试指导版本: v2.1*
*更新内容: 百分比配置、Context Window 动态获取、UI 历史清理、用户级配置、System Role 摘要、多轮压缩、智能切割、完整序列化、改进错误回退*
*测试用例数: 31（新增 4 个关键测试用例）*
