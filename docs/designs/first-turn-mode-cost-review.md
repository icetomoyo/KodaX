# 三模式首轮成本、参考项目与最终验收

2026-10-25。结论：三模式接线已经完成，但 Agent 仍是完整 AMA 的通用工作面，
不是 Minimal；主要成本是工具契约和常驻策略，builtin Skill 全文没有被全部注入。
仍有契约表示与规则归属的优化空间，尚无证据支持再无损删除数千 token 的能力入口。
本次只有源码、既有请求重算与离线守卫检查，**0 真实模型调用，未改生产行为**。

后续 [pi 完整工作面复核](pi-agent-surface-review.md) 补充了官方规划/协作/问答扩展：
增强配置的源码投影仍约 2.1–2.35k，不能用 AMA 能力差异解释 KodaX 的全部成本。
保留 36 工具与原策略的紧凑教学反事实约省 874，但尚未实施或证明行为等价。

## 1. 证据范围

- KodaX：`5ebfbc0c` 加当前工作区；真实 Runtime/ClientPlane/provider SDK 抓包
  `kodax-first-turn-wire-UW7OAm` 的十项生产源码 hash 与当前一致。
  入口为 [wire inventory](../../tests/first-turn-wire-inventory.test.ts:89)。
- 本机参考 checkout：Codex `970111f6cb`、DSH `22ddee3792`、pi `136b87e8a`。
  本轮没有联网更新，不能将本机 HEAD 称为远端实时最新。
- 数字采用同一个 [countTokens](../../packages/agent/src/tokenizer.ts:42) 启发式，
  不是 provider BPE、API usage、账单或 Codex UI 上下文。
- KodaX 是空 workspace、隔离个人配置、保留官方 builtin 的完整 Host 场景；
  不代表真实项目 AGENTS、个人 Skills、MCP、历史也这么小。
- 不把旧版本 wire、新源码快照投影与真实任务 usage 混成一种证据。

## 2. 当前 KodaX 的分账

| 完整模型字段，normalized OpenAI | Agent | Coding 默认 | Script |
| --- | ---: | ---: | ---: |
| 工具表示 | 9,062 | 12,291 | 14,260 |
| system 消息 | 6,194 | 6,528 | 6,529 |
| 其他消息/动态上下文 | 1,092 | 1,160 | 1,161 |
| 外层包装与取整差 | 31 | 32 | 31 |
| 合计 | **16,379** | **20,011** | **21,981** |
| native 入口 | 36 | 54 | 25 |

Agent 少 18 项 Git/Repo/LSP 专项入口及相关自动内容，减少 3,632（18.15%），
但保留计划、协作、交互、Goal、Memory、历史恢复、可信读写和知识工具。
因此它是通用工作面选择，不能算作 Coding 等能力压缩。
Script 包含 31 项完整叶契约、原生控制与后台 bash，另加编排说明；不以 25 个入口冒称工具成本更低。
见 [模式分配](tool-mode-allocation.md)、[模型表示](../../packages/coding/src/agent-runtime/script/model.ts:21)。

Agent 工具族约为：AMA 协作 2,122，文件/命令/检索 1,823，Todo 1,113，
问答/审批 1,039，Memory 685，Goal 549，manual/Skill 544，历史 397，
发现/桥接 340，worktree 231，Web 226。各族独立取整与整数组有数 token 差异。
最大单项是 ask_user_question 801、spawn_agent 738、todo_update 564、memory_intent 513、grep 446；
其中 ask 参数约 650、spawn 参数约 579、grep 参数约 394，不能只压缩顶层 description。

常驻 system 的主要规则组为协作策略/操作/steering 约 1,800，计划/去重约 788，
execution guidance 719，Memory 规则约 696，可信上下文 343、终止 288、修改纪律 256。
这些是 raw 段落估算，不能与序列化 system 再相加。
不是 SA/AMA 两份完整提示意外叠加：Worker 根据实际能力选互斥分支，AMA builder
排除独立 execution-guidance section 后由 Worker 放入一次。
见 [Worker](../../packages/coding/src/agents/worker-role-prompt.ts:120)、
[execution guidance](../../packages/coding/src/prompts/execution-guidance.ts:14)、
[capability sections](../../packages/coding/src/prompts/capability-sections.ts:235)。

## 3. 与参考项目的成本对照

### 实际保存的 Windows 请求

| 产品/模式 | 完整模型字段估算 | 工具表示估算 | 证据版本 |
| --- | ---: | ---: | --- |
| KodaX Agent | 16,379 | 9,062 | 当前工作区 normalized wire |
| KodaX Coding | 20,011 | 12,291 | 同上 |
| KodaX Script | 21,981 | 14,260 | 同上 |
| Codex Sol Direct | 15,174 | 7,399 | `deede7201d` 同模型三臂 wire |
| Codex Sol CodeMode 混合 | 18,476 | 10,700 | 同上 |
| Codex Sol CodeModeOnly | 17,047 | 9,272 | 同上 |
| DSH Standard | 9,325 | — | `687f282e86` Windows wire |
| DSH PTC | 11,760 | — | 同上，SDK 全部计入 |

三产品保留各自官方能力，**不是能力等价 benchmark**。表中数字统一估算但
fixture 路径/包装并非逐字相同，不把个位数差额解释为产品收益。
Codex 工具在 input/AdditionalTools 内也已计入；DSH 的完整 HTTP 还有独立扩展字段，
历史整包为 23,228/28,097，不能把这两项直接称为模型上下文。
服务端怎样处理扩展字段尚未证实。来源与抓包方法见
[Windows 对照](first-turn-windows-comparison.md)、[模式源码对照](tool-mode-design.md)。

更合适的表示比较是 Coding 对 Direct、Script 对 Only；混合另列。
Coding 比历史 Direct 多约 4,837，其中工具表示多约 4,892；非工具并不更大。
Agent 比 Direct 多约 1,205；Script 比 Only 多约 4,934。
这些差额不能全叫冗余，但不能一直只选较大的 Codex Only 当作 Coding 唯一基准。

### 当前本机源码的投影，非完整 HTTP 新抓包

| 产品/工作面 | 估算 | 方法与限制 |
| --- | ---: | --- |
| DSH Standard | 9,499 | 当前 tracked Bash 快照经生产 serializer 字段映射；32 native |
| DSH PTC | 11,326 | 同快照，内嵌 SDK 已计入 |
| DSH Minimal / Bash | 477 | 同快照，仅 shell/read_image/working_directory |
| DSH Minimal / Pwsh | 463 | 按当前源码替换 shell schema 的投影；非 Windows 实抓 |
| pi 默认四工具 | 约 1,414 | 当前源码 system/schema 重建，无用户/项目说明、Skills、MCP、扩展 |

DSH 当前 Standard：system 1,442、tools 7,775、messages 264，另有包装；
Agent 对它的差距主要在 system，其次才是工具。同样是约三十个工具，文字预算仍可相差很大。
新旧 DSH Standard 有 27 个完整 schema 逐字节不变；plugin_manager、模型目录、subagent
等已有变化，不能用旧 wire 假装当前总量。当前 Minimal 的静态 Bash/Pwsh 差仅约 14，
不支持继续笼统声称“Minimal 必然有巨大平台差异”；此前差异的原始场景尚需单独追溯。
DSH Minimal 不装 Standard 的 Todo、Goal、协作和技能目录，故不作为当前 AMA 等能力目标。
源码入口：`C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/`，
`packages/llm/llm-deepseek/src/serialize.ts` 与各 tool 插件。

DSH 系统只教协作原则，工具教调用语义，host 管理深度/后代/inbox。
send_message 同时承担 steer/继续，父级按结果唤醒；Todo 是全表替换；Goal 允许从长任务推断。
这些与 KodaX 的 wait/followup/历史 turn、增量 Todo/owner/hooks、明确授权 Goal 不等价。
可借鉴规则归属，不能只删除几个 KodaX 名字就宣称得到相同能力。
主要源码：DSH `packages/subagent/tool-subagent/src/index.ts:363`、
`packages/subagent/subagent/src/manager.ts:252`、`packages/todo/tool-todo/src/index.ts:137`、
`packages/goal/tool-goal/src/authority.ts:76` 与 `packages/goal/tool-goal/src/index.ts:115`。

pi 当前默认 read/bash/edit/write，其他工具与 codemode 扩展不默认激活。
它已有可选 `on/only` code mode：on 在 native 描述只追加调用方式/返回形状，不重复一份参数 schema；
only 集中声明，默认内联预算 3,000，超出可在 cell 内搜索/描述工具。
这证明“同一次代码执行中发现”值得研究，但运行时才取得未知 schema，并不能自动保证模型
事先写好的代码能正确构造参数。不能据此承诺所有发现都无额外模型往返。
源码：`C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts`、
`src/core/system-prompt.ts`、`src/extensions/codemode/tool.ts:179`、
`src/extensions/codemode/index.ts:32` 与 `src/core/settings-defaults.ts`。

Codex 当前 model_info.tool_mode 优先于 feature fallback；Direct/混合/Only 是独立形态。
当前 Sol/Terra 目录均为 Only，不能推定切换两者就切回原生。
最新源码仍须重新构建抓包才能更新上表精确总量；本轮未执行该构建。
源码：`C:/Works/PubProj/codex/codex-rs/core/src/tools/mod.rs:64`、
`core/src/tools/spec_plan.rs`、`models-manager/models.json`。

## 4. builtin Skills 的影响

纯净完整 Host 可见三项 builtin：code-review、skill-creator、visual-review。
名称/描述合计约 362，固定使用教学 347，目录 raw 合计 709；没有全部加载 SKILL.md 正文。
在完整请求中删除这整段的反事实仅省 715（Agent 约 4.4%）；`skill` 工具本身另约 242。
不能把整个目录删除的上界当作无损可实现收益。
tdd/git-workflow 设置 disable-model-invocation，不计入默认模型目录。
源码：[目录与全文加载边界](../../packages/agent/src/capabilities/skills/skill-registry.ts:24)。

本机实际默认 discovery 另测得 25 项发现、15 项模型可见（13 user、2 builtin，存在同名覆盖），
目录约 1,547。这仅是本机目录测量，不是新的完整 Host wire；说明个人配置可以进一步增大输入，
不能由“builtin 影响小”推出“所有用户 Skills 都影响小”。没有执行技能脚本或展开正文。

Codex 历史 Only 的四个 builtin 目录约 391，连同固定使用指令约 504（约 3%），也不是全文常驻。
其当前 renderer 有窗口相关目录预算/描述截断；pi 同样按需读取全文。
KodaX 可首先压缩固定教学的同义重述，保留匹配触发、已展开不重复加载、resolver 路径与权限。
视觉/评审细则可研究归入**原本必经** Skill；未绑定 Skill、SDK/专用角色与恢复路径必须保留适当兜底。
若迁移使原本无需加载的任务新增一次调用，则不满足本项目的优化约束。

## 5. 最初到现在改进了多少

| 对照 | 变化 | 能作出的结论 |
| --- | --- | --- |
| 最初 `bd4479d` 历史记录 → 当前 Coding 完整 wire | 28,805 → 20,055；114,829 → 79,951 bytes | 记录层面净降约 30.4%；初始 raw 当前不可读，未重新独立核对两个原包 |
| 最早现存完整原包 `pRWikz` → 当前，normalized 模型输入 | 20,897 → 20,011 | 可独立重算净降 886，约 4.24% |
| 当前 Coding → Agent | 20,011 → 16,379 | 选择较窄工作面，不能与上述百分比叠加成等能力优化 |

早期大的契约/重复教学精简已有收益；近期主要工作是工具价值复核、主仓融合、Script 生命周期、
三模式和恢复验证，不是每批都会再减几千 token。期间也有主仓能力增长与恢复规则补充，不能把各阶段
节省百分比简单相加。旧表 20,028 与当前 20,011 的 17 差异来自归一化/fixture 路径口径，不是新产品节省。
历史实施证据见 [首轮改造](first-turn-input-optimization.md)、[契约保留清单](native-tool-contract-hygiene.md)。

## 6. 还值得做什么

1. **先补最终验收守卫，再作模型效果结论。** 不用低成本输入掩盖不完整 E2E，见下一节。
2. **规则与契约单一归属。** 常驻策略讲何时做/必须达到什么，schema 讲参数，host 约束确定性状态。
   保留现有 AMA 策略；逐条对照而非按字数删段。协作约 1,800 与计划约 788 是审计范围，不是可删额度。
3. **先实验无新发现步骤的表示精简。** Skill 固定教学、必经 Skill 的专业细则、参数中的重复分支文本优先。
   ask 的单问/批问共享结构值得审计；保留自由文本、多选、批问、默认值/超时和原 SDK，不造新路由。
4. **工具退役只接受实际等价证据。** multi_edit、diff_bundle、tool_describe、todo_get、LSP prepare
   已有主入口覆盖；local code_search 已退出普通默认，不能重复计功。anchor、Repo 四项、LSP、undo、
   协作控制和历史/记忆当前都有未被等价覆盖的语义，继续保留；不是永久免审。
5. **Script 看完整任务。** 当前原始叶回执全部进入模型，执行串行；不能宣称已获得中间结果过滤或并行收益。
   先量化同源重复、完整证据与大结果恢复，再考虑有界选择输出。失败、拒绝、截断、部分副作用必须显式保留。
   不把 pi 的内联预算直接复制为默认；只有无额外发现轮且参数理解可靠的任务才支持该候选。

小收益上界反例：Agent Todo 的 evaluator/metadata 删除约 222，spawn telemetry 约 64，
问答两层 UI 定制参数删除约 161；它们不是死字段，不能为这点成本增加模式分支或损失能力。
暂不新增第四个 Minimal 模式，也不把现有 Agent 悄悄改成无 AMA 的 shell-only Agent。

## 7. 智能与全任务效率验收的实际缺口

Windows 包/叶执行离线通过不等于模型自主完成质量通过。当前旧复杂评测
[runtime](../../tests/first-turn-complex-runtime.ts:46) 在模型顶层 toolBlocks 检查作用域和工具数；
[boundary](../../tests/first-turn-complex-guard.ts:21) 只给 read/bash/repo 的可恢复拒绝反馈。
它尚未支持 Script 模式，不能仅加 workMode 后直接用于付费验收。

本轮纯函数离线复现：越界 write、保护 README 的 edit、未知执行器 bash，
checkComplexTool 都返回拒绝，但上述 boundary 返回 allow；越界 read 则 block。
旧 native 链靠顶层预检阻止前三项，因此**这不是已证明的生产权限漏洞，也不否定旧 native 验收**。
Script 内部叶调用不经过模型顶层循环，若直接套用旧 harness，会漏掉评测范围与计数。
本轮没有实际执行这些工具或禁止命令。

下一批的必要最小工作：

- 将既有评测 policy 同样放在真实叶执行前，验证 native/bridge/Script 的作用域拒绝、恢复、
  一次工作计数、子只读边界；保持原参数/输出，禁止命令使用 tripwire 确认从未执行。
- 模式与版本冻结；捕获 root、child、辅助真实请求，分别记录串行依赖轮、工具工作量、
  API input/output/cache、未知 usage 保守预留、费用与任务 wall time。
- 先按 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md) 作固定输入的契约/规划/恢复比较，
  再作当前最终版 GLM/Kimi 无干预复杂 smoke；明确有界样本不能保证所有任务永不退化。
- Layer 2/3 对照使用相同任务、权限、文件及完整生产工具契约，主会话盲化评审；
  自由复杂 smoke 只验证闭环，不把单例胜负当 prompt 因果证明。
- 真实模型执行前冻结预算和停止条件；复用此前闭环成本校准，不机械用五轮截断；
  传输失败/额度失败/守卫截断/真实回退分别记账，不反复重跑挑通过。

本轮不跑模型的原因是先识别并复现了上述守卫缺口，付费运行尚不能产生可信 Script 验收。
此前模型样本不能覆盖当前最终三模式；仍未得出当前全任务效率或智能非劣结论。

## 8. 可复核离线证据

全部 raw/派生 JSON 留在 OS Temp，不提交：

- `kodax-first-turn-wire-UW7OAm`：三模式实际序列化输入。
- `kodax-cost-audit-20261025.json`：各段、工具族、Skill 和历史净差重算。
- `dsh-cost-source-22ddee-76ffea41793149248300c289bc5a4c60`：当前快照投影与旧 Windows schema 对照。
- `pi-source-cost-20261025/report.json`：默认源码投影及限制。
- `kodax-mode-audit-main-20261025.json`：主会话守卫纯函数复现、本机 Skill discovery 汇总。

逐项探索笔记保留在 ignored docs/research；本文件独立保留决定所需事实与限制，不依赖草稿作为规范。
