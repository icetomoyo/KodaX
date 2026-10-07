# Codex 文件写入沙箱失败后会无感回退吗？

结论：没有通用、无审批、无副作用的宿主回退；存在受权限与审批约束的第二次执行，而且多文件补丁可以部分提交。

固定源码：`C:/Works/PubProj/codex`，HEAD `a20fe6335f960a350483d0079db2ec281c68202c`，工作区 clean。下列文件行均对应此 SHA；只读研究，未运行功能测试。

## 已证实

- FS helper 自身不宿主重试：不可实施沙箱在启动前报错；请求发送后等待结果。该次 FS 请求的准备/启动失败可以确定未执行，但不能证明整个多文件补丁未提交。[准备与启动](C:/Works/PubProj/codex/codex-rs/exec-server/src/fs_sandbox.rs:165)、[请求执行](C:/Works/PubProj/codex/codex-rs/exec-server/src/fs_sandbox.rs:391)。
- `apply_patch` 只把识别出的 `SandboxErr::Denied` 送入第二次执行；其他工具错误直接返回。识别依赖输出关键词，连“sandbox”“failed to write file”也匹配，因此不可用/通信失败可能被归为 denial，不代表零副作用。[分类](C:/Works/PubProj/codex/codex-rs/sandboxing/src/denial.rs:45)、[重试入口](C:/Works/PubProj/codex/codex-rs/core/src/tools/orchestrator.rs:391)。
- `approval=never` 禁止退出沙箱重试；`on-request` 的补丁专用 override 允许申请审批，通过后才重试。已有审批可能免再次询问；strict auto-review 要重新审查。存在 denied-read 限制时不能宿主重试。[补丁 override](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:134)、[审批与第二次执行](C:/Works/PubProj/codex/codex-rs/core/src/tools/orchestrator.rs:439)、[denied-read](C:/Works/PubProj/codex/codex-rs/core/src/tools/sandboxing.rs:293)。
- Full Access 对应不限制写入的有效 FS policy 时，首次就走直接 FS；这与失败降级、approval 设置是不同维度。[写路由](C:/Works/PubProj/codex/codex-rs/exec-server/src/local_file_system.rs:103)、[限制判断](C:/Works/PubProj/codex/codex-rs/file-system/src/lib.rs:416)。
- helper 已开始写后，丢响应、异常退出或 IO 错误不能证明未提交；代码还明确承认截断后失败，把 delta 标为 `exact=false`。没有统一的 `no-start`/`committed_unknown` 回执契约。[响应错误](C:/Works/PubProj/codex/codex-rs/exec-server/src/fs_sandbox.rs:406)、[副作用不确定](C:/Works/PubProj/codex/codex-rs/apply-patch/src/lib.rs:489)。
- 多文件按 hunk 顺序执行，无整批回滚；失败保留已提交 delta。获准重试再次执行原补丁，累计 delta，未筛除已成功文件，不能视为安全幂等重放。[顺序与失败](C:/Works/PubProj/codex/codex-rs/apply-patch/src/lib.rs:432)、[逐文件](C:/Works/PubProj/codex/codex-rs/apply-patch/src/lib.rs:504)、[原补丁与累计结果](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:179)。

## 未证实

未现场验证本机 helper 可用性、延迟和具体故障后的磁盘内容；源码关键词分类也不证明某次错误来自 OS 沙箱。

## 未解问题

KodaX 是否允许明确授权后的降级、怎样证明 no-start、怎样处置部分提交，需要新契约/ADR；不能直接沿用 Codex 重试作为无感回退保证。
