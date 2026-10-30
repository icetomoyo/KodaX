# P7 顺序验证：证据利用 → 自主取证 → 完整任务

2026-10-30，Asia/Shanghai。来源是用户本次“按这个顺序继续”执行指令，目标仍为**先看任务效果，再看全程 token，最后决定优化方向**。本 revision 不覆盖或替换 [R5 失败与账目](visual-harness-p7-task-value-run-2026-10-30.md)。本文件先冻结设计；运行结果另行追补，不把准备/脚本回放写成模型通过。

## 范围、路由与预算

- 单路由沿用已认可的 Kimi Code `KIMI_CODE_API_KEY`、`kimi-for-coding`、官方 Chat Completions；thinking disabled、每次输出2048 token、60秒；同 provider 串行。执行前重新保存 models 响应和路由资料。官方模型 alias 规格核对于2026-10-30：[模型](https://www.kimi.com/code/docs/kimi-code/models.html)、[订阅](https://www.kimi.com/code/docs/kimi-code/membership.html)。协议与原运行相同，不切 provider、不假称内置 Anthropic kimi-code 路径。
- 新 revision 独立账期，总上限 **26次生成、550,000实际 input+output token、USD2追加支出停止预算**；metadata HTTP最多64。沿用追加钱包CNY差额的保守停止观测（1CNY算USD1），计数可能延迟、订阅分摊与准确美元账单未知。达到上限立即停止，保存失败/缺失；无重试、fallback、repair、child、外部judge。
- 第一阶段2调用，第二阶段2调用，第三阶段B/D各两arm、每arm最多5调用，共最多24次；另外2次为全局余量，不自动追加样本或重试。A/D每单元80K、B100K token；第一、二阶段每单元只允许一次响应。
- 真实 raw、冻结源码、输入、hash、driver、模型响应、usage及盲评在专用 OS Temp。旧R5仅只读。每个单元有独占 started 标记，不能重跑同单元。

## 阶段一：固定局部证据能否帮助纠错

Layer1已经证明原图与裁剪/采样可用，无法回答模型是否会利用这些像素；因此只做一个配对 Layer2 后续响应诊断，2次生成。

固定 R5 候选 A 的第一请求和真实错误回答，两arm前缀完全相同（含原始完整图、生产system、57工具合同）。追加相同复核请求与一张补充图片：一arm重复完整原图，另一arm是实际处理器生成的TP6局部视图（原坐标680,130,120,100，最近邻放大至720×600）。不用文本提示断口位置或正确端点。追加图片明确为Host提供；设置tool_choice=none，只检验这一次答案如何利用证据，不伪造原模型已经调用工具。

固定复核文字：`请复核上一答复。下面是主机提供的补充视图；结合原图，重新给出 J2-3 的最终执行器/端口，以及 upper、lower 的判断和依据。可以维持或修订原结论。本轮只根据给定图像作答，不调用工具。`

主会话先读取随机重标的回答，按端点Valve-C/P2、upper连接/lower跨越及对TP6分支的证据解释评审，再揭盲/查看成本。正确终点但理由仍连接到Motor-E视为矛盾。n=1/arm，仅诊断原失败，不证明新题泛化或自主选择区域。

- 局部图纠正、原图未纠正：局部证据有可用信号，进入阶段二。
- 两边都纠正：记录二次作答本身的可能贡献；局部净收益未建立，但模型能利用现有证据，可进入阶段二。
- 局部图仍错/不可信：先解释模型/表示/案例问题，停止后续模型生成；可继续完成B/D的离线修正。不能靠追加工具调用或换到获胜题跳过此结果。

本阶段成本只表示诊断新增调用，R5历史前缀的原生成费用另有旧账；它不是完整生产任务成本。

## 阶段二：最小行为指导是否改善自主取证选择

阶段一解释完成后执行。Layer2，每arm只捕获下一响应，不派发提案、不自由续跑，2次生成；不把“调用工具”算最终任务成功。

使用同一冻结的原始A任务与完整图，无Host选区或旧错答。基线是C的现有工具合同；候选只在生产visual_inspect描述前增加以下文字，schema/system/其它工具保持不变：

> When a conclusion depends on unclear visual detail or an earlier image, inspect the relevant view before committing. Check whether the returned evidence resolves the question, and confirm or revise the conclusion. Skip inspection when existing evidence is sufficient.

保存 pre/post 精确合同及请求差异。主会话先盲评：是否正确直接答；或提出能消除实际连接疑点的有效选区/采样（TP6顶端分离处及必要上下文）；仅重复全图、检查无关交点、无效参数和无依据猜测分别记录。几何包含只是诊断，最终需语义核对提问目的。未执行反馈后的改答不能标通过。

该A已被用于诊断，不是held-out泛化样本；本阶段只决定是否值得继续该最小候选。没有可信收益时，不把新增指导自动留在生产；先记录原因。后续B/D smoke可以独立完成，但不能代替本阶段prompt比较。

## 阶段三：修正B/D，核对完整任务与全程token

小规模 Layer3.5 smoke，B/D两case，每arm一次，不用于单独归因prompt或估算稳定成功率。B0仍为`1826cc228f299995fe5b22e608c7fbd90c3dc9ee`，候选为已接受C加本轮有依据保留的最小指导（若不保留则使用C），精确源码/补丁hash在执行前冻结。

- B沿用原前/后/稍后场景，修正Queued筛选下不应出现Running行和错误行数。两边实际历史接纳→一次生产压缩→新问题→实际回取→回答；三主响应加压缩/review各一，最多5生成。没有模型热身历史，不能宣称测了建立长历史的总成本。
- D保留相同空/空白配置、默认字段、有效值与无效JSON行为，实际文件/五项冻结原测试。**四个主响应**分别容纳读取→编辑→测试→读取反馈并总结，另最多一次默认后台review，共5生成。Host测试与模型看到测试反馈分别记录。
- **每响应至多四工具**，使三文件普通read批次合法；工具10秒，B6分钟/D5分钟。所有允许工具仍走真实生产handler，参数错误反馈如实返回；child/额外生成入口仍在派发前阻断。
- 两边相同图片、任务、初始Memory、权限、工作路径、预算，独立重置。先用scripted provider回放三read批次及四响应路径，断言原图进入真实后续serializer、所有后台工作结算；回放仅算接线证据。
- 先盲评答案/补丁/冻结原测试/未要求修改，再查看usage。逐请求累计input+output，缓存已含输入不重复加；计入压缩、review、失败恢复、全部图片，区分首轮与全程、用户完成与后台结算。无同质量完成对时不报告框架总体增幅。

## 实施与评审

沿既有公共接缝TDD：冻结请求构造/隔离、物理传输与预算、真实Runtime产品输入和工具反馈；不重新探讨P0–P2。具体行为提示按LLM-facing合同语义评审，不为一段文案添加同义反复式单测。最终做定向测试、typecheck/build及双轴评审；全仓失败如实保留，不用单独复验关闭原因。

本轮不扩ARC/桌面/新模型，不预设零token增量或固定采用百分比，不把阶段一人工提供局部图包装为自主取证成功。
