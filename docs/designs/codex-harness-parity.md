# KodaX 对标 Codex：效率、可靠性与任务表现

2026-10-14；KodaX 设计基线 `0c24ce40`，Codex 源码 `400f2356`，完整请求来自安装版 CLI `0.162.0-alpha.17.2`。本阶段为源码分析与零网络验证，产品未修改、外部模型调用 0。实施细节和既定预算沿用 [首轮精简计划](first-turn-contract-refinement.md)。

## 目标及证据边界

先做到真实可用能力与模型契约一致、相近的上下文效率、可靠的执行/取消/恢复，再报告选定模型的任务表现。输入达到 Codex 的约 17.2–17.3k 不等于智能达到 Codex；不同模型、协议、skills、工具集合与桌面插件不能混为严格横向质量结果。

Codex 的当前指定模型路径是 catalog 驱动的 CodeModeOnly/ResponsesLite/V2 协作。其完整工具约 9.3k，包含 11 个 native calls 与 12 项 SDK 声明；本次 capture 无 ranked tool_search，IncrementalTools 默认关闭。不能把其总量归因于已启用所有渐进披露 feature。

## 逐项对标与选择

| 维度 | Codex 当前源码路径 | KodaX 当前事实 | 最小合理选择 |
|---|---|---|---|
| 模型适配 | 模型 catalog 同时选择指令、工具模式、推理及协议 | 多 provider 的原生工具、推理/输出/上下文能力已有 descriptor 和兼容逻辑 | 核对真实 route/能力；只为已观察到的差异保留例外，不复制每模型整套提示词 |
| 工具输入 | CodeMode SDK 和 native 问答/协作约 9.3k | AMA native 契约约 15.3k；四项短契约候选已省约 1.0k | 先精炼现有契约；保留核心 direct 工具，小步延迟长尾完整 schema |
| 能力真值 | 启用、可发现、呈现方式分开，工具注册同源 | 默认 Runtime SA 展示协作，但实际 list_agents 返回 unavailable | 按真实 host binding 门控 builtin；SDK 注入 Actor 的 SA、AMA 和有效 override 保留 |
| 调度 | runtime 按 supports_parallel 经共享/独占 gate；独立 shell 可并行 | 已有读/工具并行、文件锁/CAS；native bash 串行而 bridge→bash 并行 | 先统一 canonical target 的既有调度语义，不先造依赖图或放开所有 shell |
| 启动时机 | OutputItemDone 后可启动工具，stream 尾部有序汇合 | SA/AMA 等 provider.stream 完整返回后 dispatch | 先测工具 ready→start 的实际损失；有收益才考虑已完成只读调用提前运行 |
| 长命令 | process session、yield、stdin 与增量输出，明确 exit/cancel | 已有后台日志、进程终止/清理，缺相同的模型侧 session/交互接口 | 先测重复启动/轮询问题；复用现有进程管理补生命周期事实，不先扩成通用终端框架 |
| 上下文与缓存 | state diff、稳定 prefix、provider 原生压缩；部分传输可增量 | 已有稳定/动态消息分离、cache diagnostics/affinity、输出容量与持久压缩 | 保住这些底座；看真实 cache 和任务总输入，不能只搬字段或降低输出限额 |
| 计划与完成 | 自主模型结合真实工具/测试结果；wait wake 与 child terminal 分开 | 稳定 id、owner、完成 veto、状态和证据已有实现；SA/AMA evaluator 接线不同 | 保留执行事实与真实检查，不把 completed、wake 或 run success 当作测试通过 |

这些是工程机制对标，不是任务质量排名。CodeMode 的代码生成、嵌套错误恢复及结果裁剪在 GLM/Kimi/DeepSeek 上尚无对照证据；本轮不默认改成 PTC。现有 edit 批处理、错误恢复及 SDK 兼容继续保留，不为匹配 Codex 名称更换编辑语法。

## 两项已验证的不一致

### 默认 Runtime SA 的协作展示

生产 SDK Runtime + CLI ClientPlane、scripted SSE 首轮展示 57 个工具；实际执行一次只读 `list_agents` 返回 `[Tool Error] list_agents: Agent collaboration is unavailable on this turn.`。相同实际 Runtime AMA 的对照调用返回 `ok:true`、`callerPath:/root` 和当前容量。两项都没有真实模型、child 或 shell。SDK 默认 SA 不把 ActorSession 绑定到本轮，七个协作 handler 均要求 actorControl；owned Actor registry 存在不等于模型工具已绑定。

只对这一宿主事实做离线假设移除七项契约，OpenAI SA 19,574→17,422、Anthropic 19,850→17,679。与四项 r3 精炼合并、扣除 spawn 重复节省后为 16,560/16,817。其余 system/history 保留；这些是候选预算，不是实现或实际 API usage，也不是与有协作能力的 Codex 等能力结果。

实施 seam：`tool-execution-context.ts` 的真实绑定与 `tool-search.ts` 的共享 ceiling。按 builtin 所需 binding 判断，模型工具表、描述/发现、策略指导一致；执行入口仍保持 SDK/历史兼容及原权限检查。不得按 `agentMode=sa` 一刀切，不丢 caller-injected Actor 或独立有效的 extension override；AMA 不套用此次七项删除。

### Native/bridge 的目标调度

生产 SA `runToolDispatch` 与实际 bridge，在隔离进程把 bash handler 替换成可控内存 barrier：native 最大在途 1，bridge→bash 最大 2。未启动真 shell、未调用模型。证明这一 SA 路径的外层名称分类与实际目标调度不一致，不证明权限绕过或文件丢写，也不宣称所有 AMA 路径已同样复现；原文件锁/CAS 继续保护文件 mutation。

实施 seam：SA `tool-dispatch.ts`；managed Runner 的相近分类须另做 barrier 契约验证，再修确实存在的差异。桥接前解析 canonical target 的调度身份，继续保留 outer call id、target authorization/override、取消、结果顺序和 mutation accounting。先使 bridge 与 direct 对等；是否允许更多并行另由具体独立任务证据决定。

## 执行顺序与回归边界

1. **先修能力真值和桥接调度**。TDD 覆盖默认 SA、注入 Actor 的 SA、AMA、override、取消、native/bridge 同一目标的 barrier 顺序；这些无需模型评测即可回答。
2. **落实已核对的短契约与规则归属**。保持 ask 自由文本/批问、Todo 增量/owner/veto/metadata、独占写集合、模型档位限制、terminal 证据与用户最新修正。修正过时的 permission-mode 教学。新抓包报告完整字节和估算，不能沿用离线数字当上线结果。
3. **试点低频完整 schema 披露**。稳定核心前缀、短能力目录，一次批量 search 返回完整契约后经原 bridge 执行；验证首次发现、compaction/resume、权限和 override。核心编辑/Todo/交互/技能/AMA 协作保留 direct。
4. **按证据再做流式启动与长命令优化**。先测 request、completed tool input、执行启动/结束、final response 的时序和进程重复操作。任何提前执行都必须有完整参数、执行前持久记录、正确取消和无重复副作用；不能因 JSON 暂时可解析而执行半成品。若实际延迟收益小，则不增加运行时机制。

SA/AMA 已共享执行上下文、权限、工具投影、输出容量与持久压缩；不因存在两个 loop 就合并整套框架。优先统一确实不一致的窄契约。输出治理已有单项 16k、批量 48k attention 边界及可恢复 artifact；任何进一步削减须验证诊断与补读成本，不静默丢证据。

## 如何判定接近 Codex

- **输入效率**：固定场景完整 request/工具/说明字节及估算；另列真实 API input/output/cache。SA 有约 16.6–16.8k 的离线预算，AMA 首个工程目标仍为约 18–20k，均等待实现和质量验证。
- **执行可靠性**：真实可用工具一致、权限/取消、原子编辑失败零写、目标调度、child terminal 与恢复事实。以 production Runtime 不变量和回归证明，不以名称数或 run success 判断。
- **有限任务表现**：保留既定最多 18 次的 KodaX 基线/候选 pilot 与有界 Runtime smoke，报告正确性、计划/协作、证据、诚实性、总 token、轮次、时延与失败归因，不宣布广域智能非劣。
- **同模型 Codex 对照**：先确认共同 native model/route/effort/protocol，再单独预注册；当前 KodaX codex-cli 忽略本地 system/tools、转发最新消息并由 Codex 自己执行，不能隔离 KodaX harness 增益。Windows 当前仅解析到 bundled codex.exe，而桥接执行器使用 codex.cmd，入口也未验证。原生 OpenAI adapter 为 Chat Completions，不声称已支持此次 sol/astra 的同条件 Responses 路径。

若首轮缩小而额外发现/补读/重试抵消、任务责任弱化或出现可信退化，修复或撤回对应阶段。不会通过新 CodeMode 运行时、增加模型层级或扩充评测矩阵来预先保证“达到 Codex 智能水平”。

研究原件与复现脚本在忽略研发笔记及 OS Temp，历史 raw/账本不改写；正式文档追踪工程选择和证据边界。当前尚未运行新的付费质量对照。
