# 下一阶段 Token 效率：验证记录

2026-10-31。计划：[整体方案](../designs/token-efficiency-next-stage-plan.md)。
起点 `13f2fe93d`；本轮存在并发视觉文档/实验工作，必须使用相关源码hash而非仅HEAD识别输入。

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
