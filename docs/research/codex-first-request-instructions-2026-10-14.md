# Codex 首次请求的指令与界面计数审计

日期：2026-10-14。仅核查本地 primary sources；Codex 固定 commit **`c22a06c18070c3e33bd2648c7210a00a2a9f6f80`**。下文所有 Codex 源码引用均属于此 commit。KodaX estimator 所在 HEAD 为 `bd4479d59cab3d082f07c2d34681fff198d82fa0`。未读取用户私有配置/session，未联网、调用模型或运行 eval，未构建 Rust，也未修改参考仓库。

## 核心结论

不能根据 Codex 界面看起来较小的 token/上下文数字，断言其完整首轮输入较小。当前两个选定模型的 **base 指令自身**按 KodaX 同一估算法已有约 5.4k tokens；加本报告固定场景中的 collaboration、权限、环境、multi-agent 指令，文本小计为 **6,525（gpt-6.1-sol）/6,437（gpt-6-astra）**。这些数值仍须加全部工具 channel、用户任务及协议开销，才能讨论完整首次请求。另一方面，本地 TUI 的绝对 token 和上下文百分比都存在不同于原始输入 token 的展示公式；**尚未证明 desktop UI 使用相同公式**。定量来源见下表与脚本，显示公式见后文。

## 取哪个 prompt 才是公平比较

`models.json` 中 gpt-6-astra 的选定 base 在 [models.json:76](C:/Works/PubProj/codex/codex-rs/models-manager/models.json:76)，gpt-6.1-sol 在 [models.json:250](C:/Works/PubProj/codex/codex-rs/models-manager/models.json:250)。两者 `tool_mode=code_mode_only`、`multi_agent_version=v2`、`use_responses_lite=true`、默认 reasoning=low；这些字段分别在 [models.json:20](C:/Works/PubProj/codex/codex-rs/models-manager/models.json:20) 和 [models.json:193](C:/Works/PubProj/codex/codex-rs/models-manager/models.json:193) 起的模型条目中。不能累计仓库里的所有 prompt 模板，也不能把旧的短 `prompt.md` 当成这两个模型的实际 base。

本版已经**不做 personality 变量插值**。`render_model_instructions` 直接返回选定 `instructions_template` 字面文本，缺失才为空并 warning；`supports_personality` 是兼容字段。第一方 `renders_literal_templates` 测试明确保留 `{{ personality }}` 字面串。因此“default personality 渲染”在这个 commit 中不是额外可选模板拼接步骤。[renderer:8](C:/Works/PubProj/codex/codex-rs/prompts/src/model_instructions.rs:8)、[literal test:63](C:/Works/PubProj/codex/codex-rs/prompts/src/model_instructions_tests.rs:63)、[compatibility field:253](C:/Works/PubProj/codex/codex-rs/protocol/src/openai_models.rs:253)、[literal template contract:545](C:/Works/PubProj/codex/codex-rs/protocol/src/openai_models.rs:545)。

实际会话优先级为 config override → 历史保存的 base → 当前模型 renderer；本报告选空历史、无 override。默认 update_plan 没有显式 enabled 即关闭；对于 builtin catalog/model 来源的 base，请求副本会删除规划工具指导。离线按该函数重放后，这两个选定 base 的长度**没有变化**。[base resolution:800](C:/Works/PubProj/codex/codex-rs/core/src/session/mod.rs:800)、[request filter:1600](C:/Works/PubProj/codex/codex-rs/core/src/session/mod.rs:1600)、[update_plan config:2766](C:/Works/PubProj/codex/codex-rs/core/src/config/mod.rs:2766)、[filter implementation:4](C:/Works/PubProj/codex/codex-rs/prompts/src/update_plan_instructions.rs:4)。

## 固定场景与可复跑结果

场景为 bundled catalog、CLI root、新会话、Default collaboration、默认 low reasoning；空 skills/MCP/AGENTS/历史/用户自定义 developer 指令/插件应用/子 agent。为控制权限变量，**显式选 danger-full-access + never**；这不是声称所有 Codex 安装的默认权限如此。环境固定单个本地 `C:\workspace`、PowerShell、2026-10-14、Asia/Shanghai，无 network requirements、shell version 功能和额外 workspace roots。V2 并发数 4、wait 和模型 override guidance 按源码默认启用。[V2 defaults:256](C:/Works/PubProj/codex/codex-rs/core/src/config/mod.rs:256)、[V2 config:1392](C:/Works/PubProj/codex/codex-rs/core/src/config/mod.rs:1392)。真实默认 approval 受 project trust/requirements 影响，默认权限 profile 也受 trust/Windows sandbox 可用性影响。[approval resolution:3854](C:/Works/PubProj/codex/codex-rs/core/src/config/mod.rs:3854)、[permission defaults:72](C:/Works/PubProj/codex/codex-rs/core/src/config/permissions.rs:72)。

统计直接 import [KodaX tokenizer.ts:112](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/agent/src/tokenizer.ts:112) 的 `countTokens`，没有加载模型 BPE。普通文本公式为 `ceil((3*UTF8 bytes - UTF16 units)/8)`，长编码串另有保护系数；本表各字符串不触发长编码串保护。数字为 **文本估算**，不含每 message 的 4-token 近似或 API framing。UTF16 units 与 Unicode codepoints 在这些文本中相等；精确 UTF8 bytes 单列。[estimator:41](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/agent/src/tokenizer.ts:41)。

| 已选组件（含其实际 XML markers） | sol UTF16 | sol UTF8 bytes | sol 估算 | astra UTF16 | astra UTF8 bytes | astra 估算 |
|---|---:|---:|---:|---:|---:|---:|
| base（无 XML markers） | 21,769 | 21,779 | 5,446 | 21,420 | 21,428 | 5,358 |
| Default collaboration | 920 | 920 | 230 | 920 | 920 | 230 |
| permissions | 363 | 363 | 91 | 363 | 363 | 91 |
| 固定 environment | 357 | 357 | 90 | 357 | 357 | 90 |
| V2 root role + shared/wait/model override guidance | 2,400 | 2,400 | 600 | 2,400 | 2,400 | 600 |
| V2 explicit mode | 271 | 271 | 68 | 271 | 271 | 68 |
| **以上文本分项估算相加** | | | **6,525** | | | **6,437** |

复跑命令：

```powershell
node --experimental-strip-types docs/research/measure-codex-first-request-instructions.mjs C:/Works/PubProj/codex
```

[离线脚本](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/docs/research/measure-codex-first-request-instructions.mjs)读取选定 catalog、bundled 权限模板和 multi-agent 常量，重建上述文本；[聚合 JSON](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/docs/research/codex-first-request-instructions-2026-10-14.json)保存 commit、catalog hash、场景、逐项字节/字符/token estimate/hash，不保存私有上下文。脚本对 runtime environment 固定值做静态重建；这不是实际 Rust builder capture。catalog 字符串按 JSON 解码，include_str 权限模板按本地实际字节读取，Rust raw literal 的源码 CRLF 归一为 LF。

组件来源与注入条件如下：

- **Collaboration**：优先选模型 catalog 的 default，而不是额外累计 bundled `default.md`；该内容 role 为 developer，带 `<collaboration_mode>`。默认 include flag 为 true。[selection:26](C:/Works/PubProj/codex/codex-rs/core/src/context/world_state/collaboration_mode.rs:26)、[render:158](C:/Works/PubProj/codex/codex-rs/core/src/context/world_state/collaboration_mode.rs:158)、[config:4129](C:/Works/PubProj/codex/codex-rs/core/src/config/mod.rs:4129)。
- **Permissions**：模型这两个 override 为 null，选 bundled sandbox + approval 文本；XML role developer。`append_section` 从空字符串开始先补换行，sandbox 模板 trim_end、approval 保留文件结尾、最终确保换行；脚本包含这些字节。[composition:101](C:/Works/PubProj/codex/codex-rs/prompts/src/permissions_instructions.rs:101)、[markers/body:257](C:/Works/PubProj/codex/codex-rs/prompts/src/permissions_instructions.rs:257)、[append_section:285](C:/Works/PubProj/codex/codex-rs/prompts/src/permissions_instructions.rs:285)、[sandbox selection:347](C:/Works/PubProj/codex/codex-rs/prompts/src/permissions_instructions.rs:347)。
- **Environment**：role user；新上下文含 cwd、shell、时间、filesystem，并可增量更新。date 与 timezone 由运行时提供。额外 network 片段依赖 requirements.network，不能因 sandbox network enabled 就盲加。shell version 受默认关闭 feature 控制。[environment builder:43](C:/Works/PubProj/codex/codex-rs/core/src/context/world_state/environment.rs:43)、[role/render:249](C:/Works/PubProj/codex/codex-rs/core/src/context/world_state/environment.rs:249)、[filesystem:59](C:/Works/PubProj/codex/codex-rs/core/src/context/environment_context.rs:59)、[network:537](C:/Works/PubProj/codex/codex-rs/core/src/context/world_state/environment.rs:537)、[time flags:4142](C:/Works/PubProj/codex/codex-rs/core/src/config/mod.rs:4142)。
- **Multi-agent**：默认 low 选择 explicit mode（只有 ultra 自动选择 proactive）；root catalog role 与 shared/wait/concurrency/model-override guidance 拼接，两个片段均 developer。不要再将 subagent role 或 proactive mode 也累计。默认 include 有四个 slots，即使尚未 spawn 子 agent 也有该指导。[role selection:14](C:/Works/PubProj/codex/codex-rs/core/src/session/multi_agents.rs:14)、[mode selection:84](C:/Works/PubProj/codex/codex-rs/core/src/session/multi_agents.rs:84)、[role rendering:53](C:/Works/PubProj/codex/codex-rs/prompts/src/multi_agent_instructions.rs:53)、[mode rendering:27](C:/Works/PubProj/codex/codex-rs/core/src/context/multi_agent_mode_instructions.rs:27)。

## 不能遗漏的请求项与离线证据边界

当前 client 把非空 base 作为 **developer message** 前置，而非固定 system role。Rlite 工具是 `AdditionalTools { role: developer }`；普通 Responses 才走顶层 `tools`。所以只数 `system` 字段必漏，数完 base 又数其 developer 副本会重复。incremental_tools 开启时 base/tools 已在 world state，不能额外累计一遍。[request construction:977](C:/Works/PubProj/codex/codex-rs/core/src/client.rs:977)、[base prefix:996](C:/Works/PubProj/codex/codex-rs/core/src/client.rs:996)、[world state:146](C:/Works/PubProj/codex/codex-rs/core/src/session/world_state.rs:146)。

本报告**全部未计工具 channel**，必须与并行工具审计合并：native schema、code-mode 执行器文档/声明、collaboration 工具 schema、provider tool serialization、dynamic/MCP 等不能当作零。也没有计用户任务正文、响应 format、额外 host extension 指令或协议 framing。空 skills 表示目录为零，不代表 base 中通用 skills 使用指导被删掉。[client:979](C:/Works/PubProj/codex/codex-rs/core/src/client.rs:979)、[extension contributors:340](C:/Works/PubProj/codex/codex-rs/core/src/session/world_state.rs:340)、[selected base:250](C:/Works/PubProj/codex/codex-rs/models-manager/models.json:250)。

可选 TokenBudget、DeferredExecutor、ModelCatalogInContext、IncrementalTools 在 feature 表的默认值均 false；persistent 仅选 Persistent reasoning 时启用。实际 app/host 可能覆盖这些，因此上表不能代表安装中的 desktop 全部默认注入。[features:1126](C:/Works/PubProj/codex/codex-rs/features/src/lib.rs:1126)、[features:1484](C:/Works/PubProj/codex/codex-rs/features/src/lib.rs:1484)、[features:1592](C:/Works/PubProj/codex/codex-rs/features/src/lib.rs:1592)、[features:1910](C:/Works/PubProj/codex/codex-rs/features/src/lib.rs:1910)、[persistent predicate:582](C:/Works/PubProj/codex/codex-rs/features/src/lib.rs:582)。

第一方测试有捕获请求 snapshot。例如 [astra_active_environment_selection.snap:9](C:/Works/PubProj/codex/codex-rs/core/tests/suite/snapshots/all__suite__scenarios__astra_active_environment_selection.snap:9) 可确认 additional_tools/developer 与 message/developer 布局，但 base 在第 33 行被替换为 `<OMITTED ... ~4935 TOKENS ...>`；不能直接以 snapshot 文件大小当请求大小。snapshot formatter 默认规范化 path/id，并截断长行/长段；`rewrite_known_segments` 可替换整段，`include_request_settings` 默认关闭。[snapshot formatter:24](C:/Works/PubProj/codex/codex-rs/core/tests/common/context_snapshot.rs:24)。本轮未找到针对本报告固定场景、两个目标模型的完整未截断 request artifact；**静态重建 ≠ 真 builder 输出 ≠ API usage**。

## Token UI 三种口径：TUI 已证实，desktop 未证实

核心 `TokenUsage` 分开保存 input、cached input、output、reasoning output、total；`TokenUsageInfo` 有累积 total 和最后一轮 last。更新时累加 total，同时替换 last。[fields:2366](C:/Works/PubProj/codex/codex-rs/protocol/src/protocol.rs:2366)、[info/update:2401](C:/Works/PubProj/codex/codex-rs/protocol/src/protocol.rs:2401)。

本地 CLI/TUI `/status` 的绝对 token count 用**累计** `total_usage.blended_total()`：

```text
cached = max(cached_input_tokens, 0)
non_cached_input = max(input_tokens - cached, 0)
blended_total = max(non_cached_input + max(output_tokens, 0), 0)
```

因此它不是原始 input，也不是 provider `total_tokens`。CLI final usage 也同样显示 blended total，并将 cached 单独放在 `(+ N cached)`。这不是精确费用公式，cached input 仍占上下文。[formulas:2551](C:/Works/PubProj/codex/codex-rs/protocol/src/protocol.rs:2551)、[/status:368](C:/Works/PubProj/codex/codex-rs/tui/src/status/card.rs:368)、[CLI final:2613](C:/Works/PubProj/codex/codex-rs/protocol/src/protocol.rs:2613)。

TUI 上下文百分比则选**最后一轮** `last_token_usage.total_tokens`，并扣固定 `BASELINE_TOKENS=12000`：

```text
若 window <= 12000：remaining_percent = 0
否则：
  effective_window = window - 12000
  used = max(last.total_tokens - 12000, 0)
  remaining = max(effective_window - used, 0)
  remaining_percent = round(clamp(remaining / effective_window * 100, 0, 100))
```

注释称 12,000 用于涵盖 prompt、tools 以及 compact 空间，令 UI 显示用户可控部分；它是**固定展示基线，不是测量到每次请求真的有 12,000 输入**。小于基线时，即使输入有几千 tokens，也可显示 100% left；大窗口下四舍五入也会隐藏小变化。绝对上下文 tokens 仍取 last.total。[baseline/formula:2543](C:/Works/PubProj/codex/codex-rs/protocol/src/protocol.rs:2543)、[/status context:357](C:/Works/PubProj/codex/codex-rs/tui/src/status/card.rs:357)。

举例（仅演算）：某轮 provider input=10,000、cached=9,000、output=100、total=10,100，累积仅此轮，则 CLI blended total=1,100，但原始输入仍为 10,000；window>12,000 时上述 context left=100%。这说明**显示低、缓存命中高、原始输入短，是三件不同的事**。

**用户已确认观察 Codex 界面的 token / 上下文数值，尚未区分 CLI/TUI 或 desktop；TUI 已证实，desktop 消费逻辑未核查。** app-server 的 `ThreadTokenUsage { total, last, modelContextWindow }` 把 core 的 total/input/cached/output 原样传出，并未在这里套用 blended 或减 12,000；是否变换取决于消费端。本轮没有读取到 desktop 相应 UI 消费逻辑或该会话的 usage 数据，故其显示公式仍未证实。[app-server conversion:1974](C:/Works/PubProj/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1974)、[raw fields:1995](C:/Works/PubProj/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1995)。

## 对 KodaX 的具体含义与待验证项

1. **先统一可观察口径，再判断提示词是否过大。** KodaX 报表至少应分原始 input、cached input、noncached input、output、最后一次 context usage、累计 usage；界面首轮差距不能直接作为 prompt 裁剪收益。该建议依据上述已证实的多种计数口径，不要求照搬 Codex 的 12,000 常量。
2. **完整 payload 归因须覆盖所有 role 和工具通道。** 建议下一步在固定模型/权限/目录/任务/空外部上下文场景下，对现有真正 builder 做离线 snapshot，按 base、developer runtime、environment、tool declarations、external instructions 分项；避免只比较 system 长度。该设计建议来自 Codex request 的明确多通道结构。
3. **不能用“Codex 只有短 persona”支持 KodaX 大幅砍 base。** 本 commit 的 selected base 本身约 5.4k 统一估算；应保留保障行为的指令，优先消除重复与无效信息，再验证总体任务成本。工具延迟策略和 token UI 不同是单独的问题。
4. **仍未证实**：desktop 展示公式、当前安装实际 catalog/feature overrides、真实首个 provider input/cache usage、tool channel 的服务端 tokenization、完整 Rust builder 固定场景 capture。本文数字只能称“源码静态重建的指令文本小计”。
