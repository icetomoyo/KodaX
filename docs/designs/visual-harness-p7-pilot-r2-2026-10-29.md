# Visual harness P7：Kimi pilot r2 执行阻塞记录

2026-10-29，Asia/Shanghai。工程候选冻结为 `3b2d48e8ffeebdd0f14cd81c5c04b65736884938`，基线为 `30310e0018b3c0803653a278f451751a00ccc3bc`。基线已含 P0–P2，本次只比较后续增量，不能评价整套视觉改造。旧 [离线草案](visual-harness-p7-pilot-2026-10-29.md) 与原 raw 保留。

**结果：首个 provider 请求因账户余额不足返回 HTTP 429；停止，无重试，其余三格未发出。没有 assistant 行为输出，P7 行为价值仍未验证。**

后续用户明确改用 `kimi-code / KIMI_CODE_API_KEY`，新的 [r3 四格 pilot](visual-harness-p7-pilot-r3-2026-10-29.md) 已完成。本稿是按量端点的历史失败，不代表订阅服务不可用；下文未执行/阻塞结论只属于 r2。

## 执行前冻结

用户明确回复“同意上述 Kimi 路由与预算”。选择 `kimi / kimi-k2.6`，端点 `https://api.moonshot.cn/v1/chat/completions`，凭据仅从已有 `KIMI_API_KEY` 读取，不落请求文件或日志。官方 [模型说明](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)、[视觉协议](https://platform.kimi.com/docs/guide/use-kimi-vision-model)、[Chat API](https://platform.kimi.com/docs/api/chat) 支持原生图片、工具及关闭思考；具体账户的模型/图片请求接受仍未验证。

Layer 1 只能证明回取、精度、时效和容量接线，不能证明模型是否选择相关证据或克制工具调用，因此采用 Layer 2 下一响应 pilot。每 arm 每 case 一次：

| case | 输入与独立真值 | 评审目标 |
| --- | --- | --- |
| exact-rgba | 同一 3×2 PNG；原 (1,1) RGBA 为 [0,255,255,128]；问 alpha 是否恰为 128 | 选择相关原像素证据，或可信地承认未核实；调用新工具本身不算成功 |
| irrelevant-image | 同图作为无关旧参考；问 17+25 | 答 42，避免无用视觉/历史/远端动作 |

两题均明确提示取证或图片无关，只能初筛实验，不能证明自主识别视觉需求。Layer 2 不执行返回的工具；取证后的答案改善、历史时刻选择与动态探索需要另建最多三轮固定反馈场景。

| 限制 | 已授权且执行的边界 |
| --- | --- |
| 总请求 / 每格 / 轮数 | 最多 4 / 1 / 1；顺序串行 |
| 输出 / 总 token | `max_tokens=512` / 100,000；每次按实际 usage 核算 |
| 费用 / timeout | USD 1 停止上限 / 60 秒每请求 |
| 重试 / fallback / repair / 外部 judge | 全为 0 |
| 停止条件 | HTTP/协议失败、timeout、未知 usage、输出 cap 不受支持或达到 token/费用上限；保留已完成 raw |

两 arm 均以 `thinking.type=disabled`、`stream=false` 请求，删除原 OpenAI 草稿的 `max_completion_tokens` 和 `stream_options`，替换为该路由文档的 `max_tokens=512`。这是共同冻结的传输/推理设置，不是生产 Runtime 在线端到端验证。

2026-10-29 核对官方 [定价页面](https://platform.kimi.com/docs/pricing/chat) 的源数据：K2.6 每百万输入 ¥6.50、缓存命中 ¥1.10、输出 ¥27.00。价格页 Markdown 表格未完整展开，原 HTML 中对应行与模型/API 原文一并保存在 OS Temp 并记录 hash。按人民币核算，并保守地将 ¥1 计入 USD 1 预算额度，**不是市场汇率换算，也不是实际美元账单**。四格完整模型字段合计约 61,549 个启发式 token，最多 2,048 输出 token；若以相同输入数作费用情景、全未命中缓存，约 ¥0.456（非 API token 预估保证，图片计费另依实际 usage）。$1 是上限。

## 输入来源与字节证据

新目录：OS Temp `kodax-eval-dumps/visual-harness/pilot-r2-iKIsvM`。`preregistration.json` SHA-256 为 `12b8ef0b5ea35ae58a3bde896e06ce9227b709921ab39fbe01563d9b07fa3863`。旧 `IUrBpR`、`U9dLg2` 等草案不覆盖。

基线沿用已核对 30310e00 合同的 `kodax-first-turn-wire-mwTGST`；候选沿用补修时新捕获的 `kodax-first-turn-wire-B4xY9i`。后者 inventory 的历史标签仍为 6778640e，本次重新核对其 15 个生产合同源与 3b2d48e8 工作树 hash 全相等；未把旧标签改写为新抓包。候选修复没有改变本 pilot 的生产工具合同。

读取两份 `openai-ama-runtime-host/request.json` 的原始 tools，保留描述/schema 及 JSON 键顺序；只使用同目录已保存的 normalized messages 消除 fixture 根目录、session ID、快照时间差异。再将 system 的 `Provider: wire-openai / Model: fixture-model` 头替换为实际 Kimi/K2.6。两 arm 文本前缀 hash 相同。来源 raw、normalized、准备文件及工具 hash 均保留，不能将准备文件称为未经转换的在线生产请求。受控空 workspace 前缀也不能代表真实任务复杂度。

每格初始 **1 张相同 PNG**；共仅提交首格的 1 张，模型是否实际接受未知。PNG SHA 为 `4317923a6616a3ad3dbac5d706f443c3a3e6b1304cf502fdcfdbb3853a8b49dc`。基线 56 项工具 SHA 为 `b7a810620089e57dad4a0383f562adc882708e915d24686179e20f1914fbdfdc`；候选 57 项为 `5d7ff3c800f949a020524c24e84264b0cbd8d1e18be9f3986c6a4f7156b822ee`。增加工具不等于行为成功。

| case/arm | 冻结 request SHA-256 | 完整字段启发式 token |
| --- | --- | ---: |
| exact-rgba/baseline | 3754598d637aa462354f365aa28e18ff8dda14c8b895fa78300bf2fec7b51fb6 | 15,223 |
| exact-rgba/candidate | 773a6f73de3d2cc9de31309f015940d80369bb6fa0f40009afed29161b1cc6e8 | 15,589 |
| irrelevant-image/baseline | 5176311b0a3a766c873b6a37ddec7d1acf912c072b996e6c90caf44cce0ef98b | 15,186 |
| irrelevant-image/candidate | 340210bce7833bf6cd4fecfdc29ae66a584c79ba92fa5e3c2d7d8fb85af900b8 | 15,551 |

完整字段包含 messages 和 tools；这些估算包含 base64 文本，不能代替图片 tokenizer/API usage，也不能同默认无图成本表混算。相对基线两题分别 +366/+365 个估算 token，整体任务净增量未知；原默认累计 +726～748 的证据仍独立保留。

## 实际执行、失败和主会话评审

首格为 exact-rgba/baseline，HTTP 429，`exceeded_current_quota_error`，原因是账户余额不足；176 ms，原响应 SHA `98b98affbfb4d237633295e29459a64c929c6b7e355c387588b9d4fecdb43323`。不是可擅自重试的瞬时限流，也不是模型回答错误。请求已计入 provider 调用数 **1/4**，其余 **3/4 未发出**，完成行为样本 **0**。没有额外 smoke、fallback 或 judge 请求。

未返回 usage，实际输入/输出/总 token、缓存命中、人民币费用及美元账单均为 **unknown/null**，不是 0。请求前冻结的统计规则为失败即停止。最初 runner 的 `results.json` 在 `usageComplete=false` 下仍输出零运行小计，该历史文件原样保留；随后以 RED→GREEN 将不完整 usage 的实际总量改为 null，已知小计单列。未为修正报告重新调用模型。`analysis.json` 明确解释旧零小计不能当作实际零消耗，其 SHA 为 `3a5a0621ff17ad127a87fea766f244db6fa34177925440445f5cfea976150964`。

没有 assistant 输出和配对样本，不能开展模型优劣盲评。主会话只完成执行有效性分析，并落盘 `main-session-review.json`（SHA `c6f9116e79caaaa37148cad0ab8eb749a60f6e52f38657860f1d0261405bd485`），没有伪造首选 arm 或行为通过比例。cause 归为 provider-noise 下的账户可用性阻塞，不能据此判断 case 设计无效或 candidate 回退。

建议 **recommend-iterate（恢复可用路由后验证，当前没有采用价值结论）**。继续需已充值的 Kimi 账户，或用户指定替代路由，并重新冻结 revision/调用预算；不能静默重启已消耗一格的计划，也不能把失败请求复用为 baseline 行为样本。

## 工程验证与支持边界

新增 [pilot-runner.ts](../../benchmark/visual-harness/pilot-runner.ts) 只执行这四格；先校验全部请求 hash、实际模型/输出 cap，再以独占 started 标记防止重复付费。原始响应逐块写入 OS Temp，真实路径校验拒绝工作树；没有生成自由循环或新产品模式。

预先约定的冻结输入与有界执行 seam 上，先运行缺失 API 的 RED，再 GREEN；追加路由头、缺失 usage、被改大输出 cap、工作树落盘及未知实际成本的 RED→GREEN。公共入口以真实本地 HTTP 覆盖四格串行、费用核算、工具调用只记录、HTTP 429、token/output 上限、缓存/usage 异常、超时 partial、请求篡改、零授权和禁止重复执行。两文件 **17 项通过**（新增 runner 13 项，原 freezer 4 项），无在线调用隐藏在单测中。

本片 runner 覆盖语句 **98.16%**、分支 **96.34%**、函数/行 **100%**；连同旧 freezer 两模块语句 93.71%、分支 90.75%、函数 90.9%、行 96%，不是全仓 coverage。raw 为 OS Temp `kodax-visual-p7-runner-final-coverage-20261029`。`npm run typecheck`、`npm run build` 通过，CLI 仍为 5,151 KiB，14 SDK 声明检查通过；仓库没有 lint 脚本，未声称执行。

局部细节、图像记忆、动态探索、克制使用的后续受控反馈批次均未执行。steer crash replay、子 Actor 媒体 owner、更多宿主仍未验证；未扩展 ARC 或完整桌面。支持矩阵没有新增成功在线视觉路由。

### Standards

独立评审最初指出 OS Temp 目录边界缺少约束、价格重复维护，均已最小修复并复核关闭；剩余成文违反 0，smell 判断 0。

### Spec

独立只读评审：0 项可行动发现。没有将账户阻塞、未知 usage、未执行格或后续行为场景记为通过。
