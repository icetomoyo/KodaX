# InfCodeX

**InfCodeX** 是词元无限新一代 AI Coding CLI，也是一个面向真实软件工程执行的智能体运行时（Agent Runtime）。

它不是一个只会在终端里“对话补全”的工具，而是一个以 **执行闭环、工程可落地、平台可集成** 为核心目标构建的 TypeScript 原生系统：既可以作为 CLI 使用，也可以作为库嵌入到更大的智能体平台中。

> 当前仓库中仍保留历史命名：**KodaX / `kodax`**。仓库名已经是 **InfCodeX**，但部分代码、命令和文档仍沿用旧名称。

---

## 为什么 InfCodeX 很重要

很多 AICoding 工具更擅长做演示、做单轮回答、做局部辅助；而 InfCodeX 更值得强调的是，它从一开始就更靠近 **真实工程执行**。

它的重要性来自以下几个方面：

- **CLI 优先**：天然适合终端开发工作流
- **运行时架构**：不是单体工具，而是分层 Agent Runtime
- **项目连续性**：支持 session、长任务、自动续跑
- **安全可控**：具备权限模式与确认边界
- **模块化复用**：可作为 CLI，也可作为 npm library
- **多智能体演进路径**：具备 parallel、team、skills 等基础能力

对于词元无限而言，InfCodeX 的价值不只是一个开发者工具，而是一个 **工程执行型智能体底座**。

---

## 一句话定位

**InfCodeX 是一个面向真实软件工程交付的 AI Coding CLI，也是一个可复用、可扩展、可治理的智能体执行运行时。**

它同时承担两种角色：

1. **面向开发者的终端智能体**
   - 阅读仓库
   - 修改代码
   - 执行命令
   - 连续推进多步工程任务

2. **面向平台的执行层组件**
   - 可作为 npm package 被复用
   - 可被上层系统编排与调用
   - 可扩展 provider、tool、skill 和项目策略

---

## 核心特色

### 1. 清晰分层的模块化架构
InfCodeX 当前采用 monorepo 结构，核心分为五个包：

- `@kodax/ai`
- `@kodax/agent`
- `@kodax/skills`
- `@kodax/coding`
- `@kodax/repl`

这不是一个细节，而是这个项目最关键的差异点之一。它说明 InfCodeX 从设计上就不是“把所有东西揉成一个 CLI”，而是把 AI、Agent、Skills、Coding、交互层拆开，便于理解、复用、替换和治理。

### 2. CLI 与库双重使用形态
InfCodeX 既可以直接拿来做终端智能体，也可以被嵌入到其他产品或系统中。

这意味着它不是一个孤立的交互工具，而更像一个 **可被上层产品调用的执行引擎**。

### 3. 多 Provider / 多模型抽象
项目当前公开文档和配置中已经体现出多 Provider 抽象能力，内置支持包括：

- Anthropic
- OpenAI
- Kimi
- Kimi Code
- Qwen
- Zhipu
- Zhipu Coding
- MiniMax Coding
- Gemini CLI
- Codex CLI

这使得 InfCodeX 在以下场景中更有战略价值：

- 模型成本优化
- 国内外模型路由
- 私有化 / 代理部署
- 企业采购与合规适配
- 上层平台统一模型治理

### 4. 面向真实仓库执行，而不是只会回答
InfCodeX 的 Coding Layer 不是只生成文本，而是围绕工程动作组织起来的。当前文档中的工具包括：

- read
- write
- edit
- bash
- glob
- grep
- undo
- diff

这意味着它的核心价值不是“回答得像不像”，而是能否围绕代码仓库形成 **思考—行动—观察—继续推进** 的执行闭环。

### 5. 权限可控的自治能力
InfCodeX 设计了四级权限模式：

- `plan`
- `default`
- `accept-edits`
- `auto-in-project`

这是一个非常重要的产品选择。它允许团队在效率与安全之间做渐进式平衡，而不是在“完全手动”和“完全放开”之间二选一。

### 6. 会话记忆与长任务连续推进
真实工程任务通常不是一轮 prompt 就能完成。InfCodeX 支持 session 持久化以及长任务工作流，因此更适合：

- 连续迭代一个 feature
- 跨多轮处理复杂问题
- 在中断后恢复上下文
- 在项目级别持续推进工作

### 7. Skills 驱动的专业化能力
InfCodeX 并不满足于通用 prompt，它内置并支持可发现的 skills、Markdown skill 定义、自然语言触发等能力。

这让它有机会从“通用 coding agent”进化为“面向特定工程场景的专业智能体”。

### 8. 天然具备向多智能体演化的路径
当前仓库中已经能看到它面向多智能体方向的基础能力，例如：

- parallel execution
- team mode
- init / auto-continue
- project mode 相关思路

这使 InfCodeX 的发展方向并不止于“单 agent CLI”，而是有潜力成为 **多智能体软件工程执行运行时**。

---

## 架构概览

```text
InfCodeX
├─ AI Layer        → Provider 抽象、流式输出、错误处理
├─ Agent Layer     → Session、消息管理、Token 工具
├─ Skills Layer    → Skill 发现、注册、执行
├─ Coding Layer    → Tools、Prompts、Agent Loop
└─ REPL / CLI      → 交互体验、权限控制、命令系统
```

这种分层设计的直接价值在于：

- **职责清晰**：每层边界明确
- **便于测试**：更容易做独立测试和替换
- **便于复用**：不必所有能力都绑死在 CLI 上
- **便于治理**：权限、规则、策略可以逐层约束
- **便于平台化**：适合作为上层智能体系统的执行底座

---

## 为什么说 InfCodeX 对 InfOne 很关键

InfOne 承载的是词元无限更长期的“智能组织 / AI org”平台愿景，强调的是：

- 如何打造多智能体组织
- 如何管理大规模智能体组织
- 如何让智能体形成可治理、可协同、可持续运转的组织能力

在这个体系里，InfCodeX 的位置非常明确，而且非常关键。

### InfOne 更像控制平面（Control Plane）
InfOne 更适合负责：

- 智能体注册与生命周期管理
- 模型路由与策略下发
- 组织级记忆与审计
- 权限、安全、观测与治理
- 大规模多智能体编排

### InfCodeX 更像执行平面（Execution Plane）
InfCodeX 更适合负责：

- 在代码仓库内真正执行任务
- 进行文件读写、命令调用、工程分析
- 按项目上下文持续推进编码任务
- 承接 SDLC 场景中的工程执行动作
- 作为终端形态或嵌入形态落地工程智能体

### 两者组合后的价值
如果只有管理层，没有执行层，平台容易停留在“管理看板”。
如果只有执行工具，没有管理层，CLI 很难上升为组织级能力。

**InfOne + InfCodeX** 的组合，恰好把这两层补齐：

- **InfOne** 解决“哪个智能体应该做什么、如何管理它们”
- **InfCodeX** 解决“软件工程任务如何被真正执行出来”

这就是 InfCodeX 的战略意义所在：
它不是一个孤立产品，而是连接 **开发者终端、仓库级执行、组织级智能体管理** 的关键桥梁。

---

## 典型使用场景

### 1. 终端里的工程助手
开发者在本地终端直接使用 InfCodeX 阅读仓库、修改代码、执行命令、推进任务。

### 2. 多步特性交付
一个特性开发不必被拆成一次性 prompt，而可以通过 session 与连续执行多轮推进。

### 3. 团队标准化工程智能体
团队可以叠加统一规则、技能、模型选择，使不同仓库和成员获得更一致的智能体行为。

### 4. SDLC 智能体执行底座
InfCodeX 可以作为编码执行层，未来承接代码生成、审查、测试、交付等更大 SDLC 智能体体系中的具体动作。

### 5. 企业渐进式落地
企业可以先从安全模式、权限模式、项目边界开始使用，再逐步走向更高自治。

---

## 能力概览

- TypeScript 原生实现
- Monorepo 分层架构
- CLI + Library 双形态
- Streaming 输出
- Thinking / Reasoning 模式
- Session 持久化
- 权限可控执行
- Skills 系统
- 并行执行
- Team 模式
- 长任务 / 自动续跑
- Windows / macOS / Linux 跨平台

---

## 快速开始

### 运行要求

- `package.json` 中声明 Node.js `>=18.0.0`
- npm workspaces

### 安装与构建

```bash
npm install
npm run build:packages
npm run build
```

### CLI 使用

```bash
export ZHIPU_API_KEY=your_api_key
kodax "Help me understand this repository"
```

### 直接运行构建产物

```bash
node dist/kodax_cli.js "your task"
```

### 常见示例

```bash
# 会话记忆
kodax --session my-project "Read package.json"
kodax --session my-project "Summarize it"

# 并行执行
kodax --parallel "analyze and improve this module"

# team 模式
kodax --team "implement,review,test"

# 初始化长任务
kodax --init "deliver feature X"

# 自动持续推进直到完成
kodax --auto-continue "finish remaining work"
```

---

## 权限模式

| 模式 | 含义 |
|------|------|
| `plan` | 只读规划模式 |
| `default` | 默认安全模式 |
| `accept-edits` | 自动接受文件编辑，bash 仍需确认 |
| `auto-in-project` | 项目范围内全自动执行 |

这使得 InfCodeX 更适合严肃工程环境，因为它不是简单追求“越自动越好”，而是提供 **可信度渐进提升** 的使用路径。

---

## 配置体系

仓库内置了完整的配置模板，支持：

- 默认 provider 选择
- provider 下的 model 选择
- provider model override
- 自定义 provider 定义
- 统一 reasoning mode
- compaction 压缩配置
- permission mode 默认值

当前文档中的配置文件路径是：

```text
~/.kodax/config.json
```

完整模板可参考 `config.example.jsonc`。

---

## 设计哲学

InfCodeX 体现出一套相对清晰的设计哲学：

- **透明优于黑盒**
- **可组合优于单体封装**
- **执行优于对话表演**
- **可治理优于无边界自动化**
- **可演进优于一次性工具化**

这正是它为什么不仅能做 CLI，还能成为更大工程智能体体系基础设施的原因。

---

## 演进方向

结合当前仓库结构和已有文档，InfCodeX 很自然的后续方向包括：

- 更强的多智能体协同
- 更多内置 skills
- 更成熟的插件 / 扩展能力
- 更深的 SDLC 集成
- IDE / Web 形态扩展
- 与 InfOne 的更紧密协同

---

## 仓库说明

当前仓库仍处于快速演进阶段，因此存在一些文档与实现前后不完全一致的地方，例如：

- `InfCodeX` 与 `KodaX` 命名并存
- 有些文档还写 7 个 provider，但更新后的 README / config 已展示 10 个内置 provider
- 包名和 CLI 命令仍是 `kodax`

因此，这份 README 更强调 **稳定的架构事实** 与 **长期产品定位**，并尽量与当前公开仓库保持一致。

---

## 相关文档

- [English README](./README.md)
- [Architecture Overview](./docs/ARCHITECTURE_OVERVIEW.md)
- [架构概览（中文）](./docs/ARCHITECTURE_OVERVIEW_CN.md)
- [InfCodeX + InfOne Positioning](./docs/PROJECT_POSITIONING.md)
- [InfCodeX + InfOne 定位说明](./docs/PROJECT_POSITIONING_CN.md)

---

## 总结

**InfCodeX 的重要性不在于它是另一个 CLI，而在于它有机会成为软件工程智能体真正的执行底座。**

对今天，它是一个执行力很强的 AICoding CLI；
对未来，它可以成为词元无限更大智能体组织体系中最关键的工程执行节点之一。
