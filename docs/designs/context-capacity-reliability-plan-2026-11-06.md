# 小上下文与超大文档：可靠性优化方案

**状态：用户已确认并分阶段实施。** 日期：2026-11-06。下文保留实施约束，实际完成项和验证范围见 §11；真实模型语义 pilot 尚未执行，不作为已验证效果。

目标：模型窗口小于 100K 时，按任务需要逐段读取远大于窗口的文档，保留可追溯原文、关键约束和执行进度；遇到可恢复超限自动缩减后继续，遇到不可恢复条件保存进度并说明需要什么变化。不能通过静默丢弃证据或反复发送同一个超限请求实现“看起来一直运行”。

基线：KodaX `587f9a9ba23fb517db37fc990a6fd72ac5188199`；Space `527df095bcf6d7993781218f4652b9560cfca6ab`；Extensions `32d410d75ef6d01c384c594f8ebb6e80739d2c19`。本轮未核实用户安装扩展版本，未重放原会话。

## 1. 独立回迁，不整体合并 next-dev

来源提交：`2cd1b7420bca10f3595db24b1fb2f7b150bbf9a9`。原始需求：

> Preserve completed summary markup and plain-text literal tags while rejecting unfinished leading scratchpads. Keep persisted evidence unchanged when no valid summary exists, with no new retry or memory layer.

仅移植以下三文件对应的增量：

- `packages/agent/src/session-lineage/compaction/summary-generator.ts`
- `packages/agent/src/session-lineage/compaction/summary-generator.test.ts`
- `packages/repl/src/session/compact-session.parity.test.ts`

实现补丁与原提交的 stable patch-id 同为 `28ea5a068f85d8511a97261d6cb29158d891567d`。当前主线新增的 credential/provider projection 逻辑保持原样；不以旧分支整文件覆盖当前文件。原提交另外三个文件是视觉实验说明和成本记录，其中修改的历史 validation 文件主线不存在，不作为修复依赖引入。

验证：先只移入原回归测试，5 失败/15 通过；再移入 parser 改动，4 文件/64 测试通过。`npm run typecheck`（源码及测试）和 `git diff --check` 通过。新增持久化回归验证摘要无效时 messages、lineage 均不变。

```powershell
node node_modules/vitest/vitest.mjs run packages/agent/src/session-lineage/compaction/summary-generator.test.ts packages/agent/src/session-lineage/compaction/compaction.test.ts packages/repl/src/session/compact-session.parity.test.ts packages/repl/src/session/compact-session.test.ts --maxWorkers=2 --reporter=dot
npm run typecheck
```

该最小修复已独立提交；未做 next-dev branch merge 或发布。回迁提交记录 `Backport-from: 2cd1b7420bca10f3595db24b1fb2f7b150bbf9a9`，明确是 selected-file backport，不伪称原 commit 的完整 cherry-pick。

### 为什么不顺便合并整个 next-dev

以基线为固定点，`HEAD...KodaX-next-dev` 两边分别有 14/62 个独有提交；next-dev 侧改变 315 文件，39,827 新增/673 删除，涉及 visual 能力、提示词/工具契约、权限、代理网络、Agent home 和文档子模块，不是一个 compaction 补丁。

不改动工作区的 `git merge-tree --write-tree --name-only --no-messages HEAD KodaX-next-dev` 预演返回冲突，路径为：

1. `docs/FEATURE_LIST.md`
2. `docs/features`（gitlink）
3. `packages/coding/src/agent-runtime/script/pilot.ts`
4. `packages/coding/src/agent-runtime/tool-dispatch.ts`
5. `packages/coding/src/prompts/static-text.json`
6. `packages/coding/src/tools/web-fetch.test.ts`
7. `src/sdk-runtime.ts`
8. `tests/restructured-contract.test.ts`

这不表示 next-dev 所有功能都有问题，只表示其整合必须另行审查来源需求、主线新修复保留、冲突语义与完整验证。当前 parser 修复不依赖它们。今后优先按独立修复/功能切片回迁；整体合并是单独的集成任务。

## 2. 已验证缺口与修改边界

| 缺口 | 固定基线的验证事实 | 最小修改区域 |
| --- | --- | --- |
| 未结束 scratchpad 被接收 | 真实 compact 返回 compacted:true；原回迁测试验证错误替换 | §1 已回迁；不要扩展此补丁的行为范围 |
| 显式截断摘要被接收 | max_tokens 结束的未完成 summary 被当成功文本 | summary-generator 及 checkpoint admission |
| 最终 reduce 再次超限 | 16,384 窗口，前 11 次 map 合法，第 12 次输入 23,241 + 输出预留 3,000，失败 | summarizeCompletePrefix、摘要请求预算与 stream options |
| 超限错误误分类 | Gemini/本地 context-size 文本成 ProviderError，Kimi model-token-limit 文本成 RateLimitError；控制组成 ContextOverflowError | Provider base 分类及 overflow facts |
| 长行内存/取消未受分页约束 | 96MiB 堆隔离进程读 8MiB 单行 limit=1 OOM；取消信号未终止 read | 普通文本读取 scanner |
| PDF 传输先失败 | 真实扩展 exec helper 输出 1,100,000 字符，exitCode=1、仅捕获 1,048,576 字符 | read_pdf 协议与 extension 执行结果传输 |

上述均为离线机制验证。Provider 文本样本来自 Pi 支持的方言，未向当前线上端点制造超限；96MiB 是压力条件，不是默认 Host 内存；PDF 只复现传输 seam，未执行真实 OCR。源码入口：[分类](../../packages/llm/src/providers/base.ts)、[摘要](../../packages/agent/src/session-lineage/compaction/summary-generator.ts)、[归并](../../packages/agent/src/session-lineage/compaction/compaction.ts)、[读取](../../packages/coding/src/tools/read.ts)、[扩展 helper](../../packages/coding/src/extensions/helpers.ts)。

此前基线的现有相关套件 11 文件/191 项通过，新增诊断 7 项中 1 控制通过、6 安全断言失败，说明已有通过项没有覆盖所有边界。本轮 §1 修复后的 64 项是单独的回迁验证，不能据此宣告其他缺口已修复。

## 3. 总体选择：强化现有链路，不新增并行框架

保留 canonical 历史、工具收据、artifact 原文、Unicode line_offset、主循环压缩 hook、受限 generation retry 和 recovering 状态。修改现有单点，让每一层遵守自己的边界。

```mermaid
flowchart LR
  A[有界提取和分页] --> B[现有批次接纳与原文保存]
  B --> C[真实请求预算]
  C --> D[完整摘要及有界归并]
  D --> E[请求投影与原文分页]
  E --> F[Provider]
  F -->|确认超限且实际减小| C
  F -->|已无合法缩减| G[保存并明确等待]
```

必须区分三件事：原文可找回、某段已交付模型、模型已正确理解。工具读取成功不能证明后两者。研究性追踪不应该直接变成新的全局 memory/coverage 服务。

## 4. 摘要：完整性和物理容量一起收口

### 4.1 单独补摘要终态校验

§1 只回迁原 parser 语义。另一个小补丁应拒绝显式 max_tokens/length 截断的 checkpoint，即使看见闭合 summary 标签，也不把标签当成语义覆盖证明。正常无终态的兼容 Provider、正常 stop、纯文本摘要和正文中的字面标签保持各自已有契约。

失败时不替换原历史，不增设无限摘要续写循环；继续调用既有容量恢复逻辑。默认恢复是可读原文分页/输出预留回收，不应假设已禁用的旧破坏性 pruning 一定会救场。

必须成对验证：截断摘要不会替换原证据；同一可恢复负载仍可经 history-capacity-recovery 继续且不重放工具。缺少授权 read、固定输入已不可表示时，保存并等待/返回 typed failure，不能写入假成功摘要。

### 4.2 摘要计划中的预算必须等于 wire 上的预算

当前摘要规划接收 reservedResponseTokens，但 `streamSummary` 未传显式 maxOutputTokensOverride，不能假设规划值总等于 Provider 默认值。给每一次实际摘要请求派生并传递相同输出上限，受模型能力、reasoning 最低要求及现有预算约束；不新增用户配置项，也不复用过大的主回答上限来挤占小窗口。

预算检查应使用实际构造的 system/user prompt、工具定义/ephemeral suffix（若走 cached prefix）、之前摘要、输出预留与安全边际。缓存复用只是优化；完整缓存前缀放不下时，回到原有无工具分块路径。

### 4.3 在现有 map 数组上做有界分组归并

选择分组归并，而非无界递归、不断滚动改写单一摘要或增加一套外部索引系统：

1. 将需要纳入摘要的旧 checkpoint 与新 eligible prefix 都列入有预算的源输入；不能在最后一步突然附加此前未计算的旧摘要。
2. 每个 map 请求及输出都受预算约束。过大不可分割单元先走现有可读原文恢复；不能无声跳过正文。
3. 只有完整且有效的结果才成为一个 summary unit。记录来源范围，使归并始终对应同一批 canonical 输入。
4. 在发任何 reduce 前，用同一 prompt builder 计算完整请求；只合并能装下的组。每个 reducer 至少消费两个单位，最后一个孤立单位直接带到下一层。
5. 每次合并必须有实际缩减，单位数量逐层下降。总调用由初始分片数和有限合并次数决定，并受已有 Goal/取消/超时约束；不循环尝试单个单位自我压缩。
6. 若最小一组也装不下、输出不缩减或固定开销已过大，进入既有容量恢复，不重试同一个不变请求。输出 cap 只是规划保障，Provider 拒绝仍需按真实事实处理。
7. 全部成功后一次提交最终 checkpoint；局部成功不能把后续尚未摘要的历史删掉。不新增跨重启的中间摘要缓存，避免新持久化状态机。

倾向分组归并的原因：滚动 reducer 会让最早信息反复经历摘要、增加漂移；有界组每层可证明少一个以上单位，能在当前函数内实现。输出 cap、缩减检查与不可行退出缺一不可；不要仅增加递归层数。

### 4.4 Exact query ledger 保留原有权威

最终 checkpoint 合并精确用户 ledger 一次。暂不为节省 tokens 简单从摘要输入删除旧 ledger：其中可能有语义摘要遗漏或扭曲的纠正。若将 semantic summary 与 ledger 拆开规划，两者仍需有明确的输入来源/约束投影，不能在最终 reducer 中隐藏添加未计费内容。

只有通过“早期要求被后来纠正”的受控语义验证后，才考虑删去重复 rendered ledger 的成本优化；不会把这项优化和容量修复捆成一个补丁。

## 5. 普通文件读取：先修资源边界，再优化页预算

### 5.1 必做的有界 scanner

- 原始字节块扫描 + 增量 UTF-8 解码，避免 readline 和 Array.from 持有整条巨行。只保留当前页所需的字符。
- 入口、读取流和循环都响应 abort；正常关闭句柄。读取时固定已打开普通文件的大小，避免追着不断追加的日志跑；对变化给出诚实结果。
- 保留 offset/limit、Unicode line_offset、CRLF 和结构化 next 语义，不把超长行尾部直接丢掉。
- 当前页完成后尽早停止。为了显示精确“总字符数/总行数”而扫完整巨行/整本文件不值得；未知时不编造总数，给出确切下一位置。先检查这些展示字段的现有契约，再做兼容调整。
- 初版不建全局 cursor/index/cache 管理器。按行号重新定位仍可能有重复扫描成本，需明确这只是内存/取消修复，不能声称已经获得全文遍历的最优 I/O；有实测瓶颈再考虑已有文件 revision 下的索引复用。

回归：小文件逐字兼容、跨块 Unicode/CRLF、巨型单行的低堆子进程、已取消/读中取消、行内连续页无跳过无重复、读取中追加/替换。

### 5.2 预算感知分页是下一小片，不与 scanner 绑死

复用执行上下文已有预算，不按模型名字或固定 50KiB 判断能否装下。可用输入空间由现有 calculateMaxContextInputTokens 减去当前不可变请求开销、已保留历史及续读提示得到；未知预算维持当前有界页，不猜测无限空间。

`toolResultCapacityTokens` / `resolveToolResultCapacityTokens` 是**批次级容量**。并行 N 个 read 不能各自认为自己拥有整个预算。最小方案是读工具使用建议性上限，最终由现有 batch guardrail 统一接纳；若要更精确分配，放在知道整批调用的 dispatcher，不在工具内部新建共享预算调度器。

预算裁剪后，去重 cache 也必须反映实际交付范围：不能只因同一个 path/offset/limit 已经执行，就返回“先前正文仍在”的 stub。优先对预算裁剪结果不登记完整范围，或复用有效范围字段；用预算变化后的重读回归证明修复。模型真正收到的页还须经 batch guardrail，不能提前把工具产生的页标为已交付覆盖。

若现有固定 envelope 加最小有效页已放不下，应先缩减历史/按需暴露 schema；仍不行则明确等待调整，不能不断产出只有分页提示没有正文的空进度。

## 6. Provider 分类与 Space 恢复体验

容量分类使用结构化错误 code 与明确描述，统一映射到现有 KodaXContextOverflowError；精确 tokens、下界和 unknown 分开。容量错误优先于宽泛的 limit/too many 字串匹配，但不改变真实 429/TPM/余额不足语义。

每一个方言正例都配真正限流、余额、输出参数错误等负例；验证真实 Provider wrapper → Run recovery 入口，不能只测 regex 返回 true。重试必须有实际请求减小；沿用现有最多四次容量恢复边界和已完成工具不重放契约，不另增一般 retry 层。

Space 要区分“正在缩减”与“已保存、等待用户调整”。即使上游不提供可靠 token 数，也应显示等待原因和可用操作，不把未知数值伪造成准确计数。用 Host/Space 现有 settings、input、Stop 路径验证唤醒、取消、重启恢复，不增加新的用户恢复协议。

## 7. PDF：入口和传输必须先有界

单独的跨仓切片修改 read_pdf：默认按页/提取文本量限制，返回 total/实际范围/可继续位置；单页过大的文本也要有读取路径。完整提取物若落盘，必须位于 SDK/扩展合法的运行目录并通过既有读权限，不以任意路径字符串冒充可读 artifact。

避免通过 stdout 搬运整本 JSON；采用有界响应或受授权的文件结果引用。错误详情同样有界。提高 maxBuffer 只能作为明确受限传输的实现细节，不能作为大 PDF 方案。

页码区间先与实际页数相交再枚举；OCR 图像和单页提取资源也有内部边界。PDF/OCR 是独立验收，不用普通 read 测试通过代替。若原文可按页重新提取，优先复用它，不为了“有 artifact”建立重复存储系统。

## 8. 实施切片、依赖与验收

| 切片 | 内容 | 依赖/验收门 |
| --- | --- | --- |
| S0，已提交 | 原样回迁 unfinished-scratchpad parser 和原测试 | RED→GREEN、64 项、typecheck、独立双轴评审 |
| S1 | 容量错误分类 | 独立小补丁；多方言正负例、真正进入恢复分支 |
| S2 | 摘要完成性检查 | S0；拒收截断 + 原历史不变 + 可恢复负载继续、不重放 |
| S3 | 摘要 wire 预算、有界归并 | S2；16K 归并失败 fixture 转绿；所有物理摘要请求有界 |
| S4 | 有界 scanner 和取消 | 可与 S1–S3 独立开发；内存压力、Unicode 连续页、取消/文件变化 |
| S5 | 建议性自适应页预算及缓存范围 | S4；N 路并行 batch 接纳、缓存重读、无零正文空转 |
| S6 | PDF 分页/传输 | 跨 Extensions/SDK 独立验收；越过 1MiB 不破坏协议，错误详情有界 |
| S7 | Space 操作及模型阅读效果 | S1–S6 按产品承诺范围完成后；离线与真实模型结果分别报告 |

每片先把对应失败写进现有公共测试边界，红→绿，独立审阅；避免把不同原因混成一个大提交。当前不整体合并 next-dev，不顺带重写提示词、加入新全局记忆层或后台投机摘要。

### 离线边界矩阵

8K、16K、32K、64K、96K 模拟窗口；中文/英文/混合 Unicode、长单行、多文件并行、重复分页、恢复/切模型、摘要失败、I/O 故障与 Stop。每次请求包含 system/schema/正文/提示/输出/安全边际，完整原文可找回，已执行工具不重放。

8K/16K 是必须检查的压力边界，**不据此承诺任意 Agent 的全量固定 system/schema 都能在其中运行**。固定请求本身装不下时应给出明确不满足条件，而不是虚假“支持”。真实产品最低窗口应由实际固定 envelope 与最小有效工作量确定，不以模型名称硬编码。

### 真实模型效果验证

只靠单元测试不能证明大文档理解。按 `benchmark/EVAL_GUIDELINES.md`，先选用户实际使用的 1–2 个小窗口模型；固定文档及三轮阅读/两次压缩调用图，前中后布置可引用事实、跨章节例外、后续纠正和未读部分。每次 Provider 请求都计入预算，包括 summary。

pilot 前注册 calls/rounds/output tokens/total tokens/费用/超时上限；此处仅登记方法，尚未执行真实模型实验，也不预先编造通过率。盲化比较修复前后证据，用主会话判断关键事实、约束、出处、未读边界与重复执行。既看容量持续性，也看任务价值；失败要区分工程故障、模型遗漏和实验设计失真。

## 9. 独立回迁评审

### Standards

未发现需要修改的规范违反或可行动的坏味道。

检查范围为 `587f9a9ba` 之后的指定 3 文件 diff。生产变更集中在原私有清理函数，无新增配置、抽象或跨层依赖；参数化测试与真实存储回归各自验证不同边界，重复的调用准备不足以支持额外抽象。临时目录清理先验证路径，无新增错误吞没。

已核对 AGENTS.md 与 12 项坏味道基线；git diff --check 通过。RED→GREEN 证据采用主会话报告，本轴未重复运行测试。

**Standards：0 项发现，无严重级别。**

### Spec

发现 **0 项**（P0/P1/P2/P3 均为 0）。

已对照原提交 `2cd1b7420`：指定三个文件的补丁与原提交对应改动一致，仅解析器位置偏移。

- 缺失／部分实现：无。覆盖未闭合前导 scratchpad 拒绝、完整 summary 内字面标签保留、无包装正文中的未闭合字面标签保留。
- 范围蔓延：无。仅解析器及回归测试；未引入重试、记忆层或独立优化计划。
- 实现错误：本次回移范围内未发现。持久化回归断言失败时消息与 lineage 不变，且仅调用一次 provider。

结论限定为忠实回移，不将解析修复解释为摘要语义质量保证。

**Spec：0 项发现，无严重级别。**

## 10. 参考选择与未验证范围

方案讨论分别从 backport 依赖、摘要/PDF 设计、读取/模型效果反证三个角度独立提出，再互相质疑预算公平、旧 ledger、无缩减循环、已读语义等边界。

参考源码固定为 DeepSeek Harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`、Codex `2c502d8b3d382dd609179164f31396d95deee55c`、Pi `63bc4da65adc2b45b1674d85a303d5eaefe3ae07`。借鉴有界 scanner、完整摘要拒收、模型降档预检、多方言正负例；不照搬丢最旧历史、只取工具输出前 2,000 字符或固定 65,536 headroom。

未来可选项：只有实测显示有价值才考虑大窗口切小窗口时使用旧模型先摘要；必须尊重当前选择和已撤销权限。后台投机压缩、跨重启中间摘要缓存、通用文档记忆数据库不属于此次方案。

未验证：真实小模型语义效果、默认 Host 的极限文件大小、用户安装的 PDF/OCR、其他格式文档，以及 next-dev 全部分支的发布适用性。已执行的工程验证范围见 §11。

## 11. 实施记录

用户在本轮明确授权按阶段实现和提交。已提交的生产切片：

| 切片 | 提交 | 实际验证 |
| --- | --- | --- |
| S0 parser | `37baedc7c` | 原回归 RED5，GREEN64；独立双轴评审 |
| S1 错误分类 | `1eca089ba` | 6 方言 RED；59 Provider 用例通过，另联动 SA/AMA 容量套件；Kimi requested 不冒充精确输入 |
| S1 no-retry/typed identity 补修 | `14e1da985` | no-retry 容量错误不丢类型、不重发原请求；已分类容量对象保持身份和精确事实；65 Provider 用例及 typecheck 通过 |
| S2 截断摘要拒收 | `64b218be8` | 原历史不变；56 相关测试通过 |
| S3 摘要预算/归并 | `cc48eea79` | 265 项/15 文件通过；真实 wire 输出限额、完整 envelope、有限归并；无进展 typed failure 沿既有操作名进入恢复 |
| S4 读取资源边界 | `a856136fc` | 81 项/5 文件；8MiB 长行/96MiB 堆、Unicode、取消、文件变化 |
| S5 自适应分页 | `d723d8352` | 119 项/7 文件；精确续读、并行批次、预算裁剪不污染 cache |
| S5 预算一致性补修 | `7823443e0` | 53 项/3 文件；8K–96K 五档大输出预留导致零预算的 RED→GREEN，正常正预算不变 |
| S7 离线联动 | `dcda31e11` | 真实 Runner/LLM adapter/read/batch/managed compact，10 场景通过；模型 stream 受控，无付费调用 |

各组测试有交集，不能相加当作独立覆盖率。多次源码/测试 typecheck、diff check 通过；全量测试、完整 build 的最终结果另行补录。

跨仓对应提交：

- Extensions `0e18e07`：默认 4 页/16,000 Unicode 字符、页内续读、原 pages/engine/force_ocr 继承指导、错误传输有界、25MP OCR 预检。51 TS + 7 Python 测试、typecheck/build、五目标 packaging 检查通过；实际 20 页 PDF 经过 KodaX exec helper 返回 4 页/12,833 bytes、next_page=5。PDF 底层单页提取仍由 PyMuPDF/OCR 实现，不宣称 parser 峰值内存已完全有界。旧二进制/remote sidecar 需一起更新。
- Space `6cc7db4c`：SDK 有 saved recovery 但无可信 token 数值时，给出本地化保存/恢复说明；43 个 activity 测试通过。只提交本轮 3 个文件的改动，保留其他用户工作；未把当前安装包标为已更新。

Spec/Standards 审查覆盖 parser、分类、摘要、read/budget、PDF 和 Space 对应切片。PDF 审查的 whitespace、force_ocr、超长失败 JSON/TS throw 信息已补回归并修复。S7 初版直接 mock Runner LLM 造成 stale snapshot 的假失败，改为真实 adapter 后验证；不把该 harness 修正冒充生产缺陷。

真实模型 pilot 的 40 请求/US$5 上限及冻结协议见 [ISSUE_322_v0.7.97_REGRESSION_GUIDE.md](../test-guides/ISSUE_322_v0.7.97_REGRESSION_GUIDE.md)，状态未执行。next-dev 完整评估见 [next-dev-integration-assessment-2026-11-06.md](next-dev-integration-assessment-2026-11-06.md)。没有执行 next-dev 整体合并或发布。

定向覆盖率：7 文件/172 项通过，测量 `context-overflow.ts`、`read-text-page.ts`、`tool-result-budget.ts`、`summary-generator.ts` 四模块，statements 94.57%、branches 92.27%、functions 91.30%、lines 97.03%。这是指定模块覆盖率，不是全仓覆盖率；报告位于 OS 临时目录 `kodax-context-implementation-20261106/coverage`。
