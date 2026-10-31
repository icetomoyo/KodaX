# 下一阶段 Token 效率：验证记录

2026-10-31。计划：[整体方案](../designs/token-efficiency-next-stage-plan.md)。
起点 `13f2fe93d`；本轮存在并发视觉文档/实验工作，必须使用相关源码hash而非仅HEAD识别输入。
最新一次冻结回归及 deferred 后续批次见 §6；前面的失败、未采用项和历史数字继续保留。

## 1. 实际首轮基线

使用现有 `first-turn-wire-inventory.test.ts`，真实SDK序列化后拦截fetch，32格全部通过，外部调用0。
路径：OS Temp `kodax-first-turn-wire-ICxeNg/inventory.json`。只保留模型字段并使用现有字节启发式重计：

| 协议 | Agent | Coding | Script |
|---|---:|---:|---:|
| OpenAI | 12,035 | 15,667 | 17,536 |
| Anthropic | 11,790 | 15,292 | 17,372 |

场景为空项目、官方builtin、完整Runtime Host、短自然请求，路径按既有规则归一化。
不是provider分词/账单，也不是原始未优化版。与前次Claude报告一致；P0不以缩短根首轮为目标。
原始 `bd4479d` 的同案例单次留存继续见
[原始版指南](FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md)，本轮不重跑它。

## 2. P0 边界修复

### 信封截断撤销

回归seam为真实runner跨三个Run的模型transcript：第一次Skills存在，第二次撤销且更新超32K，第三次正常。
旧实现第二Run保留旧信封，RED；修复在更新截断时不恢复旧信封、直接重建当前完整上下文，GREEN。
该回退不增加模型请求；完整信封仍受原32K上限，不声称解决所有超长内容的取舍。
正常连续性、重开、fork与公共SDK消息边界继续沿用回归。

### R17 原始响应

记录完整脱敏response，保留toolBlocks、stopReason、thinking和usage，并保留原text兼容字段。
tool-only与嵌套脱敏测试先RED后GREEN；历史raw不改、不重新调用模型。
相关4文件124项回归通过（Agent执行）；主会话负责最终集成类型/构建验证。

### Goal

继 `13f2fe93d` 之后补缺根usage结算、在途归属和跨Run待结算边界。
已实现调用开始时目标归属捕获、缺根usage独立结算、同Runtime的Session pending共享，以及正常结束/
complete/blocked前flush。旧Run无权写journal；迟到回报由后续活跃根处理，终态补计不重新激活。
进程重开前未flush的内存pending仍非持久化；预算为结算点检查，不是预付硬上限。
10文件114项定向回归通过。独立评审另发现pending先删除再写journal会在写失败时丢账；
现改为读取快照、写成功后确认扣除，期间新增用量保留。最终相关4文件51项通过。
此修复影响预算准确性，不能当作首轮或全任务token收益。

## 3. 编辑回执候选

内部 `toolEditWithCompactReceipt` 复用同一权限、锁/CAS、备份、缓存更新和LSP诊断链。
仅单处精确匹配、没有并发warning时返回路径/增删行数/应用位置；归一化、多个匹配、批编辑和错误保持原反馈。
规范 `toolEdit` 与注册SDK路径保持原回执，候选未进入默认。下文已建立有限真实模型证据；
仍需证明UI/SDK完整证据与模型短回执的装配边界，不为这项收益新造整套输出协议。

首轮测试先因候选缺失RED，再以真实磁盘编辑GREEN。定向2文件32项通过，涵盖规范回执、
归一化、歧义拒绝、多处替换、只读/并发与LSP。模型下一步是否增加read是后续检查点的主要问题。
write新文件已有短确认；暂不缩短整文件覆盖的diff，不能把这一窄候选称为全部写工具已优化。
评审发现旧执行器的JS replacement-pattern展开可能与输入字面值不同，短回执会掩盖这个差别；
候选现比较实际字节与字面替换结果，存在差异时返回真实diff，不改变规范执行语义。
新增该失败轨迹后相关3文件39项通过。

## 4. 子契约、全量盘点与有限模型验收

全部81项builtin及根17类规则的归属见[完整盘点](../designs/token-contract-inventory-20261031.md)。
内置通用child候选成对保留系统义务、精简25项已审计工具文字，Memory mutation保持规范原文；
先作为独立候选验证，随后已接入普通内置child的生产请求装配。最终相关161项离线测试通过。
私有来源按调用隔离且只允许一次claim；专用角色显式屏蔽，SDK override不继承。
完整工具经visibility/fitting后才成对投影，裁剪时整对保留规范合同；每次请求与fallback重建实时权限。
公共SDK历史仍保存规范合同。测试包含实际executor→runner→provider及两回合权限切换。
Repo off/无MCP/visual owner的契约对照中，
只读35工具的system+完整tool字段8,972→7,597（省1,375），可写39工具9,639→8,050（省1,589）。
这不是完整宿主首轮；实际briefing/项目规则仍需计入，根首轮不变。

有限模型实验 `token-efficiency-next-stage-r1a-20261031` 冻结21次单次调用：
两个独立候选、各两检查点、三family；edit-warning两臂完全同字节，只保留每家一次负控，不当作候选独立样本。
Pilot 8次已完成，用量90,306 API token、无未知usage，主会话先读无用量/标签映射的盲包再保存评审。
其中Kimi一臂编辑受保护测试、生成无关参数直到max_tokens，作为截断/质量观察保留；不重跑、不执行/改写输出。
另两版GLM只读审查均有事实错误；不把机械识别零/false等同于完整正确审查。只继续预登记未运行的格。

L2共21次完成，已知238,115 API token、无未知usage，参考记账0.012675美元（订阅占位费率不代表账单）。
揭盲后Kimi pilot截断为基线臂；同字节warning负控也截断，不能据此判短回执退化。
DeepSeek短回执后读取未曾读过的index导出是合理取证，不能只按read工具计作无效增轮。
child两臂有合法取证路径差异；GLM报告优先级错误双方均有，未证明子契约独有退化，也未证明整体智能等价。
盲评与揭盲raw均在该revision目录，原始版不重新生成。

### 最终组合完整任务smoke

三家各一次原自然配置优先级修复+后续0/false与缺省追问，复用既有隔离和命令限制；不强迫派发、不改写模型参数。
范围为L3.5组合可用性，不作为提示词因果比较。Temp：`token-efficiency-next-stage-smoke-r1-20261031`。
只读汇总及主会话评审：`token-efficiency-next-stage-smoke-review-20261031`，证据hash
`440f63928149d0eb6f5dd4990af060791a6ae565b15ce14655e79078a03b8770`。

| 模型 | 完成两Run | 已知API token | 所有物理请求 | 墙时 | 验收与覆盖 |
|---|---|---:|---:|---:|---|
| DeepSeek | 是 | 204,627 | 11 | 42.54s | 公开/隐藏通过；使用write，compact edit 0次，child 0次 |
| Kimi | 是 | 181,070 | 12 | 122.57s | 公开/隐藏通过；compact edit 3次，child 0次 |
| GLM | 否 | 38,288 | 4 | 141.52s | 第4请求120s超时取消，无usage；不是完整任务对照 |

GLM额外65,999 token为未知调用的保护预留，账本104,287不能冒称实际API用量。
三家合计已知423,985，计预留489,984；不是两个值相加。L2与smoke合计48次尝试、已知662,100、
加未知预留728,099。没有重跑任何付费cell，原始/失败输出不替换。

质量复核：DS实际测试12/12→26/26；Kimi7/7→18/18，均保护原测试未改，拒绝复合命令后用合法npm test恢复。
Kimi被拒绝的保护测试编辑也改为新建测试，短回执后没有立即新增确认读取；后续用户追问中的读取是正常行为。
报告仍有错误：Kimi称新增13个实际新增11个；DS错称旧实现null会透传。不能称如实报告全面通过。
GLM为AbortError/physical attempt cancelled，只有本地120s超时确定，无法据Runtime网络错误文案定位具体网络/provider原因。
中断后的oracle失败反映未完成产物，不冒称完成任务的精简退化。三格均无child，不能作为子契约真实多Agent E2E证据。

### 与历史同任务留存并列

下面是不同源码/守卫/输出限制和轨迹的描述性对照，不是本轮匹配因果实验。
token/所有请求/秒；原始版只复用R7单次留存，不重新调用。

| 模型 | R7原始未优化 | R7旧当前 | 本轮组合候选 |
|---|---|---|---|
| GLM | 304,257 / 11 / 230.85 | 135,962 / 10 / 82.10 | 38,288已知 / 4 / 141.52；未完成 |
| Kimi | 274,202 / 10 / 137.46 | 142,637 / 10 / 97.81 | 181,070 / 12 / 122.57 |
| DeepSeek | 497,539 / 15 / 41.55 | 607,039 / 27 / 72.87 | 204,627 / 11 / 42.54 |

R7 GLM/Kimi两版均漏缺省回退oracle，本轮Kimi在后续核验中修复，因此不能把多两次调用直接判作同质量退化。
DS本轮没有触发两个候选，不能把其下降归功本轮回执/子契约。较近的R16 DS保留信封版
240,013/13/47.55，旧信封版223,410/13/37.95，两者均通过；仍只是留存观察。

离线体积、单次行为对照和完整任务smoke分开记录；
未返回usage不按0处理；根/子/辅助调用和费用/套餐口径分列。
候选未采用、失败或证据不足须保留，不用重复运行替换原始样本。

### 最终生产child独立smoke

Temp：`token-efficiency-child-smoke-r1-20261031`。父级脚本派发一个自然只读配置审查任务，
使用真实ActorController、executeChildAgents和生产请求投影；没有父模型调用，没有在driver中替换合同。
每家一次、最多4请求/12工具/150K token，达到停止条件后不加预算重跑。不是匹配A/B。

| 模型 | 状态 | 物理请求/工具 | API输入/输出 | API总token | 墙时 |
|---|---|---|---|---:|---:|
| GLM | completed | 3 / 6 | 20,370 / 970 | 21,340 | 24.54s |
| Kimi | completed | 4 / 7 | 25,238 / 1,875 | 27,113 | 49.07s |
| DeepSeek | limitReached，无最终报告 | 4 / 9 | 29,363 / 434 | 29,797 | 4.75s |

三家保护文件均未变化，未知usage为0。Kimi/DS拒绝dir或复合命令后使用glob/read合法继续，未换写法反复执行禁止操作。
质量不等于状态：GLM误报`APP_ENABLED=0`为合同要求、漏env覆盖CLI，还称已读实际未read的package.json；
Kimi错误认为undefined缺省符合逐层回退。DS继续grep时触及预设上限，既不算完成，也没有匹配基线可归因于精简。
这些限制不否定离线等价与体积收益，但不足以宣称三模型复杂多Agent任务智能全面等价。

本driver的Relay在真实provider外增加嵌套operation观察；既有child-fallback把外层汇总和内层physical分别求和，
导致result.totalTokensUsed/routeFacts恰为原始API账本2倍。零网络重放：110→220；单层native仍为110。
本表使用每次raw物理账本，不使用放大的聚合值。不是账单/Goal翻倍，也不是本轮合同造成的新计量行为；
自定义嵌套provider的聚合边界另留后续，不重写冻结raw或扩大本轮Goal改动。

全部有限实验合计59次尝试、已知740,350 API token；加GLM未知预留后保护记账806,349，
参考费用不是订阅账单。没有重复执行同一付费cell。

## 5. 最终集成与采用边界

最终packages构建、source/test类型检查通过。CLI新增来源保护和Goal结算后为5,285,612 bytes，
比先前已审计5,279,845增加5,767 bytes；没有新重依赖或重复child提示。
原5 MiB+40 KiB上限超出1,772 bytes，按实际新增成本仅调整到+44 KiB；启动依赖/输入/credential检查保留。
14 SDK入口、Script worker与Repo worker均完成bundle构建。发布包测试和完整源码回归另以下方最终结果为准。

已采用：撤销截断回退、Goal已知用量边界、R17完整raw、普通内置child成对精简。
未采用：短编辑回执。根三模式首轮不因child投影而下降；不把子收益冒充Agent根首轮达标。
下一批优先核实已有deferred工具能否以自足短说明直接调用，避免必须发现与回执重复schema；
完整schema延迟须独立计首次发现、动态菜单缓存和全任务成本，不自动隐藏Repo/LSP/视觉能力。

### 最终检查与全量失败保留

最终10个直接受影响文件324项通过；辅助5文件49项通过；one-shot完整10项通过。
原失败文件另有SDK exit/actor/repo三个完整文件43项通过，visual完整文件18项通过。
类型检查、packages/bundle/14份SDK声明构建通过。最终实际发布包6项通过：MCP recoverable/
without-read/storage-failure、任务回执经独立IPC及重启、Script打包清单与干净目录运行/缺worker明确失败。
只实测Windows，不声称macOS/Linux或全部独立二进制已验收。

最终32格抓包 `kodax-first-turn-wire-q3AkVL` 通过，`uniform-report.json` 重计12个根模式场景，
本指南§1及盘点表数值不变；完整Host OpenAI Agent的hash仍为
`dcb50621bfdef7fdc8a644c5f397ba470edf689a0409f3a13508b5de421fedfd`。
此前并发全量时重抓曾120s超时，保留该失败；在全量结束、最终源码固定后本次52.31s完成，未改抓包超时。

全量源码套件的原始结果必须保留：1,296文件通过、15失败、7跳过；18,276测试通过、22失败、
99跳过、19 todo，2,340.74s。日志位于OS Temp `kodax-token-next-stage-full-20261031.log`。
这次运行与源码修复重叠，出现旧`takeDescendantTokens`缓存配新`get/ack`测试、旧短回执配新特殊替换回归；
不能作为最终版本单一冻结快照的全量验收，也不能笼统把所有22项说成已有不稳定测试。
最终源码对全部22个失败点完成定向复核并通过；不能把分组复核称为重新冻结后的单次全量全绿。
其余观察包括目录清理竞争、存储读边界、生命周期等待、报告载荷断言和Issue摘要计数。

Issue摘要原13f已有249条index却记248，现与已登记Issue370一起校正249/213 resolved，未新增Issue编号。
one-shot默认1s轮询超时后关闭仍在途Runtime可产生二次拒绝；测试现用mock入口/stop握手、finally先释放并
等待原pending，再严格关闭和删除。没有增大超时、增加rm重试或放宽隔离。此前ENOTEMPTY不能仅凭10项通过
宣称已全面修复。没有再次运行完整套件来替换失败数字；采用结论保留这一验证范围限制。

visual复核再次准确定位最后wire为后台`commit_episode_learning_review`，测试却把它当已投递图像的根请求。
沿用fixture已有todo_update标识单独保存rootWires，仅投递图像的三处断言使用根请求；
全部wires仍保留，撤销/损坏/未授权原图与替换图不泄露的原断言不变。没有修改视觉生产逻辑或隔离。
修正前完整文件17/18，修正后18/18，不重复运行模型或改写请求。

### Standards

成文AGENTS与固定坏味道基线独立评审；先删除pending再持久化的风险已修复，失败写和并发回报回归通过。
最终child来源、SDK/角色、完整菜单及实时权限保护无剩余阻断发现。预算调整按实测字节审计，无新增重依赖。
剩余阻断发现0；上述全量验收范围不等于代码审查发现已消失。

### Spec

独立复核确认child系统/工具成对装配，不增加发现步骤或改变AMA；特殊JS替换效果差异由候选真实diff保留。
P0及child阶段性采用、编辑回执未默认、GLM/DS未完成和报告错误均已如实记录。
剩余阻断发现0；根首轮继续下降、全任务智能非劣和P3尚未完成，不能被阶段性采用声明替代。

## 6. 推送后冻结回归与 deferred 后续批次（2026-10-31）

先推送 `0b8d85c86d00aea67111f763b1a99bd28f4c16f4` 到 `origin/KodaX-next-dev`，并核对远端完整 hash。
本节是随后独立批次，不覆盖前一批 raw，也不重跑已经付费的 cell。

### 冻结回归与发布包

旧提交在无源码变动期间完整运行一次：1,312 文件通过、1 失败、7 跳过；18,305 测试通过、1 失败、99 跳过、19 todo，
1,636.92s。Temp：`kodax-frozen-regression-20261031-01723bd4`，3,346 个受监测文件零变化。
唯一失败为 `state.windows.test.ts` 并发读取状态文件，`readErrors=1643`、`invalidJson=0`。
一次隔离诊断及 bare/KodaX writer 探针均未复现；原因未确认，未放宽断言或猜测修改生产实现。

后续候选完成后重新冻结，单次完整套件 **1,316 文件通过、7 跳过；18,333 测试通过、0 失败、99 跳过、19 todo**，
1,466.98s。Temp：`kodax-final-deferred-regression-20261031-994c9b41`。
全部 tracked 源码/配置/文档及 5 个新增候选文件共 3,211 个 hash 在运行期间零变化；
其余并发工作留下的 untracked 文件另有启动后补充清单，补充后零变化，不能称为启动前完整冻结。
旧 Windows 用例本次通过，不等于根因已修复。文档验收记录在测试完成后才追加。

source/test 类型检查、packages/bundle、14 SDK 声明及配置模板检查通过；仓库无独立 lint 命令。
CLI 5,287,232 bytes，在原 5,287,936 bytes 上限内，没有再提高上限。
实际 npm tarball 的 Script 清单/干净目录运行/缺 worker 失败、MCP 三种输出恢复、独立 IPC 与重启回执共 6 项通过。
仅实测 Windows，不升级为 macOS/Linux 或全部二进制验收。

### 最小生产改动与兼容边界

- 十项普通 deferred 短说明保留调用条件、用途与现有参数 schema，取消强制发现暗示；Workflow 激活教学保持原状。
- `tool_search` handler、SDK/公开事件和持久化结果仍完整。仅普通 managed root 的模型请求视图可省略重复参数；
  完整 description、warning、错误、图片和 metadata 保留。SDK override、专用角色、同名独立 search 扩展不投影。
- 必须证明结果来自唯一且先出现的成功 `tool_search`，且 parameters 与本次实际可见契约严格相同。
  Script 使用真实结构化绑定，不解析生成教学；工具被 fit 移除、参数改变、名称歧义或证据不完整均保留完整结果。
  每次从完整历史重建，因此移除菜单后无需额外发现即可恢复参数。
- 原生/Script 执行、权限、预算、取消、AMA、SDK 和专用角色不变；没有新增产品开关、路由器或发现步骤。
  正常请求、重试、非流式回退、续写、诊断和 fit 计量复用同一请求视图。

新增投影单测 13 项、真实 adapter 9 项、三模式 Runtime 闭环 3 项，均在上述冻结全量中通过。
覆盖实际 fit 后参数恢复、真实 stream 重试/complete 回退、前缀稳定、来源/角色边界和完整历史不变。
新增投影模块覆盖率：语句 85.71%、分支 87.27%、函数 100%、行 94.87%；不是整个仓库覆盖率。

### 根首轮：真实 SDK 序列化后统一重计

32 格抓包通过，Temp：`kodax-first-turn-wire-qaWpIi`；`uniform-report.json` 重计 12 个根场景，外部调用 0。
相对旧冻结抓包 `kodax-first-turn-wire-HZtIeR`，12 格的完整工具集合、顺序、参数及工具外所有模型字段均相同，
只改变普通 deferred 的 description，核对结果保存在 `assembly-equivalence.json`。
以下仍为完整模型字段紧凑 JSON 的统一启发式，不是 BPE/API 账单。

| 场景 / 协议 | 旧 Agent → 本次 | 旧 Coding → 本次 | 旧 Script → 本次 |
|---|---:|---:|---:|
| 完整 Host / OpenAI | 12,035 → 12,023 | 15,667 → 15,592 | 17,536 → 17,536 |
| 完整 Host / Anthropic | 11,790 → 11,778 | 15,292 → 15,218 | 17,372 → 17,372 |
| empty / OpenAI | 9,708 → 9,696 | 12,071 → 11,997 | 14,176 → 14,176 |
| empty / Anthropic | 9,499 → 9,487 | 11,789 → 11,715 | 14,032 → 14,032 |

Script 叶契约本来完整自足，本次没有缩短它；共享的后续回执投影仍生效。
根首轮收益很小，不以普通 child 的 1,375/1,589 收益替代根指标，也未达到完整 Host Agent 10K。
原始 `bd4479d` 只复用既有单次留存；它没有 Agent/Script 模式，且 Host 已演进，不能拼成同夹具三版本因果对照。

### 完整固定轨迹与有限真实模型

自然请求为阅读 Node.js URL、保存结论并核对，随后切换模式核对已有报告；未要求固定发现或派发。
离线 provider 刻意选择一次可选 help 来覆盖本次回执，然后走真实 fetch（仅该 URL 的 HTTP stub）、write、read、AMA 收尾。
三模式均为首任务 5 请求/4 叶调用、跟进 2 请求/1 叶调用；HTTP 读取仅一次，完整公开/持久化回执保持不变。

| 模式 | 完整回执反事实输入估算 → 本次 | 首任务墙时 | 含切换跟进墙时 |
|---|---:|---:|---:|
| Agent | 56,977 → 56,665 | 1.535s | 3.334s |
| Coding | 68,120 → 67,806 | 1.264s | 3.058s |
| Script | 79,371 → 79,057 | 2.878s | 3.902s |

本表是实际 Runtime 的脚本固定轨迹，反事实仅恢复 search 回执参数，使用相同当前 system/tools；
不是旧提交完整任务实跑，不是 SDK wire/API 用量或模型智能非劣证明，也没有基线墙时可宣称提速。
证据在 `deferred-tool-direct-runtime/kodax-deferred-direct-{lP0daN,UfNlWr,bW2jL8}`。

L2 Temp：`deferred-tool-contract-r1-20261031`。实际 Runtime 捕获的两个独立检查点：
Agent 首次响应只比较旧/新短说明；Script 可选 help 后只比较完整/投影回执，当前完整叶契约不变。
GLM/Kimi 8 次 pilot 盲评后只补预登记 DeepSeek 4 次；**12 次物理调用、141,425 已知 API token、0 未知 usage**，
参考记账 0.0065782458 USD，不是套餐现金账单；未重跑任何 cell。

| 模型 | 两检查点 API 总 token，基线 → 候选 | 两次墙时之和，基线 → 候选 |
|---|---:|---:|
| zhipu-coding/glm-5.3 | 23,548 → 23,485 | 10.192s → 8.418s |
| kimi-code/kimi-for-coding | 21,819 → 21,786 | 7.163s → 17.572s |
| deepseek/deepseek-flash | 25,524 → 25,263 | 2.485s → 1.690s |

这不是完整任务总账。每家 API 输入之和仅下降 56–61 token，其余差异包含输出波动；基线先运行也有利于候选命中缓存，
不能归因为新的缓存能力。Kimi 一次延迟增大，归因不明，不为更好数字重跑。
三家 Agent 均直接获取同一 URL，没有发现调用或捏造证据；DeepSeek 基线同时批量建 Todo，候选仅 fetch，均未增加请求轮次。
GLM/Kimi Script 两臂均正确走 tool_call；DeepSeek 两臂均返回菜单外 web_fetch。
源码确认 Script 保留原 agent.tools、只投影菜单，Runner 仍可经现有权限/预算执行该叶；
记录为共同的调用表面偏差，未改写参数、未把 L2 声称为已执行或恢复失败。

主会话先读盲包、保存 case 判断再揭盲；`main-review.json` 建议采用这项有界表示优化，未见检查点特有退化，
不声称广泛智能等价或稳定全任务提速。原始版历史留存、本批旧契约控制和候选明确分开。

pilot 结算留下 `reservedTokens=0/reservedUsd=-1.0842e-19` 的浮点残差。
共享离线预算守卫仅对完全结清且绝对残值不超过 JS Number.EPSILON 的 USD 预留归零，恢复时复制账本，真实负账/在途预留仍拒绝；
9 项回归通过，原 pilot 账本不改。该 helper 未列入原 5 文件 manifest，例外和 hash 在 `guard-continuation.json` 显式记录，
没有改模型输入/预算上限或多跑调用；分析元数据曾误用 .NET Epsilon，已记录更正。

### Standards

沿用 AGENTS、CONTRIBUTING、ADR-033/050 与完整坏味道基线独立评审：无硬违反或可行动 smell。
预算残差修复另独立复核，不放宽真实预算；0 项阻断发现。

### Spec

独立复核自足说明、严格 schema 证明、完整持久化与 SDK/角色回退，无新增固定发现或 AMA 策略变化。
实际 fit/fallback 回归补齐；DeepSeek 菜单外叶调用按原执行链核实，未扩大范围修复。0 项阻断发现。
本批不再追加模型矩阵；缓存、Script 参数表示及大型外部 namespace 延迟仍为未实施专题。
