# v0.7.96 正式主线融合与 KodaX fast-forward

2026-10-07。用户要求先处理冲突、保持统一契约面，再将主 `KodaX` 分支 fast-forward 到当前开发分支。

## 固定点与范围

- 开发分支起点：`codex/product-client-refactor` / `f9b0fb586aa9bc8af8ffa67160d2c9ec952779b9`。
- 主分支起点：`KodaX` / `c2c8fdc41f4e0b50fa1c2d0b24142586f155777c`；共同祖先为 `cad8b658`。
- 主分支新增的唯一提交为 `chore: release v0.7.96`，主要为版本、正式发布记录和自知识说明；不引入新的运行架构。
- 设计子模块起点 `22f1c3561d24b225f057edebb25f6325e362b8e8`，正式主线设计 `65ddb8ddbcfcffa8207d8091114609e952c7f747`。
- 设计子模块双亲融合提交：`7be826f`，保留双方历史；v0.7.97 的已实施状态与未完成发布验收分别记录。

不采用 rebase / squash / 强推，不移动既有 `v0.7.96` 标签。用户暂不选择文本工具 OS 沙箱迁移，研究笔记作为未选方案资料保存。

## 冲突意图与融合结果

| 文件 | 当前开发分支意图 | 主分支意图 | 解决 |
| --- | --- | --- | --- |
| `docs/DD.md` | 产品以统一 Client 接入；旧 Runtime 发布段落不能复活已移除接口 | 更新正式发布基线 | 保留当前设计说明，将包基线更新为 `0.7.96`，明确 `v0.7.97` 尚未发布 |
| `docs/HLD.md` | 一个产品 Host、一个 Client 契约；历史 ADR 不改变当前 API | 标识 v0.7.96 正式版 | 同上，保留 Client contract / migration 入口，避免恢复已退役 capability |
| `docs/FEATURE_LIST.md` | FEATURE_298 已有核心与 T38–T56 实现；发布验收仍开放 | 正式版、FEATURE_299 和 Issue 326 的发布记录 | 更新正式发布/包版本与已发布功能基线，保留 FEATURE_298 InProgress 及实际实现状态、既有统计 |
| `public_docs/README.md` | 简明的统一产品 Client 与可信 Host 文档入口 | 正式发布版本标识，原有长篇 beta 历史说明 | 保留统一文档入口，更新稳定包基线；历史发布记录继续留在专门版本文档，不回接旧产品模式 |
| `public_docs/sdk/embedder-guide.md` | 当前 Product Client 是产品业务入口；低层机制与历史段落有明确边界 | v0.7.96 正式基线及同一 sandbox capability | 保留当前接入、迁移与退役 API 说明，更新包基线；当前 v0.7.97 设计 capability 不被历史 release 标签覆盖 |
| `docs/features` | 当前 v0.7.97 已完成的选定设计与实现 | v0.7.96 正式发布设计记录 | 在子模块真正合并双方提交；README 的旧 Planned 行按已有 v0.7.97 实现事实更新 |

自动融合保留主线正式 CHANGELOG、README 双语发布记录、PRD 基线、ADR 稳定版历史和 release checklist。生产代码相对开发起点只吸收 `kodax_manual` 的稳定版说明；对应已有断言同步，并按既有只读契约修正崩溃恢复夹具。native、Host/Client、Thinking token 估算与执行器逻辑未改。

三篇此前本地研究笔记一并保存，其中明确记录 2026-10-07 用户暂不迁移文本沙箱。它们不是已选迁移规格，也不构成合回主分支的阻塞项。

## 本轮验证

下列结果来自本轮融合候选；不会把此前的通过数字当成本轮结果。

| 检查 | 本轮结果 |
| --- | --- |
| Source / tests typecheck | PASS；`npm run typecheck` 退出码 0 |
| 受影响测试 | PASS；registry、tracker、release workflow、SDK independence、Host activity 与流式视图共 7 文件、69 项，退出码 0 |
| 快速测试层 | PASS；冻结产物、修正只读夹具后完整运行，218 文件通过、1 跳过；2,203 项通过、32 跳过，退出码 0 |
| 构建、声明与纯 Client 消费者 | PASS；`npm run build` 退出码 0，包含 native、14 个 SDK 声明入口及无 Node ambient 的纯 Client 编译 |
| 构建产物与代表性 Host/Client 验收 | PASS；九个 bundle 文件、39 项通过，退出码 0；覆盖 Provider、daemon、Memory、Full Access / Auto 文本授权与图像、文本恢复 |
| Standards / Spec 独立评审 | PASS；含夹具修正的固定 tree `b0c02b71d1e518d9a2a4ff3972cd2f0876f81037` 两轴均 0 finding |

首轮快速层为 217 文件通过、1 文件失败、1 文件跳过；2,201 项通过、2 项失败、32 项跳过，退出码 1。两项均在 `sdk-client.crash.test.ts` 被 `launcherBuild` 保护拒绝，而非崩溃恢复行为断言失败：测试期间运行了构建，当前进程保存的构建指纹与更新后的 compiled workspace / native 文件不再一致。`src/runtime-build-identity.ts` 明确将这些产物纳入 source launcher 指纹。构建结束后不改产品或测试，单 worker 崩溃恢复专项 3/3 通过、退出码 0。随后冻结产物重跑整个快速层；不以专项结果替代完整快速层结果。

第二轮冻结产物快速层为 2,202 项通过、1 项失败、32 项跳过，退出码 1；唯一失败是崩溃恢复的 Session 读取边界返回 `data_changed`。原第三场景窄循环连续三次通过，不能据此抹去完整测试失败。规格 `CLIENT_CONTRACT.md` 明确允许 `data_changed/resync_required`，首次观察建立失败仍 reject；Host ready 只代表连接就绪。源码的 store-lock 回收先检查 30 秒陈旧窗口，即使旧 owner 已死，刚创建的遗留锁仍可能暂时拒绝读取。原失败现场的锁内容未捕获，不声称已证明每次冲突均为同一 owner 或同一写入者。

夹具修正沿用已确认的公开 Client seam：重启后仅对上述两种错误有界重试 Run / Session 的只读调用，其它错误立即失败，不删除锁、不重交输入、不改生产重试或锁窗口，不延长原测试整体时限。崩溃点另外等待实际 Provider 请求体含 `tool-ran`，而非只依赖请求头计数；原 Run interrupted/unknown、工具只执行一次、Provider 不重跑与完整观察内容断言全部保留。诊断阶段标记已移除。完整快速层在此夹具修正后另行复验。

夹具修正后，整文件崩溃恢复专项 3/3 通过，测试类型检查再次通过。最终完整快速层为 `npm run test:fast -- --maxWorkers=2 --reporter=dot`，218 文件通过、1 跳过，2,203 项通过、32 跳过，414.86 秒、退出码 0。没有修改生产源码或重建产物后再复用旧测试进程。日志保留在本机临时目录的 `kodax-stable-merge-fast-corrected-2026-10-07.log`、`kodax-stable-merge-bundle-2026-10-07.log`、`kodax-stable-merge-focused-2026-10-07.log` 与崩溃专项日志中。

Spec 首次发现两处当前包基线仍为 rc.14（DD 正文与 SDK 迁移指南），已同步为 `0.7.96`；PRD 的 GitHub pre-release 表述同时改为正式 release。两轴对新增文档差异复核后均通过。`git diff --cached --check` 通过；仓库没有 format / lint 脚本，本轮不添加新检查配置。

## 合回主分支的顺序与边界

先保证设计子模块融合提交在 origin 可取得，再推父仓库开发分支；确认正式主分支仍为预期起点、主工作区及其子模块无本地修改，然后执行 `git merge --ff-only codex/product-client-refactor`，更新子模块并普通推送 `KodaX`。每个推送均使用既有 `GITHUB_TOKEN`，不输出令牌，不强推。

主工作区的 `scripts/kodax-bin.cjs` 读取 `dist/kodax_bootstrap.js`；快进后还需重建该工作区的 CLI / SDK 产物，使本机 `npm link` 入口跟随新源码。设计子模块 `7be826fcab188720745e9a5c9374ec5c78997b56` 已先行推送到 origin 的开发分支并核对远端 SHA。

这次属于代码主线融合，不是 v0.7.97 发布。正式发布、人工终端手感和 Linux/macOS 实机验收仍沿用现有未完成边界；不创建新版本标签或触发发布工作流。
