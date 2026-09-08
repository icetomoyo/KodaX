# v0.7.97 产品入口自动化验收

本指南验证构建后的产品入口。组件、协议和 SDK 单测继续保留，但不替代这里的真实进程与终端操作。

## Windows 终端验收

入口：`tests/repl-pty-acceptance.mjs`。

链路：node-pty 的 Windows ConPTY → 发布入口 `scripts/kodax-bin.cjs` → 构建后的 CLI → 独立 Host → 本地 HTTP SSE Provider。xterm 解析终端实际输出；测试通过键盘输入操作产品，通过公开 Client 接口核对 Host 事实，并核对 Provider 实际收到的正文。

准备并运行（仓库根目录，PowerShell）：

```powershell
npm run build
npm install --prefix "$env:TEMP/kodax-acceptance-tools" --no-audit --no-fund node-pty@1.1.0 @xterm/headless@5.5.0
npm run test:repl-pty:built
```

可用 `npm run test:repl-pty:built -- ink` 或 `-- classic` 单独运行。Ink 路径明确使用当前 owned 渲染器；`KODAX_FORCE_INK=1` 选择的是旧 legacy 渲染器，不属于这一通过结论。若工具安装在其他位置，以 `KODAX_ACCEPTANCE_TOOLS` 指向包含 `package.json` 和 `node_modules` 的目录；这是验收驱动的位置，不是产品配置。

每次运行创建独立临时 Home、配置、项目和 Provider，只使用本地测试凭据。退出时停止本次创建的 Host；测试证据保留在启动输出的 `Artifacts:` 目录：

- `results.json`：每项结果及失败原因。
- `*-*.txt`：终端屏幕文本；`*-*.ansi`：原始终端输出。
- `*-requests.json`：本地 Provider 收到的请求，用来核对原文与历史。
- `*-host.json`：公开 Client 读取的视图、Run 和事件，区分正常停止与运行失败。

两种终端均验证新会话启动、流式输入/输出、设置往返、完整长输入、提问、停止后继续输入、新建隔离、退出和历史续接。Ink 额外验证忙时排队撤回编辑、搜索旧消息及冻结浏览。Ink 长输入使用 bracketed paste；classic 使用原有反斜杠续行。新建会话沿用各入口原有交互：Ink 确认后创建，classic 直接创建。具体通过项以当次 `results.json` 为准；失败不能以旧测试通过数豁免。

## 打包 Electron 与沙箱验收

入口：`scripts/test-electron-daemon-smoke.mjs`。配置已有 Electron 和 electron-builder 后执行：

```powershell
$env:KODAX_ELECTRON_DIST = '<electron 包>/dist'
$env:KODAX_ELECTRON_BUILDER_CLI = '<electron-builder 包>/out/cli/cli.js'
npm run test:electron-daemon:built
```

要求本机 Windows restricted-user sandbox 已就绪。验收不会隐式执行全局 sandbox setup 或修复 ACL；前置条件不足时明确失败。不要将真实用户目录传给 `KODAX_ELECTRON_SMOKE_HOME`，因为现有脚本把该参数视为可清理的验收专用目录。

测试实际打包并启动 Electron，检查 20 次工具查询、4 个 Session 并发、Windows 沙箱实际执行、环境隔离、连接/断开、关闭 Host 和重新启动。它运行 Electron 主进程但不创建 BrowserWindow，因此不覆盖视觉界面点击。

## 结果与边界

本轮执行与修复记录见 [真实产品入口自动化验收](../REVIEW_v0.7.97_FINAL.md#真实产品入口自动化验收)。确定性 Provider 让输入与交互断言可重复，不代表真实商业模型的任务质量验收。本指南也不替代 macOS/Linux 实机、剪贴板/输入法、视觉 GUI 和主观终端手感检查。

仍有两项已知缺口：其他客户端修改会话设置后，当前 REPL 的状态栏未同步刷新；强制 legacy 渲染器的搜索结果跳转可能无法显示屏幕外的历史消息。详见 [Known Issues](../KNOWN_ISSUES.md)。因此本指南的通过结果不代表整个 v0.7.97 无条件验收通过。
