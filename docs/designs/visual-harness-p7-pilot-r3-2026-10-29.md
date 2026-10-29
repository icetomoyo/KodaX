# Visual harness P7 r3：Kimi Code 四次 pilot 与成本

2026-10-29，Asia/Shanghai。候选 `3b2d48e8ffeebdd0f14cd81c5c04b65736884938`，基线 `30310e0018b3c0803653a278f451751a00ccc3bc`。**最小 pilot 四格完成：候选选择了更直接的原始数值像素证据；无关图片题两边都没有多余调用。只形成下一步证据选择的有限信号，尚未证明最终答案改善、自主识别视觉需求或整体智能提升。**

## 路由与冻结

用户先批准新的四次预算，随后明确可用 `kimi-code` 或 Ark Coding，并指出 `KIMI_CODE_API_KEY`。本 revision 使用 **`kimi-code / kimi-for-coding`**，凭据仅在内存读取。前一次 `KIMI_API_KEY` 的按量端点余额不足不能说明订阅端点不可用；[r2 原失败](visual-harness-p7-pilot-r2-2026-10-29.md) 保留，未复用为 baseline 样本。

实际端点 `https://api.kimi.com/coding/v1/chat/completions`，真实客户端标识 `KodaX`。官方 [接口与模型配置](https://www.kimi.com/code/docs/kimi-code/models.html) 及只读 `/models` 响应确认该 alias 当前为 **K2.8 Preview**、支持原生图片。返回四格的 model 均为 `kimi-for-coding`；这是服务声明的 alias/版本，不是独立核验模型权重。旧本地注册表将该 alias 标为 K2.7，不能据此误标本次实际模型。

两 arm 均 `thinking.type=disabled`、`stream=false`、`max_tokens=512`。官方文档说明关闭 thinking 路由至 K2.8 Preview 无思考版本；只读模型元数据同时标有 reasoning-only，二者来源均保存，实际请求成功接受该设置。没有偷偷切换模型/路由。KodaX 注册的 kimi-code provider 通常使用 Anthropic Messages；本受控 probe 使用官方 Chat 兼容接口以保留既有生产 OpenAI tools 字节，**不代表 Runtime 的 kimi-code Messages 传输已做在线端到端验证**。

冻结目录为 OS Temp `kodax-eval-dumps/visual-harness/pilot-r3-9w0qA1`。预注册 SHA-256 `d16da10544258b94c5994cf8ea3601f4ce99c3ea68cc27b2a6c38a8e4845161c`。初步冻结 `pilot-r3-yqGvGc` 在预算预检修补前生成但没有执行，保留不覆盖。来源 raw、共同文本前缀的路径/时间规范化、生产 tools 与 PNG 来源沿 [r2 字节证据](visual-harness-p7-pilot-r2-2026-10-29.md#输入来源与字节证据)，没有重做 P0–P2。

| 项目 | 冻结/实际边界 |
| --- | --- |
| 层级与样本 | Layer 2；2 case × 2 arm × 1 次；每格一轮，不执行模型工具 |
| generation | 最多/实际 **4/4**；无重试、fallback、repair、外部 judge |
| token | 总上限 100,000；输出上限每格 512；实际总计 **50,053**，无截断 |
| timeout / 并发 | 60 秒每请求 / 串行 |
| 费用停止 | USD 1；以可见加油包月支出增量 **100 个整数分**作更保守的人民币停止阈值；未知/回退停止 |
| 其他 HTTP | 只读 readiness 2 次（models/usages）；runner 额度读取 5 次（前置及每格后）；本 r3 共 **11 次 HTTP，其中仅 4 次模型生成** |
| 图像 | 每格初始 1 张相同 3×2 PNG，共提交 4 张；工具结果图片 0 |

图像 SHA `4317923a6616a3ad3dbac5d706f443c3a3e6b1304cf502fdcfdbb3853a8b49dc`，(1,1) 原 RGBA 独立真值 [0,255,255,128]。两 arm 的问题与初始证据相同；基线 56 项工具 SHA `b7a810620089e57dad4a0383f562adc882708e915d24686179e20f1914fbdfdc`，候选 57 项为 `5d7ff3c800f949a020524c24e84264b0cbd8d1e18be9f3986c6a4f7156b822ee`。在线成功说明协议接受了含图请求；不能单由这些题目证明模型实际利用了图片内容。

| case/arm | request SHA-256 |
| --- | --- |
| exact-rgba/baseline | 8b8953d281db67ee0c6184cb82210ee4552adbb8ee51017578d223e42da2643c |
| exact-rgba/candidate | 21e6ca685788708ebfe1782322f2f060386892d54ff2a363d58240fbbf4e5ff7 |
| irrelevant-image/baseline | 8be6fbce3973b62a6bbd546f21a3c56c3ee46ec3d7ee85e81a6753ee1546747a |
| irrelevant-image/candidate | d8b0cdcce9f8a857842823e8aef9c8d0bed2aebf9b194af3889333a727327237 |

## 先盲评，后揭盲与机械核对

主会话先读取随机 X/Y 的输出，保存 `main-session-review-before-reveal.json`（SHA `bade214642304a0444f5eab6c1ea6328f2ec7a61f34b3bcdaabad878891f4c9c`），再读取映射与成本。标签隐藏，但工具名本身可能暴露能力集合，盲化并不完全。

| case | 盲评与揭盲结果 | 限制 |
| --- | --- | --- |
| exact-rgba | 优先 Y（揭盲为 candidate），价值 minor；candidate 请求 `visual_read_pixels`，(1,1) 1×1、rows=columns=1。baseline 请求同一区域 `visual_inspect` | 原始数值采样更直接；裁剪仍是合理相关取证第一步，两边都未提前断言 alpha。工具未执行，不能说 candidate 已给出正确 RGBA 或改善最终答案 |
| irrelevant-image | X/Y 均只答 `42`、0 个工具；揭盲 X=candidate、Y=baseline，tie | 每 arm 仅 1/1，且题目明确说图片无关；不能证明无提示的自主克制 |

揭盲后逐一按各 arm 的冻结 schema 检查提案：工具存在，所用全部 schema 关键字对应的类型、必填字段、范围与额外属性均满足，观察 ID 和目标区域正确。没有执行工具或注入回执。最初尝试的本地 Ajv 不可用，未安装依赖或重跑生成；改为对这两份简单 schema 的完整已用关键字集合检查，未知关键字会报错，方法写入 raw analysis。

两题都明确提示所需证据或图片无关，controlled 空 workspace 也不是复杂真实任务。pilot 能筛查下一步选择和明显误用，不能据此宣称局部细节、历史时刻选择、动态探索、自主视觉需求识别已经通过。建议 **recommend-iterate**：保留当前工程候选，把这个有限选择信号用于设计下一小批，而不是扩大能力/宣传智能提升。

## 实际 usage 与完整成本边界

下表均为 provider 返回的实际 usage；耗时含本格落盘/额度读取。首格 cache 未单独报告，不能虚构数值。

| case/arm | input | output | total | cached input | 耗时 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| exact-rgba/baseline | 12,174 | 401 | 12,575 | 未报告 | 10,287 |
| exact-rgba/candidate | 12,501 | 366 | 12,867 | 7,168 | 10,024 |
| irrelevant-image/baseline | 12,131 | 11 | 12,142 | 11,776 | 1,771 |
| irrelevant-image/candidate | 12,458 | 11 | 12,469 | 12,288 | 1,738 |

两个采样任务中，candidate 首请求实际输入各 **+327 token**。合并两题的下一响应：baseline **24,717**，candidate **25,336**，净 **+619 token（+2.50%）**；其中输入 +654，输出 −35。正例总量 +292，算术题 +327。**这不是完整任务 token 增量，也不是相对 P0 前版本的实测。** 单个模型的 tokenizer/API 口径与原默认 +726～748 的启发式固定开销不同，不能混算；原数字继续保留为估算。

调用顺序固定为各 case 的 baseline→candidate，前缀缓存明显且不均衡；无重复采样、无后续工具结果/纠错轮次，因此不把耗时或输出减少解释成稳定性能收益，也不推断费用节省。

Kimi Code 是订阅服务，[会员权益](https://www.kimi.com/code/docs/kimi-code/membership.html) 的额度与加油包规则独立于按量 API。仓库 cost-rates 的 kimi-code 单价明确是名义占位值，本实验没有拿它算账。runner 五个新快照中可见 `monthlyUsed` 增量均为 **¥0**；这只是共享账户加油包计量的观察，可能存在延迟，不能归属订阅摊销，也不能证明实际费用为零。**实际归属订阅费用/美元账单仍为 null**。没有修改账户开关、月度限额、充值或启用新付费兜底。

`analysis.json` SHA `86b6b084a4aa864c962e0adee0bd8d00e972086f395d21b21bf098585818c315`，含逐格 usage、提案、响应 hash、揭盲映射、主会话建议和限制。r2 的一个失败请求另计，usage 未知；不能把 r2+r3 所有尝试的总消耗写成 50,053。

## 工程验证与待验范围

同一 [runner](../../benchmark/visual-harness/pilot-runner.ts) 增加显式订阅入口，未改产品默认 provider、prompt 或工具。TDD 保留旧 r2 的全部反例；订阅四格入口、cache-write usage、空/null 金额、10→10.50→10.20 回退、后续 meter 失败旧值失效、101→201 分精确阈值均实际执行 RED→GREEN；额度缺失的前置拒绝、达到支出上限也保留为反例回归。当前两文件 **26 项通过**；runner 覆盖语句 **97.38%**、分支 **95.62%**、函数/行 **100%**，非全仓覆盖率。类型检查/构建通过，CLI 仍为 5,151 KiB、14 SDK 声明通过；没有 lint 脚本。

r3 扩展前的本轮默认全仓日志 `kodax-visual-p7-r2-full-20261029.log`：**18,084 通过、1 失败、97 skipped、19 todo**，1,295 文件通过、1 失败、6 skipped，用时 1,089.88 秒，退出码 1。失败为 `src/one-shot-task.test.ts` 的并发设置用例清理临时 `.kodax/sessions` 时 `ENOTEMPTY`；单独该文件 **10 项通过**，没有生产修复，**原因仍未定位**，不据此宣称已解决或与本次无关。此前 Feature270/T30 的历史失败也不抹除。

该全仓中新的 `kodax-first-turn-wire-1P2yft` 32 格 normalized 完整输入与补修抓包逐格相同；比较 SHA `02976e2ac6cfd4a46b6d8fd3c32641c2840bb9599a6c088dcc9c67e168aac9c2`。说明评测 runner 未增加默认首轮字段，不代表含路径/ID 的原始 wire 相同或新增 API usage。

最终代码冻结后同一默认命令 `npm test -- --reporter=dot`：**18,094 通过、0 失败、97 skipped、19 todo**（18,210 项），**1,296 文件通过、6 skipped**（1,302 文件），用时 **1,128.24 秒**，退出码 0；日志 OS Temp `kodax-visual-p7-r3-full-20261029.log`。这不关闭前述 ENOTEMPTY、Feature270/T30 的未定位原因，也不代表默认排除的 provider integration 或后续行为场景通过。

最终全仓的新抓包 `kodax-first-turn-wire-bsOZr7` 再次产生 32 格相同 normalized 完整输入；比对记录 `kodax-visual-p7-r3-default-compare-20261029.json` SHA `de2fd739c49b66435a0dbce382e5b7164fad384e6b1d363784960658cc7589b4`，不改写旧 capture 标签。全仓运行期间未编辑源文件。

| 行为/支持 | 当前状态 |
| --- | --- |
| 官方 Kimi Code Chat 含图下一响应 | 仅本模型/这四格成功；不外推全部模型/宿主 |
| 原 alpha 数值取证选择 | 1 对显式提示样本，candidate 选择更直接；未验证取证后答案 |
| 明示无关图片克制 | 每 arm 1/1，无工具；未验证无提示普通任务 |
| 无提示局部细节、正确历史时刻、动态补观察/动作修正 | 未执行；需各自固定反馈、最多三轮及新预算 |
| Runtime kimi-code Messages、steer crash replay、子 Actor 媒体 owner、更多宿主 | 本片未验证；原支持矩阵限制保留 |
| ARC/完整桌面/游戏扩展 | 未扩展 |

### Standards

预检指出空/null 金额转零与浮点阈值漏停，均补失败回归后修复、独立复核关闭；剩余成文违反 0、smell 判断 0。

### Spec

预检指出快照回退、未知值保留旧快照和精确阈值问题，均 RED→GREEN 并复核关闭；剩余发现 0。该结论不把四次 pilot 等同于 P7 整体行为验收，也不关闭未定位的全仓失败。
