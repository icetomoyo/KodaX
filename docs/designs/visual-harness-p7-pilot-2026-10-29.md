# Visual harness P7：冻结输入与未执行行为方案

2026-10-29。工程候选 `a591967522287b8b880ee507347668e46f98ea15`，比较基线 `30310e0018b3c0803653a278f451751a00ccc3bc`。本文件没有发起付费实验。工程与成本见 [实施记录](visual-harness-p3-p7-implementation-2026-10-29.md)、[完整字段证据](visual-harness-p3-p7-costs.json)。

后续 P6b 收据等待竞态补修后，本稿的旧候选输入仍作为历史草案保留。若获授权执行行为验证，应针对补修提交重新冻结实际候选；本次没有执行旧草案或新增行为请求。

## 已做与未做

已执行 Layer 1、生产 serializer 离线抓包和四份 Layer 2 request 草案生成；**provider 请求 0、费用 0、行为输出 0**。模型、可用路由、在线图片协议接受、实际 usage/cache 与定价未验证；authorized budget 为 0。没有行为 lift/回退结论，没有新增 judge panel。

freezer 是 [pilot-plan.ts](../../benchmark/visual-harness/pilot-plan.ts)，只读显式指定的两个已捕获请求，完整保留各 arm 的生产 tools 描述/schema 与文本上下文前缀，再替换末尾真实任务。它没有网络执行路径，不是已授权的付费 runner。授权后还须明确实际 provider/model/route，核对该路由的生产前缀、输出 cap、usage 和费用核算，再冻结新 revision；不能把此处 UNRESOLVED 草案直接称为在线就绪。

Layer 1 能证明回取、像素、时效、恢复和权限接线，不能证明模型会选择相关证据、理解 alpha 或避免无用检查，因此提出以下受控下一响应 pilot。它只回答“下一步取证/回退是否有价值”，不回答取证后的最终准确率或完整任务总收益。

## 最小 pilot

| case | 固定问题/初始证据 | 主会话评审关注点 |
| --- | --- | --- |
| exact-rgba | 3×2 历史 PNG，问 (1,1) 的原 alpha 是否恰为 128；不能靠合成显示色断言 | 是否选择相关原像素证据或明确未核实；inspect 也可能合理，单纯调用新工具不算成功 |
| irrelevant-image | 同一图是无关旧参考，只问 17+25 | 是否回答 42 并避免无用视觉/历史/远端动作；不能据此保证永不误用 |

每 arm 每 case 1 次、先只选 1 个经核对的 provider，合计 4 次；不扩默认五模型 panel。两 arm 的最后任务、参考 PNG bytes/hash 与初始帧数相同。frozen reference 是控制历史 fixture，不冒充实时环境或 Runtime end-to-end。各 arm 的生产文本前缀分别冻结并记录 hash，合同差异属于机制；其他内容差异若使任务失真，应判 eval-invalid 并重建 revision。

freezer 只接受不含历史图片的生产前缀；任何保留前缀中出现 image/image_url/input_image 都明确拒绝，不能给候选额外帧却仍报告 1 帧。此限制针对本 pilot，不更改 Runtime 的历史图片支持。实际 CLI 生成的 PNG 在 (1,1) 为 RGBA [0,255,255,128]，测试独立核对此字面真值。

| 上限 | 当前授权 | 拟议 pilot（须另行授权） |
| --- | --- | --- |
| provider 调用总数 | 0 | 4 |
| 每 cell 调用/轮数 | 0 | 1/1，Layer 2 不执行返回的工具 |
| 单次输出 token | 0 | 512，按路由 API 强制 |
| 总 token | 0 | 100,000，实际 usage 每次核算；未知 usage 停止 |
| 外部美元费用 | 0 | $1 硬停止上限，**不是价格估计**；先核对定价 |
| timeout / 并发 | 不执行 | 60 秒/请求，同一 provider 1 在途 |
| 自动重试/修复/judge | 0 | 0/0/0 |

任一限额、timeout、未知 usage 或不支持输出 cap 均停止，保留已完成 raw；不能自动切 provider/model 或追加调用。没有授权就不执行。需要连续反馈时另建最多 3 轮的预定义 Layer 3 revision，不能让返回的工具调用自由展开。

五项行为问题的范围仍明确保留：本 pilot 覆盖颜色/网格取证与不需要视觉；小细节相关局部、旧时刻/新假设、动态探索/过期依据及 unknown 不重放，仍待下一独立受控 case/固定反馈图验证。P6 的脚本选择 reveal/select 是机械接线证据，不是这些模型行为已经通过。

## 可复现的离线输入生成

```powershell
node --import tsx benchmark/visual-harness/pilot-plan.ts `
  C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-wire-mwTGST/openai-ama-runtime-host/request.json `
  C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-wire-2XNJsB/openai-ama-runtime-host/request.json `
  a591967522287b8b880ee507347668e46f98ea15
```

这里的基线 raw 是经 30310e00 合同源码逐个匹配后复用的 P0–P2 证据，不是重新抓取的基线。默认成本记录保存 Windows LF/CRLF 对应关系及原 hash，未改写历史。需要实际模型/路由时在参数后显式给 provider/model，并重审完整来源/预算，提供参数本身不产生授权。

最终离线生成目录为 OS Temp `kodax-eval-dumps-visual-freeze-IUrBpR`；先前草案 `U9dLg2` 保留，不冒充修补后的版本。目录含四份 request、PNG、plan 与 review-template，未保存到仓库。PNG SHA-256 `4317923a6616a3ad3dbac5d706f443c3a3e6b1304cf502fdcfdbb3853a8b49dc`，每 cell 初始 1 帧。

生产 tools 的 compact JSON SHA：baseline `b7a810620089e57dad4a0383f562adc882708e915d24686179e20f1914fbdfdc`，candidate `5d7ff3c800f949a020524c24e84264b0cbd8d1e18be9f3986c6a4f7156b822ee`。四份 request SHA：

| case/arm | SHA-256 |
| --- | --- |
| exact-rgba/baseline | b04def8dacc65ff64d6e3392a8d95b5b8d73e65eed863cadbc1bedcbb7a91a44 |
| exact-rgba/candidate | 400cec69c8a44008abcd40e914518bfb1afa1cb3d6d2bd31910439d0b9c40830 |
| irrelevant-image/baseline | 255626a4c1fe2225dcf0c1cf8d881a6c54e59877dfa81c75859c3d272cc17f80 |
| irrelevant-image/candidate | b03a9cbc845db040cc9f36da3fca6053fc663f62178427f07c95b2862d4391ae |

## 分析与采用判据

授权生成后先将每 case 配对输出随机盲化为 X/Y，将 reveal 单独保存；主会话在揭盲前记录任务有效性、实质帮助、可信回退、原因及证据，再揭盲关联 arm。允许 recommend-ship / recommend-iterate / recommend-revert / eval-invalid，并说明局部保留与验证成本；不由工具次数、退出码或单一通过率决定。任何 scorer/rubric 修改先重读已有 raw，输入改变才另建 revision/补最小 cell。

目前没有 raw 行为输出，不能开展盲化语义比较。建议 **recommend-iterate（行为价值待验证）**：保留已验证的限定工程能力，不据此宣传通用智能提升。最终采用由用户/owner 决定。

首轮与总体 token 分开：默认完整字段相对“token 优化后、P0 前”累计 **OpenAI +748 / Anthropic +726～744**；相对 30310e00 为 **+365～366 / +358～364**，是同一启发式估算。Anthropic 的 Coding SA 兼容格为 **+364/累计 +744**，Coding AMA、Agent、Script 为 **+358/累计 +726**；完整八格见实施记录。显式卡片消费者另 +194（已测 OpenAI Coding）。总任务还取决于模型请求次数、结果/标签历史、主动图片与数值结果，以及因此节省或新增的步骤；usage/cache/费用/总任务净增量尚未测量，不能用首轮差值替代。
