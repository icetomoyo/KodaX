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
  <img src="kodax-hd.gif" alt="KodaX 实战演示" width="880">
</p>

---

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
一次可选 ASRT sandbox：Windows 可能弹出一次 UAC；
macOS/Linux 会报告 Seatbelt/bubblewrap 所需依赖。拒绝 UAC 或缺少依赖不会破坏普通
权限管理，日常启动也不会反复提醒。

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

`@kodax-ai/kodax/runtime` 支持 inline、Worker 和本机共享 daemon。FEATURE_269
让 CLI、Space、IDE 与其他本地 SDK 客户端可以原子加入同一个 Coder
session/run，共享 transcript、Todo、tool、AskUser、permission、队列与唯一终态。
daemon mutation 使用持久 operation identity 和 revision CAS；崩溃后不会盲目重放
可能已有副作用的 provider、run 或 Host Tool 调用。

Space 的 provider credential 仍由 OS keychain 持有，只通过 run/provider-scoped
broker 使用；Space Artifact/Office/Control 只通过显式绑定到该 run 的 Host Tool
lease 暴露。CLI run 不会因为 Space 后来加入而继承这些能力。Partner 继续使用独立
data/session root 下的 inline Runtime，不参与 Coder owner fence。capability 缺失时必须
fail closed，不能静默退回 inline Coder。完整接入说明见
[SDK Embedder Guide §23](public_docs/sdk/embedder-guide.md#23-shared-coder-daemon-for-space-and-ide-hosts-feature_269-v0769)。

**v0.7.71 Electron 打包修复**：packaged/asar Electron 宿主可以直接自动启动
daemon，不会再次打开 GUI。`ELECTRON_RUN_AS_NODE` 只存在于子进程启动边界，
在 daemon 与普通用户子进程代码加载前即被移除。该路径要求 Electron 默认开启的
`RunAsNode` fuse；主动关闭该 fuse 的宿主必须通过普通 Node/KodaX CLI 启动 daemon，
再使用 attach-only 模式连接。SDK 的 `homeDir` 是拥有 `.kodax` 的 CLI 风格基础目录，
不是 `.kodax` 目录本身。

**v0.7.75 Windows GUI 稳定性候选版**：Runtime Worker 可达的非交互后台子进程
在 Windows 上统一请求隐藏控制台，覆盖 memory/Git、provider CLI/ACP、LSP、
clipboard、worktree、review、extension command、checkpoint 与 sandbox 路径；
显式 editor、terminal 和 PTY 行为保持不变。SDK bundle 增加静态子进程审计，
packaged Electron 回归连续执行 20 次普通查询并检查控制台可见性。KodaX Space
产品级验证仍然有价值，但不阻塞 SDK 打包、tag 或 npm 发布。

同一候选版还会区分“当前请求完成后的可选后续工作”和“完成当前请求所必需的
澄清”，只为符合资格的 Sidecar `revise` 发布预算审批状态，并在 embedded 与
daemon Runtime 边界保留结构化 blocked 原因。

**v0.7.76 Kimi Code 模型目录更新**：`kimi-code` 现在默认使用官方
`k3-256k` Model ID，并直接发送该同名 ID。`kimi-for-coding` 继续作为 K2.7 Code
可选模型，同时保留 `kimi-for-coding-highspeed` 与 1M `k3` tier。K3 支持
`low` / `high` / `max` 思考强度，默认 `high`；256K 路由支持图片但不支持视频输入。

**v0.7.77 正式版**：AMA 现在通过现有 Actor 控制面按需组合六种具名问题解决
模式，不引入固定拓扑或隐藏 Workflow。可选策略元数据会形成有界、仅记录事实的
`PatternTrace`，现有 Sidecar 仍是唯一的终态答案质量裁决者。治理式记忆可在工具
失败、验证失败或已提交 compact 之后稀疏触发，在下一次 Action-LLM 请求前注入最多
三条 prompt-safe、低权威证据；默认路径不增加 selector 模型调用，SDK 宿主可在
进程内显式注入 `memoryRecallRunner`。公开 `kimi` provider 同时新增 1M
`kimi-k3` 路由，并继续以 K2.7 Code 为默认。详见
[v0.7.77 设计](docs/features/v0.7.77.md)与
[发布检查清单](docs/release.md#v0777-release-ready-candidate-verification)。
冻结的 F274/F275 付费评测已完成；F274 最终 Layer 2/Layer 3 与 F275 pilot 盲审均
为 `recommend-ship`，随后形成发布确定性契约的联合 `SHIP` 决策。语义记忆选择仍为
实验性、宿主显式启用能力；本版本不宣称任务质量、token 或延迟改善。

**v0.7.78 证据门禁学习、首次配置与权限/沙盒正式版**：后台学习遵循
Memory-first；只有重复且独立验证的证据，或带已验证终态证据的显式
preserve-as-Skill 请求，才能把低风险声明式 Skill 放入不可变、项目级的有界
canary。自动项目信任需要完成三次精确 revision 使用并取得独立验证成功；每个
revision 都可在 `/learn` 中查看、禁用、回滚、信任或拒绝。受保护/正式 Skill、
全局提升和 Extension 编写仍必须由用户显式决定。

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

首次 setup 会创建并校验 core/MCP/Extensions/A2A 分离配置及带注释模板，不覆盖
现有配置，也不收集密钥。Auto[LLM] 在 classifier 延迟之前放行可精确建模的普通
读取及 workspace/temp 变更；classifier 基础设施失败只重试一次，随后按
Accept-edits 边界降级，绝不切换到 rules。ASRT 是可选执行期 containment，不是
权限裁决者；`/sandbox` 是显式诊断入口，SDK 宿主也可独立使用 `/sandbox`
subpath，且不可用时不会静默改为非隔离执行。KodaX 自身的 workspace containment
会拒绝读取常见的用户主目录凭据路径及完整的已解析 agent home，同时不把普通外部
读取收窄成 allowlist。详见
[v0.7.78 设计](docs/features/v0.7.78.md)、
[发布检查清单](docs/release.md#v0778-release-verification)与
[SDK 指南第 29–30 节](public_docs/sdk/embedder-guide.md#29-evidence-gated-background-skill-learning-feature_263-v0778)。

本次发布收口同时保证相邻表面不扭曲意图：Edit/Plan 可加载静态 Skill 指令，但不
预授权其后续副作用；动态 Skill 命令必须由宿主显式控制 executor；根 AMA 会通过受
治理的 `memory_intent` 控制面立即执行用户明确提出的记住、纠正与遗忘请求，只有异常
或推断出的变更才进入可解释的决策；Workflow
Actor wait 只有在 workflow 显式设置
deadline 时才超时；embedded、Worker 与 daemon 的 Runtime Auto v4 均声明
`fallbackPersistsEngine:false`。Actor owner 还会验证 Runtime identity，而不是只看
PID，因此 PID 复用不会卡住已崩溃 owner。恢复 Session 选择器也改为显示宿主本地时区。

**v0.7.79 发布**：configured outbound A2A Agent 现在可持久化两项彼此独立、
默认拒绝的网络权限：private-address 访问与非 loopback 明文 HTTP。embedded Worker
与共享 daemon 会协调并执行同一份授权配置。Runtime 宿主同时获得唯一权威的
Session 状态、有界只读诊断、字节保持的 Session 导出、严格 transcript 观测，
证据约束的普通对话投影，以及通过 capability 协商并仅在 daemon 空闲时升级的
有界流式事件合并。standalone 子进程、Session lineage、shell 清理、发布 sidecar
和并行 admission 路径也完成了相应的发布加固。

OpenAI-compatible 自定义 provider 现在可在 provider 或 model 级选择 `max_tokens`
或 `max_completion_tokens`。DeepSeek V4 Flash/Pro 使用各自的 reasoning profile，
并正确标记为纯文本。详见 [v0.7.79 设计](docs/features/v0.7.79.md)与
[发布清单](docs/release.md#v0779-release-preparation)。FEATURE_280 已显式改期到
v0.7.81（2026-08-04 再改期到 v0.7.86），本版本没有把它表述为已交付。Issue 256 同样已显式改期到 v0.7.84，
本版本没有把它表述为已交付。

**v0.7.80 加固发布**：CLI 现在支持在 `~/.kodax/config.json` 中配置
`worker.configuredA2A`：嵌入式 Runtime 改为 Worker 托管，并在 Worker owner 内
装载 configured A2A 执行平面，因此 configured outbound Agent 会以
`external:<name>` 出现在 `list_dispatchable_agents` 中并可用 `spawn_agent`
调度。该模式会拒绝 configured MCP server 或 Extension（它们无法跨 Worker
边界）；如需保留这些能力，请使用默认 inline Runtime。Worker 托管的嵌入式
CLI 会话也会像 daemon 模式一样把 run options 收敛为
JSON 安全的 wire DTO，而不再以 `RuntimeTransportBoundaryError` 崩溃。Auto
permission 分析不再把普通搜索范围与工具 metadata 当作 unresolved，
`max_tokens` 截断的 classifier 重试改用 1024-token 预算（Issue 275）。Managed
AMA 回合现在以 500 次迭代的机械 panic fuse 约束单次不间断工具循环，每次
idle-yield 恢复都会重置计数——它只是失控循环的熔断，绝不是累计任务预算；触发
熔断的 Runner 会抛出携带恢复 transcript 的结构化 `RunnerIterationLimitError`。
Managed-run 重复循环已被封堵，并行 review 与 delegation 指引已恢复并收紧。
FEATURE_278/279/282/283/285 已显式改期到 v0.7.85，因此 v0.7.80 仍是
debug/patch 槽位，没有把未完成特性表述为已交付。详见
[v0.7.80 发布清单](docs/release.md#v0780-release-preparation)。

**v0.7.81 Runtime 中断交付完整性发布**：以 `delivery: 'interrupt'` 提交给活动 Run
的输入，会先获得唯一的 canonical Session 物理 entry，之后才会被标记为已交付。
`runtime.runs.get(...).interruptInputs` 与 durable `run.input.delivered` 事件均公开
每项的 `entryId`；压缩、事件重放和 Runtime 重启后该引用仍可追溯。一次批量安全边界
交付会保留每条 prompt 独立的 user message 与 entry 映射。Runtime-owned 持久化或
provenance 失败会 fail closed，不会发布无法验证的交付事件。FEATURE_287 仍计划于
v0.7.93；本版本是非 Feature 补丁。详见
[v0.7.81 发布清单](docs/release.md#v0781-release-preparation)。

**v0.7.82 Runtime 因果性发布**：daemon 的未过滤 capability 发现会组合 live、complete
的 MCP 与 Host Tool snapshot；显式 `server` 过滤只选择对应来源，legacy provider 则如实
报告 incomplete/unknown。观察到 Stop 后，后续 retry、continuation、guardrail、tool 及
Run-admitted Actor 工作会协作式停止；可信 Abort 会在 credential redaction 前保留为终态
因果，但不会覆盖真实 completion 或独立 failure。输入提交先解析已接纳的 authoritative
Run，再读取可变 Session history，因此活动中断和 after-turn 接纳不会产生瞬态
`data_changed` 拒绝。FEATURE_287 仍计划于 v0.7.93；本版本是非 Feature 补丁。详见
[v0.7.82 发布清单](docs/release.md#v0782-release-preparation)。

**v0.7.83 Windows daemon containment 发布**：Windows daemon 会先以 suspended
状态创建，在用户代码运行前分配到 kill-on-close Job Object，并由 Job 外部的
supervisor 等待整个 Job 清空。SDK 导出 `waitForRuntimeDaemonShutdown()`，并通过
`daemonShutdownVerification:1` 宣布该能力；CLI stop 会等待 daemon 与 supervisor
都退出。旧的未 containment daemon 不会被报告为已验证，也不会被静默地原地升级。
Issue 256 的 Worker owner lease 部分仍计划于 v0.7.85，FEATURE_287 仍计划于
v0.7.93。详见 [v0.7.83 发布清单](docs/release.md#v0783-release-preparation)。

**v0.7.84 Actor settlement recovery 发布**：Agent progress 持久化现在限制为一个进行中的写入加一个最新替换，terminal settlement 不会再被无限 progress backlog 阻塞。同 owner 的 Stop 可以在 durability timeout 后协调迟到的 Actor snapshot，持久化 quiesce 剩余子任务，并在后续 Stop 中重试修复。修复后 Promise 的 success/failure fact 优先于 fallback callback；过时的 durable unknown 状态不能回退本地已终态 Run，也不会重复取消效果。没有可处理 turn 的 quiesce 现在是真正 no-op，不再无意义地重写 Session。详见 [v0.7.84 发布清单](docs/release.md#v0784-release-preparation)。

**v0.7.85 发布**：本版本包含 F289/F290 的 Memory review drain 与 lesson/verdict 生产管线、F291 的 Session-scoped Runtime Event Journals，以及 F292 的 conversation-first Memory 管理和实验性 SDK 管理 facade。同时包含 Actor settlement convergence、Agent Home/learned-root guardrail、terminal Run 启动时避免重放完整 event journal、repo-intelligence Worker 空闲退役、Windows sandbox/ACL 加固及对应回归指南。这些包含明确的 Runtime/system code 改动。Issue 256 剩余的 Worker owner lease 仍未完成，已改期到 v0.7.86，本版本不将其表述为已交付。详见 [v0.7.85 发布清单](docs/release.md#v0785-release-preparation)。

**v0.7.86 加固发布**：本补丁版本加入 abandoned inline Runtime owner 的原子恢复、Runtime 与 learning lock 的 OS process-start identity 校验，以及 Windows sandbox 生命周期 attestation。Sandbox ACL owner marker 持久化并在不同 Runtime profile 间串行恢复；停止流程在 ACL 恢复前等待 process-tree termination proof，保留组合清理错误；如果 Shell effect 未证明已 drain，则继续 fence 后续文件系统 effect，绝不重放可能已经产生副作用的命令。POSIX workspace session 会在策略身份计算前初始化全新的 `KODAX_HOME` 内部目录，仅在既有 Shell abort/deadline 内等待当前 workspace 的 warm-up，并在 lease cleanup 失败后退役失效缓存；进程树或清理结果无法确认时同样保持 fail-closed，不允许旧 session 与替换 session 竞态。规范化 workspace、Agent Home、附加文件系统、toolchain 与网络策略完全一致的命令，可以跨 KodaX 进程共享同一个 Windows sandbox policy group。文件系统 effect 协调锁会在合法进程交接时等待完整的 30 秒 stale-owner 证明窗口，但不同 effect 类别之间原有的一秒 fail-closed 边界不变；不同策略或目标启动前的 sandbox 基础设施失败会回到已经授权的普通权限执行路径，目标已经启动或启动状态未知时绝不重放。Runtime sandbox capability v3 会隔离旧 daemon 的执行策略版本。Issue 256 剩余的 Worker owner lease 边界仍未关闭，曾改期到 v0.7.87。详见 [v0.7.86 发布清单](docs/release.md#v0786-release-preparation)。

**v0.7.88 发布**：本版本包含 Actor settlement convergence v2 持久化边界、受界定的启动/恢复工作、guardrail classifier reason 诊断，以及首次提交查询后自动收起过期 learning-recovery 提示的 REPL 修复。这些都是明确的 Runtime、Agent、LLM 与 REPL 系统代码改动。`zhipu-coding`、`zai-coding` 与 `ark-coding` 均默认使用 `glm-5.3`，同时保留 `glm-5.2` 作为显式路由；Ark 继续保留 `glm-latest` 别名。Coding Plan model ID 原样发送，不附加虚假的 context 后缀；GLM-5.3 的 `off` / `none` 会降为 `low`。详见 [v0.7.88 发布清单](docs/release.md#v0788-release-preparation)。

**v0.7.89 发布**：本版本包含 Issue 293 的 managed context 拓扑透明投影与 v4 conversation page cache、FEATURE_293 的有界零服务 web search fallback（DuckDuckGo HTML → Bing RSS → Bing HTML），以及 FEATURE_294 的 run-scoped Host Tools。绑定到 Run 的 Host Tools 会出现在该 Run 的模型工具表和 capability catalog 中，按 registry-first 规则 dispatch，撤销后 fail-closed，不进入全局 registry，也不会泄漏到其他 CLI Run。自定义 web-search endpoint 仍保持隔离；本版本没有修改 shell/sandbox 系统代码。详见 [v0.7.89 发布清单](docs/release.md#v0789-release-preparation)。

**v0.7.90 发布**：本稳定性版本保留 v0.7.89 的契约，并修复 workspace session RPC 超时后的有序退役与 daemon Error/AggregateError/cause 诊断、链式 compaction 的 direct physical predecessor 与 archive marker 拓扑，以及 run-scoped tool 在 provider 边界的 object schema 规范化。它包含明确的 Runtime/sandbox、Agent lineage、Coding runtime 与 REPL 持久化系统代码修复，但没有放宽 fail-closed 安全边界。详见 [v0.7.90 发布清单](docs/release.md#v0790-release-preparation)。

**v0.7.91 发布**：本维护版本新增 SDK 自有的 `runtimeExitSettlement:1` 能力和
`settleKodaXRuntimeExit()` 事务。宿主可以在完整退出前持久化精确 Runtime owner，
崩溃后安全恢复，并且只修复已验证的 Windows process/Job/ACL 残留；POSIX 同一启动周期
仍保持 fail-closed。Provider retry、fallback、continuation 统一使用由
`responseId` 与 `providerRequestId` 标识的 output segment 投影；独立 Bun 二进制会打包
Anthropic/OpenAI 的 lazy SDK 依赖图。它包含明确的 Runtime、LLM、Coding runtime 与
SDK 系统代码契约更新，但没有放宽 shell/sandbox 的 fail-closed 边界。详见
[v0.7.91 发布清单](docs/release.md#v0791-release-preparation) 与
[SDK Embedder Guide](public_docs/sdk/embedder-guide.md)。本版本同时为 AskUser/permission
交互加入 owner AbortSignal 和有界 deadline，在 Runtime 边界校验默认答案，提供
`handleRuntimePermissionRequest()` 管理 SDK 权限 UI，并在 prepared Session 尾部遇到
`data_changed` 时通过权威 delta 合并恢复；后台持久化失败会显示为诊断，不再静默丢失。

**v0.7.95 发布**：零字节、畸形或截断 owner 的过期 learning lock
会在字节与 stat 二次确认未变后自动恢复。同一次 Windows 启动内的
`unconfirmed-owner` 会持续自动重试，只有精确 sandbox-user SID 探针证明空闲后
才清理，不要求用户删除 marker。Windows 沙箱清理将每个修改 ACL 的 helper 与命令
owner 保存在可恢复的机器级 Job 中，并在后台重试进程 drain、ACL reset 和
effect fence 释放；Runtime 关闭会校验精确的 daemon 与 supervisor 进程代际。
显式 Skill 的 canonical 历史保留用户原始 query，
多个 Skill 引用会被拒绝，失败或畸形的 `PreToolUse` 会拒绝工具。终态持久化不确定
时发布 `unknown`，或让 live Session observer 失效并重新取快照。若终态已经提交、
随后 status-lock 清理失败，只在重读状态与本地 proposal 完全一致时继续且只发布
一次 terminal event；不同的权威终态仍然优先。coding runtime 会在发出公开完成
信号之前先收敛出权威结果，A2A 不会再发布空的成功答复（Issue 302）。
本版本广告 Windows `sandboxRuntime:5` 与 `runtimeExitSettlement:2`。详见
[v0.7.95 发布清单](docs/release.md#v0795-release-preparation)。

**v0.7.95 动态 worktree 修正**：KodaX 创建的 linked worktree 会在路径
返回给模型前加入该 Session 的精确 shell/text sandbox 策略，跨后续 Run 持久化，
并按同一 Git common-dir 关系重新校验。删除 worktree 时立即撤销；未登记的
sibling 目录仍保持门禁。若 Session 根本身是真实 Git submodule，只接受其有界
`.git/modules/...` `core.worktree` 对精确工作区的反向绑定；候选仍须通过普通
linked-worktree backlink 校验。旧版本创建的 worktree 没有持久化登记：Session 若仍
保留成功的 `worktree_create` 结果，会在同一 Git 关系重新校验通过后
一次性迁移；若该精确证据已不存在，请先停止后台进程，再通过 KodaX 删除并重新
创建一次。迁移时不要删除 ProgramData 协调文件。

**v0.7.95 自动清理修正**：文本清理会跨重试保留已经读取的执行
attestation，并对瞬时 workspace cleanup、策略 reset 与 effect lease 释放失败自动
重试；已经完成的阶段不会重复执行，也不会留下必须人工删除的恢复标记。

**v0.7.94 发布**：Runtime 文本工具可以与兼容的长驻/后台 Bash 并发，因为
snapshot 与 commit 走同一套 ASRT workspace 策略。硬链接工作区目标会被拒绝。
Windows 沙箱 git 只信任已授权的仓库根，不再发出 `safe.directory=*`（Issue 300）。
linked-worktree / submodule 关系文件在授予 git trust 前按严格字节上限读取。
沙箱文本 helper 的 stdin 失败留在该操作 Promise 上。
计划中的 daemon shutdown 在 cleanup 失败时报告失败，而不是声称安全停止。
工作区目录尚不存在时，Run 启动会省略并发文本沙箱，而不是中止 option 构造。
Runtime 广告 `conversationHistory:2`。显式 Skill 调用（`/<name>`、
`/skill:<name>`）对每个已启用 Skill 始终可用；`disable-model-invocation`
只关闭模型工具路径。无效 `allowed-tools` 与畸形 hook JSON 会被诊断；
embedder 的 result observer 抛错时 `PostToolUse` 仍会运行。所有 Run 终态收敛以及 sandbox / managed-child
终止 Promise 都会显式观察 rejection。若两种终态记录都无法持久化，Run 以
`unknown` + `run_settlement_not_persisted` 收敛，并继续关闭 Session 执行门禁。
daemon 断线公开 typed code、`connectionId` 和 `reconnectable` 事实。宿主一旦取得
`runId`，重连后必须在 replacement Runtime 上调用 `runs.get(runId)` 与
`runs.await(runId)`，绝不能为同一已接纳 Run 再次调用 `runs.start()`。
`sandboxRuntime:4` 与 `crashOutcomeModel:2` 不变。Issue 256 仍保持 Open。
详见 [v0.7.94 发布清单](docs/release.md#v0794-release-preparation) 与
[SDK Embedder Guide](public_docs/sdk/embedder-guide.md#query-authoritative-session-and-run-lifecycle)。

**v0.7.93 发布**：Windows 退出结算在精确 owner 已写入 durable `failed`
shutdown outcome 后不再空等 170 秒有序窗口，改为立即进入既有精确恢复路径。
验证 boot 变化后，可在 machine lock 下回收上一启动留下的共享 ACL marker，
并在记录 recovery 之后才清除。Anthropic/OpenAI 的 abort 包装在请求 signal
已中止时按隔离加载的 SDK class identity 识别，managed Stop 在凭据脱敏前
仍保持 interrupted。能力版本不变。Issue 256 仍保持 Open。
详见 [v0.7.93 发布清单](docs/release.md#v0793-release-preparation) 与
[SDK Embedder Guide](public_docs/sdk/embedder-guide.md)。

**v0.7.92 发布**：文件系统效应协调器为每次排队使用精确 token 并 heartbeat。
只有当该 token 不再持有 coordinator lock 时，才会回收同一长期 daemon PID 上的过期票；
durable release marker 允许后续调用退役已结算的 effect owner。精确仍持有的 lock、
未证实的进程树或未启动的命令继续 fail-closed。Managed 终态在 completion 之前提交
canonical Session，repo-intelligence / task 文件投影不再拖住活跃 Run。
`KodaXResult.managedTask` 是终态核心快照；维护工作只会增强随后落盘的投影。
普通权限 fallback 仍走同一 effect fence。Resume 时 TUI 历史先从 canonical
Session messages 重建；稀疏的 `uiHistory` 只能叠加展示信息，不能遮蔽普通对话。
展示用的 `agent-completed` / `task-completed` 在 CLI 已有非空 `uiHistory`
时仍由宿主决定是否显示。
宿主必须协商 `sandboxRuntime:4` 和 `crashOutcomeModel:2`。Issue 256 的
lost-ancestor descendant-closure 仍保持 Open。
详见 [v0.7.92 发布清单](docs/release.md#v0792-release-preparation) 与
[SDK Embedder Guide](public_docs/sdk/embedder-guide.md)。

**v0.7.87 GLM Provider 发布**：`zhipu-coding` 默认使用 `glm-5.3`，并保留 `glm-5.2` 作为显式回退路由。`zai-coding` 当时保留两个模型但默认使用 `glm-5.2`，直到 v0.7.88 的海外 Coding Plan 路由切换。Coding Plan model ID 原样发送，不附加 context 后缀。GLM-5.3 的思考不可关闭，因此 `off` / `none` 会降级为 `low`，不会发送上游不支持的 disabled-thinking 请求。Issue 256 剩余的 Worker owner lease 边界在 v0.7.87 后仍保持 Open，且本版本不指定新的替代目标。详见 [v0.7.87 发布清单](docs/release.md#v0787-release-preparation)。

Windows workspace Shell 还会保留大小写不敏感的 `PATH`/`Path` 与 `PATHEXT` 约定，
按最终 PATH 和 shell executable 生成有界读取授权，并在 broker 层之间保留 `cmd.exe`
的 verbatim-argument 约定，确保 profile 管理的可执行文件和带引号路径不会被重复解析。

v0.7.77 还增加了由宿主显式配置的 Shell Execution Contract。Runtime Session
设置或单次 Run 可以选择 `pwsh`、Windows PowerShell、`cmd`、`bash`、`zsh`
或 Git Bash 的绝对路径；KodaX 会在实际项目 cwd 中解析 shell 环境，再通过同一
解释器执行命令。环境缓存按 contract 与 cwd 隔离，使用有界 TTL，也可由宿主显式
刷新。Provider 凭据与执行控制变量会在加载 profile/setup 前以及实际执行前分别
过滤；旧的 platform-shell 路径同样会过滤凭据型变量。用户级 `sandbox.envPass`
明确列出的变量只会在最终命令目标中恢复。没有配置 `shellExecution` 时仍保持原有
解释器路径。详见
[SDK Embedder Guide 第 28 节](public_docs/sdk/embedder-guide.md#28-host-configurable-shell-execution-contract-v0777)
与 [Issue 214 回归指南](docs/test-guides/ISSUE_214_v0.7.77_REGRESSION_GUIDE.md)。

Kimi Code 请求现在还会携带由 Runtime 逻辑上下文派生的稳定、不透明 Prompt Cache
affinity key。它会在跨 Run、重试、fallback、恢复与压缩时复用；递归子 Agent 则按
规范 Agent 路径获得与 root 和临时 transcript Session 隔离的 key。公开 Kimi 与
官方 OpenAI 使用对应的 `prompt_cache_key`；其他兼容网关保持显式 opt-in，因为
部分严格端点会拒绝未知字段。该能力提高缓存路由稳定性，但不能绕过 Provider TTL
或缓存分片。详见
[Issue 215 回归指南](docs/test-guides/ISSUE_215_v0.7.77_REGRESSION_GUIDE.md)。
Codex CLI 的缓存读取/写入与 Gemini CLI 的缓存读取现在会原样贯穿 CLI bridge
和 Runtime diagnostics，不做估算；Provider 明确报告的 `0` 与未报告字段保持
可区分。详见
[Issue 216 回归指南](docs/test-guides/ISSUE_216_v0.7.77_REGRESSION_GUIDE.md)。
CLI bridge 还会让首个原生 CLI turn 以 fresh 模式启动，只恢复 CLI 自己报告的
原生 session ID；无 conversation ID 的 stateless 调用每次创建独立 ACP Session，
非零 CLI 退出会显式失败。用户主动取消保持安静，hard/idle timeout 的 Abort 则会
作为失败进入 Runtime 恢复路径，不再伪装成空成功；已经报告成功但迟迟不退出的
CLI 也会在配置的 deadline 被终止。详见
[Issue 217 回归指南](docs/test-guides/ISSUE_217_v0.7.77_REGRESSION_GUIDE.md)。

**v0.7.72–v0.7.73 Runtime 权限契约：**Auto Mode 的权限决策由 Runtime Session 持有，
不再由 UI hook 抢先决定。Runtime 会跨 turn 复用 LLM/rules guardrail，先分类、
仅在 `escalate` 时创建共享 permission 请求，并持久化显式选择的 engine。
Session 也可设置 classifier model 和有界 timeout；`auto` 默认使用 LLM
分类，没有有效 classifier model 时会在调用 provider 或创建审批前返回可恢复配置错误，
绝不静默退回 rules。v0.7.78 中 classifier 失败会重试一次，再按 Accept-edits
安全边界降级，绝不把 engine 改为 rules。Runtime 权限请求可给出由 Runtime 生成的精确作用域建议：一次允许、
本 Session 允许，或（仅安全场景）持久允许；客户端只能回传不透明 suggestion id，不能从
预览内容自行扩大范围。持久授权由 daemon 持有并通过 revision 管理。没有宿主审批回调时，
不会向模型暴露 `exit_plan_mode`。完整 SDK 接入见
[Runtime Auto Mode 指引](public_docs/sdk/embedder-guide.md#24-runtime-owned-auto-mode-and-plan-approval-bridges-v072)。

**v0.7.74 Auto 切换可靠性：**默认用 `Shift+Tab` 在 `Plan -> Edits -> Auto`
之间循环，`Shift+Enter` 仍用于换行。进入 Auto 时状态栏会立即显示已解析的
`Auto[LLM]` 或 `Auto[RULES]`，同一 Session 的 Runtime 设置按键入顺序串行提交，
快速循环不会让较早的异步结果覆盖最后一次选择。`Auto[RULES]` 是手动选择后的
合法粘性状态；从 v0.7.78 起它只由显式/持久化选择产生。使用
`/auto-engine llm` 可显式选择 LLM 分类。

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
      <sub>V2 Worker 单循环 + Sidecar Verifier + 异步子 agent</sub>
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

`kodax setup` 与首次安装 setup 会检查 sandbox。也可以显式检查或激活：

```bash
kodax sandbox doctor
kodax sandbox setup
```

- Windows 使用受限 sandbox 账户和网络策略。普通 Terminal 即可，按提示同意一次
  UAC；不必先以管理员身份启动 Terminal。
- macOS 使用 Seatbelt/`sandbox-exec`，需要 ripgrep：
  `brew install ripgrep`。
- Linux 使用 bubblewrap，需要 `bubblewrap`、`socat` 和 `ripgrep`，请根据发行版用
  `apt`、`dnf` 或 `pacman` 安装。

KodaX 不会自动运行 `sudo` 或系统包管理器。sandbox 未激活时，确定性安全操作与
Auto[LLM] 的权限体验保持一致，只缺少 OS 级 containment；普通运行不会反复打扰。
在 REPL 中，`/sandbox` 会刷新 ready 状态与诊断，但不会激活 backend 或请求提权。
逐命令 sandbox 路由属于内部机制，不显示在普通命令历史中。SDK 嵌入方还可通过
`@kodax-ai/kodax/sandbox` 在 Auto[LLM] 之外独立使用该能力，
见 [SDK sandbox 指南](public_docs/sdk/embedder-guide.md#30-standalone-sandbox-sdk-v0778)。

模型发起的 shell 命令默认会过滤名称形似凭据的环境变量。若要把指定宿主变量
透传给命令目标（包括 ASRT），只需在用户级 core 配置中列出变量名：

```json
{
  "sandbox": {
    "envPass": ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]
  }
}
```

默认列表为空；`config.json` 只保存变量名，不保存值，项目配置也不能扩大该列表。
变量名精确匹配（Windows 不区分大小写），`NODE_OPTIONS`、`BASH_ENV` 等执行控制
变量即使列入仍会被阻止。修改宿主环境变量或该配置后需重启 KodaX；若使用常驻
daemon，还需先停止并重新启动 daemon，让它获取新的环境与配置。
SDK 调用方可按 Run 传入同结构的 `KodaXOptions.sandbox`，并发 Run 无需修改全局配置，
也可以各自使用不同的变量名列表。

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
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';   // embedded/Worker/daemon 宿主 API
import { runKodaXSandboxed } from '@kodax-ai/kodax/sandbox';    // 独立 ASRT 受控执行
import { createKodaXA2AServer } from '@kodax-ai/kodax/a2a';    // A2A 1.0 双向接入
import { createMemoryAgent } from '@kodax-ai/kodax/experimental-memory'; // opt-in 实验性记忆 SDK
```

13 个 SDK 入口（root + 12 subpath）通过 ESM 共享 chunk 复用底层代码 —— 只 import `/agent` 不会把 `/repl` 的 Ink + React 一起拉进来。

完整的宿主集成契约——包括 embedded/Worker/daemon 所有权、外部 Agent 注册与任务控制、session cursor 分页、workflow 模型分层和效率遥测——见 [SDK Embedder Integration Guide](public_docs/sdk/embedder-guide.md)。

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

`userAgentMode` 默认 `"compat"`（发送 `KodaX` 而非上游 SDK 的 User-Agent）；如果你的网关要求原生 SDK header，再切到 `"sdk"`。

自定义 reasoning 模型优先使用 v0.7.57 的 `reasoning: { efforts, default }`；无 thinking 能力的模型使用 `"reasoning": "none"`。SDK 宿主的 effort 选择器应从 `reasoningProfile.supportedEfforts` / `defaultEffort` 动态生成，不要假定固定五档。

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

Sidecar verifier 的结构化裁决请求会优先使用 provider 级 `tool_choice` 强制工具调用；如果某个兼容端点明确拒绝 `tool_choice` 参数，KodaX 会对该 verifier 请求自动重试一次“不强制但仍带 tools”的兼容模式，并保持 fail-open，不会阻塞主 Worker。

调试 Worker 结束后的 verifier 行为时可设置：

```bash
export KODAX_VERIFIER_LOG=1
export KODAX_VERIFIER_PROVIDER=anthropic
export KODAX_VERIFIER_MODEL=claude-haiku-4-5-20251001
```

`KODAX_VERIFIER_LOG=1` 等价于在 `~/.kodax/config.json` 写 `"verifierLog": true`，会显示 verifier gate、elapsedMs 和 trace；`KODAX_VERIFIER_PROVIDER` / `KODAX_VERIFIER_MODEL` 需要成对设置，用独立模型执行 verifier；`KODAX_VERIFIER_ALWAYS=1` 仅建议调试和回归测试时使用。

SDK / headless 宿主可以通过 `KodaXEvents.onSidecarMessage` 观察 Sidecar
Verifier 的 `revise` / `blocked` 可执行消息；JSONL 输出使用同形
`sidecar.message` 事件。`accept` 仍保持静默。

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

内置 vision-capable alias（Anthropic、OpenAI、Kimi、Qwen、Zhipu、MiniMax、MiMo、Ark，以及通过 CLI `@<path>` file-include 语法传图的 Gemini-CLI）已经默认开了图片输入。DeepSeek V4 默认模型（`deepseek-v4-flash` / `deepseek-v4-pro`）和 Codex-CLI 是纯文本 —— 内置 `deepseek` 只有 `deepseek-v4-flash-vision-exp` 这一个路由收图；自定义 provider 在底层模型支持图片输入时需要手动 opt-in。

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

### 6. Runtime 与本机 daemon

交互 REPL、位置参数、slash-command 生成的任务和 `kodax -p` 现在都走统一的
`KodaXRuntime` 入口。默认使用最低延迟的进程内 `embedded`；单一 SDK 宿主需要
独立 V8 与硬销毁时，可选择 Worker-hosted embedded；需要后台持续运行、断线后
查询或多个本机客户端共享时，可切到 `daemon`：

```ts
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const isolated = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'worker',
  requirements: { hardDispose: true },
});
```

inline 形态由调用方私有且开销最低；Worker 形态仍然私有，但可硬销毁；
daemon 形态使用独立进程并允许多个客户端共享。`runtime.close()` 会关闭
私有 inline/Worker Runtime，但对 daemon 只断开当前客户端。矛盾的隔离参数
会直接报错，不会静默降级。Worker 是 V8 故障隔离边界，不是安全沙箱。

daemon 按设计会持续驻留。测试若自动启动 daemon，删除临时 home 前还必须执行
`kodax daemon stop --home <目录> --profile <名称>`（或发送已认证的
`runtime.shutdown`）。不要按进程名批量结束 Node；应先核验命令行和父进程归属。

```bash
kodax daemon start
kodax daemon stop --profile default
kodax --runtime-mode daemon
kodax -p "检查这个仓库" --runtime-mode daemon
```

持久设置写入 `~/.kodax/config.json`：

```json
{
  "runtimeMode": "daemon"
}
```

统一优先级是：显式 CLI/SDK 参数 > 环境变量 > `config.json` > 内置默认值。
`KODAX_RUNTIME_MODE=daemon` 适合临时覆盖。其他成对配置也遵循相同规则，例如
`provider` ↔ `KODAX_PROVIDER`、`effort` ↔ `KODAX_EFFORT`。JSON 保持 camelCase，
环境变量保持 `KODAX_UPPER_SNAKE_CASE`，两者按语义一一对应。

一个 daemon 可以承载多个 session。不同 session 可以并发运行；同一个 session
内部仍保持一次只运行一个任务，后续任务按队列执行。多个 `kodax` 进程可以连接
同一个 daemon，并分别打开或观察不同 session。

### 7. 打包成单文件二进制（无需 Node）

KodaX 可以用 `bun --compile` 打包成单可执行文件 + 一个 `builtin/` sidecar 目录，目标机器**不需要安装 Node.js 或任何运行时**。

支持目标：`win-x64`、`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`。Win7 / glibc < 2.27 的发行版 / 龙芯 LoongArch 暂不支持。

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
├── runtime-worker.js              # SDK Runtime Worker
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
| kimi | `KIMI_API_KEY` | Native | kimi-k2.7-code（262,144 token；可 `/model` 切换 `kimi-k3`〔1M〕/ `kimi-k2.7-code-highspeed` / `kimi-k2.6` / `kimi-k2.5`） |
| kimi-code | `KIMI_CODE_API_KEY` | Native | k3-256k（Moderato+，256K，直接请求同名上游模型；可 `/model` 切换 `k3`〔Allegretto+，1M〕/ `kimi-for-coding`〔K2.7 Code〕/ `kimi-for-coding-highspeed`） |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| qwen-token-plan | `QWEN_TOKEN_API_KEY` | Native | qwen3.8-max（Anthropic 协议；可 `/model` 切换兼容项 `qwen3.8-max-preview` 及 `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-flash` / `glm-5.2` / `deepseek-v4-pro`；均为 1M ctx；两个 Qwen 3.8 ID / 3.7 Plus / 3.6 Flash 支持图片理解） |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5（可 `/model` 切换 `glm-5.3` / `glm-5.2`，均为 1M ctx，另有 `glm-5.1` / `glm-5-turbo`；GLM-5.3 开放平台 API 仍标注为即将上线） |
| zhipu-coding | `ZHIPU_CODING_API_KEY` | Native | glm-5.3（1M ctx、128K 最大输出；可回退到 `glm-5.2`，也可切换 `glm-5-turbo` / `glm-4.7`；原样发送上游 ID） |
| zai-coding | `ZAI_CODING_API_KEY` | Native | glm-5.3（保留 `glm-5.2` 回退；原样发送上游 ID；2026-08-15 起默认从 glm-5.2 切换） |
| minimax-coding | `MINIMAX_CODING_API_KEY` | Native | MiniMax-M3（Frontier Coding，原生多模态 + 1M ctx；仍可通过 `/model` 显式选择兼容模型 `MiniMax-M2.7` / `MiniMax-M2.7-highspeed`） |
| mimo | `MIMO_API_KEY` | Native | mimo-v2.5-pro（小米 MiMo 按量计费，Anthropic 协议） |
| mimo-coding | `MIMO_CODING_API_KEY` | Native | mimo-v2.5-pro（小米 MiMo Token Plan，Anthropic 协议） |
| ark-coding | `ARK_CODING_API_KEY` | Native | glm-5.3（火山方舟 Coding Plan — GLM-5.3（1M ctx、128K out） · GLM-5.2（别名 `glm-latest`） · Kimi K2.7 Code / K2.6 · MiniMax M3 / M2.7 · DeepSeek V4 Pro / V4 Flash · Doubao Seed 2.0 Code / Pro / Lite · Doubao Seed Code） |
| deepseek | `DEEPSEEK_API_KEY` | Native | deepseek-v4-flash（可 `/model` 切换 `deepseek-v4-pro` 及视觉模型 `deepseek-v4-flash-vision-exp`，后者支持图片输入） |
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
| `emit_managed_protocol` | managed-task 协议侧信道（verdict role payload）。v0.7.42 FEATURE_184 起默认走 V2 Worker 单循环 + Sidecar Verifier；v0.7.43 FEATURE_193 退役 V1 chain。 |

## Repo Intelligence（内置 full/light 引擎）

KodaX 内置 repo intelligence（`repo_overview` / `module_context` / `symbol_context` / `process_context` / `impact_estimate` 等），让 coding agent 不靠零散 grep/glob 就能理解大型仓库。

REPL 中使用 `/repo-intel status` 查看当前引擎状态。旧的独立 `repointel` host skill 已移除；repo intelligence 已内置于 KodaX，无需任何外部安装。

```bash
# 选一个运行模式（auto | full | light | off）
kodax --repo-intelligence full --repo-intelligence-trace
```

## 仓库结构

KodaX 是基于 npm workspaces 的 TypeScript monorepo，**源码层 4 个 workspace 包**（FEATURE_194 v0.7.43 包合并 — 9 → 4，ADR-036），npm 上以单 bundle 包 `@kodax-ai/kodax` 发布 + 12 个 SDK subpath exports（`/agent`、`/llm`、`/coding`、`/media`、`/repl`、`/skills`、`/mcp`、`/session`、`/runtime`、`/sandbox`、`/a2a`、`/experimental-memory`；ADR-024 + ADR-032 + ADR-038）。核心包：

| Workspace 包 | 作用 | 主要依赖 |
|----|------|---------|
| `@kodax-ai/llm` | LLM 抽象层（16 个内置 provider alias + 自定义 provider 注册），可独立使用 | `@anthropic-ai/sdk`, `openai` |
| `@kodax-ai/agent` | 通用 Agent 框架 —— Runner / runFanOut / runWithIdleYield / AgentActorController / AgentTurnScheduler + media/input artifacts + 会话管理 + tokenization + 面向自定义 loop 的可插拔 compaction primitive（不关闭 KodaX coding runtime 的始终开启策略）+ **inline 后**:session-lineage 子树 + capabilities (mcp + skills + builtin) + tracing（subpaths: `/media`、`/session-lineage`、`/capabilities/mcp`、`/capabilities/skills`、`/tracing`） | `@kodax-ai/llm`, `fflate`, `jimp`, `yaml` |
| `@kodax-ai/coding` | Coding Agent:50+ 工具（含 canonical Actor 协作工具）、role prompts、agent loop、auto-continue + repo-intelligence protocol(v0.7.43 inline) | `@kodax-ai/llm`, `@kodax-ai/agent` |
| `@kodax-ai/repl` | 完整交互式终端 UI（Ink / React、权限模式、命令系统、流式渲染） | `@kodax-ai/coding`, `ink`, `react` |

根目录 `src/kodax_cli.ts` 是 CLI 入口；`src/sdk-{agent,llm,coding,media,repl,skills,mcp,session,runtime,sandbox,a2a,experimental-memory}.ts` 是 SDK subpath 入口；构建产物在 `dist/`，单文件二进制在 `dist/binary/<target>/`。

### 源码层 vs npm 发布层

KodaX 有两层结构，SDK 用户需要分开理解：

- **源码层**：上面 4 个 workspace 包（开发者读代码时看到的物理结构）。
- **npm 发布层**：单个 bundled 包 `@kodax-ai/kodax`，对外暴露 12 个 SDK subpath（SDK 消费者 `import` 时看到的接口）。subpath 分两种角色：
  - **完整包 subpath**（`/agent`、`/llm`、`/coding`、`/repl`）—— 每个 1:1 对应一个源码包，暴露完整公开 API。
  - **集成与窄子集 subpath**（`/media`、`/skills`、`/mcp`、`/session`、`/runtime`、`/sandbox`、`/a2a`、`/experimental-memory`）—— 聚焦能力或宿主集成边界；`/experimental-memory` 明确为 opt-in 不稳定接口。

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
| `src`             | `@kodax-ai/kodax/runtime` | 宿主 API | Embedded/Worker/daemon facade，含 sessions/runs/events/permissions/catalog/MCP/artifacts/diagnostics/外部 Agent 和 daemon schema (10 exports) | SDK 宿主、Space/IDE、daemon client |
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
HTTPS 或精确 loopback 规则。Worker-hosted SDK Runtime 可通过
`worker: { configuredA2A: true }` 让 Worker owner 装载同一配置执行平面。
CLI 同样支持在 `~/.kodax/config.json` 中配置 `"worker": { "configuredA2A": true }`，
将嵌入式运行时改为 Worker 托管并装载配置的 A2A 执行平面。
`a2a serve` 会在监听前装载已配置的 MCP/Extension 能力并固定执行权威，同时热加载
公开信息、鉴权和限额。Agent、Skill、Extension 工具权威、工作区、tool policy
或任务存储变更必须显式重启服务。

A2A 配置迁移与历史任务 owner 迁移是两件事。如果升级 realm-aware owner key
后仍需访问 v0.7.70 的任务库，应先停止 A2A server，执行
`kodax a2a migrate-tasks` 查看精确 owner 计划，再用
`--apply --confirm-server-stopped` 应用。OAuth 还必须提供已知历史
`--subject`；正常服务不会猜测或双读 legacy owner key。

托管 A2A 上下文默认位于 `~/kodax_a2a_server_workspace/<runtime-profile>/contexts/`。
精确授权的 Skill 脚本必须使用隔离策略，并通过 `kodax sandbox doctor`；
Windows 的一次性显式初始化由 `kodax sandbox setup` 完成。

**v0.7.72 会话恢复与队列闭环：**裸 `kodax -r` 先加载可搜索选择器，不为列出
session 预加载完整 CLI；选中后才把 stdin 交给恢复后的 REPL，Esc 会释放选择器的
stdin 并立即回到原 shell。历史回放保留每条持久 event 的原始时间。用户 follow-up
使用 session-root Actor queue scope，避免一个 session/child 的待处理输入被另一个
REPL 显示、唤醒或消费。

**外部 Agent SDK plane（FEATURE_258，v0.7.67）**：`/agent` 导出协议中立的 executor、registration、policy、credential broker、artifact policy、catalog 和 durable task 契约；`/runtime` 通过 `admin.agentRegistrations`、`agents`、`agentTasks` 向 embedded 与 daemon client 提供同一组 DTO API。Executor factory 是宿主函数，只能装入 inline owner，或在创建新的 in-process daemon owner 时装入；不能通过既有 daemon 连接或 Runtime Worker 边界注入。Plane 关闭后是终态：未完成的 wait 和后续所有服务调用都会拒绝；受限 Workflow 脚本会完整校验并传递 `phase` 与外部 `target`。完整所有权、注册、preflight、启动/等待/继续/取消/对账和安全边界见 [SDK Embedder Guide §18](public_docs/sdk/embedder-guide.md#18-external-agent-executor-plane-feature_258-v0767)。

**成本受控 Workflow SDK（FEATURE_259，v0.7.67）**：SDK 调用方用 run-scoped `modelTiers` 与 `workflow.maxConcurrency` 配置路由和并发，workflow 作者只表达 `fast` / `balanced` / `deep` 语义意图。terminal workflow event 回显 tier/source/fallback/usage/duration，持久化 `run.json.efficiencyReport` 给出 token coverage、role/tier 启动数、packet-read 拓扑、review wave 和 quality gate 结果。完整配置与遥测读取方式见 [SDK Embedder Guide §20](public_docs/sdk/embedder-guide.md#20-cost-disciplined-workflow-routing-and-telemetry-feature_259-v0767)。

**Inline workflow authoring（FEATURE_246，v0.7.58；F270 于 v0.7.72 更新）**：Worker 在明确表达 Workflow 意图时，可通过 model-callable 的 `run_workflow` 工具在会话内编写并运行工作流。F270 退役 AMAW 与复杂度驱动激活；AMA 保留显式 `/workflow`、named/SDK 和自然语言 Workflow 请求。Workflow 子 Agent 统一运行在 Actor 控制面。详见 [docs/features/v0.7.58.md](docs/features/v0.7.58.md)、[docs/features/v0.7.72.md](docs/features/v0.7.72.md) 与 ADR-044/046/047/048/049/055。

**历史工作流激活分层（FEATURE_248 + FEATURE_249，v0.7.59；F270 于 v0.7.72 取代）**：v0.7.59 引入 AMAW 和 AMA 的显式请求行为。F270 退役 AMAW 及其复杂度驱动指令；SA 保持单独作业，AMA 成为唯一自适应多 Agent 模式，并且只在明确 Workflow 意图下激活 Workflow。详见 [docs/features/v0.7.59.md](docs/features/v0.7.59.md) 与 [docs/features/v0.7.72.md](docs/features/v0.7.72.md)。

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
│   ├── build-bundle.mjs     # esbuild 单 bundle 多 entry 打包（CLI + root + 12 SDK subpath + chunks）
│   ├── build-binary.mjs     # Bun --compile 单文件二进制打包
│   └── release.mjs          # 构建/审计后仅临时切换 private 以 pack/publish
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
