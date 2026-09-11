# SDK 契约修复计划（2026-09-11）

来源：用户要求谨慎修复 `multimodal-contract-audit.md` 的遗漏，并修复运行中追加输入的
canonical entryId 在后续保存、上下文变化、压缩、重启、分页中的身份断裂。
用户授权先交叉调研讨论，再实施、回归、评审、提交并推送。保持包独立，不引入新配置或框架。

## 交叉讨论后的方案

- Worker RPC 透传合法 text/image 内容数组，普通 JSON 返回值保持既有兼容序列化；
  只保留明确允许的错误诊断字段。
- MCP 在 agent 适配原生图片为持久的内部图片路径；coding 三条真实调用路径复用窄结果适配，
  保留图片和显式错误状态；managed 直接调用复用已有错误分类。
- 历史容量恢复复用既有数组 guardrail，预算计入图片；旧 opt-in 微压缩保留含图片的结果。
- Runtime、持久化读取和 daemon schema 共同识别本地执行失败，保留安全诊断，
  不落入 provider fallback；原 provider、容量及中断类别保持。
- 最终交叉核验另复现 managed 工具事件通知抛出本地异常却缺少来源的路径。
  在现有 `composeToolObservers` 的四个同步通知边界复用本地错误结构；
  不改可能调用 provider 的 `beforeTool`，保留已有归因及 provider/取消/容量错误。
- OpenAI 视觉能力明确的 provider 将工具图片放入合法 user 图片运输消息，工具回包仍为文本，
  以 tool_call_id 标明来源。先保持完整 tool-call 配对，丢弃孤儿/重复结果时连同图片一起丢弃。
  非视觉 provider 维持明确降级；同步诊断投影。此变换只在请求中，不新增历史用户输入。
- 身份修复遵循已证明的对象来源/显式 lineage 关系，在首次重新挂接时保留 logicalId/sourceEntryId。
  不按文本、时间戳相等推测别名，不修改真实用户档案。具体触发须由 Runtime writer replay 验证。

## 验收

1. 将 9 个已知失败探针改为正常回归并通过，补真实 PNG、RPC/磁盘、显式错误和失败容量路径。
2. Runtime 实际投递追加输入后经历后续保存/上下文变化/压缩，最终 conversation 可以解析 delivered
   entryId；同文新输入仍是独立身份；重启、分页与完整读取一致。
3. Provider 请求测试覆盖 complete/stream、并行回包、孤儿/重复/缺失图片、非视觉回退。
4. 针对性检查后执行完整测试、typecheck、build；独立 Standards 与 Spec 评审。
5. 仅提交本任务修改，通过现有 GITHUB_TOKEN 非交互推送当前分支，不发布新版本。

旧档案中如果来源证据已永久丢失，不能靠推测批量修复；应明确报告这一边界。

## 身份问题的定位与最终修复

真实档案显示，delivered `entry_fdb4f2769c49` 与 main `entry_c49fccdba757` 的父链，
在一条 `managed-run-context` 重新出现的位置分叉。该证据用于缩小复现范围，
不能单凭现存快照还原当时每次函数调用的时序。

逐层离线回归证实三个断点：

1. `createSessionLineage` 普通上下文重写重新挂接已有消息时，不继承已证明的来源；
   原先只有 compaction 专用路径处理该关系。修复复用同一继承函数。
2. 普通 message 的 lineage 读取未登记来源，公开 storage 的 read/peek/snapshot 克隆也会
   丢失该关系。修复在已知 lineage 读取时登记，在克隆后从克隆 lineage 重新物化消息；
   不新增序列化私有 ID，不根据正文匹配回填。
3. conversation 投影仅记录选中 epoch 的条目和最近一代 source，遗漏仍保存在 lineage
   中的更早物理副本。修复沿显式 `sourceEntryId` 追溯，验证兼容来源、阻止循环及跨组
   冲突；竞争别名不分配给任一记录，并报告 ambiguous。分页缓存升级 v5，旧缓存重建。

Runtime 回归使用真实 Runtime、managed runner、FileSessionStorage 与离线 provider，
执行 submitInput/delivered 后再保存、替换上下文、持久化压缩、重启和分页。
另验证同文同 turn/timestamp 的新输入不产生别名，storage load/read/peek 返回后再保存保留来源。
真实用户档案仅只读检查，未做任何推测性修复。

## Standards

独立评审无未解决的运行代码规范问题；已改正诊断测试跨包源码导入及陈旧状态说明。
daemon 测试清理改用验证所有权的停止命令，并检查停止结果；不再直接终止 fixture 中的 PID。

## Spec

独立评审发现并处理了旧缓存版本与跨组祖先竞争两项问题，最终无未解决 finding。
最终 managed 通知异常补漏再次经过 Standards / Spec 独立增量评审，两轴均无 finding。
全量测试发现的 MCP fallback 文字格式兼容问题恢复了原有缩进格式，未修改旧断言，
该增量再次经过 Spec 评审，无 finding。

## 最终验证记录

- 默认全量：`npm test -- --maxWorkers=2 --reporter=default`，995 个文件，
  15,341 passed / 6 failed / 78 skipped / 21 todo；992 个文件通过、2 个失败、1 个跳过。
  两个失败文件均已在最终代码上独立复验消除：MCP fallback 原有文字格式的 2 项回归已修复；
  observer 的 4 项失败出现在跨越其实现修改的全量进程中，最终代码干净启动后 19/19 通过。
  后者与旧实现/新测试混用一致，未声称已证明具体缓存机制。
- 最终失败项与相邻多模态路径统一复验：CAP-025、compose-tool-observers、
  multimodal-tool-results、capability-tool-results 共 4 文件 39/39 通过。
- 最终 managed Runner 与 observer 完整组合：131 passed / 2 原有 todo。
  MCP fallback、capability、MCP tools、run-scoped 组合：51/51 通过。
- `npm run build`、`npm run typecheck`、`npm run test:bundle` 在最终代码上通过；
  bundle 测试 24/24。构建仍提示既有私有 shared type 导出警告，无构建错误。
- 新增三个辅助模块的定向覆盖：95.83% 行/语句、100% 函数、76.47% 分支；
  此数字不是全仓覆盖率。真实 Runtime 身份回归及原始九项审计探针均为普通通过测试。
- Windows 受限沙箱的独立 `os.userInfo()` 会报 `ENOMEM`，正常账户上下文成功；
  涉及真实子进程的默认全量在正常账户上下文执行，未为环境错误修改 SDK 产品逻辑。

没有调用付费模型、发布版本或改写原始会话档案。最终代码的新增修复均已复验，
未再次从头运行一次 995 文件全量；上述记录保留首次全量与最终定向复验的区别。
