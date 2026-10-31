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

## 7. 共享规则与契约激活候选（2026-10-31）

控制版本 `1dd6d64d358e12ff7c6e6fab9be4501942a26f29`；候选为本节实际源码 hash 清单，
不是 §6 的小规模 deferred 收尾。原始 `bd4479d` 保留
[既有单次证据](FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md)，原始 Coding Host 为 28,734 估算 token；
Agent/Script、新视觉及本批三个检查点无匹配原版，标 N/A，不改名、不补跑原矩阵。
历史 Host/能力已演进，不能把 28,734 与本次当成同夹具提示词因果对照。

### 范围与保留规则

共享根规则、Skill 前言与 Actor 容量只在来源可信的普通根请求中重组。
AMA 规划/派发、独占写入、语言/信任、子证据整合、拒绝恢复及真实核验/收尾义务保留；
SDK formatter、Actor canonical builder、完整历史和专用角色不变。
Worktree 两项和原生历史 read 的全部当前浅对象参数，在现有桥接中自足表达，无固定发现；
历史 search 或对应回执后恢复原生。Script 的历史叶保持完整，未伪造其披露证明。

视觉详情只在可信产品 owner 与完整已知空记录的组合下延迟；未知、仅 Host state、自定义 owner 保守原生。
接受图片、视觉调用/发现回执或有效视觉 Skill 后，下一原有请求提供详情参数。
合法 bridge/Skill 别名复用原解析；已知非 Plan 不注入 exit，Plan/未知保留，stream retry/complete/续写实时重建。
Goal、Memory、交互、核心文件/编辑/undo、协作、Todo、RepoIntel/LSP/MCP 和全部底层能力保留。
请求视图不改执行、授权、预算、取消、原图、SDK/公开事件或耐久回执；Coding 仍为默认工作模式。

### 实际首轮与整体分账

最终 32 格抓包 `kodax-first-turn-wire-YhkWuN`，12 个根 empty/Host 输入在 `uniform-report.json` 统一重计。
SDK fetch 前真实序列化，外部调用 0；紧凑 model-fields JSON 使用同一 KodaX 启发式，不是 BPE/API 用量。

| 夹具/协议 | Agent 控制→候选 | Coding 控制→候选 | Script 控制→候选 |
|---|---:|---:|---:|
| 完整 Host / OpenAI | 12,023→10,547 | 15,592→14,116 | 17,536→16,100 |
| 完整 Host / Anthropic | 11,778→10,345 | 15,218→13,785 | 17,372→15,972 |
| empty / OpenAI | 9,696→9,379 | 11,997→11,679 | 14,176→13,859 |
| empty / Anthropic | 9,487→9,184 | 11,715→11,412 | 14,032→13,730 |

同一完整 Agent 信封顺序只替换 tools、system、非 system 消息：12,023→11,055→10,836→10,547。
相应净收益 968/219/289，是完整输入反事实差值，不是把分别四舍五入的字符/token 分项机械相加。
Worktree/历史的桥接教学和视觉目录开销均已计入；完整 Host Agent 距 10K 仍差 547。
外部项目仍只引用设计 §11 固定源码及历史 wire，不宣称本批刷新了 Codex/DSH 的最新实包。

### 三模式真实执行、首用和恢复

最终候选 Runtime raw：`contract-activation-runtime-r2-20261031` 下
`candidate-final/{iLnsAC,bVPpvf,CXOns7}`（目录均带 `kodax-contract-activation-` 前缀）和
`candidate/{weWxdY,MvsaHD,rqakuA}`。每组 Agent/Coding/Script 顺序相同；源 hash 前后零漂移。
首组 stage 标签未触发旧的 `stage==='candidate'` 专属菜单断言，主线另从原始捕获核验三格 cold 详情缺席、
实际 PNG admission 后下一原有请求两项详情齐全；原始数据不改。

原 R1 在历史阶段把 snippet 命中误当原文读取完成；严格检查发现 stale，失败原样保留。
只复用其真正成功的 edit/follow-up/visual 三阶段。独立 R3 以实际 inactive 元数据选唯一历史条目，
保留原 stale 后发出新的合法省略可选 revision 请求，并断言同一 entry 的实际 read.status=ok 及 content；
没有改写先前参数、执行失败命令或放宽隔离。选错 active 命中及缺 native 的旧失败也保留。

| 轨迹 | 模式 | 请求数控制/候选 | 累计 SDK 输入估算控制→候选 |
|---|---|---:|---:|
| 编辑、真实 Node 测试、跟进、PNG/区域/像素/历史 | Agent | 11/11 | 131,462→120,770 |
| 同上 | Coding | 11/11 | 156,773→146,077 |
| 同上 | Script | 11/11 | 184,577→174,319 |
| 独立 seed→压缩/重开→历史原文恢复 | Agent | 5/5 | 57,509→51,360 |
| 同上 | Coding | 5/5 | 69,010→62,865 |
| 同上 | Script | 5/5 | 79,581→73,514 |

这两组轨迹不得相加冒充同一完整任务；Skill 目录在执行夹具中明确关闭，不能用其首轮替代完整 Host。
SDK 序列化和 typed FrozenInput 分列；不借脚本轨迹宣称模型自主质量、API 成本或稳定提速。
控制版从精确 Git archive 自行构建必需四包与原 native，仅借用外部 node_modules；
原完整 artifacts/pdfjs 构建失败仍是限制，不宣称控制版全发布构建通过。

### 有限 GLM/Kimi/DeepSeek 及语义判断

Temp `contract-activation-l2-r2-20261031-b681f2`，manifest hash
`a267aa1b3dc905024e2993c82aa2a84ab2b9fa9eda0217503602e0eec2c03bd6`。
先 GLM/Kimi 两点两臂 8 次 pilot，主线盲评后只补 DeepSeek 同两点 4 次及三家容量检查 6 次。
18 次物理调用、182,015 已知 API token、未知用量 0，参考记账 USD 0.012684685；不是套餐现金账单。
硬顶 18 次/120 万 token/USD1，单次 2,048 输出/120 秒；无自动 retry/fallback、无重复 cell、无 proposed-tool 执行。

检查点：真实干净 Git 前置后的首次 Worktree；真实 search/stale 后的历史读取；
真实三只读 Actor 占槽、原 spawn 拒绝后使用现有 inspect-child 并合法继续。
均为 capture-derived 固定输入，不冒充原 Runtime wire；新 Temp cwd/Git/Actor 状态真实生成并对齐两臂，
容量候选通过真实 adapter 投影。完整 production system/tools 走实际 API tools 通道，不用简化 stub。
主线先读含共同业务事实的盲包、逐对落盘判断，再揭盲；两份 raw 备份在 OS Temp `kodax-eval-backups`。

| 三个独立 L2 检查点之和 | API 输入控制→候选 | API 总 token 控制→候选 | 墙时之和控制→候选 |
|---|---:|---:|---:|
| zhipu-coding/glm-5.3 | 32,041→28,596 | 32,312→28,887 | 21.808→18.681s |
| kimi-code/kimi-for-coding | 29,302→26,452 | 29,837→26,740 | 16.293→10.026s |
| deepseek/deepseek-flash | 33,490→30,006 | 33,964→30,275 | 5.063→3.627s |

不是完整自主任务总账或统计非劣证明。三家都无 Worktree 发现前置、无盲目再 spawn/递归绕限/虚报完成。
九对中六对语义持平；DeepSeek 候选一次合法历史恢复优于控制、容量简洁性略好，控制的 Worktree 中文说明更忠实。
后者是保留的小幅描述偏差，未为更好数字重跑。各臂仍欠真实根调查与最终报告，不能将下一工具调用当完整 AMA 收尾。

重要限制：GLM/Kimi 两臂都将 stale 返回的新全局 revision 继续传入。源码核实正常 Runtime 在工具前后追加消息，
会再次使全局 revision 过期；这是 `1dd6` 原有版本契约缺陷，不是精简引入，也不算恢复通过。
R3 仅证明省略可选 revision 的合法路径；DeepSeek 候选一次选择该路径不证明泛化提升。
后续应独立设计 entry 证据版本，保留全局严格校验及可见性/归档/fork 边界，不靠提示特例自动忽略 revision。

GLM 未缓存输入 16,489→19,124，Kimi 16,246→18,516；两者总输入虽下降，缓存收益尚未证明。
随机映射恰好令候选始终先运行，且各检查点菜单会变化，顺序、旧缓存与菜单失效混杂。
不据此宣称稳定费用/缓存或耗时改善；原始 usage 不改。`usage-comparison-v2.json` 使用真实 endedAt 重计物理耗时，
旧 derived 版本误读时间字段为 0 被保留，不是原始 API 记录或新增 generation。

### 离线、发布与最终冻结

激活 adapter 11 项、共享上下文 8 项与 Skills/owner/恢复及原生桥接边界回归通过。
最终激活模块覆盖语句 90.36%、分支 89.51%、行 96.55%，共享上下文 96.77%/93.1%/100%；
这是变更范围覆盖，不冒充全仓覆盖率。tsconfig.test 原继承 exclude 遮住已显式 include 的 package 测试，
现真实纳入，修复 provider/metadata/readonly/真实 Actor cleanup 等旧 fixture 类型，不弱化生产类型。

类型检查、配置模板、packages/native/bundle/14 SDK 声明构建通过。
CLI 5,293,184 bytes，比 1dd6 的 5,287,232 增加 5,952；无新增依赖，按实测只将预算 +44→+50 KiB，
保留原启动依赖/输入/credential 守卫。实际 npm 包 Script 清单/干净目录/缺 worker 明确失败、MCP 三种输出恢复、
独立 IPC/重启任务回执共六项通过；仅 Windows 实测。

评测 guard 在付费前修好两项：异常用量先同步取消全部 lane 再写盘；盲包补共同业务事实而不暴露契约/映射/费用。
都有 RED→GREEN 与两轴复核。旧 prepare 与刚启动后中断的全量快照保留，均无付费调用。

完整冻结 `kodax-shared-activation-full-20261031-3f1cec9a`：3,500 项 Git 路径清单的受监测文件零漂移，18,371 项通过、1 失败、100 跳过、19 todo。
唯一失败为 SDK 视觉旧测试期待首轮原生详情；业务图像流程已成功，不是原图/隔离失败。
单文件先复现 11 过/1 失败，再保留全部原有图像/像素/持久化/恢复断言，校正到原始拒绝 ACK 后核对完整 schema，
并在 12 格真实工具流补首轮缺席/下一请求恢复断言；最终单文件 12/12、tests 类型检查通过，生产未改。
付费后仅修改这项测试与正式证据，模型输入及生产代码未变，不重跑生成。

最终再次冻结 `kodax-shared-activation-full-20261031-c03497f8`：同样 3,500 项清单零变化、无新增路径；
**18,371 项通过、1 失败、100 跳过、19 todo，1,167.88s**。本批视觉断言及其他候选回归全部通过。
唯一失败是已有 `src/runtime-daemon/state.windows.test.ts:109`：跨进程 reader 的 readErrors=1,010，invalidJson=0；
200 次 writer、父进程逐次读回、子进程退出/stderr 均已通过。不能据此宣称全量全绿。
该完整文件隔离一次 1/1 通过，证据 `kodax-activation-final-state-windows-isolated-20261031.json`；不覆盖原全量失败。
当前、1dd6 和旧 0b8 的 writer/test Git blob 完全相同，旧留存已有 readErrors=1,643；未发现候选改变实际状态文件读写路径。
reader 丢弃错误 code，故根因仍未确认，不能简单称为评测无效或已修复。后续只增加有限错误诊断，保留零错误断言，
不加入 reader 重试、不猜测修改原子写、不再反复跑全量求全绿，也不阻断已被独立验证的契约收益。

按当前清单重核，付费期间完整普通文件快照零变化；事后只有 SDK 视觉测试和这两份正式文档改变。
Runtime 抓包自己的 glob 清单只覆盖部分路径，未涵盖所有顶层 src 文件；本次由并行完整快照补齐该证据，
不声称 subset guard 自身覆盖全仓。Gitlink 目录是非普通文件哨兵，不代表递归核验子模块内部源码。
后续 capture 清单应修正目录 pathspec；本批模型输入不变，不因此重跑 generation。

### Standards

独立复核来源/兼容/权限/预算及固定坏味道基线。重复 projection、合法别名激活、评测 stop 顺序与盲包事实缺口已修复，
已封口生产及 L2 范围无剩余阻断发现。SDK 旧断言修正已由主线与独立 Spec 轴复核，未弱化原检查。

### Spec

独立核对三模式共享、全部能力/SDK/专用角色、无固定发现及真实证据分层；已封口生产及 L2 范围无剩余阻断。
有限证据支持采用这项普通根候选；全产品验收仍有上述已存在的 Windows 失败，不能把候选采用等同全量无问题。
Agent <10K、Script 参数表示、真实多轮缓存/套餐成本和全局智能等价均未被本次小样本证明。

## 8. 历史 revision 修复与缓存离线审计（2026-10-31）

本轮相对 `2e826835438cf321d901434574889ac68c20f33b`。生产改动仅限历史证据版本、对应工具教学和 daemon 可选字段声明。
AMA、派发、专用角色、SDK 执行器、工具能力及菜单激活策略不变。新增真实模型调用 0，不重跑旧 18 格，也不为 Agent <10K 删除规则。
发布回归使用本地 HTTP mock 和 IPC，不把离线验证说成没有任何网络系统调用。

### 8.1 先复现、再修复

公共 search→正常工具消息追加→带 revision 的 read 先复现 stale；新增可选 entryRevision 后同一目标可成功读取。
旧 search.revision/read.revision 仍是原算法的严格全局快照，正常追加后旧全局版本继续 stale；没有自动删除或改写调用参数。
新 entry 版本约束目标证据及身份/来源；内容、物理来源、逻辑身份、时间、父节点、消息来源变化均拒绝且不附正文。
额外覆盖分页后的目标修改、压缩、fork/rewind、隐藏/移除条目、子 Session 存储绑定及旧无版本输入。
已有 hidden reasoning、cooperative search 同步结果一致、超限和取消回归保留。

实际装配还先暴露了紧凑说明仍教全局 revision 的缺口，再统一原生、短桥接、Script 与子契约说明。
分页说明原写 next_offset，但原工具实际回执是 nextOffset；公共 adapter 回归先红后绿，只改教学，不改回执。
daemon 严格响应 schema 先拒绝真实新 hit，再仅声明可选 entryRevision；旧 hit 和未知字段拒绝均保留。
Runtime transcript page/chunk 继续用原快照 revision，不能拿 entryRevision 替代。
33 项合同的哈希守卫只在逐项核对本轮历史说明变化后校准，字段/必填/枚举及 canonical 不变断言继续保留。

### 8.2 最终三模式实际 Runtime

最终抓包 stage 为 `history-entry-r4-frozen`，原始 evidence 位于 OS Temp 的
`kodax-eval-dumps/contract-activation-runtime-r2-20261031/`。
真实经历自然 seed、保存、压缩归档、驱逐旧岛正文、关闭重开、搜索及带版本的精确读取。
新路径直接读取一次成功，正文 marker 严格核验；旧全局兼容路径保留原 stale，再发新的合法无版本读取。
所有参数、原始错误及结果都保留，没有在执行前修正模型输出。

| 模式 | 当前代码的旧全局路径请求数 | entry 版本路径请求数 | 累计 SDK 输入估算：旧路径→新路径 |
|---|---:|---:|---:|
| Agent | 5 | 4 | 51,834→41,122 |
| Coding | 5 | 4 | 63,335→50,322 |
| Script | 5 | 4 | 74,004→58,500 |

这是同一当前源码下的协议路径对照，**不是原始版/当前版/候选版的自主模型 A/B**。
数字是归一化完整 SDK 模型字段的同一启发式，非字符数、BPE、API 用量或费用。
fixture 的 skills 显式为空，首轮 9,950/12,250/14,140 不能冒充完整 Host 低于10K。
完整测试另产出32格 SDK 抓包 `kodax-first-turn-wire-MMXX5p`，按既有统一计数器重计其中12格；
完整 Host 的首轮如下，均为完整模型字段启发式，仍非API token。

| 协议 | Agent：2e826版→本轮 | Coding：2e826版→本轮 | Script：2e826版→本轮 |
|---|---:|---:|---:|
| OpenAI | 10,547→10,596 | 14,116→14,165 | 16,100→16,149 |
| Anthropic | 10,345→10,395 | 13,785→13,834 | 15,972→16,021 |

本轮每请求多约49–50个估算token，用于正确的entry/global版本与分页教学；不冒称本轮进一步减少首轮。
原始未优化Coding的28,734仍是此前历史留存，不能用它归因本轮版本修复；新历史检查点仍N/A。
同一当前源码的两种协议路径首轮相同，主要收益来自消除已确认的一次 stale 往返；
不能由脚本轨迹外推所有任务不增加轮次或智能等价。
最初未优化版 `bd4479d59cab…` 没有本新检查点数据，标 N/A，继续保留旧一次性留存；不把中间控制版重命名为最初版本。

### 8.3 缓存归因与反事实

既有 18 格 API 账目分解见[方案 §13](../designs/token-efficiency-next-stage-plan.md#13-历史版本自失效修复与缓存归因2026-10-31)。
准确指标是非缓存读输入=inputTokens−cachedReadTokens；GLM cachedWriteTokens 六格缺失，Kimi/DeepSeek 各六格明确0。
缺失不冒充0，该指标也不等于后端原始 input_tokens 或实际费用。
GLM/Kimi 的增加集中 history；全部候选先跑，且候选菜单33→34→33而控制固定39，无法拆开顺序与菜单的独立因果。
不同检查点目录与捕获 provider 标签也是混杂，不能把三个独立下一响应当一次连续会话总账。
旧 L2 没传生产 promptCacheKey；Kimi 的条件 affinity metadata 路径未使用，不能外推真实连续会话缓存。

另用上述三份同 Session 的真实四请求进行零调用表示反事实，原 source/raw 哈希不变。
新激活原生项放末尾不改累计输入，Agent/Coding 激活时相同工具前缀从18/27项增至24/34；
但 tool_call 的 read 短合同同时移除，仍非完整菜单稳定，不承诺 KV 改善。
read 始终保留完整 bridge 的反事实，Agent/Coding 各四请求仅少80个启发式输入 token，首轮不变，Script不变。
原 native 调用、消息、参数及回执未改；这只证明表示成本，未验证模型会正确改用桥接，也未计潜在工具包装差异。
因此不改默认、不为这点收益新增模型；后续若研究缓存，应整体处理 schema 和桥接说明变化，再核实实际 provider wire。

### 8.4 验证与限制

最终类型检查通过；完整 packages/native/bundle/14 SDK 声明构建通过。
CLI 为5,293,912 bytes，原预算5,294,080，未提高预算或增加依赖。
历史及相关工具定向443项通过；SDK定向18项通过（筛选未执行344项，不冒充362项全过）；
最后三模式 Runtime 7项通过；最终实际 npm 包 Script、MCP三种输出恢复与独立IPC重启回执6项通过。
本轮仅Windows实测，未证明macOS/Linux二进制运行或GLM/Kimi新版本契约的自主选择质量。

完整冻结 `kodax-shared-activation-full-20261031-16fbb54b`：18,386通过、2失败、100跳过、19todo，
3,500个Git路径受监测文件零漂移、无新增路径，测试时间窗约25分43秒。Gitlink是非普通文件哨兵，非子模块递归哈希。
两项失败均保留原raw：

1. 旧冻结评测期待32项投影，实际30。旧fingerprint正确拒绝把两项已演进历史合同覆回旧教学；
   原完整schema、顺序、canonical不变断言均成功。单独先复现，再校准到30并明确断言两项历史原合同保留，
   及entryRevision/nextOffset说明不退回。**不更新旧fingerprint或旧实验输入**；修正后相关5文件59项通过，tests类型检查通过。
2. `src/sdk-runtime.test.ts:5300` 正确收到read_timeout，但耗时101ms超过100ms门槛；单次隔离为102ms，同样失败。
   该计时case和transcriptPage生产路径未改，未进入本轮entry版本算法；尚未定位时序根因，不认定为无效评测。
   未修改的2e826源码另导出至Temp，独立编译llm/agent/coding/repl四包后，同一检查106ms同错；
   使用共享node_modules依赖及archive自身src别名，不借当前dist，非旧版完整发布构建验证。
   首次baseline因尚无dist在准备期失败，保留为preparation-invalid，未计作同错证据。
   source审计确认snapshotPage链与计时case均未变化；两次当前运行及有效控制都在取消段之前失败，
   不据此宣称该case的取消延迟通过。保留失败，不放宽门槛、不重跑全套求绿。

全量后只有上述旧评测测试与正式文档校准；生产及真实SDK抓包输入保持冻结，没有再次运行模型。
本次旧Windows并发reader测试通过，不代表此前失败已定位或修复；旧失败继续保留。

### Standards

独立规范轴逐hunk审查生产、测试、SDK和设计文档：硬违反0、可行动坏味道0；未新增配置、路由或执行链。

### Spec

独立需求轴核对旧全局并发保护、entry证据版本、三模式、隔离和SDK兼容：需修复发现0。
缓存结论仅为离线定位和有限表示反事实，不冒充因果或模型智能验证。

## 9. SDK 首读时序失败的离线收束（2026-10-31）

修复前版本为已推送 `55d1bc6f`；本节不覆盖§8的原始失败，不重跑全仓或新增模型请求。
公共 seam 仍是 `runtime.sessions.transcriptPage`，原20ms预算、100ms响应断言及取消守卫均保留。

### 9.1 归因：环境触发的同步生产阻塞

原用例本轮首次单独复核通过，故不能仅凭一次通过宣布已解决。临时分段计时显示：
接口99.7ms、实际拒绝98.8ms，其中首次全局Temp过期目录清理87.9ms，断言约0.9ms。
唯一控制变量改为独立空Temp后，接口23.0ms、清理0.21ms；取消20.4ms。
原错误仍为read_timeout，未出现过期成功。计时诊断在OS Temp保存为
`kodax-sdk-timing-prune-probe-20261031.json`与`kodax-sdk-timing-empty-probe-20261031.json`。

结论：目录规模/文件系统环境触发首读同步`readdirSync/statSync/rmSync`阻塞事件循环，
使预算定时器和取消无法及时运行；不是断言格式化成本，也不是本轮entryRevision或provider问题。
100ms边缘断言具有调度敏感性，但对应生产阻塞真实存在，不能靠调高门槛或只隔离测试Temp解决。

### 9.2 最小修复与回归

既有全局清理改用异步文件操作，复用原读预算/共享flight取消信号，检查取消后再删除；
预先发布单一Runtime目录再await，防止并发首读创建分叉。沿用原前缀、5分钟TTL、错误告警、
磁盘/文件容量、reader lease、关闭和部分失败恢复；没有新后台服务、状态机、配置或执行链。

新增公共SDK回归同时模拟旧同步150ms扫描和阻塞异步扫描：修复前timeout/cancel分别161.9/158.2ms，
均被原100ms门槛拒绝；修复后两项及原150ms open延迟用例均通过。
初次回归因Node内置ESM绑定未同步而未接到扫描，保留为fixture-invalid；补`syncBuiltinESMExports`
后才取得上述有效RED。没有把该准备失败当作产品证据，也没有删除原断言。
另验证并发首读共用一个目录、过期目录删除、新鲜/无关目录保留。

受影响SDK snapshot/transcript/compacted-history共43项通过（其余297项筛选未执行），
包含共享快照、分页版本、容量/文件数、reader lease、取消、关闭与关闭后不重建。
公共SDK历史观测/会话正文兼容两文件另35项通过，不与43项筛选数量混算全仓。
source/tests类型检查、完整构建及14项SDK声明通过；CLI5,294,025 bytes，原预算5,294,080未变。
实际发布包的Script tarball、三类MCP输出恢复、独立IPC与重启回执6项通过。
本轮只做受影响验收，不把§8的旧全量重新标成全绿。
临时性能探针已移除。Windows实测；没有新增模型调用或跨平台二进制实测。

### Standards

独立规范轴：硬违反0、可行动坏味道0；复用既有预算、flight及关闭链，无新增路由或配置。

### Spec

独立需求轴：需修复发现0；保留100ms门槛、容量/取消/SDK/AMA及全部能力，区分环境触发与生产缺陷。

## 10. 累计优化与模型验证的版本边界（2026-10-31）

三家均有真实完整编辑、运行测试、报告及同Session两用户Run留存，不是只做离线脚本。
最初未优化版固定为`bd4479d`，每案例/模型按原registry只留一次，不重命名中间控制版。
原始只有AMA Coding，没有与今天Agent/Script匹配的原始模式基线。
已有文件/检索/编辑/undo、AMA规划协作、SDK、专用角色、MCP、Skill、RepoIntel/LSP、Memory/Goal、
交互和恢复能力继续保留；入口投影及三模式不等于底层能力删除。功能保持有源码/离线/发布回归，
但不能据此宣称所有任务的智能表现已获统计等价证明。

代表性R14全文保留/归属任务，每格含两个连续用户Run：

| 模型 | 最初bd4479：物理请求 / 全任务API token / 秒 | 当时已采用490ea：同口径 | 质量边界 |
|---|---:|---:|---|
| GLM 5.3 | 13 / 345,574 / 129.88 | 12 / 154,002 / 94.56 | 两版核心修复正确；原始复用R13旧环境留存 |
| Kimi | 12 / 315,607 / 75.85 | 12 / 151,640 / 75.61 | 两版核心修复正确 |
| DeepSeek Flash | 12 / 362,435 / 36.55 | 11 / 188,640 / 39.25 | 两版核心正确；当前稍慢且报告有小幅误述 |

这是`490ea6de`阶段证据，**不是55d1最终版本重跑结果**。不只列正例：R7 DeepSeek配置案例
曾多12个root请求且token上升；R15 GLM/Kimi两版均有契约漏项，Kimi还出现不同边界的混合差异。
R15 DeepSeek原始截断、当前完成，不把截断账单当等质量完整任务比较。
案例有效性、质量与环境限制详见[原始留存/多轮指南](FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#r14-结果三模型均覆盖不能把功能检查通过等同完整任务通过)。

最近`1dd6→2e826`三家18次L2已真实调用，但仅三个独立下一响应，不执行模型提议工具；
总token分别32,312→28,887、29,837→26,740、33,964→30,275。质量、缓存混杂和失败均见§7/§8。
`55d1`历史entry契约修复及本节SDK时序修复均新增模型0；三模式四请求成功是实际工具链的脚本验证。
因此累计收益与工程采用有依据，最终新契约的三模型自主选择/最新完整多轮质量仍是明确的未验证范围。
