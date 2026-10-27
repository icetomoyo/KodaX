# 三模式共享契约与自然任务验证修订

2026-10-27。当前状态：三模式共享工具说明与较大的共享 Worker 契约已按末尾的规则保留审计和实际装配验证默认采用，提交为 `c5c296ff`。早期“候选未采用”的判断及模型失败保留在下文，已由后续控制变量归因更新，不能当作当前状态。新增全能力离线验收见[验收清单](../test-guides/FEATURE_WORK_MODES_v0.7.97_TEST_GUIDE.md)；未用重复模型矩阵掩盖历史质量限制。
关联：[完整重组验收](restructured-contract-validation.md)、[统一计数](first-turn-uniform-costs.md)。

## 已确认：Script 不变是实施边界，不是必要成本

三模式本来共用 Worker、AMA 与执行底座；Script 在后段包装 Worker，改变模型调用入口。
来源：`packages/coding/src/task-engine/runner-driven.ts:1875–1894,2095–2113`。

实施前的精简有三处排除（以下行号为审计时版本）：

- 普通 managed 文案投影依赖 Agent 对象身份，Script wrapper 不继承标记，且显式排除 `script_exec`。
  所以 Script 留在原生菜单中的 Todo/协作等也没得到这部分精简。
  来源：`packages/coding/src/tools/managed-tool-contract.ts:9–25`、`agent-runtime/script/model.ts:83–91`。
- Script 叶定义只经基础投影就串化进 description，未使用 managed 文案。
  来源：`agent-runtime/script/pilot.ts:35–41`、`agent-runtime/script/model.ts:54–56`（均相对 `packages/coding/src/`）。
- 本轮重组候选也显式跳过 Script，且要求顶层 native 工具合同齐全；wire fixture 只允许 ama/agent。
  来源：`tests/restructured-contract.ts:60–64`、`tests/first-turn-wire-inventory.test.ts:181–187`。

因此审计时的“完整重组”仅完成普通原生 root 候选，当时**尚未完成三模式共同契约装配**。本轮已接通共享工具说明和三模式候选验证，见末尾。
不能仅删一条判断，也不能把 Script 22K 当作已经证明不可优化的成本。

离线诊断：在保存的 Script 完整请求中只替换已审计 Worker 文本，全部 tools 原样：

| 口径相同的完整模型字段 | UTF-16 字符 | 启发式估算 token |
| --- | ---: | ---: |
| 已抓包 Script 基线 | 87,486 | 22,073 |
| 仅共享 Worker 的文本投影 | 78,666 | 19,854 |

减少 2,219 估算 token。没有优化工具说明、Memory/manual 或调用协议。
这是文本成本诊断，**不是新抓包、合格 Script 候选、实际 usage 或行为通过**。
证据保存于 OS Temp `kodax-script-shared-core-W3rKdv/report.json`；原始源为
`kodax-first-turn-wire-LqPHVb/openai-script-runtime-host/normalized-model-input.json`。

## 最小统一方案

共享一份决策核心与 canonical 工具语义；按模式形成实际可调用工具集合，再补调用协议。
Agent 保持通用工作面，Coding 保持默认完整编码工作面，Script 在相应工作面使用脚本调用。
统一规则来源不等于三模式工具集合或字节总量完全相同。

1. Worker 的范围、规划、派发、证据、恢复和交付原则同源，能力相关 Repo 指导按实际绑定生成。
2. 将现有单工具文案投影以小纯函数复用；Script 在 JSON 串化**之前**处理结构化叶合同。
   原生控制工具也采用同一经过资格检查的来源。不要反解析模型说明字符串，不另建手工 Script 文案表。
3. 保留 Script 特有的 fresh VM、async 调用、逐叶错误、完整回执、部分副作用、取消/预算和禁止盲重放。
   特别保留 native undo/control 与后台 bash；Script bash 仍 foreground-only。
   通用 bash 文案鼓励后台，不能直接复制给 `run_in_background: const false` 的 Script 叶。
   来源：`script/model.ts:54–58,88–91`、`script/pilot.ts:37–40`、`tools/managed-tool-text.ts:11–12`。
4. 保留 SDK、child、专用角色、自定义工具/提示及缺能力 fallback 边界；不给所有 registry-managed 对象自动提权。
   原生菜单和结构化 Script leaves 一起证明操作合同覆盖完整，而非只检查顶层工具名。
5. 三模式共同做装配/参数/权限/预算/取消/部分失败恢复回归和完整请求计数。
   后续原生优化必须明确说明 Script 的对应结果，不能默认排除且仍称统一完成。

## 旧评测的价值与代表性限制

旧缓存任务确实通过真实 provider、生产 Runtime、真实文件读写与测试执行；其结果不是伪造。
但用户提示预列了租户编码、去重、TTL、合法空值、失败重试等验收点；复杂 smoke 又明确要求只读 child。
来源：`benchmark/datasets/search-entry-complex/fixture.ts:6–12`、`tests/first-turn-complex-runtime.ts:114`。

因此它适合验证“已明确要求的复杂修复和故障恢复”，不足以单独证明自然任务智能：
未充分检验模型自主发现遗漏要求、判断任务复杂度、自行选择是否派发，也没有覆盖简单任务的不过度规划。
实际拒绝轨迹仍是有效负面证据；人工 read fault、命令限制对任务效率的影响必须单列，
不能全部算成 prompt 退化，不能把两个任务 completed 或不建 Todo 的单次观察直接当智能总评分。

## 本地真实会话参考

本轮只读一个 KodaX 主项目 session、两个 Codex 用户线程的有限样本；未上传日志、未调用模型。
排除当前 token 优化线程、子 Agent 派发、系统/环境消息和应用事件。此样本不代表总体分布。
原始路径、行号、文件/请求 hash 与 8 条引用仅保存在 OS Temp `kodax-natural-query-audit-YSk7FJ/references.json`。
正式文档只保留任务形态；不得把整份日志、账号数据或无关内容提交进仓库。

观察到的真实用户措辞包含：

| 类型 | 原始请求示例 | 必需上下文 |
| --- | --- | --- |
| 新评审 | 请review下当前版本的改动和提交 | 当时 HEAD、基准提交、dirty diff、项目规则 |
| 增量续作 | 请再看一下最新的改动 | 前次评审范围/结论及之后的实际变更 |
| 验证追问 | 你做过验证这部分代码没问题了吧？ | 当前实现、已运行检查的真实回执、检查后的修改 |
| 完成性复核 | 请看下 SDK 当前的改动是不是都处理完了（去路径转述） | 先前约定的 SDK 契约、验收条件、已修与未修事项 |
| 简短交付 | 那请你补充写一段话，我让kodax那边处理 | 已讨论的缺口与接收方所需信息 |
| 具体故障 | 客户端退出后清理状态仍 unknown、再次启动被阻塞（摘要） | 原请求本身较详细，约 554 字符，含保留未知事实与不得绕过检查的约束 |

KodaX 上述自然评审轨迹确有 Todo、spawn、wait、read/grep/bash，后续报告区分了已审过内容与新增提交。
它说明短请求能触发复杂工作，并非所有真实用户都要写评测清单；但旧 Agent 报告不是正确答案，
其中历史发现、测试通过与归因均需对代码/回执独立核实。

“像人一样”也不等于把所有请求强行压成一句话：具体故障报告本来可以详细；“再看一下”必须带真实前文。
解析回放还须按 active lineage 去重，不得把序列化中的重复记录当用户反复催促。

## 修订验证设计

先固定以下四类案例，不再只反复跑缓存题：

1. **短请求、真实复杂度**：保留自然评审请求；用固定 Git 基线、dirty diff、少量确定 bug/非 bug 作隔离复刻。
   验收范围准确、实质发现、证据与合理分工；不要求固定工具顺序或子 Agent 数量。
2. **增量续作**：保留前次结论/范围和真实 delta，避免从零再读整仓、重建计划或重测未变化内容。
3. **日常修复**：从真实故障的症状和约束派生最小可复现仓库；不把根因、修复位置或所有隐藏断言写进用户请求。
   README/既有测试中的公开契约正常可见；隐藏 oracle、参考补丁及未来结果不进入上下文。
4. **简单交付与验证追问**：前文充分时直接给出所需交付或如实汇报证据；不无故规划、派发、发现或重复测试。

真实日志仅作为参考，区分两种标签：恢复当时仓库/有效上下文才可称“忠实回放”；否则称“日志启发的隔离复刻”。
只用各模式当前生产装配生成工具合同，不能把 Codex 工具调用原样拼入 KodaX 历史。
Script 的源码提示、实际 native control、嵌入 leaves、VM 边界一并冻结。

先离线核实 fixture 确实可解、oracle 能杀死原缺陷、前后状态一致、无未来答案泄露，再运行有限模型验证。
L2 在现成决策点盲评有用行动、无效调用与遗漏；复杂任务第一步读取不自动判漏规划。
L3.5 单独验证完整交付，不靠一次 smoke 声称因果非劣；保留全部失败且不重跑到成功。
专项拒绝/错误恢复另列，继续保留隔离，不让人工故障成为所有自然任务的默认障碍。

指标：成果正确性/报告证据、模型往返、父/子/辅助请求、Script 内叶调用、重复操作、全任务 usage/缓存/保守费用/墙钟时间。
Script 一次调用里的 N 个叶操作不能伪装成一次工作，也不能把 N 个叶操作都误算为 N 次模型往返。
先选两个有代表性的模型做小 pilot，实验设计有效才扩；不直接做三模式×三模型×全部案例的大矩阵。
准确的调用/费用上限在实际 runnable fixtures 确定后预注册；本记录不授权脚本隐式发起模型调用。


## 2026-10-27 本轮实施与预注册

生产普通根现在显式传递共享工具契约资格给 Script 包装器，在叶工具串化前使用与 Agent/Coding 相同的 canonical 文案。原生 bash 的后台能力不变；Script 只披露前台约束。SDK、自定义提示、专用角色、child、宿主可见性/同名覆盖不自动获得资格。Script 绑定元数据保留结构化叶合同，只有本次可见入口完全匹配时才作为已披露能力的证据；没有新增发现调用。

较大的 Worker/Memory/协作教学重组仍是显式测试候选。三个模式复用同一候选函数；Script 通过结构化叶合同证明操作细节仍在同一请求内，而不是解析工具说明。针对上一版证据，候选明确非平凡任务在实质编辑/派发前建立里程碑，可与独立读取/派发同响应；子任务使用用户语言，最终综合保留子任务报告的拒绝和验证限制。原有 AMA 策略、工具执行、SDK 和默认 Worker 均未替换。

自然数据集 `benchmark/datasets/shared-contract-natural` 是日志启发的隔离复刻，不是原始会话回放。固定 Git 提交与源码，四类自然请求分别为新评审、增量评审、症状修复和验证追问。隐藏 oracle 能区分已验证安全退出、错误进程身份、未知状态以及历史回执保留；不测试实际操作系统进程观测。参考补丁/隐藏 oracle 不进入模型 workspace。

有限模型计划在 generation 前冻结：

- L1：三模式实际 Runtime 读→拒绝→合法修复→运行测试→AMA 收尾；SDK/宿主兼容、取消/预算；32 场景实际 SDK 序列化抓包。机制问题不用模型回答。
- L2：GLM `zhipu-coding/glm-5.3`、Kimi `kimi-code/kimi-for-coding`；三模式各两个固定检查点（修复任务读取真实源码后的下一行动、已有真实验证回执的简短追问），baseline/candidate 各一响应。最多24请求，Script先8请求pilot，其余16须主会话先盲评实验有效性。每响应8192输出、180秒；全实验2M token、$2参考价硬上限。模型调用不执行，无重试、fallback或续轮。费用/映射在语义评审后揭示。
- L3.5：只有L2评审后才做最多3个完整修复smoke：GLM Script、Kimi Script、Kimi Agent。各32请求（父/子/辅助共用）、80工具尝试、600秒、1.2M token、$0.30参考价、8192输出/请求。每例一次，不作为因果优劣排名。自然prompt不指定工具顺序或强制子Agent；专项只读拒绝恢复沿用离线和先前专门案例，不伪称本次自然任务必定覆盖派发。
- 同provider单lane，不同provider并行；失败/截断保留，不重跑到成功。报告实际全任务质量、父/子/辅助请求、Script叶操作、usage/cache、保守费用与耗时；参考价不是账单。

本轮统一首轮口径为规范化完整请求中的 `system/instructions/messages/input/tools` 紧凑JSON，保留嵌入Schema与SDK，只规范化夹具路径/Session ID/快照时间；全部使用相同KodaX估算器，不是BPE/API账单。Windows Runtime Host 场景：

| 模式 | 原工作区字符 / 估算token | 共享工具说明后 | 共享Worker候选 |
| --- | --- | --- | --- |
| Agent | 56,720 / 14,376 | 56,720 / 14,376 | 45,111 / 11,458 |
| Coding | 71,216 / 18,008 | 71,216 / 18,008 | 59,607 / 15,090 |
| Script | 87,486 / 22,073 | 78,695 / 19,877 | 67,086 / 16,959 |

Script本次已采用路径减少约2,196估算token；候选共同再减约2,918。较上一轮候选回补了已观察到的计划/语言/报告限制，不能把回补视为倒退。空环境与Runtime Host另列，不能混作优化。原始抓包：Temp `kodax-first-turn-wire-AaU6B5`（共享说明）、`kodax-first-turn-wire-pOAb3y`（候选）；统一计数在 `kodax-shared-natural-costs-r1/normalized-report.json`。付费结果后续填入，当前数字不是智能非劣证明。


### L2 实际结果与解释边界

2026-10-27 完成24/24请求，均单次调用，无重试/续轮/未知usage。原始证据位于Temp `kodax-shared-natural-l2-r1-verified`，manifest hash `189ce759c148650a0b5e3d55fae886ee7c87711ee0ff3aabaf837ea4c3aef77c`。主会话先读盲化输出并保存每对理由，后揭示映射及费用。总313,714 token、$0.008913755参考价（非账单）。

12对语义判断：候选2对更好、baseline3对更好、6对接近、1对各有取舍。候选正例为GLM Script直接如实回答及Kimi Script更相关的修复调查；负例为GLM Agent/Coding、Kimi Coding在验证追问时加入不实际或不必要的核验命令。不能将一次下一行动差异直接归因为压缩导致智能下降，也不能用输入降低掩盖这些反例。没有模型在L2执行其工具请求。

| 模型 / 模式 | baseline两响应总token | candidate两响应总token | baseline耗时 / candidate耗时 |
| --- | ---: | ---: | --- |
| GLM / Agent | 25,763 | 20,792 | 15.451s / 12.926s |
| GLM / Coding | 29,965 | 25,116 | 15.436s / 16.210s |
| GLM / Script | 32,239 | 27,494 | 13.404s / 22.356s |
| Kimi / Agent | 24,205 | 19,306 | 9.323s / 9.118s |
| Kimi / Coding | 27,987 | 23,252 | 10.368s / 13.833s |
| Kimi / Script | 31,044 | 26,551 | 12.936s / 22.380s |

验证追问的前文是真实执行后外部提供的fixture回执，**不是同一Session中助手亲自执行的tool_result历史**。模型选择重新核验有合理解释；这组数据不能回答“同会话已验证结果是否被无谓重测”。pilot已记录该限制，未改输入、未为评分重跑，后续仅按外部证据的诚实处理和行动相关性解释。修复检查点中大多继续读取尚未看过的公开复现，不能只因该响应没有Todo就判违背规划。

目前建议 `recommend-iterate`：共享工具装配保留；较大的Worker候选不进入默认。有限smoke仅检查完整修复/测试/收尾，不据此排名提示优劣。

### smoke 启动校验修复

初始smoke r1两次启动都在Runtime构造前失败，`budget.calls=0`、用量与预留为0；原因是把含费用小数的总LIMITS对象传给只验证整数调用/工具/期限的Runtime参数。旧失败保留于Temp `kodax-shared-natural-smoke-r1`。r2仅修独立smoke驱动的参数传递，不改生产、fixture、候选、模型输入或工具守卫；实际模型尚未被r1调用，不属于重跑模型。

r2与L2源码差异只允许这个L2未导入的独立驱动文件，并由人工资格记录精确before/after hash及理由；其余任何源码差异仍拒绝。L2原manifest/输入/输出/盲评不改、不重跑。r2独立冻结于Temp `kodax-shared-natural-smoke-r2`，manifest hash `3578504e97440854be32fd8919b0d4e4c772cd8b88314bafef6779c1151f8b39`。


### 完整任务结果：闭环完成不等于质量通过

r2只运行GLM Script与Kimi Script各一次；两者都有真实编辑、增加测试、实际测试输出、原工具拒绝后的自主替代和AMA终止，无参数/输出改写。未创建child、未调用辅助判断，因此本组不能代表大型仓库或多Agent协作质量。

| 真实完整任务 | 根请求 / 子 / 辅助 | Script叶调用 | 总token | 参考费用 | 墙钟 | 公共+新增测试 | 独立验收 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| zhipu-coding/glm-5.3 · Script | 8 / 0 / 0 | 9 | 129,846 | $0.0066196 | 92.211s | 7/7 | 4/5，失败 |
| kimi-code/kimi-for-coding · Script | 9 / 0 / 0 | 7 | 137,583 | $0.000716315 | 73.900s | 5/5 | 2/5，失败 |

两次均保留原公共文件；公共测试数字与最终报告相符。独立oracle在模型结束后运行，不能算作模型已运行的验证。各新增测试原样放回原始有缺陷代码后都失败，说明并非无效测试，但覆盖仍不足。

- GLM读了README并检查pid+startedAt匹配，却把“两边startedAt都缺失”当作匹配。离线直接调用其原始补丁，确认错误放行。
- Kimi未读README，只去掉历史cleanup门槛，没有核对旧进程身份，错误pid、缺失身份和替换进程均可能放行。离线直接调用原始补丁复现。
- 这些是实际交付缺陷，不能归咎于隐藏oracle过严：用户要求未知安全状态不放行，公开README也要求准确进程身份。另一方面，没有同版本完整baseline，不能断言由契约压缩引起，更不能据此证明“不增加往返/不降低智能”。
- 初始shell文件读取被fixture要求使用read/glob/grep而拒绝；模型改用已披露Script叶工具，未增加发现调用。两者尝试修改受保护公共测试后改为新增测试，合法恢复生效。拒绝次数分别为3和5，任务耗时包含这些fixture边界成本，不能当正常项目的通用效率结论。
- Kimi的 `node examples\restart.mjs` 是Windows下同一个受保护脚本，却被精确字符串守卫误拒。当前评测已离线修复该等价识别，原参数不重写；其它脚本/flags/链式/越界/child/后台仍拒绝。15项fixture/Runtime离线验证及类型检查通过。未修改r2冻结源码/raw，未重跑模型。这个评测缺陷只解释多余往返和示例未执行，不能解释身份校验遗漏。

第三例Kimi Agent未启动，停止决定保存在r2 `decision.json`。本轮总付费请求41次，581,143 token，$0.01624967参考价；无未知usage、无模型重试。离线反事实证据：Temp `kodax-natural-counterfactual-kqc5ex43/report.json`。

### 当前采用范围与下一步

1. **保留已经接通的共享工具装配**：同源canonical说明、显式普通root资格、Script串化前处理；全部能力/SDK/专用角色/AMA/执行边界不变。24个非Script抓包的规范化完整请求逐字相同，Script实际减少约2,196估算token。已有Script执行回归、自然Runtime离线验证、完整构建和独立Standards/Spec检查已通过；这不是智能非劣证明。
2. **共享Worker重组暂不默认采用**：仍位于tests显式候选。当前模型结果不足以支撑“不多往返、不降低智能”的目标，不能为达到10K强推。
3. **先离线完善决策点和归因**：将“同会话已验证续作”改为真实Session前一Run的工具回执，不用外部文字模拟记忆；初始修复检查点保留文档发现难点，不预先替模型读取全部关键契约。固定当前缺失身份/错误身份反例及预期拒绝，不把领域答案写入系统提示。
4. **修订方向只针对已知遗漏**：检查相关仓库约束、负向/未知边界与报告证据是否在共享契约中有清楚的单一归属，放进现有读取、编辑和测试步骤；不新增强制计划、子Agent、发现调用或验收往返。不按个案追加通用长篇教学。
5. **后续只补最小受影响对照**：原始输出保留；先用固定初始/完成决策点区分工具装配、Worker表述和模型波动。离线规则完整性与语义对照支持后，再考虑正式联合装配及必要完整任务检查；不再重复整张矩阵或重跑同一smoke求通过。正式装配还需保证裁剪/续轮/上下文计量时系统规则与已披露工具合同一起成立。

本轮完成的是共享装配及一次受控验证闭环，**不是整个首轮优化方案已经全部上线**。默认Coding仍保持既有Worker策略；目标是完整任务可靠且有效率，首轮体积是其约束之一。


## 分模式采用与 DeepSeek 覆盖澄清

本轮两个独立验收失败样本都来自Script；当前修订版Agent/Coding只做了单响应配对，未完成这组自然任务的完整模型验收。不能写成“三模式都失败”，也不能写成“Agent/Coding完整验收通过”。三个原生负面配对仅是下一行动观察，且外部回执场景存在解释限制。

缺失身份检查属于交付中的推理/验证遗漏，尚未证明是Script调用机制特有问题。不能因失败样本来自Script，就将原因限定为Script；也不应让Script样本自动阻断原生模式的独立资格验证。上一轮停止未启动Kimi Agent是当时的保守决定，不是原生模式失败的证据。

采用顺序修订为：共享工具说明继续保留；Agent/Coding补齐当前候选的原生完整任务证据，独立决定采用，不以Script同时通过为前提。Script保留独立的调用协议/拒绝恢复检查，针对已捕获反例分析。共享规则保持同源，避免为三个模式维护三份分叉的策略文本；是否采用候选可分别验证与决定。

`deepseek/deepseek-flash` 未参加本轮24次自然任务配对或2次完整Script任务。它参加的是更早 `restructured-contract-r1-20261027`：三个固定检查点、每臂一次，共6次请求，初始对候选较优、其余两对相当；这不是当前修订版或完整E2E的验证。本轮先选GLM/Kimi作为有限pilot，没有技术上排除DeepSeek的理由。

后续当前版本覆盖应纳入DeepSeek：先用最小受影响的固定检查点比较，原生完整任务采用有限分配而非三模型乘三模式的全矩阵。重点填补当前Agent/Coding证据缺口；保留既有Script失败，不重跑求通过。只有获得原生模式自身的充分证据，才把较大重组接入其默认装配。


## 原生模式独立资格：2026-10-27 预注册

用户授权按模式采用，不再把 Script 的结果作为原生模式的前置阻断。本轮候选文本、工具投影、生产 Runtime、fixture、oracle 均冻结不改；不根据结果追加同例请求。

- L1：原生/Script 工具菜单、子 Agent/辅助请求不投影、SDK/专用角色边界、拒绝/预算/取消回归；复用既有运行轨迹。真实模型是否理解并交付完整修复不能由离线调用模拟回答。
- L2 `native-deepseek-r1-20261027`：复用零网络捕获的六检查点中 Agent/Coding 的 `symptom-repair` 精确输入，仅 DeepSeek Flash，两个模式各 baseline/candidate 一次，共4次；Agent两次pilot，主会话盲评有效后再Coding两次。每请求8192输出、180秒，revision上限2M token/$2参考价，无执行模型工具、无重试。GLM/Kimi的24次既有配对原样复用，候选/生产/工具字节不得变化。历史source变化只允许明确审核的评测driver、测试，以及已有Windows示例路径分隔符守卫等价修复；逐项before/after哈希和理由，禁止候选/生产源码例外。
- L3.5 `shared-native-smoke-r1-20261027`：GLM Agent、Kimi Coding、DeepSeek Coding各一次，同一自然故障任务，严格最多三例。每例共享32请求（root/child/aux合计）、80工具、600秒、1.2M token/$0.30参考价，输出8192、单请求180秒；同provider一个在途。采用当前离线修复过的Windows路径等价守卫，禁止命令仍拒绝。新建隔离fixture，不给模型oracle或领域答案；原参数/输出如实执行和记录。
- 本组不是完整3模型×2模式矩阵，也不是完整任务因果A/B。L2看下一行动是否有实质损害；L3.5记录独立oracle、公共及新增测试、报告准确性、AMA终止、拒绝恢复、请求/工具次数、全任务token、参考费用、墙钟。流程完成不能替代质量判断，低token不能抵销错误交付。未自然出现子Agent则标记未覆盖，不强迫增加派发轮次。
- 三原生样本独立于此前Script失败启动；若出现调用/预算/隔离错误，停止相应lane并保留证据。任务质量失败仍按预注册完成其它不同provider样本；不追加或复跑失败样本。
- 原生模式默认采用由当前原生证据独立判断，不必等Script；若质量或效率有未解决的实质风险则说明原因，不将“不曾测到”当作通过。支持采用时还需正式联合装配并离线验证实际请求与本候选相同、上下文裁剪/续轮计量一致，保留SDK、专用角色与Script原契约。


## 原生模式独立资格：实际结果与采用决定

冻结：DeepSeek L2 `371d9a701a4927424f7ac61c6892ebd112d315bcc463fae715fa760955cfdcd1`；原生smoke `ea124354251524c9c23a24b42adcde1c1ec0e21c33ad2227533728a341b9c132`。完整raw分别保存在OS Temp的 `kodax-native-deepseek-l2-r1`、`kodax-shared-native-smoke-r1`，包括原输入/输出/物理请求事件、资格记录、冻结源码、独立验收和决策。候选/生产/fixture/oracle在付费阶段未改动。

### 当前 DeepSeek 单响应配对

4/4请求、2/2配对，先盲评再揭示。Agent baseline略优：两臂都读取尚未读过的示例/包配置，candidate另加fixture拒绝的组合shell命令；Coding相当：两臂都有同类组合命令，下一行动没有清楚的优劣。没有虚报完成，也尚未产出完整补丁。命令拒绝与fixture边界有关，不能直接推广成正常仓库下的智能退化。

| 模式/检查点 | baseline token | candidate token | baseline / candidate 秒 | 语义结论 |
| --- | ---: | ---: | --- | --- |
| Agent repair | 13,282 | 10,836 | 2.881 / 1.197 | baseline下一行动更直接可执行 |
| Coding repair | 15,518 | 13,014 | 1.098 / 1.639 | 相当，双方有被拒风险 |

全部52,650实际token、$0.00758016参考价，4次物理请求，无重试/未知usage。token是固定检查点单次完整请求的provider返回量，不是首轮静态估算，更不是完整任务费用。

### 三次完整任务观察

| provider/model · 模式 | 根请求 / 辅助 | 全任务token | 墙钟 | 公共+新增测试 | 独立oracle |
| --- | --- | ---: | ---: | --- | --- |
| zhipu-coding/glm-5.3 · Agent | 14 / 1取消 | 已知174,977；保守计入195,009 | 117.685s | 6/6 | 4/5 |
| kimi-code/kimi-for-coding · Coding | 23 / 0 | 380,258 | 178.996s | 7/7 | 4/5 |
| deepseek/deepseek-flash · Coding | 11 / 0 | 178,366 | 38.455s | 9/9 | 4/5 |

GLM参考费用已知$0.0088691，含取消请求预留的保守记账$0.0099219；Kimi $0.00198183；DeepSeek $0.0051380952。GLM辅助判断在实际dispatch后被正常取消，符合原先有界sidecar取消规则；该次真实usage未知，不能把预留当真实账单。全部付费阶段共53请求，已知786,251 token，含未知usage预留的保守记账806,283 token；参考价已知$0.0235691852，保守$0.0246219852。

三次均完成实际编辑、测试、报告和AMA终止，公共文件不变。首次请求provider input_tokens分别9,568 / 10,555 / 12,146；这是隔离fixture及各provider各自口径，不能拿它替换Windows Host统一估算表，或当作三个模型的同tokenizer比较。用户往返为0；上表模型请求数包括工具闭环及取消的辅助判断。

**质量事实**：三份实际代码都只检查 `observed.startedAt === receipt.process.startedAt`，没有先证明身份存在；两边同时缺失时 `undefined === undefined`，错误放行。三模型都读过README；独立oracle在模型结束后才执行。离线直接调用原始补丁复现三次 `readyToStart:true`，应为false（`offline-counterexamples.json`）。将各模型新增测试原样放回原始有缺陷代码都失败，证明测试有价值，但边界覆盖不足；不能将公开测试通过当完整验收通过。最终报告的测试数和示例运行属实，但“任何不确定都拦截”等完整性断言超过证据。

**效率事实与归因**：GLM、Kimi、DeepSeek分别20/27/16次工具尝试、2/7/2次拒绝，无新增发现工具调用。GLM在首次修改和测试后才补Todo；DeepSeek未建Todo；Kimi遵循先计划再编辑，但有多次被拒后的重新派发。它们都是观察到的契约执行偏差，不应隐藏；缺少完整同版本baseline，不能断言由精简造成，也不能声称全任务轮次没有增加。

### Kimi协作评测缺陷与离线修复

Kimi原生Run的协作/效率证据标记 `eval-invalid`：root合法派出的只读child，在评测器对输入调用 `structuredClone` 时遇到可执行工具元数据，抛出 `DataCloneError`，没有进入付费provider回调。冻结版本先自增计数再快照，故记录24次Runtime尝试但只有23次真正付费请求、0次child provider请求。root收到失败后尝试重新派发（守卫按预注册的一child上限拒绝），最后自行增加边界测试并如实披露child失败。不能把这段额外耗时/往返全部归为模型或提示退化；root生成的补丁缺陷仍是客观事实，但若child成功是否能发现它尚未验证。

付费结束后最小修复仅在 `tests/shared-contract-natural-runtime.ts`：快照只取LLM定义契约的name/description/input_schema，保留messages/system/schema原值；成功快照后再增加计数。Runtime的handler、SDK、权限、执行、候选文本、provider参数均不改。真实离线child复现先RED（childCalls=0；不可克隆字段tools），修复后读→写拒绝→诚实报告3次child回调通过；另验证共享请求预算、取消后不再发起请求及不可写边界。旧paid冻结raw未改，不补跑Kimi求通过。

本轮7文件51项相关回归及专项类型检查通过。取消断言加强后，Runtime完整13项再次通过：要求实际中断终态interrupted、error为空、请求数停在取消瞬间，排除预算耗尽假通过。独立Standards首次0项、追加1项P2（上述取消断言，已关闭）；Spec两次均0项。未改生产默认，没有删除AMA、SDK或工具能力。

### 决定与接下来的最小范围

建议 `recommend-iterate`，暂不默认采用较大Worker重组。依据是原生自身的质量缺口及未解决效率证据，**不是要求等Script通过**；也不是已证明压缩导致回归。保持已有三模式共享工具精简、Coding默认、AMA/SDK/全部能力。

Script单独分析后的调整方向：保留已有协议/回执投影；其GLM样本与三个原生样本都出现双侧缺失身份误判，因此没有依据再给Script专门叠加长篇身份教学或调用步骤。此前Kimi Script未读取README是另一类约束发现遗漏，要与本轮“已读取但未覆盖负例”区分。领域答案仍不进入通用系统提示。

下一步不再跑同一整任务矩阵：利用已经保存的修改/测试/收尾决策点，核对baseline与candidate中“读取相关约束→覆盖变更的不变量与失败边界→只报告证据支持的范围”的单一职责是否完整。若需调整，用同一现有读/编辑/测试步骤中的简短规则替换模糊教学，不强制新计划/新子Agent/新发现/新验收轮次。先离线锁定缺失/无关证据和报告过度推断反例；只在明确需要区分模型共性遗漏与契约损失时，再预注册最小受影响检查点配对。原生默认接入仍有正式联合装配、schema裁剪/续轮/计量一致性检查待完成；支持证据到位即可独立采用，Script不构成前置条件。


## 相对基线的最小归因对照：2026-10-27 预注册

用户纠正采用标准：候选不能因未达到绝对满分而一直不采用，必须比较同条件baseline。此前“recommend-iterate”只是缺少相对证据时的决定，不能当作已证明退化。本轮不增加完整任务模型运行。

Layer 1可证明历史/工具/执行不变，却无法判断同一推理点长短教学是否造成遗漏。故Layer 2 `failure-attribution-r1-20261027`固定8次单响应：GLM Agent原Run call4、Kimi Coding call7、DeepSeek Coding call4，均为首次实质修改前的真实原始输入；另取旧Runtime缓存任务known-plan-and-content作为异域迁移点，由Kimi运行。每点baseline/当前compact各一次。三个原生输入与历史originalInputHash校验，重新投影后必须与当时实际candidate inputHash一致；Kimi检查点早于DataCloneError，不注入后续失败或oracle答案。缓存输入同样校验旧baseline hash。历史由候选轨迹产生，这是条件反事实比较，不代表baseline从任务开始会走完全相同的路径。

pilot为GLM/DeepSeek首次修改4请求；盲评任务可解释后再Kimi首次修改与缓存4请求。每请求8192输出、180秒、无工具执行/重试/追加轮次；revision预算2M token/$2参考价，同provider串行。评审查看具体代码/测试建议与合理的下一步，不要求每个响应都直接提交完整补丁；共同遗漏与实际相对损害分别记录。缺少配对优势不能自动等同劣化，缺少绝对满分不能自动否决默认采用。

事先冻结一条领域无关的补充，用 `general-verification-r1-20261027`最多4请求独立测量：GLM首次修改、Kimi缓存点，各plain compact/compact+补充一次。仅在归因阶段有效且该补充仍有必要时执行。该阶段只替换现有验证段，工具、任务、history及其余system字节一致。GLM pair pilot后盲评再Kimi pair。不会依照输出修改规则再跑。

补充原文（英文，仅实验候选）：Derive focused checks from the changed behavior and its required preconditions, including relevant failure and uncertainty cases. Extend the planned verification rather than adding a separate review phase or blanket test sweep; report only what observed evidence establishes.

该规则不含字段名、身份/重启/缓存等领域答案；要求在原本需要的验证里覆盖相关失败/未知条件，不新设Agent、计划或验收阶段。若它使模型额外读取已知文件、重新建计划、无依据全量测试或延后有效操作，应记为代价，而不是为了“更严谨”忽略往返。绝不把没有观察到额外调用当作全任务不增加往返的统计证明。

决策按组成部分分别处理：若短长同样遗漏且候选无可信额外损害，遗漏归为本条件下的共同问题，不再单独阻止精简；补充的收益/代价独立判断。真实负面差异保留并定位具体规则，不要求三模式同时采用。不用单个4/5门槛或简单投票替代语义评审。原生默认落地仍需实际装配/SDK/专用角色/续轮/schema裁剪/计量离线等价。

### 实际归因结果及分项采用（2026-10-27）

本节更新前述“原生质量缺口阻止采用”的暂定判断，不改写历史结果。归因 manifest `e5ef4a2d440c51b9164557342316caf07272999680171aba5048b7ce82092480`；补充 manifest `8c4fb06b2fa17d522b9f81007381fe5a99f19b4c7691aaf64ce0f90805127651`。raw、精确输入、盲评和揭示分别保存在 OS Temp `kodax-failure-attribution-l2-r1`、`kodax-general-verification-l2-r1`；输入来源校验在 `kodax-failure-attribution-inputs-r1`。4/4 原始 hash 一致，三个真实编辑点重新投影后也与历史实际 candidate hash 一致。

| 同一决策点，每臂一次 | baseline / candidate token | baseline / candidate 秒 | 相对结果与归因 |
| --- | ---: | ---: | --- |
| GLM Agent 首次修改 | 13,783 / 11,408 | 13.169 / 16.661 | 两臂都用 edit 修主要故障，也都未证明必需身份存在；共同遗漏，未见该缺陷由精简独有地造成 |
| Kimi Coding 首次修改 | 16,859 / 14,290 | 6.458 / 4.939 | 两臂同样遗漏身份缺失；baseline 用 edit，candidate 用全文件 write，baseline 的变更方式略优 |
| Kimi 缓存任务迁移点 | 11,907 / 9,412 | 2.609 / 1.681 | 两臂继续已有计划；baseline 同批读取两个相关未读文件，candidate 只读一个，baseline 批处理略优 |
| DeepSeek Coding 首次修改 | 17,620 / 14,713 | 2.972 / 1.335 | baseline 整文件写入仍保留原始错误门槛；candidate 调查尚未见过的 Git 证据，下一步更合理，但尚未产出补丁 |

8/8 请求完成，无重试、无未知 usage，109,992 token、$0.0043860392 参考价。盲评后才揭示。不能把 DeepSeek 的调查一步记为“未直接编辑所以失败”；也不能因候选未产出补丁就声称它已修复边界。Kimi 的两项差异是待解释的单样本负面信号，尚不足以证明系统性退化或额外整任务往返；共同遗漏同样不证明各模型普遍都会犯错。

通用验证补充只运行 GLM pilot 两臂：两边仍遗漏同一边界，并都选择 write，没有目标质量改善。补充/不补充分别 11,231/11,172 token、11.082/10.188 秒。合计 22,403 token、$0.0011667 参考价；停止剩余 Kimi pair，记录未运行而非失败，不改词求通过。该句未进入生产。全轮总计 **10 次物理请求、132,395 token、$0.0055527392 参考价**，未执行 L2 工具建议，没有新增完整任务矩阵。上述价格为已有评测价格表估算，非账单。

**三类问题区分**：身份存在性遗漏在 GLM/Kimi 长短两臂均出现，不能再单独作为压缩否决依据；旧 Kimi child 的 DataCloneError 属于已离线修复的评测缺陷；write/批量读取差异保留为不确定的相对信号。这个条件反事实只能解释相同历史下的下一行动，不能替代完整基线路径或承诺全任务质量非劣。

**本次默认采用的最小组成部分**：普通托管 root 的 `spawn_agent`、`wait_agent`、`todo_create`、`todo_update`、`todo_list` 顶层重复说明，复用既有 `managedToolText` 装配；Agent/Coding/Script 的原生控制工具共同受益。Worker 全文、执行链、工具集合、参数、AMA 规划派发、权限/预算/取消均不改变；没有新增发现、复核或测试阶段。SDK、child、专用角色、自定义宿主/可见性和同名覆写仍保留原契约。该子集没有独立付费优劣证明；采用依据是规则逐条保留审计与实际装配等价，不能把较大候选的 L2 结果冒充该子集的 A/B 证明。

| 删除的重复教学 | 保留位置 |
| --- | --- |
| spawn 的评审分工、独占写集、继续本地工作 | `buildWorkerStableInstructions` 的 parallel-first；只要可用 spawn 即保留，包括有限工具面 |
| Todo 的语义里程碑、续作去重、语言、单 owner 进度 | Worker 的完整/有限计划段及原 schema；不增加无条件刷新 |
| Todo 操作时机与失败恢复 | **保留**原句“Mark in_progress with activeForm before work, completed only after finishing”；该时序不可因笼统里程碑规则而删除；hook/evaluator 拒绝恢复仍在工具说明 |
| wait 的仅关键路径等待、先做本地工作 | Worker 完整/有限协作段；工具保留唤醒与 mailbox 证据边界 |

较大 Worker/Memory 重组仍为实验候选；本轮不把 Kimi 两项单样本差异升级为确定的压缩因果，但也不将共同缺陷消失的误读当作整包采用证据。接下来应对这两项决策的既有规则位置做定向审计、解决实际联合装配边界，按组成部分继续采用。不要围绕身份字段添加领域口诀，也不要为了小额收益重复整矩阵。Script 的执行协议、SDK 和 undo 入口保持原样。

### 默认子集的离线验收与同口径收益

先 RED 确认五项短描述尚未接入，再 GREEN；另对 Todo 开工时机做 RED→恢复原句→GREEN。8 文件共 63 项相关回归覆盖工具投影、Worker、历史候选重放、评测冻结、通用补充、真实 child 拒绝恢复和 Script 模型链；专项 TypeScript 检查通过。此轮未再次运行完整仓库测试或付费完整任务。独立 Standards / Spec 各 0 项发现；Spec 对照了完整和有限工具面的规则保留位置。

实际 SDK 序列化抓包在 OS Temp `kodax-first-turn-wire-E07fb0`（改前）和 `kodax-first-turn-wire-9Ayxo8`（最终）。2 协议 × 4 工作面 × 4 上下文，共 32 场景通过；仅将 fixture 自身随机路径/时间/会话 ID 规范化，再逐字段对比。24 个普通托管场景只允许五项 description 变化；8 个 SDK 场景完全一致。工具 schema、system/messages、Script 协议及其他字段逐值相等。对比结果 `kodax-partial-tool-adoption-wire.json`，统一计量 `kodax-partial-tool-adoption-costs.json`，均在 OS Temp。

下表使用与历史总量表相同的 Windows Runtime Host、OpenAI 协议、完整模型可见字段紧凑 JSON 和 KodaX heuristic；不是模型 tokenizer 或实际账单。每模式减少 1,166 UTF-16 字符，取整导致 291/292 token 差异。

| 模式 | 改前字符 / 估算 token | 默认子集改后字符 / 估算 token |
| --- | ---: | ---: |
| Agent | 56,720 / 14,376 | 55,554 / 14,085 |
| Coding | 71,216 / 18,008 | 70,050 / 17,716 |
| Script | 78,695 / 19,877 | 77,529 / 19,586 |

这仅是五项重复说明的新增收益，不能冒充较大重组约 2,918 token 的全部收益，也不能替代此前共享工具精简的累计收益。程序没有新增任何请求/发现/执行阶段；模型未来自主行为仍可能有方差，离线字段等价不等于所有任务往返数的数学保证。

## 较大共享契约正式接入（2026-10-27，后续批次）

本节接续用户授权，更新上一节“较大重组仍仅实验”的状态：普通托管 Agent、Coding、Script **默认采用较大的共享契约重组**，不增加配置开关，不以基线也犯的身份遗漏继续阻止采用。本次无付费模型请求，不重跑完整矩阵；依据是前述相对盲评、规则保留审计和下述实际装配回归。全任务质量/轮次仍只拥有历史观察与有限条件对照，不声称新的统计非劣证明。

### 编辑方式与批量读取归因

逐字核对历史基线、冻结候选和真实角色装配：

- Kimi 两臂均已收到“现有文件用 edit；write 只用于新文件或明确要求的全文重写”的工具契约，候选并未新增整文件写入许可。但候选 Worker 的该段更短，单样本不能排除措辞显著性或模型波动。正式版将原 `MUTATION DISCIPLINE` 整段逐字保留：read 前置、当前锚点、edit/write 条件、单文件原子批量编辑、禁止已知内容经 heredoc 写入、scratch 边界均不再改写；不是添加针对某个补丁的提示。
- Kimi 两个相关文件只读一个的差异，发生在两臂**同样拥有**三条批量读取规则时。它们来自角色装配的独立段，始终不在 Worker 替换范围内：“独立只读调用同响应发出；仅依赖前序结果时串行；少量聚焦读取优于许多碎片探测”。保持这三条原文，不加入“总读两个文件”或缓存/身份场景特例。
- 生产版仍要求非简单任务在 broad execution 前建立语义里程碑；没有采用实验中额外限定“不得晚于首次实质编辑/派发”的措辞。并行能力/工作集归属、共享预算、证据整合与 AMA 终止不改变。通用验证补充 pilot 无效的句子仍不采用。

### 生产装配与兼容边界

`prompts/managed-system-contract.ts` 复用普通 root 的既有资格标记，按**实际披露的完整工具合同**核对操作教学覆盖，然后投影已知 canonical Worker。新文件 `compact-worker-contract.ts` 只承载重组后的决策与生命周期文案；原 Worker 工厂和 SDK 指令保持不变，实验文件不进入产品依赖。

工具别名口径与原角色工厂一致，使用 `filterModelToolAliases`；第一次抓包暴露未过滤清单导致安全回退，现已修复，正式抓包明确断言实际采用，不能以辅助函数通过替代生产生效。

- 保留 SDK、child、专用角色、自定义提示/工具可见性及同名覆写；canonical Worker 有自定义改动时不替换。
- Script 依赖宿主保存的结构化叶合同和完全一致的实际 `script_exec` 描述/schema，不能根据工具名或解析描述猜能力；脚本入口未披露、被裁剪或修改时保留原教学。原生控制、undo、权限、预算、取消和回执链不变。
- Memory/manual 只有在对应操作合同完整披露时才缩短，缺少或裁剪时保留原段；既有低权限证据、精确授权/claim/ref、拒绝与 durable receipt 语义均保留。
- 工具裁剪继续按**原完整 system**预算运行，工具选择不因本次精简变化；随后才对最终菜单投影。这是保守装配，不为利用节省空间引入反复 fitting 或另一条发现路径。
- 首次请求、每次重试、L5 续写及 `measureRequest` 共用同一投影。canonical transcript 不改写，当前权限仍在投影后应用；续轮不能恢复长提示却按短提示记账，也不能在未披露操作契约时错误删除教学。
- Worker、Memory、manual 的 canonical 规则均有审计快照；源规则变化必须重新核实短文覆盖。运行时不使用实验 hash 白名单，也不引入参数开关、领域条件或新执行阶段。

### 实际首轮抓包

OS Temp `kodax-first-turn-wire-9Ayxo8` 对比 `kodax-first-turn-wire-9jCFqF`，统一复算在 `kodax-managed-contract-assembly-wire.json`。32 场景中：24 个托管场景确认默认采用，只有 system 文本变化；所有工具合同和非 system 字段逐值相等；8 个 SDK 场景完整相同。仅规范化 fixture 随机路径/会话/时间，不删除任何工具或用户内容。捕获经真实 SDK JSON 序列化，网络完全截断，无 API token usage 冒充真实计费。

同 Windows Runtime Host、OpenAI 协议、模型可见字段紧凑 JSON、同 KodaX heuristic：

| 模式 | 上一批默认：字符 / token估算 | 本批默认：字符 / token估算 | 本批减少token估算 |
| --- | ---: | ---: | ---: |
| Agent | 55,554 / 14,085 | 45,606 / 11,583 | 2,502 |
| Coding | 70,050 / 17,716 | 60,102 / 15,215 | 2,501 |
| Script | 77,529 / 19,586 | 67,581 / 17,085 | 2,501 |

每模式净减少 9,948 字符。与五工具说明采用前相比，这两批累计各减少约 **2,792～2,793 token估算**。相比冻结候选多保留约125 token的原有约束，不追逐最小数字；Agent 在本 Host 场景仍未达到10K。数字不是各模型 tokenizer 的真实输入，也不是完整任务总token。

历史实验输入和 raw 不改。`restructured-contract.test.ts` 明确重建历史 Worker 输入以检验旧实验重放；新的真实自然任务检查点标为 `managed-default-r2`，确认当前默认已生效且旧变换不再重复投影。后续若需模型实验必须新建 revision，不能把已经精简的默认输入当作旧长基线。

### 本批最终验收

- 15 文件 **266 项**离线回归通过，覆盖正式 adapter/Runner、工具装配、Worker、Script、自然任务读取回执和拒绝恢复、旧冻结实验；另有32场景实际序列化抓包通过。
- 128K/12K 两种上下文的实际 provider 边界使用离线替身，分别验证重组与裁剪回退；两次既有 max_tokens 路径再续写，共3次预定请求，system/tools保持一致；`measureRequest` 与实际首个 wire 的system、消息、schema及响应预留计量一致，canonical transcript不变。没有网络调用。
- `tsc -p tsconfig.test.json` 及独立评测文件专项类型检查通过；新增装配测试已纳入正式测试类型检查清单。
- `npm run build` 通过，含工作区包、Windows native、CLI/SDK bundle和声明打包。
- 实际 `npm pack` 解包验收 **2/2** 通过：干净目录运行Script、隔离process/fetch、真实读取、模型回执去重与持久化原值、三模式原生shell合同一致、缺失worker明确失败。SDK直接`runManagedTask`的该fixture未绑定Actor，故依资格边界保留`LOCAL EXECUTION`原教学；完整协作root的正式采用由前述32场景捕获验证，不把SDK回退误报成默认重组失效。

发布测试最初失败于上一批留下的旧断言：要求Script原生bash描述等于未投影的SDK canonical长描述。补充stderr后确认实际为已采用的短描述，并非后台能力丢失。现改为比对三模式的实际完整bash合同，同时检查后台执行说明与boolean参数，SDK canonical定义仍独立校验。新增的“所有SDK运行都必须精简”断言又暴露未绑定Actor场景，按原有兼容边界改成明确验证有/无绑定两个分支。未修改生产隔离、许可、执行参数、模型输出或超时来通过测试。

#### Standards

首次1项P2维护风险：Memory/manual原规则未来变化时，短文覆盖审计可能遗漏。已将两者与Worker一起纳入canonical审计快照，复核关闭；未解决0项。

#### Spec

0项发现。独立核实编辑与批量读取约束、规划/派发/预算/收尾、SDK及Script能力披露边界、裁剪后装配和重试/续写/计量一致性。

本轮新增付费模型调用 **0**，无完整模型矩阵。未运行全仓全部测试，也未在macOS/Linux实测；本轮实际验证平台为Windows。采用结论针对上述共享契约重组与装配，不把源代码规则覆盖等同于对所有未来任务智能和轮次的无条件保证。
