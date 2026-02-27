# 冷轨归档

_创建时间: 2026-02-25_
_最后更新: 2026-02-27_

---

## 墓碑区

### T03: CLI 冗余参数设计
- **失败原因**: --plan, -y/--auto, --allow, --deny, --config 参数冗余，仅需 --mode 即可覆盖所有场景
- **放弃日期**: 2026-02-26
- **尝试过程**:
  1. 最初设计了多个 CLI 参数
  2. 用户指出冗余
  3. 简化为仅 --mode 参数
  4. 配置文件路径固定，无需 --config

### T02: 50ms 延迟方案
- **失败原因**: 只是临时方案，不能根本解决问题，且命令执行的 50ms 延迟本身也不是 Issue 040 的真正解决方案
- **放弃日期**: 2026-02-25
- **尝试过程**:
  1. 发现命令执行有 50ms 延迟，agent 执行没有
  2. 最初考虑在 agent 执行也添加 50ms 延迟
  3. 用户指出 50ms 延迟不是真正解决方案
  4. 改为使用 console.log 捕获方案

### T01: WebSearch 查询 Ink patchConsole 机制
- **失败原因**: API 错误 "invalid params, function name or parameters is empty"
- **放弃日期**: 2026-02-25
- **尝试过程**:
  1. 使用 WebSearch 搜索 "ink react-ink patchConsole console.log render position"
  2. API 返回错误，无法获取 Ink 的 patchConsole 行为详情
  3. 改为通过代码分析和逻辑推理来确定根因

---

## 历史记录区

### Session: 2026-02-25

#### Turn 1 - 用户添加 Issue
**User**: 使用 /add-issue 添加 Issue 045 - Spinner 出现时问答顺序颠倒

#### Turn 2 - 代码分析
**Assistant**:
- 读取 InkREPL.tsx, MessageList.tsx, UIStateContext.tsx
- 发现 Issue 040 的解决方案：在命令执行时捕获 console.log
- 发现 agent 运行时没有类似的捕获

**Tools**: Read, Grep

#### Turn 3 - 进一步分析
**Assistant**:
- 发现 createStreamingEvents 中有 console.log（onError）
- 发现 catch 块中有 console.log
- 发现 patchConsole: true 会捕获所有 console 输出

**分析结论**:
1. 命令执行有 50ms 延迟，agent 执行没有
2. Agent 运行时的 console.log 未被捕获
3. Ink patchConsole 在流式响应期间可能产生渲染顺序问题

#### Turn 4 - WebSearch 尝试（失败）
**Assistant**:
- 尝试搜索 Ink patchConsole 的工作机制
- API 错误，搜索失败

#### Turn 5 - 最终总结
**Assistant**:
- 更新 Issue 045 描述，添加详细的根因分析
- 提出 3 个修复方案：
  - 方案 A：在 agent 运行期间也捕获 console.log
  - 方案 B：移除 patchConsole
  - 方案 C：添加 50ms 延迟

---

### 分析过程总结

**已确认的根因**：
1. Agent 执行没有 50ms 延迟（命令执行有）
2. agent 运行时的 console.log 未被捕获
3. Ink patchConsole 在流式响应期间可能产生渲染顺序问题

**待验证的假设**：
- 具体是哪个 console.log 导致了顺序问题
- patchConsole 的确切行为

**下一步**：
- 选择一个修复方案实现
- 验证修复效果

#### Turn 3 - 测试修复
**User**: 测试修复效果
**Assistant**:
- 用户发现 Thinking 内容消失问题
- 分析发现 `stopThinking()` 清空了 `thinkingContent`
- 更新 Issue 045 分析，添加 Thinking 内容消失的根因
- 修复 StreamingContext.tsx 的 `stopThinking()` 函数，保留 thinkingContent

#### Turn 4 - Issue 010 修复
**User**: 执行 /resolve-next-issue
**Assistant**:
- 自动选择 Issue 010（非空断言缺乏显式检查）
- 分析影响范围：所有调用者都有 null 检查
- 修复 project-storage.ts，添加显式 null 检查
- 提交并推送

#### Turn 5 - 生成快照
**User**: 执行 /context-snapshot
**Assistant**:
- 生成热轨快照 v2
- 添加墓碑：50ms 延迟方案

#### Turn 6 - Issue 011 修复
**User**: 执行 /resolve-next-issue
**Assistant**:
- 自动选择 Issue 011（命令预览长度不一致）
- 分析影响范围：cli-events.ts (60字符) vs prompts.ts (60字符)
- 修复方案：在 common/utils.ts 添加 PREVIEW_MAX_LENGTH = 60 常量
- 修改 index.ts 导出常量
- 修改 cli-events.ts 和 prompts.ts 使用常量

#### Turn 7 - 输入框 UX 改进
**User**: 输入框光标位置优化
**Assistant**:
- 分析 TextInput.tsx 渲染逻辑
- 修改光标位置：现在显示在 > 后空一格
- 保留 placeholder 显示在光标后
- 简化 placeholder 文字

#### Turn 8 - 生成快照
**User**: 执行 /context-snapshot
**Assistant**:
- 生成热轨快照 v3
- 添加 Issue 011 修复记录
- 添加输入框 UX 改进记录

---

### Session: 2026-02-26 (续)

#### Turn 1 - /resolve-next-issue
**User**: 执行 /resolve-next-issue
**Assistant**:
- 发现 Issue 011 已修复但状态未更新，修正状态
- 自动选择 Issue 012 (ANSI Strip 性能问题)
- 分析 status-bar.ts 中的 stripAnsi() 方法
- 修复：将正则表达式提取为模块级常量 ANSI_REGEX
- 添加 lastIndex = 0 重置确保正确匹配
- 提交 dc90177

**Tools**: Grep, Read, Edit, Bash

#### Turn 2 - Issue 035 状态检查
**User**: 指出 Issue 035 已解决
**Assistant**:
- 发现 Issue Index 显示 Resolved，但 Details 显示 Open
- 检查 git log 确认 f655fca 已修复
- 更新 Details 部分为 Resolved 状态
- 添加 Resolution 说明
- 更新 Summary: 14 Open, 27 Resolved
- 提交 9b079bc

#### Turn 3 - Issue 016 详细分析
**User**: 要求分析 Issue 016 详细情况和修复影响
**Assistant**:
- 分析 InkREPL.tsx 当前状态：994 行（原记录 637 行）
- 识别 7+ 个职责：SessionStorage, Helper, Banner, InkREPLInner, 包装器, 工具函数
- 重点分析 handleSubmit() 函数：300+ 行，包含 13 个回调
- 提出两种修复方案：
  - 方案 A（保守）：提取纯函数模块，994→800 行
  - 方案 B（激进）：提取 hooks + 模块，994→500 行
- 建议采用方案 A，低风险

**Tools**: Bash (wc -l), Read, Grep

#### Turn 4 - 生成快照
**User**: 执行 /context-snapshot
**Assistant**:
- 生成热轨快照 v4
- 添加 Issue 011, 012 修复记录
- 添加 Issue 035 状态修正记录
- 添加 Issue 016 分析结论
- 添加待决策事项

---

### Issue 016 分析详情

**当前状态**：InkREPL.tsx 994 行，比原记录的 637 行增长 56%

**职责分解**：
```
1. SessionStorage 接口 + 实现    (lines 84-136)   ~52行
2. Helper 函数                   (lines 64-81)    ~17行
3. Banner 组件                   (lines 153-240)  ~87行
4. InkREPLInner 核心组件         (lines 242-820) ~578行
   ├── 状态管理 (useState x 5)
   ├── 全局中断处理 (useKeypress)
   ├── 消息同步 (useEffect)
   ├── processSpecialSyntax()    ~45行
   ├── extractTitle()            ~8行
   ├── createStreamingEvents()   ~28行
   ├── runAgentRound()           ~16行
   └── handleSubmit()            ~300行 (巨型函数)
5. InkREPL 包装器                (lines 823-836)  ~13行
6. isRawModeSupported()          (lines 838-843)  ~5行
7. printStartupBanner() - 死代码 (lines 845-896) ~51行
8. startInkREPL() 入口           (lines 898-994) ~96行
```

**handleSubmit() 内联职责**：
1. CommandCallbacks 创建 (13个回调)
2. Console.log 捕获 (两处重复)
3. 命令解析与执行
4. Shell 命令处理
5. Plan Mode 处理
6. Agent 执行
7. 错误分类 (4种)
8. 自动保存

---

### Session: 2026-02-26 (续2)

#### Turn 1 - 继续会话
**Context**: 从压缩后恢复，继续 Issue 016 修复

**Assistant**:
- 读取 InkREPL.tsx (lines 700-780) 查找 printStartupBanner
- 确认 printStartupBanner 在 InkREPL.tsx 中是死代码（repl.ts 有独立实现）
- 删除 printStartupBanner 函数（行 707-745，约 39 行）
- 更新 utils/index.ts barrel export

**Tools**: Read, Grep, Edit, Write

#### Turn 2 - TypeScript 验证
**Assistant**:
- 运行 `tsc --noEmit` 验证编译
- 检查 InkREPL.tsx 行数：994 → 819 行 (-175 行，-17.6%)

**用户验证**: 通过

#### Turn 3 - 更新 KNOWN_ISSUES.md
**Assistant**:
- 更新 Issue 016 Index: Open → Resolved, Fixed v0.4.4
- 更新 Issue 016 Details: 添加 Resolution 部分
- 更新 Summary: 14 Open → 13 Open
- 新的 Highest Priority Open: Issue 019

#### Turn 4 - 提交推送
**Assistant**:
- 暂存 9 个文件（4 新建 + 5 修改）
- 提交: `refactor: resolve Issue 016 - InkREPL component refactoring`
- 推送: `1be18ea`

**Tools**: Bash (git status, git diff, git add, git commit, git push)

---

### Issue 016 修复详情

**执行方案**: A（保守重构）

**新建模块**:
| 模块 | 行数 | 内容 |
|------|------|------|
| session-storage.ts | ~70 | SessionStorage 接口 + MemorySessionStorage |
| shell-executor.ts | ~120 | processSpecialSyntax, executeShellCommand |
| message-utils.ts | ~76 | extractTextContent, extractTitle, formatMessagePreview |
| console-capturer.ts | ~109 | ConsoleCapturer, withCapture, withCaptureSync |

**删除代码**:
- printStartupBanner() 死代码：~39 行
- 内联函数提取：~136 行

**结果**: 994 行 → 819 行 (-175 行，-17.6%)

---

### Session: 2026-02-26 (续3 - Issue 045 修复)

#### Turn 1 - 用户询问 Thinking 机制
**User**: 询问 Issue 045 中 thinking 内容出现又消失的问题，希望优化

**Assistant**:
- 读取 StreamingContext.tsx 分析 thinking 状态管理
- 发现 `stopThinking()` 虽然保留了 thinkingContent，但 MessageList.tsx 的渲染条件 `isThinking && thinkingContent` 导致内容在 thinking 结束后消失
- 提出修复方案

**Tools**: Read, Grep

#### Turn 2 - 用户澄清需求
**User**: 澄清希望 thinking 内容在响应完成后立即消失并清空，不是等下一次请求

**Assistant**:
- 修改方案：用 `isLoading` 控制显示，响应完成时清空
- 实现 3 个文件修改：
  1. StreamingContext.tsx - 添加 `clearThinkingContent()` 方法
  2. InkREPL.tsx - 在 finally 块和中断处理中调用 `clearThinkingContent()`
  3. MessageList.tsx - 渲染条件改为 `isLoading && thinkingContent`

**Tools**: Read, Edit, Bash (tsc --noEmit)

#### Turn 3 - 提交推送
**Assistant**:
- 添加 `*.tsbuildinfo` 到 .gitignore
- 提交: `fix: thinking content persistence during response (Issue 045)`
- 推送: `30a9ea2`

**Tools**: Bash (git add, git commit, git push)

#### Turn 4 - Claude API 机制讨论
**User**: 询问为什么 thinking 和 text 会交替出现多次

**Assistant**:
- 分析 anthropic.ts 源码
- 解释 Claude API 流式响应的 content_block 交织机制
- Claude 可以在单次响应中多次切换 thinking 和 text block

**Tools**: Grep

#### Turn 5 - 生成快照
**User**: 执行 /context-snapshot

---

### Issue 045 修复详情

**问题**: Thinking 内容在 thinking 阶段结束后消失，用户希望持续显示直到响应完成

**根因**:
1. `stopThinking()` 保留了 thinkingContent
2. 但 MessageList.tsx 渲染条件 `isThinking && thinkingContent` 导致内容消失
3. 当 `stopThinking()` 设置 `isThinking=false` 时，条件不满足

**修复**:
1. 添加 `clearThinkingContent()` 方法到 StreamingContext
2. 修改 MessageList 渲染条件为 `isLoading && thinkingContent`
3. 在响应完成（finally 块）和中断时调用 `clearThinkingContent()`

**行为变化**:
| 阶段 | 旧行为 | 新行为 |
|------|--------|--------|
| Thinking 结束 | 内容消失 | 内容保留 |
| 响应进行中 | 无内容 | 显示 thinking 内容 |
| 响应完成 | N/A | 消失并清空 |

---

### Session: 2026-02-26 (续4 - FEATURE_008 权限控制体系设计)

#### Turn 1 - /add-feature 添加权限控制特性
**User**: 添加权限控制体系改进的 feature，使用 PERMISSION_CONTROL_ANALYSIS.md 作为详情

**Assistant**:
- 读取 PERMISSION_CONTROL_ANALYSIS.md（之前生成的分析文档）
- 添加 FEATURE_008 到 FEATURE_LIST.md
- 添加详细设计到 v0.5.0.md
- 删除 PERMISSION_CONTROL_ANALYSIS.md

**Tools**: Read, Edit, Write, Bash (rm)

#### Turn 2 - 用户澄清权限模式设计
**User**: 多轮讨论权限模式设计

**讨论要点**:
1. accept-edits 模式是否允许危险命令 → 需要 auto-in-project 模式
2. 三级模式与 ask 模式的关系 → 不需要 ask/code 区分，仅用四级模式
3. 配置文件位置 → 用户级 ~/.kodax/ + 项目级 .kodax/config.local.json
4. .kodax/ 目录需要永久保护
5. default 模式选 [Y] Yes always → 自动切换到 accept-edits
6. 确认提示文字 → "(only for this project)"

**Assistant**:
- 多次更新 v0.5.0.md 设计文档
- 修正配置文件引用
- 添加永久保护区域逻辑
- 添加模式切换行为

**Tools**: Read, Edit

#### Turn 3 - CLI 模式设计
**User**: 询问 CLI 模式的设计

**Assistant**:
- 添加 CLI 模式设计章节到 v0.5.0.md
- 包含：参数、配置加载、确认提示、使用示例

#### Turn 4 - 简化 CLI 参数
**User**: 指出 CLI 参数冗余

**Assistant**:
- 删除冗余参数：--plan, -y/--auto, --allow, --deny, --config
- 仅保留 --mode 参数
- 更新文档

#### Turn 5 - 项目模式权限映射
**User**: 要求梳理 --init 和 /project 的权限映射

**Assistant**:
- 读取 project-commands.ts 和 kodax_cli.ts 源码
- 分析现有机制：confirmTools Set, auto 标志
- 添加详细的代码集成设计（8.2 章节）
- 添加项目模式权限映射表
- 添加验收标准

**Tools**: Read, Grep

---

### FEATURE_008 设计详情

**四级权限模式**:
| 模式 | 文件编辑 | Shell 命令 | 危险命令 | 项目外操作 |
|------|----------|------------|----------|------------|
| plan | 禁止 | 禁止 | 禁止 | 禁止 |
| default | 需确认 | 需确认 | 需确认 | 需确认 |
| accept-edits | 自动 | 需确认 | 需确认 | 需确认 |
| auto-in-project | 自动 | 自动 | 自动 | 需确认 |

**命令模式匹配语法**:
```
Bash(git log:*)  - 匹配 git log 开头的命令
Bash(npm:*)      - 匹配 npm 开头的命令
Bash(rm:*)       - 匹配 rm 开头的命令
```

**配置加载优先级**:
1. CLI --mode 参数
2. 项目级 .kodax/config.local.json
3. 用户级 ~/.kodax/config.json
4. 代码默认值 'default'

**向后兼容**:
- `/mode code` → `accept-edits` + 提示
- `/mode ask` → `plan` + 提示
- 旧 confirmTools 设置仍有效

---

### Session: 2026-02-27 (Issue 046 + 047)

#### Turn 1 - Issue 046 修复
**Context**: 从压缩后恢复

**Assistant**:
- 读取 KNOWN_ISSUES.md 查找下一个 Open issue
- 读取 message-utils.ts, MessageList.tsx, context.ts 分析 Issue 046

**问题分析**:
1. 用户消息重复：InkREPL.tsx:481 和 agent.ts:76 都 push 用户消息
2. 响应截断：maxLines = 20 太小
3. [Complex content] 显示：纯 tool_result 消息返回占位符

**修复**:
- InkREPL.tsx: 删除重复 push (line 481)
- MessageList.tsx: maxLines 20 → 1000
- message-utils.ts: 纯非文本消息返回空字符串

**Tools**: Read, Grep, Edit

#### Turn 2 - 用户反馈 thinking 内容问题
**User**: thinking 的内容被当做正式的内容记录下来了

**Assistant**:
- 分析发现 extractTextContent 提取了 thinking 块内容
- 修复：在 extractTextContent 中跳过 thinking 块

#### Turn 3 - 验证并提交
**User**: 简单验证后觉得修复完了，可以进行 issue 状态变更以及提交代码和推送了

**Assistant**:
- 更新 KNOWN_ISSUES.md Issue 046 状态 → Resolved
- 提交: `fix: resolve Issue 046 - session restore display issues`
- 推送: `b524862`

**Tools**: Edit, Bash (git add, git commit, git push)

#### Turn 4 - Issue 047 分析开始
**User**: 执行 /resolve-next-issue

**Assistant**:
- 读取 KNOWN_ISSUES.md
- 自动选择 Issue 047 (流式输出时界面闪烁, Medium)
- 读取 InkREPL.tsx, StreamingContext.tsx 分析根因

**根因分析**:
1. Ink 默认 30fps 渲染，未使用 maxFps 限制
2. 每个 token 触发状态更新和 React 重渲染
3. 动态内容每次变化都触发全视口重绘

**推荐方案**: A + B 组合
- A. 添加 maxFps: 15 到 render() 选项
- B. 缓冲流式文本，每 50-100ms 更新一次 UI

**Tools**: Read, Grep, TodoWrite

#### Turn 5 - 生成快照
**User**: 执行 /context-snapshot

**Tools**: Read, Write, Edit

---

### Issue 046 修复详情

**问题**: Session 恢复时消息显示异常

**四个子问题及修复**:

| 问题 | 根因 | 修复 |
|------|------|------|
| 用户消息重复 | InkREPL.tsx:481 和 agent.ts:76 都 push | 删除 InkREPL 中的 push |
| 响应截断 | maxLines = 20 | 改为 1000 |
| [Complex content] | 纯 tool_result 返回占位符 | 返回空字符串 |
| thinking 作为正式内容 | extractTextContent 提取 thinking | 跳过 thinking 块 |

**修改文件**:
- packages/repl/src/ui/utils/message-utils.ts
- packages/repl/src/ui/InkREPL.tsx
- packages/repl/src/ui/components/MessageList.tsx

**Commit**: b524862

---

### Issue 047 分析详情

**问题**: 流式输出时界面偶尔闪烁，输出越快速，闪烁越频繁

**根因**:
1. **Ink 渲染机制**：
   - Ink 默认 30fps 渲染（约 33ms/帧）
   - 当前未使用 `maxFps` 参数限制渲染频率
   - `patchConsole: true` 增加额外渲染负载

2. **流式更新频率**：
   - `appendResponse()` 在 `onTextDelta` 中被调用
   - 每个 token 都触发状态更新和 React 重渲染
   - 高速输出时更新频率 > 30fps，超出 Ink 渲染能力

3. **终端渲染特性**：
   - 终端没有 DOM，每次更新需重绘整个视口
   - 动态内容每次变化都触发全视口重绘

**推荐方案**:

| 方案 | 优先级 | 难度 | 说明 |
|------|--------|------|------|
| A. maxFps 限制 | 高 | 低 | 添加 maxFps: 15 到 render() 选项 |
| B. 批量更新 | 高 | 中 | 缓冲流式文本，每 50-100ms 更新一次 UI |

**待实现** (用户中断)

---

### Session: 2026-02-27 (Issue 048 分析)

#### Turn 1 - 用户报告间歇性问题
**User**: 报告两个间歇性问题：
1. Spinner 动画期间消息乱序（响应结束后恢复）
2. 用户问题连续显示2次（非常偶现）

**Assistant**:
- 读取 InkREPL.tsx, MessageList.tsx, UIStateContext.tsx, StreamingContext.tsx, LoadingIndicator.tsx
- 分析渲染顺序和 spinner 动画相关代码

**Tools**: Read, Grep

#### Turn 2 - 根因分析
**Assistant**:

**问题 1 根因分析 (Spinner 动画期间消息乱序)**:
1. 历史消息未在 Static 组件中：
   - InkREPL.tsx:647-659 使用普通 Box 渲染 history
   - 每次状态变化触发完整重渲染

2. 三套独立更新系统：
   - UIStateContext (history 状态)
   - StreamingContext (streaming 内容，立即 notify())
   - Spinner (80ms interval, 独立 useState)

3. 竞态条件：
   - StreamingContext 每个 token 调用 notify()
   - Spinner 80ms 更新一次 frame
   - 终端全视口重绘时内容错位

**问题 2 分析 (用户消息显示2次)**:
- 用户不同意此分析，暂时搁置

**Tools**: Read

#### Turn 3 - 用户反馈
**User**: 同意问题 1 分析，建议：
1. 响应完毕的历史消息应该放在 Static 中
2. 两套独立状态系统不合理，流式内容应与 spinner 同步周期更新

**Assistant**:
- 整理问题 1 修复方案：
  - 方案 A: Static 组件隔离
  - 方案 B: 统一更新周期

#### Turn 4 - 添加 Issue 048
**Assistant**:
- 添加 Issue 048 到 KNOWN_ISSUES.md Issue Index
- 添加详细 Issue 048 部分，包含：
  - 根因分析（三套独立更新系统）
  - 修复方案 A + B
  - 影响文件列表

**Tools**: Edit

#### Turn 5 - 生成快照
**User**: 执行 /context-snapshot

---

### Issue 048 分析详情

**问题**: Spinner 动画期间消息显示乱序，响应结束后恢复正常

**根因**:
1. **历史消息未在 Static 组件中**：
   - InkREPL.tsx:647-659 使用普通 Box 渲染 history
   - Banner 使用了 Static，但 history 没有
   - 每次状态变化触发完整重渲染

2. **三套独立更新系统**：
   ```typescript
   // 1. UIStateContext - React useReducer
   const [state, dispatch] = useReducer(uiReducer, ...);

   // 2. StreamingContext - 立即 notify()
   appendResponse: (text: string) => {
     state = { ...state, currentResponse: state.currentResponse + text };
     notify();  // 每个 token 触发
   }

   // 3. Spinner - 独立 80ms interval
   useEffect(() => {
     const timer = setInterval(() => {
       setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
     }, 80);
   }, []);
   ```

3. **终端渲染特性**：
   - 终端没有 DOM diff，每次更新重绘整个视口
   - 多个状态系统异步更新导致渲染帧内容不一致

**修复方案**:
| 方案 | 说明 | 难度 |
|------|------|------|
| A. Static 组件 | 将历史消息包装在 Static 中，避免重渲染 | 低 |
| B. 统一更新周期 | 流式内容与 Spinner 共享同一更新周期 | 中 |

---

### Session: 2026-02-27 (Issue 047/048 修复)

#### Turn 1 - 实施方案 B
**Assistant**:
- 修改 StreamingContext.tsx 添加批量更新逻辑
- 添加 pendingResponseText 和 pendingThinkingText 缓冲区
- FLUSH_INTERVAL = 80ms 与 Spinner 同步
- 在关键操作前强制刷新缓冲区

**Tools**: Edit

#### Turn 2 - 用户验证
**User**: 验证通过，闪烁和乱序问题已解决

**Assistant**:
- 分析方案 A 的边际收益
- 结论：方案 A 边际收益低，不实施
- 理由：方案 B 已将更新频率从 ~100fps 降到 12.5fps

#### Turn 3 - 更新 Issue 状态
**Assistant**:
- 更新 Issue 047 状态: Open → Resolved
- 更新 Issue 048 状态: Open → Resolved
- 更新 Summary: 10 Open → 8 Open

**Tools**: Edit

#### Turn 4 - 生成快照
**User**: 执行 /context-snapshot

---

### Issue 047/048 修复详情

**问题**: 流式输出时界面闪烁 + Spinner 动画期间消息乱序

**修复方案**: 方案 B（批量更新）

**实现**:
```typescript
// StreamingContext.tsx
let pendingResponseText = "";
let pendingThinkingText = "";
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 80;

const flushPendingUpdates = () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingResponseText || pendingThinkingText) {
    state = {
      ...state,
      currentResponse: state.currentResponse + pendingResponseText,
      thinkingContent: state.thinkingContent + pendingThinkingText,
      thinkingCharCount: state.thinkingContent.length + pendingThinkingText.length,
    };
    pendingResponseText = "";
    pendingThinkingText = "";
    notify();
  }
};

const scheduleFlush = () => {
  if (!flushTimer) {
    flushTimer = setTimeout(flushPendingUpdates, FLUSH_INTERVAL);
  }
};

// 修改后的 appendResponse
appendResponse: (text: string) => {
  pendingResponseText += text;
  scheduleFlush();
}
```

**方案 A 决策**:
- 不实施 Static 组件隔离
- 边际收益低，风险/收益比不佳
- Ink reconciler 会跳过未变化内容


