# P7 任务价值首批执行记录

2026-10-30，Asia/Shanghai。首批六个单元已实际尝试并结算：**尚未证明框架带来可验收的任务收益，也没有干净的同质量完成对可用于推断全程增量。** API 首个主请求含输出增加600～1,059 token（4.64%～5.90%）；它不等于整项任务成本。执行依据是[任务价值方案](visual-harness-p7-task-value-plan-2026-10-29.md)，授权来自用户“那请你按方案开始执行”。先锁定质量理由、再揭盲/读取 usage；未预设采用门槛，未自动补跑。

## 冻结范围与授权

- 基线 B0：`1826cc228f299995fe5b22e608c7fbd90c3dc9ee`；工程候选 C：`3b2d48e8ffeebdd0f14cd81c5c04b65736884938`。两边分别运行实际工作树的 Runtime、SDK 序列化、生产 prompts/tools 和真实 handlers；执行前检查 `src/`、`packages/`、lockfile 与对应 revision 无差异。适配器与实验输入另存 hash。
- 只执行 A 连线图、B 压缩后历史截图诊断、D 普通配置修复，各 arm 一次。C 互动面板未执行；无 ARC/完整桌面扩展。
- 上限：26 次生成请求（含真实压缩和后台 review）、550,000 总 token；每请求 2,048 输出 token/60 秒；主模型最多三响应、每响应两工具，A/D 每 arm 80,000 token/5 分钟，B 100,000/6 分钟；工具 10 秒；metadata HTTP 最多64。重试、fallback、外部 judge、repair、子模型均0。
- USD2 是停止预算。Kimi Code 使用 `KIMI_CODE_API_KEY` 与官方 Chat Completions 路由 `https://api.kimi.com/coding/v1/chat/completions`，同一 custom-provider 适配两版本；并非内置 Anthropic `kimi-code` 序列化。正式请求之前保存 models 响应、解析目标 alias、冻结实际 route。`kimi-for-coding` 且关闭 thinking 对应 K2.8 Preview 无思考版，支持图片；[官方模型说明](https://www.kimi.com/code/docs/kimi-code/models.html)，核对于2026-10-30。
- 以每次生成后的 `booster_wallet.monthlyUsed` 人民币差值观察追加钱包消费，1 CNY 保守计作 USD1 预算单位；计数可能延迟，并非准确美元账单或订阅分摊费用。订阅额度和加油包规则依据[官方权益说明](https://www.kimi.com/code/docs/kimi-code/membership.html)。缺失 usage 不估成实际 token，失败请求独立保留。

## 真实输入与适配

原图 A 为1600×1000 PNG，B 为三张1440×900 PNG；每对使用相同原始 bytes、文件名、任务、初始 Memory 和公共 workspace 路径，各 arm 重置。普通 read/bash 与 portable bridge 保持生产行为，基线可自行取证。共同任务文本只额外声明三响应/两工具的受控边界，不提示工具或区域。

B 使用固定历史 fixture：三次图片输入及接收确认、八段健康记录，**没有模型热身生成**。候选调用实际 Runtime visual admission，基线保留原始图片块；由各自真实 Session storage 导入，再执行一次生产 `sessions.compact`（128K context、5,000 token 阈值）。最终问题到压缩后才进入模型。该透明历史导入不是伪造摘要；也不代表已测过建立这些历史的长任务成本或独立模型对旧图的首次理解。

原始文件两边始终可读；生成期间独立真值只保留在控制 Host 内存，plan 冻结摘要，不写入公开 fixture、子进程参数/环境或 raw 目录。所有生成结束后才保存 oracle，规范 JSON 的 SHA256 与冻结值一致。渲染/测试程序属于公开仓库代码；本轮不是恶意越界读取的安全隔离测试。实际提案只访问任务原图/代码/测试，未见跨目录取证；不能据此宣称通用 Host 读隔离已验证。标签/筛选值在生成前冻结，不是独立拓扑泛化测试。

## 零费用预检与失败记录

raw 保存在 OS Temp，未加入 Git。最终输入沿用 r3 的图和真值；后续只修正接线/计量，未根据模型效果选题。

| 预检 | 实际结果 | 处理 |
| --- | --- | --- |
| r1，`kodax-visual-task-r1-RrDDjF` | 底层 `runs.start` 读图缺 canonical source entry | 改用正常产品 `acceptInput`；未修改工程候选；保留失败 |
| r2，`kodax-visual-task-r2-FSiYeU` | 8K 压缩导致三次 summary，B 达到6请求 | 改回主路由128K窗口与明确阈值；不偷藏摘要调用 |
| r3，`kodax-visual-task-r3-yi7zkk` | 重复 scripted tool ID 使 B0 漏一张反馈图 | 唯一 occurrence ID；新增每张原图进入后续 serializer 的断言 |
| r4，`kodax-visual-task-r4-mBlpxP` | 六格全部完成，逐图断言通过 | 再补子模型阻断、删除文件结算与普通 bridge 恢复反例 |
| r5，`kodax-visual-task-r5-070Hn3` | 六格实际 Runtime 回放通过，逐图断言通过 | 冻结为首批在线输入；以上 revisions 均0次外部生成 |

离线正常路径实际请求图：A 两 arm 均 main×2+review×1；B0 compact×1+main×2+review×1，C compact×1+main×3+review×1；D 两 arm 均 main×3+review×1，冻结原测试通过。这是 scripted provider 的 Layer1 接线证据，**不是模型行为成绩**。

TDD 保留反例：工具反馈、源图 bytes、真实压缩先于问题；HTTP失败不重试、部分响应保存、缺 usage 不补算、容量满前拒绝、最后一次 usage 到上限后阻断提案；完整新增/删除/测试修改快照；直接和 portable 子模型入口拒绝，正常 bridge 与非严格参数走同版本生产 parser/错误恢复。执行与清理同时失败保留两者，恢复 fetch/env/计时器。

## 支持矩阵与计量边界

| 工作面 | 工程/机械证据 | 在线任务效果 |
| --- | --- | --- |
| B0/C Runtime 产品输入、OpenAI Chat兼容单模型 | 六格真实处理/完整后台结算已回放 | 六个实际尝试；A两边答错，B/D有窗口截断，未建立收益 |
| B 历史导入→生产压缩→真实回取 | 两原图均进入后续实际序列化；候选目录/inspect链路通过 | 候选实际一次inspect回取3原图并回答核心字段；基线未获像素反馈，不能作效果胜利 |
| D 普通代码与未要求修改 | 原测试独立复验、完整树差异；缺失/链接形成失败证据 | 候选补丁通过5项冻结原测试；双方无最终答复，完整任务未验收 |
| 底层 `Runtime.runs.start` 直接图片输入后再read | r1复现缺canonical source entry | 保留已知问题，本轮未修，不用Product通道的通过替代此项 |
| 动态面板、更多模型/宿主、steer崩溃回放、子Actor媒体owner | 保留原未验范围 | 未执行 |

主模型完成后，观察器继续保留，等待 `status.preflight().pendingBackgroundWork === 0` 才关闭 Runtime；关闭本身会取消 review，不能用它制造低成本。全部生成请求保存实际 request/response/usage；缓存 token 含在实际输入总数中，不重复加推理 token。metadata 分列。主完成与完整结算时间分列。

先随机重标最终答案、补丁和完整项目差异；框架生成的 `.agent/managed-tasks`、repo-intelligence 内容可能含预算，首遍只投影规范化路径/hash，完整 raw 保留给后续诊断。主会话先保存质量理由，再揭盲与成本；不把工具调用当成功。

## 在线结果、成本与建议

先锁定 `quality-review.blind.json`，之后才读取揭盲表/ledger；没有外部 judge。操作错误已暴露B失败单元的执行来源，故B不称完整盲比。接续驱动曾直接比较Windows斜线/尾分隔符，最初arm表错误；已按冻结plan根路径规范化更正，原表与更正保留。盲评理由、输入和任何生成均未改动。

| 任务 | 基线实际结果 | 候选实际结果 | 可以下的结论 |
| --- | --- | --- | --- |
| A 连线图 | 回答Motor-E/P1；两处交点分类正确 | 同样错误终点、正确交点分类 | 两边都没再取证。TP6竖线与上方横线隔10px，实际端点Valve-C/P2；本例未观察到主动局部取证收益 |
| B 历史截图 | 首个主响应提出3次read，超过每响应2工具；整批未派发，无最终答案 | 一次visual_inspect取回三张原图，正确读出09:10 All→09:25 Running、K23 Queued与稍后10:40 Queued | 证明这条真实恢复链路能用；不能把配额截断导致基线没收到图算为智能提升 |
| D 普通代码 | 首个主响应提出3次read，未派发；未修改，原测试3/5通过 | 三响应依次读取、edit、提案运行测试；准备第四响应时停止。Host独立原测试5/5通过，只有config.mjs改动 | 候选有正确补丁，但没有最终答复；基线的早停低成本不算更高效 |

B 的原始 latest.png 还有评测错误：Queued筛选下仍画出Running的K17，行数也错误。候选指出异常并提出“可能”的解释；不能把fixture造成的矛盾归为框架缺陷，也不把对隐藏时刻状态不变的强断言当作充分取证。原图、失败与回答均保留，**没有换图后补跑**。提交代码在R5结束后以像素回归先RED再GREEN修正渲染；未来prepare标记r6、授权为空，尚未新冻结/执行模型任务。

完整实际usage与请求/hash索引见[成本证据](visual-harness-p7-task-value-costs-2026-10-30.json)。以下“首轮”均指**本题首个主模型请求**；B在它之前另有已计入总量的生产压缩。

| 任务 | 首轮输入：基线→候选 | 输入增量 | 首轮含输出：基线→候选 | 含输出增量 |
| --- | --- | --- | --- | --- |
| A | 14,553→15,301 | +748（5.14%） | 14,705→15,495 | +790（5.37%） |
| B | 17,747→18,786 | +1,039（5.85%） | 17,939→18,998 | +1,059（5.90%） |
| D | 12,738→13,399 | +661（5.19%） | 12,926→13,526 | +600（4.64%） |

B包含不同的真实模型摘要/目录，不能把+1,039全归为常驻schema。普通无图D确认了本工作面仍有首轮输入增加；不是所有SDK/provider/模式的通用常数。历史+726～748仍是另一项本地估算，不能替换为这里的API usage或计费。

| 任务 | 基线全部尝试token（生成请求） | 候选全部尝试token（生成请求） | 比较限制 |
| --- | --- | --- | --- |
| A | 16,790（主1+review1） | 17,684（主1+review1） | +894，5.32%；两边都答错，不是同质量成功成本 |
| B | 23,120（压缩1+主1） | 52,044（压缩1+主2+review1） | 基线在像素反馈前截断，不能以差额宣称框架更贵/更省 |
| D | 12,926（主1） | 41,764（主3） | 早停未改与已有正确补丁不等价；候选仍未完成最终回复 |

整批 **14次生成 = 主9+压缩2+review3**；API报告输入159,537、输出4,791，总计 **164,328 token**。其中86,784缓存输入已包含在输入总数中。metadata16次（models1、初始wallet1、生成后wallet14），provider HTTP合计30；重试/fallback/repair/child/外部judge均0。基线所有尝试52,836、候选111,492，完成程度不同，**不得把这个总差额当作框架总体开销或每成功任务成本**。观察到追加钱包差额CNY0；订阅分摊与实际美元账单未知，不能说真实费用零。

原控制器在B的局部工具配额停止后中止了循环；确认当时ledger无全局停止、已发请求usage齐全后，仅接续原先注册且未执行的B另一侧和D两侧，没有重试失败单元。最终14次usage均已结算。接续输入/来源/hash及共享预算另行冻结在同一raw目录，未增加单元或上限。三个边界停止单元的用户完成/完整结算时间原记录缺失，保留null；只保存HTTP累计耗时。其它实际可见完成→后台结算为A基线7.18→17.491秒、A候选9.52→20.827秒、B候选49.617→60.346秒。全仓测试同时运行，**不据这些时间做性能归因**。

结论是 `recommend-iterate-eval`：A保留为“两版都过度确信、没有主动复查”的反例；B先修输入一致性和正常多文件取证的配额偏差；D需要容纳修复→测试→总结的合法路径。下一轮须重新冻结范围与预算，不沿用已消费授权。当前不扩展ARC/桌面/新宿主，不改工程候选，也不以固定token百分比决定采用。按需工具装配可作为后续成本优化选项，尚未实施。

## Standards

先发现raw边界与清理异常保留问题，已补统一OS Temp realpath校验和完整finally/AggregateError。最终复核又发现ledger落盘错误会覆盖原请求错误，已用真实EISDIR反例先RED再GREEN，AggregateError保留两者；未改动R5实际结果。最终复核剩余成文违反0、值得修复的smell判断0。

## Spec

先发现末次 token stop、完整代码树、重复工具ID、子模型入口及 bridge/参数恢复问题，均已补反例并复核；在线前未再发现生成阻断项。盲包框架产物的成本/执行次序泄露按规范化路径/hash投影修正，raw不删。最终复核剩余实现/文档状态冲突0；R5原fixture与窗口造成的实验无效/截断仍保留，不因修正下一草案而消失，不等于P7价值验收通过。

## 工程验证

本轮默认全仓原始结果：**18,109通过、2失败、98跳过、19todo，总18,228，退出1**，耗时约1,650秒。两项分别是 `src/sdk-runtime.memory-review.test.ts` 的terminal review应启动1次却为0，以及 `src/sdk-runtime.test.ts` 的读取预算耗时130ms超过100ms。原日志/JSON保留。只复跑这两项得到 **2通过、0失败**；原因未定位，不能据此关闭失败。本次未修改这些生产代码或测试。历史ENOTEMPTY、Feature270/T30原失败仍保留。

全仓运行后只修离线评测：Queued渲染、边界失败的部分工具/结算记录、失败不显示完成时间、未来r6授权清零，以及落盘异常保留。最终定向 **6文件53项通过**（包含旧pilot26项，不与全仓计数相加），最终 `npm run typecheck` 通过。实际覆盖范围仅为新task-cell/fixtures/transport/workspace四模块：语句 **91.16%**、分支 **80.37%**、函数 **92.50%**、行 **97.66%**；不是全仓覆盖，raw为同目录 `final-coverage-r4/`。build已通过，CLI约5,151KiB，14个SDK声明检查通过；仓库无lint脚本。不将R5旧输入或被截断任务改判通过。

R5执行时六份适配器/渲染源码现已保存于raw的 `frozen-harness/`，全部SHA256匹配生成前的 `execution-freeze.json`，与提交后的r6离线改动分开保留。r6仅做了零授权CLI拒绝验证（未写models/ledger、0次新生成），未执行新一轮六格接线预检或实际模型任务。历史基线托管工作树暂保留：应用归档工具拒绝移除该任务的primary checkout，未强行删除。
