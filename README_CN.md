<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img src="assets/logo-light.svg" alt="KodaX" width="640">
  </picture>
</p>

<p align="center">
  <b>源代码可用的 AI Coding Agent，跑你能拿到的任何 LLM。</b><br>
  Anthropic · OpenAI · DeepSeek · Kimi · 智谱 · MiniMax · 小米 MiMo · 火山方舟 · Qwen · Gemini · Codex<br>
  REPL · CLI · 库 · 免 Node 单文件二进制
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kodax-ai/kodax"><img alt="npm version" src="https://img.shields.io/npm/v/@kodax-ai/kodax?style=flat-square&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-KAI--FCL_1.0-orange?style=flat-square"></a>
  <a href="https://github.com/icetomoyo/KodaX/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/icetomoyo/KodaX?style=flat-square&logo=github&color=f1c40f"></a>
  <a href="https://github.com/icetomoyo/KodaX/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/icetomoyo/KodaX/release.yml?style=flat-square&label=release"></a>
  <img alt="providers" src="https://img.shields.io/badge/LLMs-16_aliases_+_custom-2ecc71?style=flat-square">
</p>

<p align="center">
  <a href="#30-秒上手">安装</a> ·
  <a href="#四种使用形态">使用形态</a> ·
  <a href="#为什么用-kodax">为什么用</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="docs/FEATURE_LIST.md">Roadmap</a> ·
  <a href="https://github.com/icetomoyo/KodaX/discussions">讨论</a> ·
  <a href="README.md">English README</a>
</p>

<p align="center">
  <img src="assets/kodax-hd.gif" alt="KodaX 实战演示" width="880">
</p>

---

## 版本说明

各版本的变更见 [CHANGELOG.md](CHANGELOG.md)。跨版本升级的 SDK 接入方请按
[SDK 迁移指南](docs/SDK_MIGRATION.md)操作；凭证与账号保持契约见
[接入契约](docs/LLM_INTEGRATION.md)。

## 30 秒上手

```bash
npm i -g @kodax-ai/kodax

# 选一个你有 API key 的 provider（`kodax setup --help` 会列出全部）
export ZHIPU_API_KEY=...        # ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY /
                                # KIMI_API_KEY / KIMI_CODE_API_KEY / QWEN_API_KEY /
                                # QWEN_TOKEN_API_KEY / ZHIPU_CODING_API_KEY /
                                # ZAI_CODING_API_KEY / MINIMAX_CODING_API_KEY /
                                # MIMO_API_KEY / MIMO_CODING_API_KEY / ARK_CODING_API_KEY

kodax
```

就这样。进 REPL，自然语言提问。新机器第一次交互式运行 `kodax` 时，会先检查受支持
的 API Key 环境变量。如果一个都没有，KodaX 只显示 Windows、macOS 和 Linux 的
添加方法并退出，不创建配置，也不收集或保存 Key。添加后请关闭当前终端，打开新终端，
再运行 `kodax`。如果已经存在受支持的环境变量但尚未选择 provider，KodaX 才进入
provider/model 元数据设置。使用 `kodax setup` 重新运行设置，
使用 `kodax setup --custom` 配置自定义 provider；使用 `kodax setup --help` 或
REPL `/setup --help` 查看完整路径、环境变量、命令和快捷键。交互式 setup 还会检查
一次可选 ASRT sandbox。Windows 裸交互 CLI 启动会在进入 REPL 前检查已安装 setup
generation；缺失或过期时复用同一条 setup 边界并按需请求 UAC，健康升级保留现有
sandbox SID。当前状态保持静默，并发启动只收敛到一次 setup，普通工具调用不执行
setup、也不等待 setup 锁；print 模式、daemon 与 SDK 启动绝不会自动弹 UAC。
macOS/Linux 会报告 Seatbelt/bubblewrap 所需依赖。拒绝 UAC 或缺少依赖不会破坏普通
权限管理。

> **不装 Node 的目标机器**：从 [GitHub Releases](https://github.com/icetomoyo/KodaX/releases) 拿 Bun 编译的单文件二进制（Win / macOS / Linux × x64 + arm64）。详见 [docs/release.md](docs/release.md)。

---

## 四种使用形态

| 形态 | 命令 / 入口 | 什么时候用 |
|---|---|---|
| **REPL** | `kodax` | 交互式多轮编码会话，流式 UI + 权限 + slash 命令 |
| **CLI** | `kodax -p "your task"` | 单次脚本任务、CI、批量处理 |
| **库** | `import { runKodaX } from '@kodax-ai/kodax'` | 嵌入你自己的工具 / agent / 服务 |
| **单文件二进制** | `./kodax` | 分发到没装 Node 的机器 |

---

## Runtime SDK 与共享 daemon

产品接入统一使用 `@kodax-ai/kodax/client` 的 `KodaXProductClient`。Host 负责执行、设置和存储，TUI、SDK 应用及其他 UI 提交意图并观察同一事实。详见[迁移指南](docs/SDK_MIGRATION.md)、[Client 契约](docs/CLIENT_CONTRACT.md)和[接入示例](public_docs/sdk/embedder-guide.md#product-client-integration)。

```ts
import { ensureKodaXClient } from '@kodax-ai/kodax/client';

const client = await ensureKodaXClient();
try {
  const sessions = await client.sessions.list();
  process.stdout.write(`Sessions: ${sessions.length}\n`);
} finally {
  await client.disconnect(); // 只断开当前连接，共享 Host 和 Run 继续存在。
}
```

`connectKodaXClient` 只连接已有兼容 Host；`ensureKodaXClient` 通过统一启动器启动或正常更新空闲 Host。Node 连接器不提供浏览器 HTTP/WebSocket transport。

两个产品入口均支持可选 `onStartupProgress` 和共享 `ClientStartupProgress` 类型；新 Host 通过 `initializing/phase` 报告内部初始化步骤，不增加额外探测或等待。启动 `ready` 表示 Client 接口可用；Session 加载与 UI 渲染仍有独立完成边界。详见[启动进度示例](public_docs/sdk/embedder-guide.md#show-local-startup-progress)。

底层 `/runtime` 连接唯一共享 Host，供受信任客户端处理凭据桥、Host Tools、启动和诊断；Worker-hosted embedded、通用 operation receipt/journal 已移除。不能在产品连接失败时退回私有 Runtime。下方结构化 Runtime 错误说明仅属于底层接口，不能假定 Product Client 暴露相同字段。

### 结构化且凭据安全的 Runtime 错误

自 v0.7.96 起，当 Runtime 已生成结构化失败事实时，失败和取消 Run
会在终端事件、
`handle.result` / `runs.await()`、
`runs.get()` / `runs.list()` 以及 `sessions.diagnostics()` 中提供一致的
`failureDetail`；Runtime 收尾失败形成 `unknown` 状态时通过 `run.updated` 透出。
上述字段是可选的，只在 Runtime 已生成结构化失败事实时出现。宿主应按稳定的
KodaX `providerErrorCode` 处理错误，向用户展示
`safeMessage`；`upstreamErrorCode`、`requestId`、`httpStatus` 和
`retryAfterMs` 仅作为可能缺失的支持信息。

```ts
const result = await handle.result;
if (result.failureDetail) {
  const { providerErrorCode, safeMessage, requestId } = result.failureDetail;
  showFailure(safeMessage, { providerErrorCode, requestId });
}
```

`safeMessage` 是长度受限的 KodaX 固定文案，不复制上游错误正文；Runtime 不会把
凭据、prompt、请求/响应正文、原始 headers 集合、URL、完整本地路径、stack 或原始
`Error` 复制进 `failureDetail`，仅提取文档明确列出的 allowlist 元数据。字段定义、
分类表、迁移方法和安全边界详见
[Structured Runtime failures](public_docs/sdk/embedder-guide.md#structured-credential-safe-runtime-failures)。

**v0.7.96 权限契约：**权限档位统一为 `Plan -> Edits -> Auto[LLM] -> Full Access`。
Edits 与 Auto 先尝试 sandbox；成功即静默完成，只有启动前拒绝或 backend 不可用
才在 Exec Policy 后进入用户/LLM 宿主边界。每次 Bash 调用只在入口读取一次权限档位；
Full Access 直接在宿主执行，不经过 sandbox、reviewer 或授权弹窗，也不应用内置危险命令兜底。
用户、管理员和受信项目的显式 forbidden 规则仍生效，Exec Policy `prompt` 在 Never 语义下直接拒绝。
拒绝结果以 JSON 返回来源、规则和处理方式；模型不得将其误称为机器限制或改写脚本绕过。
旧 `auto-in-project`
和 Auto[RULES] 状态只做读取兼容并归一到 Auto[LLM]；`/auto-engine` 已移除。
Reviewer 首次 90 秒，只有 timeout/provider/无效输出会再试一次 180 秒；普通失败
或具体高风险判断都不会自动弹授权框，而是拒绝本次操作并给 Agent 更安全绕行提示。
若没有安全绕行，用户可在下一条自然语言指令中给出具体知情授权，随后重新语义复核。

## 为什么用 KodaX

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <h3>🇨🇳 6 家国内 LLM 原生</h3>
      <sub>智谱 · Kimi · MiniMax · 小米 MiMo · 火山方舟 · 通义千问</sub>
      <br><br>
      first-class 适配器，跨 provider 在 5-alias canonical panel 做过 <a href="benchmark/EVAL_GUIDELINES.md">prompt-eval 校准</a> —— 不是 OpenAI-compat 转发。
    </td>
    <td width="33%" align="center" valign="top">
      <h3>📦 单文件二进制</h3>
      <sub>Bun --compile · Win / macOS / Linux · x64 + arm64</sub>
      <br><br>
      目标机器不装 Node。一份文件随处跑 —— 受管环境、内网、CI runner、断网机器都行。
    </td>
    <td width="33%" align="center" valign="top">
      <h3>🌳 可分叉会话血缘</h3>
      <sub>fork · rewind · 并行编辑</sub>
      <br><br>
      对话历史是 DAG 不是链表。即将发布的 <b>KodaX Space</b> 桌面端基于此。
    </td>
  </tr>
  <tr>
    <td align="center" valign="top">
      <h3>🤖 默认多 agent</h3>
      <sub>V2 Worker 单循环 + 实际结果评审 + 异步子 agent</sub>
      <br><br>
      <code>spawn_agent</code>、<code>send_message</code>、<code>followup_task</code>、<code>interrupt_agent</code>，多实例自动协调（content-hash safety net）。
    </td>
    <td align="center" valign="top">
      <h3>🧩 Skills + 自构造</h3>
      <sub>Markdown skill，自然语言触发</sub>
      <br><br>
      5 阶自改造阶梯（scaffold → validate → stage → test → activate），由 8 条 admission invariant 守护。
    </td>
    <td align="center" valign="top">
      <h3>🛠 50+ 内置工具</h3>
      <sub>文件 · shell · 搜索 · MCP · ACP</sub>
      <br><br>
      repo intelligence、语义搜索、git worktree、web fetch，统一从干净的 tool definition 接口暴露。
    </td>
  </tr>
</table>

## 同类产品对比

| 能力 | **KodaX** | Claude Code | Aider | Codex CLI | Cursor | Cline |
|---|---|---|---|---|---|---|
| 源代码许可 | ⚠️ KAI-FCL，非商业 | ❌ source-available | ✅ Apache&nbsp;2.0 | ✅ Apache&nbsp;2.0 | ❌ 闭源 | ✅ Apache&nbsp;2.0 |
| 免 Node 单文件 | ✅ Bun | ❌ 需 Node | ❌ 需 Python | ✅ Rust | ❌ Electron | ❌ 插件 |
| 国内 6 家原生<br><sub>（智谱·Kimi·MiniMax·MiMo·方舟·Qwen）</sub> | ✅ 6 家原生 | ❌ | ⚠ 走 LiteLLM | ❌ OpenAI 主线 | ❌ 无 provider 菜单 | ⚠ Kimi/Qwen/DeepSeek |
| 可分叉会话血缘 | ✅ fork & rewind | ⚠ routines/sessions | ❌ | ❌ | ❌ | ⚠ checkpoints |
| Multi-agent + MCP + 50+ 工具 | ✅ 三项全有 | ✅ 三项全有 | ⚠ 有 tools, 无 MCP | ✅ 三项全有 | ⚠ Composer + MCP | ✅ 三项全有 |

<sub>数据于 2026-05 对照官方公开文档核对（[Claude Code](https://github.com/anthropics/claude-code) · [Aider](https://aider.chat/docs/llms.html) · [Codex CLI](https://github.com/openai/codex) · [Cursor](https://cursor.com) · [Cline](https://github.com/cline/cline)）。⚠ 表示部分支持 / 需额外配置 / 非 first-class。欢迎 PR 修正。</sub>

## 详细配置

> 上面的 `npm i -g @kodax-ai/kodax` 一行就够了。下面这一节是给"从源码构建 / 接自定义 provider / 把 KodaX 当库使用"的场景。

### 1. 从源码构建

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build
npm link
```

构建完成后就可以直接启动：

```bash
kodax
```

### 2. 配置模型提供商

可以先运行不会收集 Key 的交互配置：

```bash
kodax setup

# 交互配置自定义 OpenAI/Anthropic-compatible provider
kodax setup --custom

# 只显示完整指导，不修改文件
kodax setup --help
```

setup 会检查以下活跃文件以及对应的 `*.example.jsonc` 注释模板：

- `~/.kodax/config.json` 与 `~/.kodax/config.example.jsonc`
- `~/.kodax/integrations/mcp.json`
- `~/.kodax/integrations/extensions.json`
- `~/.kodax/integrations/a2a.json`

活跃 `config.json` 仍是严格 JSON；`config.example.jsonc` 第一行指向全部分离配置，
并注释说明所有受支持的 core 配置项。setup 不覆盖已有文件；创建空的权威分离配置
前会先保全可读取的旧 `config.json#mcpServers` / `config.json#extensions`。命令会
先验证已有活动配置；发现无效文件时会报告并停止，不创建或覆盖任何配置。随后才会
保存 provider/model，告诉你准确的环境变量名，然后退出以便重启终端。配置自定义
provider 时，setup 要求填写的 `apiKeyEnv` 是环境变量名（例如
`MY_LLM_API_KEY`），不是 API Key 本身；`config.json` 只保存这个名字。setup 完成后，
必须把该 provider 的真实 API Key 设置为这个同名环境变量的值；KodaX 不会代为写入
系统环境变量。也可以直接设置：

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

### 2.1 激活可选 sandbox

`kodax setup` 与首次安装 setup 会检查 sandbox。Windows 裸交互 CLI 启动（包括
`kodax -r`）也会在创建 REPL Runtime 前自愈缺失或过期的 setup generation。当前
generation 只读取 marker 并立即通过；确需迁移时，启动界面会持续显示已等待时间，
不会再把最后一帧 session picker 冻在屏幕上。也可以显式检查或激活：

```bash
kodax sandbox doctor
kodax sandbox setup
```

这些宿主控制面命令应直接在用户终端中运行，不要通过 KodaX 的 Bash 工具调用。
在 REPL 内请使用 `/sandbox` 做只读就绪诊断。Windows 上，通过 Bash 启动的 doctor
自身也处于沙箱内，无法读取宿主持有的 ASRT 状态数据库；该嵌套结果不代表宿主就绪状态。

- Windows 使用受限 sandbox 账户和网络策略。普通 Terminal 即可，按提示同意激活
  所需的 UAC 确认；不必先以管理员身份启动 Terminal。并发交互启动只共享既有 setup 锁：
  一个进程修复，其他进程复查结果，shell 命令仍彼此独立。无头、print、daemon 和 SDK
  启动不会自动弹 UAC。
- macOS 使用 Seatbelt/`sandbox-exec`，需要 ripgrep：
  `brew install ripgrep`。
- Linux 使用 bubblewrap，需要 `bubblewrap`、`socat` 和 `ripgrep`，请根据发行版用
  `apt`、`dnf` 或 `pacman` 安装。宿主内核与安全策略还必须允许非特权 user
  namespace；若 backend 无法启动，KodaX 会明确报告，且不会自行修改系统策略。

KodaX 不会自动运行 `sudo` 或系统包管理器。Edits 与 Auto[LLM] 会先尝试 sandbox；
在其中完成的命令静默授权。只有已证明在启动前拒绝或 backend 不可用的精确操作
才进入对应的宿主边界；可能已经启动的命令绝不在宿主重放。
在 REPL 中，`/sandbox` 会刷新 ready 状态与诊断，但不会激活 backend 或请求提权。
逐命令 sandbox 路由属于内部机制，不显示在普通命令历史中。SDK 嵌入方还可通过
`@kodax-ai/kodax/sandbox` 在 Auto[LLM] 之外独立使用该能力，
见 [SDK sandbox 指南](public_docs/sdk/embedder-guide.md#30-standalone-sandbox-sdk-v0778)。

sandbox shell 默认继承宿主环境和普通开发凭据，并允许外部网络；固定的
KodaX/Electron 执行控制变量仍会被移除。写入范围保持在 workspace 与平台临时目录；
Windows 使用系统 TMP 下的每命令私有目录，POSIX 保留平台 canonical Temp 根与继承变量。
宿主读取范围则包含 Agent Home、凭据位置和真实的全局 Git 配置。

Qwen Token Plan 需要选择 `qwen-token-plan` 并使用单独的凭据；`QWEN_API_KEY`
不能用于该路由：

```bash
export QWEN_TOKEN_API_KEY=your_api_key
kodax --provider qwen-token-plan
```

然后在 `~/.kodax/config.json` 里写一个最小配置：

```json
{
  "provider": "zhipu-coding",
  "effort": "auto"
}
```

### 3. 启动 REPL 或执行单次任务

```bash
# 进入交互式 REPL
kodax

# 单次任务
kodax "Review this repository and summarize the architecture"
```

进入 REPL 后，你可以直接自然语言提问，也可以使用命令：

```text
/help
/mode
/agent-mode ama
```

### 4. 作为库使用

共享 Session 的 TUI、桌面/IDE 和自动化应用应使用 `@kodax-ai/kodax/client`，见[迁移指南](docs/SDK_MIGRATION.md)和[完整 Client 契约](docs/CLIENT_CONTRACT.md)。以下 `runKodaX` 示例属于独立 coding 库，不是产品客户端入口。

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX } from '@kodax-ai/kodax';

const result = await runKodaX(
  {
    provider: 'zhipu-coding',
    effort: 'auto',
  },
  'Explain this codebase'
);
```

#### SDK Subpath 导入（v0.7.39+）

如果只想用某个子能力，按 subpath 引入更轻量，bundler 也能更好地 tree-shake：

```typescript
import { Runner } from '@kodax-ai/kodax/agent';                // Agent runtime
import { getProvider } from '@kodax-ai/kodax/llm';              // LLM 抽象（16 个内置 alias）
import { runKodaX } from '@kodax-ai/kodax/coding';              // Coding tools + prompts
import { createImageArtifactFromPath } from '@kodax-ai/kodax/media'; // 输入 artifact helpers
import { SkillRegistry } from '@kodax-ai/kodax/skills';         // 零依赖 skill loader
import { loadConfig } from '@kodax-ai/kodax/repl';              // REPL 配置 / session 工具
import { createMcpManager } from '@kodax-ai/kodax/mcp';         // MCP popout manager（v0.7.42 起）
import { listSessions } from '@kodax-ai/kodax/session';         // session 历史工具
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';   // 共享 Host 连接 API
import { runKodaXSandboxed } from '@kodax-ai/kodax/sandbox';    // 独立 ASRT 受控执行
import { createKodaXA2AServer } from '@kodax-ai/kodax/a2a';    // A2A 1.0 双向接入
import { createMemoryAgent } from '@kodax-ai/kodax/experimental-memory'; // opt-in 实验性记忆 SDK
```

14 个 SDK 入口（root + 13 subpath，包含产品 `/client`）通过 ESM 共享 chunk 复用底层代码 —— 只 import `/agent` 不会把 `/repl` 的 Ink + React 一起拉进来。

完整的宿主集成契约——包括 inline/daemon 所有权、外部 Agent 注册与任务控制、session cursor 分页、workflow 模型分层和效率遥测——见 [SDK Embedder Integration Guide](public_docs/sdk/embedder-guide.md)。

> **SDK 是 ESM-only**。在 CommonJS 上下文（Electron main 进程、传统 Webpack CJS bundle、`require()` 调用方）必须用 `await import('@kodax-ai/kodax/...')` 代替 `require()`。详见 [public_docs/sdk/embedder-guide.md §5](public_docs/sdk/embedder-guide.md#5-consuming-from-a-commonjs-context-electron-main-cjs-bundles)，含 Electron main 完整 recipe + 为什么大多数 subpath 物理上无法做 dual ESM/CJS bundle。

### 5. 自定义 Provider（OpenAI / Anthropic 兼容端点）

任何 OpenAI 或 Anthropic 协议兼容的 endpoint 都可以通过 `customProviders[]` 接入，CLI 模式写在 `~/.kodax/config.json` 里：

```json
{
  "provider": "my-openai-compatible",
  "customProviders": [
    {
      "name": "my-openai-compatible",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "model": "my-model",
      "userAgentMode": "compat",
      "reasoning": {
        "efforts": ["off", "low", "medium", "high", "max"],
        "default": "high"
      }
    }
  ]
}
```

这里的 `"apiKeyEnv": "MY_LLM_API_KEY"` 表示环境变量名，不是 API Key 值。
请把自定义 provider 的真实 API Key 设置到 `MY_LLM_API_KEY` 环境变量中，然后关闭
当前终端、打开新终端，再运行 `kodax`。

原生 OpenAI Responses 可在自定义 provider 中设置 `"api": "responses"`；省略时保持 Chat Completions。Responses 使用客户端历史并保留输出块顺序；配置方式、离线验证及当前范围见 [Custom Providers](public_docs/configuration/custom-providers.md#native-responses-api)。

`userAgentMode` 默认 `"compat"`（发送 `KodaX` 而非上游 SDK 的 User-Agent）；如果你的网关要求原生 SDK header，再切到 `"sdk"`。

自定义 reasoning 模型优先使用 v0.7.57 的 `reasoning: { efforts, default }`；无 thinking 能力的模型使用 `"reasoning": "none"`。SDK 宿主的 effort 选择器应从 `reasoningProfile.supportedEfforts` / `defaultEffort` 动态生成，不要假定固定五档。

默认 Chat Completions 路径下，OpenAI-compatible provider 未声明 reasoning profile 表示能力未知。未设置 effort 时使用 `auto`：优先采用已声明默认档，否则从 `max` 开始，仅在明确的参数／档位拒绝后逐档降低。`none` 会尝试关闭；关闭被拒绝后尝试最低可用思考档。SDK 宿主通过 `onReasoningResolved` 收到用户意图、实际发送档位、回退原因和 `verified: false`；请求成功不代表模型已按该强度执行。缓存和推理数据回传规则见[详细设计](docs/DD.md#23-custom-openai-compatible-reasoning)。

#### OpenAI 兼容推理模型

部分 OpenAI-compatible 推理模型要求多轮请求时回放上一轮 assistant 的 `reasoning_content`。DeepSeek V4 thinking mode 是已知必须开启的场景；内置 DeepSeek provider 已经默认开启，但自定义 provider 需要显式配置：

```json
{
  "customProviders": [
    {
      "name": "my-deepseek-v4",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_DEEPSEEK_API_KEY",
      "model": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    }
  ]
}
```

DeepSeek Chat Completions 使用 `max_tokens`，OpenAI proper 默认使用
`max_completion_tokens`。如果网关同时代理两者，建议对这两个字段都使用
per-model override，避免把 `reasoning_content` 或不兼容的 token 字段发给错误模型：

```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    },
    { "id": "gpt-5", "replayReasoningContent": false }
  ]
}
```

如果已确认自定义端点支持缓存 affinity 路由，可以设置
`"promptCacheAffinity": true`。Anthropic-compatible 请求会把不透明逻辑上下文
key 写入 `metadata.user_id`，OpenAI-compatible 请求写入 `prompt_cache_key`。
默认值为 `false`，因为部分严格兼容网关会拒绝未知请求字段；不要只因端点宣称协议
兼容就开启。

结果由主 Agent 按需求逐项验证。内置 `visual-review` 技能覆盖图像/图表、文档/幻灯片/表格、Web/应用/终端/Canvas/3D、视频/动画，检查真实渲染证据；缺少能力或未覆盖部分明确标为未验证。必要时使用当前 Run 内普通只读子 Agent 做独立评审，主 Agent 负责修复和最终交付。

#### 给自定义 provider 开图片 / vision 输入（FEATURE_134 v0.7.40）

如果你的自定义 provider 后面的模型支持 vision，设置 `"imageInput": true` 即可，KodaX 的图片路由和 provider policy gate 都会放行图片输入。这是自托管多模态模型（vLLM / SGLang 部署 Qwen-VL 类模型、OpenAI-compatible 端点）的典型用法：

```json
{
  "customProviders": [
    {
      "name": "my-vllm",
      "protocol": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "MY_VLLM_API_KEY",
      "model": "Qwen/Qwen3.8-27B-Instruct",
      "imageInput": true
    }
  ]
}
```

`imageInput: true` 会在 KodaX 所有层面（provider 实例、能力查询、policy gate）强制 `capabilityProfile.multimodalSupport: "image-input"`，显式写了 `"none"` 也会被覆盖。进阶写法 —— 手写 `capabilityProfile` 块并设 `"multimodalSupport": "image-input"` —— 同样有效，详见 [Custom Providers](public_docs/configuration/custom-providers.md)。纯文本模型保持不设即可，图片 artifact 会在请求发出前被 `MODEL_INPUT_UNSUPPORTED` 拒绝。

内置 vision-capable alias（Anthropic、OpenAI、Kimi、Qwen、Zhipu、MiniMax、MiMo、Ark，以及通过 CLI `@<path>` file-include 语法传图的 Gemini-CLI）已经默认开了图片输入。内置 `deepseek` 的默认模型 `deepseek-flash`（DeepSeek-V4.1-Flash）原生支持图片理解；兼容名 `deepseek-v4-pro` 和 Codex-CLI 是纯文本；自定义 provider 在底层模型支持图片输入时需要手动 opt-in。

序列化层（Anthropic-compat 走 `packages/llm/src/providers/anthropic.ts:1431`，OpenAI-compat 走 `openai.ts:1496`）通过基类继承自动转发 image block —— OpenAI-compatible 端点收到的是标准 `image_url` 块。这个 flag 只控制 KodaX 自身是否预先拒绝多模态请求 —— 上游模型到底支不支持 vision 由 provider 自己决定。如果模型实际是 text-only，你会看到真实的上游 API 错误，而不是 KodaX 一侧的 `[Provider Policy] multimodal requests are unsupported` 预拦截。

库模式下用 `registerCustomProviders()` 显式注册：

```typescript
import { registerCustomProviders, runKodaX } from '@kodax-ai/kodax';

registerCustomProviders([
  {
    name: 'my-openai-compatible',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'MY_LLM_API_KEY',
    model: 'my-model',
    userAgentMode: 'compat',
  },
]);

await runKodaX({ provider: 'my-openai-compatible' }, '解释这个仓库');
```

### 6. 统一 Client 与本机 Host

当前产品入口采用共享 daemon Host，TUI 和 SDK 产品客户端都通过统一契约提交输入、读取状态、回答交互。`--runtime-mode`、`KODAX_RUNTIME_MODE` 和 config 的 `runtimeMode` 已从产品面移除。

```bash
kodax daemon start
kodax -p "检查这个仓库"
kodax daemon stop --profile default
```

daemon 可承载多个 Session；不同 Session 可以并发，同一 Session 的交付由 Host 串行协调。`after_turn` 可在当前 Run 的安全点交付，不必等整个长任务结束。客户端关闭观察或断开连接不会停止 Run。停止任务使用 `runs.stop` 或 `sessions.cancel`；关闭空闲 Host 才使用 `host.shutdown`/daemon stop。

未发布的统一 Host 收口已退役公开 embedded 构造与 inline 所有权切换；完整产品能力统一使用 `/client`。独立 llm/agent/coding 库仍可单独使用。旧状态自动迁移与降级限制见 SDK 迁移指南。当前包版本与发布状态见[SDK 迁移指南](docs/SDK_MIGRATION.md)。

普通 CLI 自动拉起的 Host 在最后一个客户端断开、后台工作持续空闲 30 秒后退出；重新连接会取消空闲退出。显式 `kodax daemon start` 会保留当前 Host，即使它原先是临时 Host；承载已配置 A2A 服务的 Host 也会在没有 CLI 客户端时继续常驻。

### 7. 打包成单文件二进制（无需 Node）

KodaX 可以用 `bun --compile` 打包成单可执行文件 + 一个 `builtin/` sidecar 目录，目标机器**不需要安装 Node.js 或任何运行时**。

支持目标：`win-x64`、`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`。Win7 / glibc < 2.28 的发行版 / 龙芯 LoongArch 暂不支持。

本地构建：

```bash
# 先在构建机器上装好 Bun（一次性）
npm i -g bun                  # 或 scoop / brew / curl，详见 docs/release.md

npm run build:binary          # 当前平台（最快）
npm run build:binary:all      # 一台机器出全部 5 个目标
node scripts/build-binary.mjs --target=linux-arm64   # 指定平台
```

产物在 `dist/binary/<target>/`：

```
dist/binary/linux-x64/
├── kodax                          # ~60 MB Bun 编译的二进制
├── builtin/                       # 内置 skills sidecar
├── provider-capabilities.json
├── semantic-worker.js             # Repo intelligence Worker
└── constructed-handler-worker.js  # Constructed tool Worker
```

冒烟验证：`dist/binary/<host>/kodax --version`。

**自动发布**：推送 `v*` git tag 会触发 `.github/workflows/release.yml`，在原生 runner 上构建全部 5 个目标、跑冒烟测试，然后自动创建 GitHub Release 并上传 archives + SHA256SUMS。也可以从 Actions UI 用 `workflow_dispatch` 不打 tag 跑流水线测试。

详细的构建参数、archive 结构、`KODAX_BUNDLED` / `KODAX_VERSION` build-time defines、故障排查，参见 [docs/release.md](docs/release.md)。

## 内置 Provider 列表

| Provider | 环境变量 | Reasoning | 默认 Model |
|----------|----------|-----------|-----------|
| anthropic | `ANTHROPIC_API_KEY` | Native | claude-sonnet-4-6（可 `/model` 切换 `claude-opus-4-6` / `claude-haiku-4-5`） |
| openai | `OPENAI_API_KEY` | Native | gpt-5.3-codex（可 `/model` 切换 `gpt-5.4` / `gpt-5.3-codex-spark`） |
| kimi | `KIMI_API_KEY` | Native | kimi-k2.7-code（262,144 token；可 `/model` 切换 `kimi-k3.1-pro` / `kimi-k3.1-pro-highspeed` / `kimi-k3`〔1M〕/ `kimi-k2.7-code-highspeed` / `kimi-k2.6` / `kimi-k2.5`） |
| kimi-code | `KIMI_CODE_API_KEY` | Native | k3-256k（Moderato+，256K，直接请求同名上游模型；可 `/model` 切换 `k3.1-pro` / `k3.1-pro-highspeed` / `k3`〔1M〕/ `kimi-for-coding` / `kimi-for-coding-highspeed`；K3.1 必须开启思考） |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| qwen-token-plan | `QWEN_TOKEN_API_KEY` | Native | qwen3.8-max（Anthropic 协议；可 `/model` 切换兼容项 `qwen3.8-max-preview` 及 `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-flash` / `glm-5.2` / `deepseek-v4-pro`；均为 1M ctx；两个 Qwen 3.8 ID / 3.7 Plus / 3.6 Flash 支持图片理解） |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5（可 `/model` 切换 `glm-5.3` / `glm-5.2`，均为 1M ctx，另有 `glm-5.1` / `glm-5-turbo`；GLM-5.3 开放平台 API 仍标注为即将上线） |
| zhipu-coding | `ZHIPU_CODING_API_KEY` | Native | glm-5.3（1M ctx、128K 最大输出；可回退到 `glm-5.2`，也可切换 `glm-5-turbo` / `glm-4.7`；原样发送上游 ID） |
| zai-coding | `ZAI_CODING_API_KEY` | Native | glm-5.3（保留 `glm-5.2` 回退；原样发送上游 ID；2026-08-15 起默认从 glm-5.2 切换） |
| minimax-coding | `MINIMAX_CODING_API_KEY` | Native | MiniMax-M3.1-Flash（M Plan，1M 上下文，原生五档推理，思考始终开启） |
| mimo | `MIMO_API_KEY` | Native | mimo-v2.6-pro（小米 MiMo 按量计费，也可选 V2.6 Flash） |
| mimo-coding | `MIMO_CODING_API_KEY` | Native | mimo-v2.6-pro（小米 MiMo Token Plan，也可选 V2.6 Flash；支持图片、思考开关） |
| ark-coding | `ARK_CODING_API_KEY` | Native | glm-5.3（方舟 Coding Plan；新增 `deepseek-v4.1-flash` / `deepseek-v4.1-flash-economy`、`glm-5.3-flash`、`kimi-k3.1-pro` / `kimi-k3` / `kimi-k2.8-preview`；六款均支持图片；保留历史配置 ID） |
| deepseek | `DEEPSEEK_API_KEY` | Native | deepseek-flash（Anthropic 协议；DeepSeek-V4.1-Flash，1M ctx，原生图片理解；可 `/model` 切换纯文本兼容名 `deepseek-v4-pro`） |
| gemini-cli | 由 Provider CLI 完成认证（无 KodaX API-key 环境变量） | Prompt-only / CLI bridge | （通过 gemini CLI） |
| codex-cli | 由 Provider CLI 完成认证（无 KodaX API-key 环境变量） | Prompt-only / CLI bridge | （通过 codex CLI） |

> 不在表里的端点：用上面"自定义 Provider"那一节加进来即可。

## 内置工具一览

KodaX 有 50+ 个内置工具，按类别分组如下（实际暴露给 LLM 是一张扁平表）。

**文件操作**

| 工具 | 说明 |
|------|------|
| `read` | 读取文件（支持 offset / limit） |
| `write` | 创建新文件或完整重写 |
| `edit` | 精确字符串替换（支持 `replace_all`） |
| `multi_edit` | 对同一文件做一批独立 edit，整批原子提交 |
| `insert_after_anchor` | 在唯一 anchor 后插入内容，避免整文件重写 |
| `undo` | 撤销最近一次文件修改 |

**Shell 与搜索**

| 工具 | 说明 |
|------|------|
| `bash` | 执行 shell 命令（支持后台、输出截断） |
| `glob` / `grep` | 文件名匹配 / 正则内容搜索 |
| `code_search` | 代码搜索，比裸 grep 噪音更低 |
| `semantic_lookup` | 借助 repo intelligence 的符号 / 模块 / 流程感知查找 |
| `web_search` / `web_fetch` | 联网搜索 / 抓取，自带 trust + 时效信号 |

**Repo Intelligence working tools**

| 工具 | 说明 |
|------|------|
| `repo_overview` | 仓库结构、关键区域、入口提示、intelligence 快照 |
| `changed_scope` | 当前 diff 涉及的文件 / 区域 / 类别 |
| `changed_diff` / `changed_diff_bundle` | 单文件 / 多文件分页 diff |
| `module_context` | 模块 capsule（依赖、入口、符号、测试、文档） |
| `symbol_context` | 定义 + 可能的 caller/callee + 备选 |
| `process_context` | 入口的近似静态执行/流程 capsule |
| `impact_estimate` | 符号 / 路径 / 模块的影响面估算 |

**MCP 能力**（配置了 MCP server 时可用）

| 工具 | 说明 |
|------|------|
| `mcp_search` / `mcp_describe` / `mcp_call` | 通过共享 capability runtime 发现并调用 MCP 工具 |
| `mcp_read_resource` / `mcp_get_prompt` | 读取 MCP 资源、获取 MCP prompt |

**Git Worktree**

| 工具 | 说明 |
|------|------|
| `worktree_create` | 在隔离分支上新建 worktree，让 agent 安全工作 |
| `worktree_remove` | 移除 worktree（自带安全检查） |

**Agent 控制 / 交互**

| 工具 | 说明 |
|------|------|
| `spawn_agent` | 创建命名子 Actor，并在继承权限、会话并发和根工作预算约束下启动首个 Turn。 |
| `send_message` | 向 Actor 的持久 mailbox 提交有界信息，不启动新 Turn。 |
| `followup_task` | 在安全边界加入运行中的 Actor，或为 idle Actor 原子启动新 Turn。 |
| `wait_agent` | 等待当前作用域的 mailbox / 用户输入 / 中断 / 超时，只返回唤醒确认，Actor progress 不会唤醒模型。 |
| `interrupt_agent` | 请求中断 active Turn，同时保留 Actor 身份。 |
| `list_agents` | 查看调用方有权访问的 Actor 子树与 Turn 状态。 |
| `agent_output` | 读取有权限的 Actor/Turn 有界持久输出。 |
| `ask_user_question` | 向用户发起单选 / 多选 / 自由文本提问 |
| `exit_plan_mode` | 仅在当前 REPL/宿主提供审批回调时提交最终方案 |

## 项目指令

把简短、默认生效的 Markdown 约定放到 `~/.kodax/rules/*.md` 或
`<项目根>/.kodax/rules/*.md`。用户目录跟随 `KODAX_HOME`。KodaX 按文件名排序读取
直属 `.md` 文件，在模型首次操作前注入完整正文和来源路径。目录缺失或为空时，
提示词没有新增内容。该格式只发现直属文件，正文按普通 Markdown 处理。

指令顺序为用户 rules → 用户 `AGENTS.md` → 项目 rules → 根目录到工作目录的
`AGENTS.md` → 项目 `.kodax/AGENTS.md`。两级同名文件均保留。没有 Git 根目录时，
从当前工作目录加载项目 rules。单文件上限为 8 KiB UTF-8，用户和项目各有 16 KiB
总额度（含来源标题开销）。超大、不可读或超出总额度的文件会整份跳过并提供诊断。
`/reload` 展示已加载路径和跳过原因。已运行的托管 Run 使用自身的指令快照，
可写子 Agent 沿用项目上下文接收规则。SDK 自定义提示词、只读子 Agent 按各自既有
指令契约运行，绑定宿主的可读路径限制也适用于规则文件。

需要强制执行的命令审批使用 `exec-policy.jsonc`，较长的任务专用流程可以放进 Skills。

## 内置 Skills

五个核心 Skill（git-workflow、tdd、code-review、skill-creator、visual-review）
默认开放自然语言发现；概念解释与无关任务不应触发工作流。TDD 的“仅补测试”
分支允许首次通过，不扩大生产代码改动；Skill Creator 按创建、打包、评测分支
执行，分享包不默认安装到个人目录。`Bash(git *, npm *)` 匹配完整命令，仍保留
Host 授权与沙箱。

描述语义筛查不等于观察到真实 Skill 调用。独立 SDK 评测需明确 Provider、model、
cwd 和预算，见[评测方法](packages/agent/src/capabilities/skills/builtin/skill-creator/references/evaluation.md)。
可选 artifact-review 聚焦已注册 Artifact 工具；与 visual-review 一样，受管准备
被拒绝或能力缺失时，受影响范围保留为未验证。

### 将 learned Skill 提升到用户正式目录

自动 canary 激活和用户目录提升不是一回事：

- 独立验证成功会把项目 Learned Area 中的 `testing` 变为
  `active_learned`；
- `/learn promote` 是一次显式所有权转移：它把精确 fingerprint 对应、且已审查的
  `ready` 或 `active_learned` revision 复制到用户正式 Skill 目录，并把生命周期
  改为 `promoted_user`。

先检查具体 revision，再按名称、slug 或精确 capability ID 提升：

```text
/learn show normalize-release-notes
/learn promote normalize-release-notes --scope user
```

`--scope user` 是目前唯一支持的 scope，也可以省略。错误 scope、未知或重复
option，以及多余参数都会失败且不改变目录。目标位置是所配置 KodaX home 下的
`skills/<slug>/SKILL.md`，通常为
`~/.kodax/skills/<slug>/SKILL.md`；不同内容的同名正式 Skill 永远不会被覆盖。

专属帮助入口为 `/learn promote --help`、`/learn help promote` 和
`/help learn promote`。在 Ink Learning Center 中可执行 `/learn`，选择一个
`active_learned` Skill，再选择 **Promote to user catalog**。

## Repo Intelligence（内置 full/light 引擎）

KodaX 内置 repo intelligence（`repo_overview` / `module_context` / `symbol_context` / `process_context` / `impact_estimate` 等），让 coding agent 不靠零散 grep/glob 就能理解大型仓库。

REPL 中使用 `/repo-intel status` 查看当前引擎状态。旧的独立 `repointel` host skill 已移除；repo intelligence 已内置于 KodaX，无需任何外部安装。

```bash
# 选一个运行模式（auto | full | light | off）
kodax --repo-intelligence full --repo-intelligence-trace
```

## 仓库结构

KodaX 是基于 npm workspaces 的 TypeScript monorepo，**4 个核心 workspace 包与私有 Artifact 源码模块**（FEATURE_194 v0.7.43 包合并 — 9 → 4，ADR-036），npm 上以单 bundle 包 `@kodax-ai/kodax` 发布 + 17 个 SDK subpath exports（`/agent`、`/llm`、`/coding`、`/media`、`/repl`、`/skills`、`/mcp`、`/session`、`/client`、`/runtime`、`/sandbox`、`/a2a`、`/experimental-memory`、`/artifacts`、`/artifacts/client`、`/artifacts/runtime`、`/artifacts/kodax`；ADR-024 + ADR-032 + ADR-038）。核心包：

| Workspace 包 | 作用 | 主要依赖 |
|----|------|---------|
| `@kodax-ai/llm` | LLM 抽象层（16 个内置 provider alias + 自定义 provider 注册），可独立使用 | `@anthropic-ai/sdk`, `openai` |
| `@kodax-ai/agent` | 通用 Agent 框架 —— Runner / runFanOut / runWithIdleYield / AgentActorController / AgentTurnScheduler + media/input artifacts + 会话管理 + tokenization + 面向自定义 loop 的可插拔 compaction primitive（不关闭 KodaX coding runtime 的始终开启策略）+ **inline 后**:session-lineage 子树 + capabilities (mcp + skills + builtin) + tracing（subpaths: `/media`、`/session-lineage`、`/capabilities/mcp`、`/capabilities/skills`、`/tracing`） | `@kodax-ai/llm`, `fflate`, `jimp`, `yaml` |
| `@kodax-ai/coding` | Coding Agent:50+ 工具（含 canonical Actor 协作工具）、role prompts、agent loop、auto-continue + repo-intelligence protocol(v0.7.43 inline) | `@kodax-ai/llm`, `@kodax-ai/agent` |
| `@kodax-ai/repl` | 完整交互式终端 UI（Ink / React、权限模式、命令系统、流式渲染） | `@kodax-ai/coding`, `ink`, `react` |

根目录 `src/kodax_cli.ts` 是 CLI 入口；`src/sdk-{agent,llm,coding,media,repl,skills,mcp,session,runtime,sandbox,a2a,experimental-memory}.ts` 是 SDK subpath 入口；构建产物在 `dist/`，单文件二进制在 `dist/binary/<target>/`。

### 源码层 vs npm 发布层

KodaX 有两层结构，SDK 用户需要分开理解：

- **源码层**：4 个核心 workspace 包，另有私有可选 Artifact 源码 workspace，经同一主包 `/artifacts` 子路径交付：PPTX 创作/限定编辑，PDF/图片/SVG 取证、DOCX 轻量预览、本地网页与 SMIL 捕获，公共准备和真实图片读取。核心启动不加载渲染依赖；桥接沿用受管权限、沙箱和取消。[SDK 支持与限制](docs/ARTIFACT_SDK.md)。
- **当前源码打包导出**（不表示已发布到 npm）：单个 bundled 包 `@kodax-ai/kodax`，对外暴露 17 个 SDK subpath（SDK 消费者 `import` 时看到的接口）。subpath 分两种角色：
  - **完整包 subpath**（`/agent`、`/llm`、`/coding`、`/repl`）—— 每个 1:1 对应一个源码包，暴露完整公开 API。
  - **集成与窄子集 subpath**（`/media`、`/skills`、`/mcp`、`/session`、`/client`、`/runtime`、`/sandbox`、`/a2a`、`/experimental-memory`、`/artifacts`、`/artifacts/client`、`/artifacts/runtime`、`/artifacts/kodax`）—— 聚焦能力或宿主集成边界；`/experimental-memory` 明确为 opt-in 不稳定接口。

| 源码包 | npm subpath | 类型 | 内容 | 典型消费者 |
|---|---|---|---|---|
| `packages/llm`    | `@kodax-ai/kodax/llm`     | 完整包 | 16-alias LLM 抽象 (108 exports) | 独立 LLM 客户端 |
| `packages/agent`  | `@kodax-ai/kodax/agent`   | 完整包 | Runner / fan-out / 外部 Agent plane / session-lineage / capabilities / tracing (331 exports) | 自定义 agent 框架 |
| `packages/agent`  | `@kodax-ai/kodax/skills`  | **窄子集** | 仅 Skills 系统 —— `SkillRegistry` / `loadFullSkill` / `expandSkillForLLM` 等 (26 exports = v0.7.43 之前 `@kodax-ai/skills` 完整 API) | Skill 加载器、IDE 插件 |
| `packages/agent`  | `@kodax-ai/kodax/mcp`     | **窄子集** | 仅 MCP —— `McpCapabilityProvider` / `createMcpTransport` / `searchMcpCatalog` 等 (23 exports) | MCP server 宿主 |
| `packages/agent`  | `@kodax-ai/kodax/media`   | **窄子集** | 结构化图片/文件/视频输入 artifact helpers (22 exports) | 桌面宿主、多模态客户端 |
| `packages/agent`  | `@kodax-ai/kodax/experimental-memory` | **实验性子集** | F228-backed `MemoryAgent` / `MemorySession` 生命周期，以及附加的 `MemoryManagementAgent` list/remember/forget 接口 | 显式评估 FEATURE_260 / FEATURE_292 的 SDK 宿主 |
| `packages/coding` | `@kodax-ai/kodax/coding`  | 完整包 | Coding agent + 50+ 工具 + repo-intelligence (505 exports) | 构建 Claude Code 形态产品 |
| `packages/repl`   | `@kodax-ai/kodax/repl`    | 完整包 | Ink TUI + 权限模式 + 命令系统 (217 exports) | 终端 UI 消费者 |
| `packages/repl`   | `@kodax-ai/kodax/session` | **窄子集** | 仅会话管理 —— `listSessions` / `loadFullTranscript` / `appendClientNotice` / `forkSession` / `compactSession` / `watchSessions` 等 (17 exports) | 读取 session 历史的 IDE 插件和桌面宿主 |
| `src`             | `@kodax-ai/kodax/client` | 产品 API | 共享 Host 连接与 `KodaXProductClient` 统一契约 | TUI、桌面/IDE 和自动化应用 |
| `src`             | `@kodax-ai/kodax/runtime` | 宿主 API | Shared-Host facade，含 sessions/runs/events/permissions/catalog/MCP/artifacts/diagnostics/外部 Agent 和 daemon schema (10 exports) | 受信任宿主集成 |
| `src`             | `@kodax-ai/kodax/sandbox` | 宿主 API | 显式 ASRT capability/doctor/setup 与宿主自有受控命令执行；不可用时绝不静默普通执行 | 需要独立进程 containment 的 SDK 宿主 |
| `src`             | `@kodax-ai/kodax/a2a` | 集成边界 | A2A 1.0 Agent Card 发现、JSON-RPC/SSE F258 executor、安全 fetch 与鉴权 Runtime Agent server | Agent 编排器和 KodaX 宿主 |

**经验法则**：需要 Runner / Agent / fan-out 时从 `/agent` 引入；只需要 skills 或 mcp API 时从 `/skills` 或 `/mcp` 引入，bundle 更小。窄子集是完整包的真子集 —— **不会**有额外符号。

Skill 的两条触发路径彼此独立：未设置 `disable-model-invocation: true` 的 Skill 会把名称和描述注入模型上下文，因而可被自然语言自动发现；所有已启用 Skill 都始终支持用户显式输入 `/<name>` 或 `/skill:<name>`（可位于 query 头部或中间，后续文本作为参数）。`disable-model-invocation: true` 只关闭模型发现与模型 `skill` 工具调用，不会禁止显式 `/skill` 或 SDK `SkillRegistry.invoke()`。旧的 `user-invocable` 字段仅保留解析兼容性，不再充当执行权限。宿主会把显式调用展开一次并以结构化 `skillInvocation` 传入 SA/AMA、Workflow 与子 Agent；模型自己在 child objective 中写出的 slash token 仍是新的模型调用，必须经过受限 `skill` 工具，不能借委派绕过该标记。

**Workflow process surface（FEATURE_229，v0.7.50）**：动态工作流不再只是 REPL 私有文本，而是 Agent 层可复用的 process/event/snapshot 契约。SDK 宿主可以订阅 `WorkflowProcessEvent`、轮询 `WorkflowProcessSnapshot`，并通过 `createWorkflowRunManager` / `createWorkflowLifecycleController` 做 stop/pause/resume、读取 final result/artifact、删除/清理 terminal runs、管理 workflow identity/preflight。`/coding` 负责 coding workflow backend 与 run graph，`/repl` 只是消费同一份 snapshot 渲染 UI；SDK 不需要解析 slash-command 输出或 Ink view-model。`KodaXEvents` 回调新增可选 meta 尾参（`KodaXToolEventMeta` / `KodaXActivityEventMeta` / `KodaXWorkflowEventMeta`），宿主据此把每个子 Agent 的 tool/thinking/progress 事件归因到对应 workflow run 与 child id，无需第二套事件协议；生成/保存的工作流脚本在运行前过 `validateRestrictedWorkflowSource`（编译 + 源策略检查）与 generator 的 repair/smoke 循环。分层取舍见 [docs/ADR.md ADR-040](docs/ADR.md)。

**宿主读持久化历史（FEATURE_230 + FEATURE_234，v0.7.51；v0.7.63 hardening）**：面向「宿主读持久化状态」的 additive 闭环。**持久化工具记录回放**——resume 的会话现在会回放助手用过的工具卡片，而不是退化成纯文本。`messages` / `lineage` 仍是 canonical；`SessionData.uiHistory` 成为有界、脱敏、仅 terminal 状态的回放缓存。SDK transcript 契约明确化：`loadSession()` = 活动 model context，`loadFullTranscript()` = 带结构化条目的追加序 host scrollback（`message` / `compaction` / `branch_summary` / `rewind_marker` / `client_notice` / `task_result`）并带 clone provenance（`logicalId` / `sourceEntryId`），`uiHistory` = 可选回放缓存，工具卡片始终可从 canonical messages 重建。宿主可用 `appendClientNotice()` 持久化本地 slash 输出且不进入模型上下文；workflow/child 完成结果通过结构化 `taskResults[]` 暴露，不再要求解析 `<task-completed>` 文本。`rewind_marker` 只用于 host scrollback 审计，不进入 model-context messages。**Workflow run 宿主归属**——`WorkflowProcessTrackerOptions` / `WorkflowProcessSnapshot` 新增 host-owned 不透明 `hostMetadata?: Record<string, string>`，SDK 存储、持久化进 `run.json`、回读回显（含进程重启后）但不解释其含义，让宿主零侧表把 run 归回发起它的 session/surface。未 stamp 的旧 run 诚实回显 `hostMetadata === undefined`。详见 [docs/features/v0.7.51.md](docs/features/v0.7.51.md)。

**会话恢复与 ACP 污染修复（FEATURE_261，v0.7.67）**：直接运行 `kodax -r` 会进入可搜索、上下选择、Tab 补全和翻页的交互式会话选择器，并显示当前选中项的完整 session ID；`kodax -r <值>` 优先按完整 ID 恢复，ID 不存在时再按忽略大小写的完整标题匹配。标题唯一则直接恢复，同名标题则进入只包含候选项的选择器，绝不静默选第一条。`listSessions()` / Runtime / daemon 会话列表新增 `surface` 精确过滤和不透明 `cursor` 分页。ACP session 改为收到首个有效 prompt 后才持久化，ACP 测试强制使用临时 runtime home，避免测试记录写入真实 `~/.kodax/sessions`。`kodax -s cleanup-acp` 只预览严格匹配的空 ACP 污染记录；仅显式追加 `--apply-session-cleanup` 时才归档，不做永久删除。

**v0.7.74 最近会话恢复闭环：**`kodax -c`、Ink/Classic 启动、单次 CLI 与 coding
runtime auto-resume 都会扫描最多 1000 条最新摘要并跳过 `msgCount=0` 的 ACP/bootstrap
占位会话；显式 session ID 始终优先。交互式恢复会在下一轮前恢复保存的 workspace
runtime、消息、UI 历史、lineage、artifact、extension 状态、标题、tag 与 session ID，
因此相对 shell 命令不会错误地落回启动目录。

**实验性 Memory Agent SDK（FEATURE_260 + FEATURE_292）**：`/experimental-memory` 保持基础 `MemoryAgent` / `MemorySession` 生命周期源码兼容；当 `createMemoryAgent()` 接收 `MemoryManagementController` 时，返回附加的 `MemoryManagementAgent`，提供与自然语言产品表面相同的 `list()`、`remember()`、`forget()` 治理操作。被动 recall 零等待，`query()` 只读且由主 Action LLM 主动选择。召回内容保持低权限，安全与 scope 边界仍由确定性代码门禁承担。直接 session 示例与宿主边界见 [SDK Embedder Guide §21](public_docs/sdk/embedder-guide.md#21-experimental-governed-memory--experimental-memory-feature_260--feature_275--feature_292-v0768v0785)。

**双向 A2A 1.0（FEATURE_267，v0.7.69）**：`/a2a` 可发现 allowlist 内的 Agent Card，并通过既有 F258 plane 安装 JSON-RPC/SSE executor。配置中的出站 Agent 还会作为 `external:<name>` 自动注册到 embedded CLI 与用户 daemon Runtime，因此主 Agent 无需宿主代码即可编排。一个 `a2a.json` 可保存多个出站注册，但最多只有一个入站 server；入站可发布 Runtime 默认 Agent，或发布一个经过验证的 `~/.kodax/agents/*.md` Agent。内置 listener 仅允许 loopback，且不会返回 Fetch 兼容客户端禁止的端口；公网部署必须由宿主用 TLS、鉴权和授权包住 `handle()`。不宣称支持 A2A 0.3、gRPC、HTTP+JSON、push notification，也不会自动把本地 Agent 暴露到网络。详见 [SDK Embedder Guide §22](public_docs/sdk/embedder-guide.md#22-bidirectional-a2a-10--a2a-feature_267-v0769)。

**A2A 互操作与认证加固**：发现得到的 interface 必须与受信 Agent Card 同源，且只有
完整满足 Card/Skill 的一个 security requirement 时才会携带凭据。无代码 client
支持 HTTP Bearer 兼容模式与 OAuth 2.0 Client Credentials；OAuth 的短期 access
token 由外部 Authorization Server 签发，KodaX 只在进程内缓存。入站 `a2a serve`
可以按外部 issuer/JWKS 校验 RFC 9068 JWT access token，但不会自行签发生产 token。
服务按 CLI、环境变量、配置、内置默认值的顺序解析 provider，Markdown Agent 也可
固定自己的 provider。补充输入会继续原 Runtime run；任务历史、保留策略与稳定
cursor 分页均有边界；带鉴权的 SSE 会先校验关联信息，流在正常终止但未给出终态时
回退 polling。仅远端直接 artifact、输出 broker 暂存结果，以及成功授权执行的 Skill
脚本输出可以发布；普通工作区写入与本地路径不会暴露。

这里的认证与逐 Agent 激活加固，是对 v0.7.69 F267/F268 设计的发布后补全，
随 v0.7.71 补丁交付；并不表示早期 v0.7.69 二进制已经包含后续 OAuth profile。

**v0.7.70 MCP 发现加固**：能力使用精确 ID 和带 revision 的 cursor，结果按真实物理
容量准入。紧凑 CJK 查询会分词；跨语言 lexical 零匹配只会返回容量内的无损分组
清单，或一条使用 catalog 语言的简短重试提示。部分 provider 失败会显式保留，
不会伪装成完整结果。

完整的内置调用路径不需要再写 TypeScript：

```bash
# 调用外部 A2A Agent
kodax a2a add research https://agent.example/.well-known/agent-card.json --effect read
kodax a2a test research
kodax a2a call research "总结这个主题"

# 显式授权私网明文端点（可用时仍应优先 HTTPS）
kodax a2a add intranet http://10.20.30.40/.well-known/agent-card.json \
  --allow-private --allow-insecure-http --effect read

# 先保存受 OAuth 保护的 Agent，再热启用/停用
export RESEARCH_A2A_CLIENT_SECRET='由你的授权服务器分配'
# PowerShell：$env:RESEARCH_A2A_CLIENT_SECRET='由你的授权服务器分配'
# PowerShell：将命令写成一行，或把每个行尾反斜杠替换为反引号。
kodax a2a add reviewer https://reviewer.example/.well-known/agent-card.json \
  --disabled --effect read --oauth-scheme enterprise-oauth \
  --oauth-issuer https://identity.example/ \
  --oauth-token-url https://identity.example/oauth/token \
  --oauth-client-id kodax-reviewer \
  --oauth-client-secret-env RESEARCH_A2A_CLIENT_SECRET \
  --oauth-scope a2a.invoke --oauth-resource https://reviewer.example/
kodax a2a enable reviewer
kodax a2a disable reviewer       # 只阻止新调度，不取消已运行任务

# 暴露 Runtime 默认 Agent，或指定 ~/.kodax/agents/*.md 中的 Agent 名称
export KODAX_A2A_TOKEN='请替换为足够长的随机令牌'
# PowerShell：$env:KODAX_A2A_TOKEN='请替换为足够长的随机令牌'
kodax a2a expose                 # 或：kodax a2a expose document-agent
kodax a2a serve                  # 仅监听 http://127.0.0.1:8765
```

MCP、A2A、Extension 分别使用 `~/.kodax/integrations/` 下的一个用户级文件。
可以通过 `kodax config paths` 查看全部活跃/模板路径，通过
`kodax config template <core|mcp|a2a|extensions>` 查看模板，通过
`kodax integrations migrate --apply` 迁移旧配置，并用 `kodax mcp`、
`kodax a2a`、`kodax extensions` 管理。迁移只导入旧
`config.json#mcpServers` 与 `config.json#extensions`；A2A 没有旧来源，且不会
覆盖已有目标文件。第一次 MCP/Extension 修改可以暂存旧条目；只有在检查目标文件
和明文 secret 警告后，才应同时使用 `--apply --cleanup-legacy` 清理旧 key。
运行中的 CLI/daemon 保留最后一个
有效版本，完整替换 MCP provider、逐条协调 Extension，并热注册出站 A2A Agent。
每个 A2A 条目都有期望态 `enabled`；`kodax a2a list` 显示配置，实际已应用注册以
拥有该 Runtime 的进程为准。自动协调不会获取已停用条目的 Card 或 token；拥有者
观察并应用该 revision 后，停用条目才会阻止新调度，CLI 写入返回本身不是跨进程生效
确认。`a2a add --disabled` 默认仍会校验 Card，除非显式使用 `--no-test`；`a2a test`
只做 discovery/security planning，不会申请 OAuth token。示例中的固定
`KODAX_A2A_TOKEN` 是运维侧预先提供的兼容凭据，并非 KodaX 自行生成或签发。
停用条目可随时重新启用。私网地址访问与非 loopback 明文 HTTP 是两项独立、
持久化且默认拒绝的权限（`--allow-private` 与 `--allow-insecure-http`）；精确
loopback HTTP 无需这两项授权。OAuth token endpoint 仍保持更严格的
HTTPS 或精确 loopback 规则。共享 Host 在内部通过 `createConfiguredA2ARuntimeIntegration({ configHome })`
装载配置执行平面；SDK 客户端连接这个 Host，公开 `externalAgents` 函数注入已退役。
`worker.configuredA2A` 选项已随
Worker facade 在 v0.7.97 移除。
`a2a serve` 会在监听前装载已配置的 MCP/Extension 能力并固定执行权威，同时热加载
公开信息、鉴权和限额。Agent、Skill、Extension 工具权威、工作区、tool policy
或任务存储变更必须显式重启服务。

A2A 配置迁移与历史任务 owner 迁移是两件事。如果升级 realm-aware owner key
后仍需访问 v0.7.70 的任务库，应先停止 A2A server，执行
`kodax a2a migrate-tasks` 查看精确 owner 计划，再用
`--apply --confirm-server-stopped` 应用。OAuth 还必须提供已知历史
`--subject`；正常服务不会猜测或双读 legacy owner key。

托管 A2A 上下文默认位于 `~/kodax_a2a_server_workspace/<runtime-profile>/contexts/`。
精确授权的 Skill 脚本必须使用隔离策略，并通过 `kodax sandbox doctor`。
当前 native protocol 10 下，该隔离 Skill Script 路径仅支持 POSIX；Windows 不可用，
因为它必须使用每命令 `denyRead`，而 Windows `WRITE_RESTRICTED` 后端会以
`unsupported_policy` 拒绝该策略；`kodax sandbox setup` 不能启用此路径。

**v0.7.72 会话恢复与队列闭环：**裸 `kodax -r` 先加载可搜索选择器，不为列出
session 预加载完整 CLI；选中后才把 stdin 交给恢复后的 REPL，Esc 会释放选择器的
stdin 并立即回到原 shell。历史回放保留每条持久 event 的原始时间。用户 follow-up
使用 session-root Actor queue scope，避免一个 session/child 的待处理输入被另一个
REPL 显示、唤醒或消费。

当前源码中，`kodax -r` 按最近真实对话消息排序并显示对应时间，旧记录缺少可靠消息时间时回退创建时间。SDK 的 `lastMessageAt`、Host 列表与选择器共用规则；标题、设置、Actor 保存和压缩不刷新对话时间。共享 Host 在取得所有权后统一恢复历史进程，连接客户端不重复清扫；加载提示继续使用统一启动进度契约。

**外部 Agent SDK plane（FEATURE_258，v0.7.67）**：`/agent` 导出协议中立的 executor、registration、policy、credential broker、artifact policy、catalog 和 durable task 契约；`/runtime` 通过 `admin.agentRegistrations`、`agents`、`agentTasks` 向共享 Host 客户端提供 DTO API。统一 Host 收口退役公开 executor factory 注入和进程内 owner 构造；支持的 A2A Agent 通过 Host 配置接入。任意 executor 函数仍可用于独立库，但没有透明等价的产品 Host API。Plane 关闭后是终态：未完成的 wait 和后续所有服务调用都会拒绝；受限 Workflow 脚本会完整校验并传递 `phase` 与外部 `target`。完整所有权、注册、preflight、启动/等待/继续/取消/对账和安全边界见 [SDK Embedder Guide §18](public_docs/sdk/embedder-guide.md#18-external-agent-executor-plane-feature_258-v0767)。

**成本受控 Workflow SDK（FEATURE_259，v0.7.67）**：SDK 调用方用 run-scoped `modelTiers` 与 `workflow.maxConcurrency` 配置路由和并发，workflow 作者只表达 `fast` / `balanced` / `deep` 语义意图。terminal workflow event 回显 tier/source/fallback/usage/duration，持久化 `run.json.efficiencyReport` 给出 token coverage、role/tier 启动数、packet-read 拓扑、review wave 和 quality gate 结果。完整配置与遥测读取方式见 [SDK Embedder Guide §20](public_docs/sdk/embedder-guide.md#20-cost-disciplined-workflow-routing-and-telemetry-feature_259-v0767)。

**Inline workflow authoring（FEATURE_246，v0.7.58；F270 于 v0.7.72 更新）**：Worker 在明确表达 Workflow 意图时，可通过 model-callable 的 `run_workflow` 工具在会话内编写并运行工作流。F270 退役 AMAW 与复杂度驱动激活；AMA 保留显式 `/workflow`、named/SDK 和自然语言 Workflow 请求。Workflow 子 Agent 统一运行在 Actor 控制面。详见 [docs/features/v0.7.58.md](docs/features/v0.7.58.md)、[docs/features/v0.7.72.md](docs/features/v0.7.72.md) 与 ADR-044/046/047/048/049/055。

**历史工作流激活分层（FEATURE_248 + FEATURE_249，v0.7.59；F270 于 v0.7.72 取代）**：v0.7.59 引入 AMAW 和 AMA 的显式请求行为。F270 退役 AMAW 及其复杂度驱动指令；CLI/REPL 使用 AMA；SDK 显式 SA 和内部单 Agent 执行器继续兼容。AMA 是唯一自适应多 Agent 模式，并且只在明确 Workflow 意图下激活 Workflow。详见 [docs/features/v0.7.59.md](docs/features/v0.7.59.md) 与 [docs/features/v0.7.72.md](docs/features/v0.7.72.md)。

**managed 工具路径的渐进披露（FEATURE_250，v0.7.60；当前策略于 v0.7.74 纠偏）**：deferred-tool 机制同时应用于 AMA managed path 与 SA。当前延迟集合精确包含 11 个工具：6 个 repo-intelligence、4 个 web/code discovery，以及 `run_workflow`；其 `input_schema` 仍可直接调用，完整描述按需由 `tool_search` 返回。5 个固定 `mcp_*` facade 与 `get_goal` / `create_goal` / `update_goal` 生命周期工具常驻完整契约。v0.7.74 的 Goal 纠偏相对旧 hint 仅增加约 109 个估算 schema token（其中常驻的 `get_goal` 反而少 12 token），消除一次发现往返，并且不改变工具 schema、handler、权限、Goal 状态或压缩保护。详见 [docs/features/v0.7.60.md](docs/features/v0.7.60.md) 与 [docs/features/v0.7.74.md](docs/features/v0.7.74.md#feature_250-v0774-correction-resident-goal-lifecycle-tools)。

**上下文高效的工具结果 + Workflow 质量预检（FEATURE_251 + FEATURE_252，v0.7.61；2026-07-14 纠偏）**：本地工具先完整采集，只采用契约等价且严格更短的无损规范化；命令专用 Bash 有损过滤默认关闭，compound Bash 不使用语义 adapter。并行结果由唯一 owner 按最终 provider 请求统一判容：先求满足 `Pmax + 输出预留 + max(2048, Pmax 的 3%) <= 上下文窗口` 的最大最终输入，再只使用剩余物理容量。能放下就逐字交付，只有真实溢出才持久化完整结果并返回 `KODAX_RESULT_INCOMPLETE`。历史仍遵守相同的物理容量安全规则：容量内不做默认有损 microcompaction，压力下 summary-first，无法形成可恢复请求时 typed failure，禁止静默删除。FEATURE_272 仅取代 FEATURE_251 的大型压缩默认触发策略；FEATURE_252 的确定性 workflow 启动前合约 lint 保持不变。详见 [docs/features/v0.7.61.md](docs/features/v0.7.61.md) 与 [docs/ADR.md ADR-050](docs/ADR.md)。

**可靠且始终开启的上下文压缩（FEATURE_272，v0.7.74）**：自动大型压缩不允许关闭。百分比阈值默认 75%，并限制在 15-90%；可选 `triggerTokens` 未设置或为 0 时不生效，否则百分比、绝对值和物理容量三者取最小。最近原始尾部保护量为有效阈值的 20%。一次事务压缩保护尾部之外的完整 eligible prefix，并用精确 query ledger 保留所有真实用户请求；只有实际减少 token、恢复物理可用且等待持久化提交成功后才发出成功事件。原始正文从内存驱逐前，Session owner 会先持久化并刷盘精确 lineage；sidecar 与精简 Session 通过稳定 entry ID 合并去重。根 Agent 与持久化子 Agent 都可用有界的 `session_history_search` → `session_history_read` 回溯自己的被省略细节；子 Agent 只绑定独立隐藏的 worker Session，永远不能读取根历史。SDK/Runtime 则使用 revision-bound `transcriptSearch`、分页和无损 chunk；隐藏思考、system 指令与合成 checkpoint 不进入模型检索。详见 [功能设计](docs/features/v0.7.74.md)、[SDK 指南第 25 节](public_docs/sdk/embedder-guide.md#25-always-on-context-compaction-and-bounded-transcript-recovery-v0774) 与 [ADR-057](docs/ADR.md#adr-057-large-compaction-is-an-always-on-context-scoped-full-coverage-transaction)。

**邮箱驱动的 Agent 协作（FEATURE_273，v0.7.74）**：`wait_agent` 现在是真正的模型侧 mailbox yield，只接受一个有界 `timeout_ms`，不再读取 Actor progress/event。它只因当前作用域的 Agent 消息或完成通知、根用户输入、中断或超时而唤醒；progress 仍通过 UI/SDK snapshot、replay 和 long-poll 提供，但不会触发父模型重采样。工具只返回 wake acknowledgement，可信 Agent evidence 与结构化 task metadata 在下一安全边界只注入一次。未确认的根 completion 可在硬重启后恢复，同进程 Runtime 重建按子 `turnId` 去重，已确认或旧版历史 completion 不重放。树状态用 `list_agents`，已知结果用 `agent_output`。详见 [功能设计](docs/features/v0.7.74.md#feature_273-mailbox-driven-agent-wait-and-telemetrycontrol-separation)、[SDK 指南第 26 节](public_docs/sdk/embedder-guide.md#26-agent-mailbox-control-versus-sdk-event-telemetry-v0774) 与 [ADR-058](docs/ADR.md#adr-058-model-agent-wait-is-mailbox-control-not-event-telemetry)。

**活跃 Run 中断输入（v0.7.74）**：embedded Runtime 与 shared daemon 声明 `interruptInput:1`。`runtime.runs.submitInput()` 把不可变、有序的输入排入当前 active Actor Run；同一安全 Runner 边界前接纳的输入按 FIFO 作为独立 user message 一次性交给下一次 LLM 请求，不创建 continuation Run。Run snapshot/event 暴露 queued/delivered 状态，确认只匹配实际消费的 ID，终态清理保证未交付输入不会泄漏到后续 Run。

```
KodaX/                       # 4 workspace packages(FEATURE_194 v0.7.43)
├── packages/
│   ├── llm/                 # @kodax-ai/llm —— 16 个内置 provider alias
│   ├── agent/               # @kodax-ai/agent —— Runner / fan-out / idle-yield + 子树:
│   │   ├── session-lineage/ # 分支 session tree (v0.7.43 inline)
│   │   ├── capabilities/
│   │   │   ├── mcp/         # MCP 集成 (v0.7.43 inline)
│   │   │   └── skills/      # Skills 标准实现 + builtin (v0.7.43 inline)
│   │   └── tracing/         # 追踪 / 可观测性 (v0.7.43 inline)
│   ├── coding/              # @kodax-ai/coding —— tools + prompts + agent loop
│   │   └── repo-intelligence/ # 含 protocol.ts (v0.7.43 inline)
│   └── repl/                # @kodax-ai/repl —— Ink TUI
├── src/
│   ├── kodax_cli.ts         # CLI 主入口（bin: `kodax`）
│   └── sdk-*.ts             # SDK subpath 入口 → @kodax-ai/kodax/{agent,llm,coding,media,repl,skills,mcp,session,runtime,sandbox,a2a,experimental-memory}
├── scripts/
│   ├── build-bundle.mjs     # esbuild 单 bundle 多 entry 打包（CLI + root + 13 核心 SDK subpath + Artifact 资源 + chunks）
│   ├── build-binary.mjs     # Bun --compile 单文件二进制打包
│   └── release.mjs          # 发布 CI 构建的通用 tarball；本地 --pack-only 保持 private:true
└── .github/workflows/
    └── release.yml          # 推 v* tag 自动发布 GitHub Release
```

这套拆分让你既可以把 KodaX 当成完整产品使用，也可以只复用其中某一层能力 —— SDK 消费者装 `@kodax-ai/kodax` 后从 subpath（`@kodax-ai/kodax/agent` 等）按需 import。
## API 导出

```typescript
// 主函数
export { runKodaX, KodaXClient };

// 类型
export type {
  KodaXEvents, KodaXOptions, KodaXResult,
  KodaXMessage, KodaXContentBlock,
  KodaXSessionStorage, KodaXToolDefinition
};

// 工具
export { KODAX_TOOLS, KODAX_TOOL_REQUIRED_PARAMS, executeTool };

// Provider
export { getProvider, KODAX_PROVIDERS, KodaXBaseProvider };

// 工具函数
export {
  estimateTokens,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal
};
```

---

## 术语说明

| 术语 | 含义 | 位置 |
|------|------|------|
| **Skills** | Agent 能力（KODAX_TOOLS: read, write, bash 等）+ 扩展 Skills | Coding 层 + Skills 层 |
| **Commands** | CLI 快捷命令（/review, /test 等） | REPL 层 |

---

## 开发

```bash
# 开发模式
npm run dev "你的任务"

# 构建
npm run build

# 可选：只构建 workspace packages
npm run build:packages

# 打包成单文件二进制（当前平台 / 全平台）
npm run build:binary
npm run build:binary:all

# 测试
npm test

# Eval-driven development（provider 矩阵、identity round-trip 等）
npm run test:eval

# 清理
npm run clean
```

### Repo Intelligence 缓存目录

KodaX 现在会把 Repo Intelligence 的本地缓存分成内置引擎 profile：

- `.agent/repo-intelligence/`
  - full 引擎索引、缓存和现有 task-engine 产物。
- `.agent/repo-intelligence/light/`
  - light 模式启发式索引缓存。

这样拆开的目的很明确：

- full 和 light profile 可以独立重建。
- light 模式的低置信度状态不会被误认为 full 引擎状态。
- 未来缓存迁移可以删除一个 profile，而不破坏另一个。

`.agent/repo-intelligence/` 是本地生成目录，不应该提交到 Git。

---

## 文档

- [README.md](README.md) - 英文版 README
- [public_docs/sdk/embedder-guide.md](public_docs/sdk/embedder-guide.md) - SDK 宿主集成、shared Runtime、v0.7.74 压缩/历史恢复、Agent 遥测与活跃 Run 输入契约
- [docs/release.md](docs/release.md) - 单文件二进制构建与发布流程
- [docs/PRD.md](docs/PRD.md) - 产品需求
- [docs/ADR.md](docs/ADR.md) - 架构决策
- [docs/HLD.md](docs/HLD.md) - 高层设计
- [docs/DD.md](docs/DD.md) - 详细设计
- [docs/FEATURE_LIST.md](docs/FEATURE_LIST.md) - Feature 跟踪
- [docs/test-guides/](docs/test-guides/) - 功能专用测试指南
- [CHANGELOG.md](CHANGELOG.md) - 更新日志（v0.7.0+；更早版本见 [CHANGELOG_ARCHIVE](docs/CHANGELOG_ARCHIVE.md)）


---

## 许可证

[KodaX-AI Fair Core License (KAI-FCL) 1.0](LICENSE) - Copyright 2026 icetomoyo。

KAI-FCL 是 source-available / fair-core 协议，不是 OSI open source。商业、
企业、托管部署、付费服务或客户再分发用途，需要 KodaX-AI 授权，并在需要时
具备有效 entitlement。

KodaX-AI 当前官方许可政策：KodaX 0.7.70 及之后版本，在由 KodaX-AI 带有该
notice 分发时，适用 KAI-FCL 或配套 KodaX-AI 客户条款。此前已带 Apache-2.0
notice 分发的历史 tag、source archive、二进制、npm 包或其他副本，仍只对那些
特定副本保留 Apache-2.0。

## 相关仓库

建议把公仓和私仓 clone 到同一个父目录下，例如：

- public repo: `<parent>/KodaX`
- private repo: `<parent>/KodaX-private`（未公开发布）
