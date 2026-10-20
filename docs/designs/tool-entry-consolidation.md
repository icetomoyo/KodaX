# Tool 入口收敛

状态：已实施，限定模型验证通过；全量回归结果见下文。基线：`5ada4f7c`。用户授权：先核实并收敛
tool_describe、LSP prepare、Todo 读取；不删除底层能力，保留 AMA 规划和派发策略，
检查替代路径、依赖和 E2E，并允许使用实际模型预算。

## 本轮契约

- 模型表优先 `tool_search(select:NAME)`；其完整契约支持直接调用或 `tool_call`。
  `tool_describe` 的注册、历史调用及执行器保留。
- `todo_list` 无 id 保持列表输出；有 id 复用 `todo_get`，保持完整单项 DTO、
  校验、当前状态及只读性质。不是把有损列表当详情。
- 来电/去电工具内部已自动 prepare；默认表不再额外提供 prepare 入口。
  单独根元数据检查和旧调用仍然可执行。
- 只在 builtin 替代项全部存在时隐藏 builtin 重复入口；旧接口独占、
  工具排除和同名扩展覆盖时保留入口。LSP prepare 要求来电/去电两项均存在。
- AMA 仅更新读取工具写法与可用能力判断；平凡任务豁免、规划、续接、
  派发、并发、里程碑和终止策略不变。内部单 Agent 执行器保留。
- 不新增模式、配置或能力分类器；本轮不缩减其他工具，不改 repo/search 后端。

## 验证与预算

先做 TDD、扩展/旧接口回归、真实 HTTP/SSE SDK、LSP stdio 与 Runtime
编辑/运行测试。再对最终源码冻结请求及 hash，用真实模型检查工具选择和
读取→修改→运行 Node 测试→如实报告。

模型调用回答离线测试无法回答的契约理解和任务行为问题；不承担机制验证。
目标路线是用户指定的 ZAI GLM-5.3、GLM-5.3-flash、DeepSeek Flash、Kimi Code。
先小样本验证实验；相同 provider 串行，无自动重试或替代路线。
本轮最多 32 次物理请求、1,200,000 保守记账 token、参考费用 USD 3；
每次输出最多 2,048 token、120 秒。未知 usage 按完整请求字节加余量保守计费，
暂停派发并检查。四步编辑闭环逐步有验收，额外第四轮用于读取测试结果后诚实报告。
比较证据先由主会话盲审，再揭示标签、token 与耗时；错误和未完成项保留。
原始证据保存在 OS 临时目录。小样本不能证明所有任务的智能不下降。

## 后续工具决策

本地 `code_search`、`semantic_lookup`、process/impact/relationship 等先分析实际
输出、调用依赖和回退路径，再决定模型入口是否值得常驻。不能以工具名相似
或 schema 较长作为删除理由，也不能宣称聚合入口已经无损覆盖现有能力。
正确性缺陷应与入口缩减区分，先确定事实与影响，再做独立最小修复。

| 工具组 | 当前判断 | 进入收敛前的条件 |
| --- | --- | --- |
| 本地 `code_search` | 默认入口退役候选；本轮保留 | `glob` 路径搜索、`grep` 内容搜索加定向 `read` 可覆盖主要行为，但过滤、片段、输出来源及续读不等价。先迁移内部提示和 ledger 消费并做同夹具验证。`provider_id` 扩展搜索契约保留。 |
| `repo_overview`、`changed_scope`、`changed_diff` | 保留 | 分别承担方向定位、变更集合、受控 diff；不是文本搜索同义词。 |
| `module_context`、`symbol_context` | 保留 | 模块测试/文档与符号签名/import 信息，现有聚合入口并不完整返回。 |
| `semantic_lookup` | 收益待证实 | 提供有类型的结构名称发现；属于词法评分，不是 embedding 检索。比较真实定位任务的读文件数和误定位，不能仅凭名字判断。 |
| `process_context` | 独立默认入口退役候选 | 只生成有界入口摘要，不保证任意函数的控制流。先证明需要的摘要经现有关系工具可获得，保留旧调用。 |
| `impact_estimate` 与 `relationship_scan` | 合并候选，尚不实施 | 先补齐相同目标、refresh、变更 overlap 与缺失字段契约，避免“聚合”掩盖有损覆盖。 |
| SCC | 算法保留，独立入口收益待测 | 图上的环/组件分析不能由一次 grep 替代；是否常驻由任务价值而非内部算法存在决定。 |

离线夹具已确认的限制：本地搜索目录漏 `.mts`，会纳入 `.min.js`/lockfile；
`scan_offset` 续文件而非续命中，同一文件被 limit 截断后不能据此无损翻页。
retrieval 文本被 ledger 当普通路径解析，出现 `Score: 0.80` 等伪路径。
full TS analyzer 的 checker 结果在 materializer 中被同名启发式关系覆盖，夹具中
未导入的同名函数也成为调用目标。因此不能将现有图宣称为编译器精确结果。

后续先给这些缺陷补独立回归，校准正确性与描述，再比较工具组合。
隐藏模型入口本身不会停止 preturn 索引暖机，也不能直接宣称减少了索引耗时。
实现时还须保留内部 dispatch、specialist、权限/classifier、MCP fallback、
result policy 和 ledger 依赖，不能只删 registry 定义。

主要源码：
[本地搜索](../../packages/coding/src/tools/code-search.ts)、
[索引最终构建](../../packages/coding/src/repo-intelligence/semantic-build-materialize.ts)、
[结构查询](../../packages/coding/src/repo-intelligence/semantic-query.ts)、
[关系聚合](../../packages/coding/src/tools/relationship-scan.ts)。

后续价值比较应同时统计首轮、全任务 token、额外调用、耗时和结果正确性。
例如工具 schema 少 200 token、任务调用 6 轮，约省 1,200 输入 token；若替代路径
因此多一次约 17k 输入的调用，总量反而更高。不能只凭首轮数字决定退役。

## 本轮验证结果

最终 Runtime 模型表为 54 项（原 57），Runtime/Host 为 55 项（原 58）。
SDK 旧入口、工具排除和同名扩展覆盖回归保留；真实 HTTP/SSE 的 OpenAI/Anthropic
两协议、AMA/内部单 Agent 两执行路径通过；真实 LSP stdio 证明来电/去电工具能
传递服务端 opaque data，内部完成 prepare。最终相关回归 105 项通过，类型检查和
完整构建通过；其余相关工具解析、planner、Todo、LSP 测试也通过。

首次全量运行记录为 16,716 通过、5 失败、89 跳过、19 todo，不能写成全绿。
运行期间仍在修复兼容性与补断言，三项失败读到了中间版本的模块缓存；
冻结后复验通过。另有 daemon T21 启动超时，隔离复验整个 daemon 文件 25 项通过；
written-files 的功能断言通过但 Windows 清理临时目录发生 ENOTEMPTY，
复验在另一 case 重现清理失败。测试清理改为 await 原生 rm 并有限重试，
不变更功能断言或 Runtime，最终对应 4 文件 81 项通过。
这覆盖首次失败涉及的全部 5 文件共 106 项；没有再把未执行的第二次完整全量
运行描述成通过。最后的测试类型检查也通过。

同 Windows Runtime/Host 请求的启发式估算：OpenAI 形状模型输入
20,915→20,535（-380，-1.82%）；Anthropic 20,533→20,175（-358，-1.74%）。
这是模型字段估算，不是计费 usage，也不是 UI 上下文显示。
同口径已捕获 Codex Sol 17,032 / Astra 16,944；KodaX 仍高约 3.5k，
本轮只关闭一小部分差距。DSH Standard 9,318、PTC 11,753 的既有同场景模型字段
估算不因本轮 KodaX 修改而变化；额外 body metadata 是否进服务端模型上下文仍未知。

两项 Layer 2 场景（当前 Todo 完整详情、两工具完整契约查询）×四模型×两组，
共 16 次真实请求。先由主会话读取盲化输出再揭示标签和成本：8 对均未见实质任务
能力损失，实际输入每轮少 350（两 GLM）、316（Kimi）、356（DeepSeek）token。
DeepSeek 两个场景中的中/英文进度句偏好分别落在不同组，是轻微表达差异，
不构成一致的候选退化信号。工具名可能暴露分组，不能称完全盲化。

最终源码的同一编辑夹具通过真实 Runtime 执行，每路线 4 次依赖调用：

| 路线 | 首轮 API 输入 token | 四轮总 token | 读→双处编辑→真实 Node 测试→如实报告 |
| --- | ---: | ---: | --- |
| zai-coding / glm-5.3-flash | 17,200 | 70,061 | 通过 |
| zai-coding / glm-5.3 | 17,199 | 70,035 | 通过 |
| deepseek / deepseek-flash | 17,759 | 72,722 | 通过 |
| kimi-code / kimi-for-coding | 15,854 | 65,422 | 通过 |

四次实际测试均退出 0、pass 1 / fail 0；最终文件逐字匹配预期并保留两处注释。
主会话读取真实工具输出及最终报告，确认报告有依据。这个小型成功路径与固定调用图
不能证明复杂任务、失败恢复或自主协作的全局智能非劣；未观察到普遍耗时改善，
缓存与网关波动也不支持模型或方案的速度排名。

共 32 次物理请求、552,486 已知 usage token、0 未知 usage，无重试或 fallback。
冻结费率参考费用 USD 0.0297886224；coding-plan 参考价不代表增量订阅账单，
DeepSeek 为 token-bill 路线。连同历史保守登记累计 302 次、5,893,476 token、
参考 USD 0.4072162096、8 次历史未知 usage；累计值不能冒称全为已测 usage。
原始请求/响应、配对评审、实际工具结果帧与账本存于 OS Temp 实验
`tool-entry-20261018-0826`，证据文件三份副本校验一致，13 项最终源码 hash 未变。
wrapper 曾将丰富结果 envelope 覆写成返回 DTO；实际工具结果完整保留在下一请求输入中，
已另存精确提取帧，无需补烧模型调用，也没有模型响应或 usage 丢失。

## 复杂任务补充验证

[复杂任务验证记录](complex-tool-entry-validation.md) 补充了四模型固定检查点、
GLM Flash 与 Kimi 的多文件实际执行及真实反例。结论为 recommend-iterate：
完整 Todo 替代入口得到支持，Flash 闭环通过，Kimi 仅能计为恢复辅助下通过；
DeepSeek 候选三次反证修复中有一次破坏原本正确的到期边界，原因未明。
本轮不继续扩大工具退役，前述小型成功路径不能覆盖或抵消这条不利证据。
AMA 策略与生产代码在补测期间保持冻结；完整限定和去重账本见该记录。

后续 [控制变量与无干预复核](deepseek-tool-ablation.md) 已补齐：DeepSeek 20 次因素隔离未见稳定的工具表损害信号；Kimi 全新 Runtime 无干预完成读改测及实际子任务，13/13 和独立 6/6 通过。支持保留当前收敛，不扩大工具退役；历史不利输出、评测无效样本及报告措辞局限均保留，不能外推普遍智能非劣。

## Standards

独立评审未发现可行动问题（0 项）。对照 AGENTS.md、CONTRIBUTING.md 及
12 项 smell 基线，复用现有读取器，未新增配置、跨层依赖或无需求抽象。

## Spec

初审发现 2 项兼容性风险，均已修复并复核：扩展覆盖 list 时优先使用仍保留的
详情读取器；goal/drift 提醒不写死可能缺席的读取入口。复核未发现新问题（0 项）。
AMA 规划、派发和终止策略未见改写，底层兼容能力保留。

评审汇总：Standards 0 项，无最严重项；Spec 0 项未解决，无最严重未解决项。

## 后续阶段：通用主动视觉

用户已指定在本 KodaX-next-dev 工作树上，将通用视觉改造安排在首轮优化收口之后。
完整设计与推进顺序见 [首轮优化后的通用主动视觉能力](visual-harness-after-first-turn.md)。
先冻结当前获保留的优化基线，再分别实现观察接纳/恢复、局部与跨时刻检查、像素采样和动态反馈；
工具表示服从本阶段获采纳的统一曝光策略，首轮增量相对优化后的同一 fixture 单独计量。

本节只连接后续设计，不改写本轮范围、验证结果、失败记录或费用，也不重新启用已撤回的
schema 隐藏/派发说明候选。视觉生产代码尚未实施，后续实验另记 revision 与预算。
