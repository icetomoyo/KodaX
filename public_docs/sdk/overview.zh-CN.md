# KodaX SDK 概览

这是基于 KodaX 开发的入口页。它讲怎样安装包、怎样选包入口、KodaX 把数据放在
哪里，以及 Windows 或 Electron 应用要做什么。后面的事交给其他指南：

| 指南 | 适合你，如果你 |
|---|---|
| [编写 Host 客户端](host-client.zh-CN.md) | 要写一个和 KodaX Host 通信的界面或工具：Node 应用、桌面应用或网页。 |
| [平台后端](host-platform.zh-CN.md) | 要在 Host 旁边运行后端，出借密钥和工具、启动 Agent、管理记忆，或者对接 A2A、ACP。 |
| [在你的进程里运行 KodaX](in-process.zh-CN.md) | 要在自己的进程里把 Agent、会话、提示词、模型、MCP、Skill 或工作流当作库来调用。 |
| [可选模块](optional-modules.zh-CN.md) | 需要文件渲染、独立沙箱、媒体输入或旧版记忆 API。 |
| [Host 协议参考](host-protocol-reference.md) | 需要每个 v2 方法的参数和结果。 |

要为别人运行 Host，见 [运行 KodaX Host](../deployment/host.zh-CN.md)。
要从手机访问自己的 Host，见 [远程访问](../deployment/remote-access.zh-CN.md)。

## 安装

```bash
npm install @kodax-ai/kodax
```

- Node.js 22.4 或更高版本。Electron 主进程加载 KodaX 时，Electron 内置的
  Node.js 也要满足这一点。
- 只有一个包。下面每个入口都是 `@kodax-ai/kodax` 的子路径，不用再装第二个包。
- 只支持 ESM。包只声明了 `import` 条件，所以对任何入口调用 `require()` 都会
  报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

### 在 CommonJS 里加载

Electron 主进程，或者用 `format: 'cjs'` 构建的产物，都是 CommonJS。在那里用
动态 `import()` 加载 KodaX：

```ts
// 类型在编译时会被擦除，所以在 CommonJS 里只导入类型没有问题。
import type { KodaXHostClient } from '@kodax-ai/kodax/client';

let host: KodaXHostClient<'local'> | undefined;

async function startKodaX(): Promise<void> {
  const { ensureKodaXHostClient } = await import('@kodax-ai/kodax/client');
  host = await ensureKodaXHostClient({ client: { name: 'my-app', version: '1.0.0' } });
}
```

类型用 `import type` 导入。普通的 `import { ... }` 只要导入了值，在 CommonJS
产物里就会变成一次 `require()` 调用。

很多打包工具在输出 CommonJS 时会把 `await import(x)` 改写成 `require(x)`。
把 KodaX 排除在打包之外，动态导入才能保留下来：

- esbuild：`external: ['@kodax-ai/kodax', '@kodax-ai/kodax/*']`。
- webpack：在 `externals` 里列出你用到的每个子路径。
- Vite（SSR 或 Electron 主进程构建）：把它们加到 `ssr.external`。

如果仍然看到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，说明打包工具改写了这次导入。
先修好打包配置。

## 包入口

| 入口 | 用途 | 指南 |
|---|---|---|
| `@kodax-ai/kodax/client` | Node 用的 v2 Host 客户端：`ensureKodaXHostClient` 启动或加入本机的 Host，`connectKodaXHost` 通过网络连接 Host。也包含旧的 v1 产品客户端。 | [Host 客户端](host-client.zh-CN.md)、[平台后端](host-platform.zh-CN.md) |
| `@kodax-ai/kodax/browser` | 网页用的 v2 Host 客户端：`connectKodaXHost`，不依赖 Node。 | [Host 客户端](host-client.zh-CN.md) |
| `@kodax-ai/kodax/a2a` | A2A 1.0 客户端执行器，以及为 KodaX Agent 提供的 A2A 服务端。 | [平台后端](host-platform.zh-CN.md) |
| `@kodax-ai/kodax/coding` | 作为库使用的编码 Agent：`runKodaX`、编码工具、提示词、扩展、工作流。 | [进程内](in-process.zh-CN.md) |
| `@kodax-ai/kodax/agent` | 编码 Agent 底下的通用 Agent 框架：Runner、会话、Skill、MCP、数据根辅助函数。 | [进程内](in-process.zh-CN.md) |
| `@kodax-ai/kodax/llm` | 提供商和模型：解析提供商，读取模型能力。 | [进程内](in-process.zh-CN.md) |
| `@kodax-ai/kodax/session` | 磁盘上的会话文件：列出、加载、分叉、回退、删除和监听会话。 | [进程内](in-process.zh-CN.md) |
| `@kodax-ai/kodax/skills` | 只有 Skill 部分：发现、加载、展开和运行 Skill。 | [进程内](in-process.zh-CN.md) |
| `@kodax-ai/kodax/mcp` | 只有 MCP 部分：传输、能力提供者、目录。 | [进程内](in-process.zh-CN.md) |
| `@kodax-ai/kodax/repl` | 交互式终端（Ink 和 React）及其配置辅助函数，比如 `loadConfig` 和 `listMcpServers`。导入它会加载 Ink 和 React。 | [进程内](in-process.zh-CN.md) |
| `@kodax-ai/kodax/media` | 图片、文件和视频输入构件，剪贴板图片，模型输入能力。 | [可选模块](optional-modules.zh-CN.md) |
| `@kodax-ai/kodax/sandbox` | 在操作系统沙箱里运行你自己的命令。 | [可选模块](optional-modules.zh-CN.md) |
| `@kodax-ai/kodax/artifacts`、`/artifacts/client`、`/artifacts/runtime`、`/artifacts/kodax` | 渲染和检查文档与图片（PPTX、PDF、DOCX、图片、SVG、HTML），并把像素作为证据读出来。 | [可选模块](optional-modules.zh-CN.md) |
| `@kodax-ai/kodax/experimental-memory` | 旧版受治理记忆 API。只为回退保留，之后会删除。 | [可选模块](optional-modules.zh-CN.md) |
| `@kodax-ai/kodax/runtime` | v1 底层 Runtime（`ensureKodaXRuntime`、`connectKodaXRuntime`），以及 `copyKodaXDataRoot` 和提供商凭据辅助函数。 | 本页 |
| `@kodax-ai/kodax`（根入口） | `/coding` 的全部内容，加上终端入口、ACP 服务端、沙箱函数和 v1 Runtime。 | 优先用子路径 |

从包含所需内容的最窄入口导入。子路径比根入口加载得少，而且只有 `/repl` 需要
Ink 和 React。

## 使用 KodaX 的两种方式

**和 Host 通信。** Host 是一个 `kodax host serve` 进程。它拥有一个人的设置、
会话和记忆，并运行这个人的 Agent。你的应用是客户端：提交输入，回应审批和提问，
展示 Host 报告的内容。CLI、终端界面和你的应用可以同时使用同一个 Host。做产品
时用这种方式。见 [编写 Host 客户端](host-client.zh-CN.md) 和
[平台后端](host-platform.zh-CN.md)。

**在你的进程里运行。** 直接调用 `runKodaX` 和其他库。运行、它的会话文件和它的
审批都归你的进程所有。适合脚本、测试、自己掌管 Agent 循环的服务端，以及基于
框架构建的 Agent。见 [在你的进程里运行 KodaX](in-process.zh-CN.md)。

### v1 客户端

在 v2 之前，应用使用 v1 产品客户端（`/client` 里的 `ensureKodaXClient`、
`connectKodaXClient`、`KodaXProductClient`），或者 `/runtime` 里的 v1 底层
Runtime（`ensureKodaXRuntime`、`connectKodaXRuntime`）。它们现在仍然可用。
Host 协议 v1 会在 0.7.100 删除；如果 0.8.0 先发布，就在 0.8.0 删除。在此之前
迁移到 v2 客户端。

- 不要混用。一个客户端只用一种协议，不要两种都用。
- [协议 v2：v1 方法对照](../../docs/SDK_MIGRATION.md#协议-v2v1-方法对照未发布)
  列出每个 v1 调用对应的 v2 方法。
- [从 v1 客户端迁移](host-client.zh-CN.md#从-v1-客户端迁移)
  讲界面能察觉到的差异。

## 数据放在哪里

KodaX 把一个人的所有东西放在一个数据根里：设置、提供商密钥、会话、记忆、
Skill，以及 Host 自己的状态。

| 设置 | 指向 | 数据根 |
|---|---|---|
| `KODAX_HOME` | 数据根本身 | 这个值。它必须是绝对路径；相对路径会被忽略。 |
| `homeDir` 选项、CLI `--home` | 包含 `.kodax` 的目录 | `<homeDir>/.kodax` |
| 都没有 | | `~/.kodax` |

`homeDir: '/data/team'` 和 `KODAX_HOME=/data/team/.kodax` 指的是同一个数据根。
`homeDir: '/data/team/.kodax'` 指的是 `/data/team/.kodax/.kodax`，那是另一个
数据根，会话也不同。

**一个数据根一个 Host。** 指向同一个数据根的客户端共用一个 Host。
`ensureKodaXHostClient({ homeDir })` 加入这个 Host；没有 Host 在运行时就启动
一个。如果某个数据根已经被活着的 Host 占用，再在它上面运行
`kodax host serve` 会以非零退出码退出。要服务两个人，就给每人一个自己的数据根
和自己的 Host。

### 在你自己的进程里

```ts
import { resolveKodaXHome } from '@kodax-ai/kodax/agent';

const home = resolveKodaXHome(); // { path, source: 'env' | 'default', ignoredEnv? }
if (home.ignoredEnv) warn(`KODAX_HOME=${home.ignoredEnv} is not absolute and was ignored`);
```

`resolveKodaXHome({ env?, homeDir? })` 读取 `KODAX_HOME`，不做任何改动。
`ignoredEnv` 存放因为不是绝对路径而被跳过的 `KODAX_HOME`。

你进程里的库代码按这个顺序选数据根：先 `setAgentConfigHome(path)`，然后
`KODAX_HOME`，最后 `~/.kodax`。在第一次导入 KodaX 之前设置 `KODAX_HOME`，因为
有些路径在模块加载时就固定了，比如 `/repl` 里的 `KODAX_DIR`。启动时调用一次
`setAgentConfigHome`，要在其他 KodaX 调用之前。它为整个进程设置一个值。不要按
请求或按租户切换它：会话、凭据和记忆读的都是同一个数据根，一个进程里的两个
租户会共享状态。每个租户用自己的进程或自己的 Host 来服务。

### 你的应用自己的文件

`getAppDataDir(appId)`（来自 `/coding` 或 `/agent`）在数据根里给你的应用一个
专属目录 `<data root>/apps/<appId>/`，并创建它。

```ts
import { getAppDataDir } from '@kodax-ai/kodax/coding';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = getAppDataDir('my-app'); // ~/.kodax/apps/my-app/
writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify(windowState));
```

- `appId` 必须匹配 `^[a-z][a-z0-9-]{1,31}$`：小写字母、数字和 `-`，2 到 32 个
  字符，以字母开头。
- `kodax` 和以 `kodax-` 开头的名字是保留名，会抛错。
- 它遵循上面同样的顺序，所以先调用 `setAgentConfigHome` 也会让它跟着移动。
- 这个目录归你的应用所有。KodaX 从不写它，迁移和清理都由你负责。

### 迁移数据根

`/runtime` 里的 `copyKodaXDataRoot({ from, to, exclude?, onProgress?, signal? })`
把数据根复制到新位置：

```ts
import { copyKodaXDataRoot, KodaXDataRootCopyError } from '@kodax-ai/kodax/runtime';

try {
  const { files, bytes, rebasedFiles, skipped } = await copyKodaXDataRoot({ from: oldRoot, to: newRoot });
} catch (error) {
  if (error instanceof KodaXDataRootCopyError) showCopyError(error.code);
  else throw error;
}
```

- 它只复制，从不移动。源目录只会被读取，SDK 从不删除它。
- 目标必须不存在或为空。只要还有 Host 在使用源目录，它就拒绝执行
  （`host_running`），所以先停掉所有客户端。
- `.json` 和 `.jsonl` 文件里指向旧数据根的绝对路径会被改写为新数据根。
- 属于某台机器或某个进程的状态不会复制，比如 Host 自己的运行时文件和锁。
- 复制本身不会切换数据根。之后在应用第一次调用 KodaX 之前，用 `KODAX_HOME`
  或 `homeDir` 指向新数据根。

完整规则、不复制的内容清单和错误码见
[迁移数据根](../../docs/SDK_MIGRATION.md#relocating-a-data-root-copykodaxdataroot)。

## Windows 和 Electron

### 保住终端的输入

在 Windows 上，用 `stdio: 'inherit'` 启动 Electron 的开发脚本，可能让
PowerShell 或 Windows Terminal 无法再接收键盘输入。KodaX 不读 stdin。原因是
Electron 子进程继承了打开的输入句柄。不要给子进程 stdin：

```js
import { spawn } from 'node:child_process';

const electron = spawn(electronBin, [appEntry], {
  stdio: ['ignore', 'inherit', 'inherit'], // stdin 用 'ignore'，不要用 'inherit'
  shell: false,
});
```

要确认问题不在 KodaX，在 KodaX 检出目录里运行
[`scripts/probe-sdk-stdin.mjs`](../../scripts/probe-sdk-stdin.mjs)，可以附上
已安装的 `dist` 目录路径。它会导入每个入口，并报告 stdin 监听器或原始模式的
任何变化。

### 后台进程

你不需要在 KodaX 周围写隐藏控制台的代码。KodaX 在后台启动的进程，比如 Git
探测、提供商 CLI、语言服务器和沙箱辅助进程，都会请求 Windows 隐藏窗口。编辑器、
终端和本来就要交互的命令仍会打开窗口。

### 打包后的 Electron 应用

KodaX 从磁盘文件加载原生辅助程序，无法从 `asar` 归档里读取它们。要把它们解包。
使用 `electron-builder` 时：

```json
{
  "asar": true,
  "asarUnpack": [
    "node_modules/@kodax-ai/kodax/dist/native/**/*",
    "node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/**/*",
    "node_modules/**/@anthropic-ai/sandbox-runtime/vendor/srt-win/**/*"
  ]
}
```

KodaX 会到 `app.asar.unpacked` 下找每个文件。如果文件不在那里，会在任何沙箱
进程启动之前报错，并在消息里给出文件名。文件渲染器另有要求，见
[可选模块](optional-modules.zh-CN.md#artifact-sdk)。

## 用本地 KodaX 检出目录开发

要让你的应用试用尚未发布的 KodaX，链接一个本地检出目录：

```bash
# 在 KodaX 检出目录里
npm install
npm run build     # 链接指向 dist/，不是源码
npm link

# 在你的应用里
npm link @kodax-ai/kodax
```

- KodaX 每次改动后都要重新运行 `npm run build`，再重启你的应用。
- 撤销：在你的应用里运行 `npm unlink @kodax-ai/kodax`，然后运行
  `npm unlink -g @kodax-ai/kodax`。
- 如果要快照而不是实时链接，在 KodaX 里运行
  `node scripts/release.mjs --pack-only`，再用 `npm install` 安装它生成的
  `.tgz`。这个压缩包只用于本地测试：它只包含你所在平台的原生辅助程序，npm
  也会拒绝发布它。

## 更多

- [客户端契约](../../docs/CLIENT_CONTRACT.md)：客户端可以依赖什么、必须做什么，
  完整版。
- [桌面应用的 SDK 与 Host 接缝](../../docs/SPACE_SDK_SEAMS.md)：可信主进程里的
  授权，分叉、重试和回退，Host 配置，附件和统计。
- [Artifact SDK](../../docs/ARTIFACT_SDK.md)：支持的格式和配置。
- [SDK 迁移](../../docs/SDK_MIGRATION.md)：旧调用及其替代（大部分是中文）。
- [CHANGELOG](../../CHANGELOG.md)：每个版本的变化。
