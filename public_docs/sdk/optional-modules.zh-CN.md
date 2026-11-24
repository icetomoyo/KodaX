# KodaX 可选模块

这些模块随 `@kodax-ai/kodax` 一起发布，但驱动 Agent 用不到它们。应用需要哪个
功能，就用哪个模块。安装和 ESM 说明见 [概览](overview.zh-CN.md)。

| 模块 | 入口 | 用途 |
|---|---|---|
| [Artifact SDK](#artifact-sdk) | `/artifacts`、`/artifacts/client`、`/artifacts/runtime`、`/artifacts/kodax` | 渲染文档和图片，并把像素作为证据读出来 |
| [沙箱](#独立沙箱) | `/sandbox` | 在操作系统沙箱里运行你自己的命令 |
| [媒体输入](#媒体输入) | `/media` | 在你的进程里给提示词附上图片、文件或视频 |
| [Skill 学习](#后台-skill-学习) | Host 的 `learning.*` 方法 | 展示 KodaX 学到的 Skill，并对它们做决定 |
| [旧版记忆](#旧版受治理记忆) | `/experimental-memory` | 在旧记忆 API 删除之前，让应用继续使用它 |

## Artifact SDK

Artifact SDK 打开、渲染和检查文件，并把渲染出的页面作为 PNG 证据返回，供
Agent 或人查看。它的九个操作是 `capabilities`、`prepare`、`create`、`open`、
`edit`、`export`、`render`、`capture` 和 `readEvidence`。

- PPTX：创建、有限的文字和几何编辑、导出（复制原文件）、渲染。
- PDF、PNG、JPEG、WebP 和 SVG：渲染成 PNG。
- DOCX：渲染成页面。配置了 LibreOffice 可执行文件时，页面来自真实的转换。
  没有配置时，得到的是标记为 `unverified` 的粗略预览。
- 固定视口下的本地 HTML，以及指定秒数下的 SVG SMIL 动画：截取。
- GIF、视频、电子表格和 3D 没有默认后端。

渲染在无头 Chromium 里运行，所以只有终端的机器也能用。除了渲染整张 PNG 图片，
每个操作都需要这个 Chromium。调用 `prepare()` 下载它；不会自动安装任何东西。

### 在你自己的 Node 进程里

`/artifacts/runtime` 在你的进程里执行这些操作。它能碰哪个工作区由你决定。

```ts
import { createArtifactSdk, validateVisualEvidence } from '@kodax-ai/kodax/artifacts';
import { createNodeArtifactPort } from '@kodax-ai/kodax/artifacts/runtime';

const sdk = createArtifactSdk(createNodeArtifactPort({ workspaceRoot: process.cwd(), maxRenderPages: 4 }));
const result = await sdk.render({ path: 'report.pdf', pages: [1] });
if (result.evidence) {
  const raster = result.evidence.evidence[0]!;
  const image = await sdk.readEvidence({ source: result.evidence.source, raster });
  if (image.status === 'ready') show(`data:image/png;base64,${image.image.dataBase64}`);
  validateVisualEvidence(result.evidence, { kind: 'paginated', source: result.evidence.source, pages: [1] });
}
```

`browserExecutable` 和 `libreOfficeExecutable` 是端口的选项，由你的代码设置。
模型请求永远无法选择它们。

### 通过 Host

要让 Host 的 Agent 使用这些操作，在一个 Host 扩展里注册一次工具，比如
`<data root>/extensions/artifacts.mjs`：

```js
import { registerArtifactTools } from '@kodax-ai/kodax/artifacts/kodax';
import { executeManagedProcess } from '@kodax-ai/kodax/coding';

export default (api) => registerArtifactTools(api, { execute: executeManagedProcess, nodeExecutable: process.execPath });
```

这会加上九个 `artifact_*` 工具和一个 artifact-review Skill。已经在运行的 Host
会在重启时加载这个扩展。`nodeExecutable` 必须是真正的 Node.js，不能是你的
Electron 可执行文件。

`/artifacts/client` 从客户端驱动这些工具。`createKodaXArtifactHostPort(client, sessionId)`
接受一个 `KodaXHostClient`（协议 v2），每个操作启动一次工具 Run，再按工具条目
指明的 blob 读回 PNG，并用工具报告的哈希校验。v1 端口 `createKodaXArtifactPort`
接受 `KodaXProductClient`，在 v0.7.100 随 v1 客户端一起移除。两个端口都从不在
本地运行任何东西，也从不重放结果未知的操作。

- `ready` 表示像素已经存在。它从不表示看起来没问题；Agent 或人仍要检查。
- 传入 `AbortSignal` 可以停止操作。停止不会撤销它已经创建的文件。
- 打包后的 Electron 应用必须把包里的 `dist/artifacts` 目录作为真实文件放在
  `asar` 之外，并附带一个真正的 Node.js。

格式、限制、错误和配置见 [Artifact SDK](../../docs/ARTIFACT_SDK.md)。

## 独立沙箱

约束 KodaX 自己 shell 命令的沙箱，你也可以用。`/sandbox` 运行你选定的命令，
并套用你设置的文件系统、网络、环境、时间和输出限制。

| 平台 | 后端 | 需要 |
|---|---|---|
| Windows | 受限用户账户 | 一次性配置，可能弹出 UAC |
| macOS | Seatbelt（`sandbox-exec`） | `ripgrep` |
| Linux | bubblewrap | `bubblewrap`、`socat`、`ripgrep`，以及非特权用户命名空间 |

### 检查和配置

```ts
import {
  activateKodaXSandbox,
  doctorKodaXSandbox,
  getKodaXSandboxCapability,
  getKodaXSandboxSetupGuidance,
} from '@kodax-ai/kodax/sandbox';

const capability = getKodaXSandboxCapability(); // 后端、ASRT 版本、控制项
const doctor = await doctorKodaXSandbox();
if (!doctor.ready) {
  show(getKodaXSandboxSetupGuidance(doctor));
  // 只在用户点击“配置沙箱”时调用。在 Windows 上可能弹出 UAC。
  const outcome = await activateKodaXSandbox();
  if (outcome.status !== 'ready') show(outcome.guidance);
}
```

- `doctorKodaXSandbox()` 检查是否就绪。它从不做任何配置。
- `activateKodaXSandbox()` 在 Windows 上配置沙箱；在其他平台返回 `unavailable` 和指引。只从用户自己选择打开的配置界面调用它。
  不要在启动时、工具调用中或后台检查里调用。
- 在 Linux 和 macOS 上，展示缺少哪些软件包的指引。不要替用户运行 `sudo` 或
  包管理器，也不要悄悄修改 sysctl 或 AppArmor。
- 不要把是否就绪当作普通工作的门槛。沙箱没有就绪时，已授权的工作仍然按正常
  的权限规则进行。

### 运行命令

```ts
import os from 'node:os';
import path from 'node:path';
import { getKodaXSandboxSetupGuidance, runKodaXSandboxed } from '@kodax-ai/kodax/sandbox';

const result = await runKodaXSandboxed({
  command: process.execPath,
  args: ['scripts/generate-report.mjs'],
  cwd: projectDir,
  filesystem: {
    allowRead: [projectDir, process.execPath],
    allowWrite: [projectDir, os.tmpdir()],
    denyWrite: [path.join(projectDir, '.git', 'config')],
  },
  network: { mode: 'allowlist', origins: ['https://api.example.com'] },
  inheritEnvironment: false,
  env: { REPORT_FORMAT: 'pdf' },
  timeoutMs: 120_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

if (result.status === 'unavailable') {
  // 什么都没运行。决定是等待配置、拒绝，还是换一种方式运行。
  show(getKodaXSandboxSetupGuidance(result.doctor));
} else if (result.status === 'execution_uncertain') {
  // 命令可能已经启动。不要盲目重试。
  throw new Error(result.diagnostic);
} else if (result.exitCode !== 0) {
  throw new Error(result.stderr);
}
```

| 选项 | 含义 |
|---|---|
| `filesystem.allowWrite` | 命令唯一可以创建、修改或删除文件的根目录。 |
| `filesystem.denyWrite` | 从 `allowWrite` 里排除的根目录。它总是优先。 |
| `filesystem.allowRead` | 命令需要读取的根目录。普通读取本来就是允许的。 |
| `filesystem.denyRead` | 命令不能读取的根目录。只在 POSIX 上有效；见下文。 |
| `network` | `{ mode: 'allow' }`、`{ mode: 'deny' }`，或者带精确 HTTP(S) 源的 `{ mode: 'allowlist', origins }`。 |
| `inheritEnvironment` | 默认 `true`。`false` 时命令只得到最小环境加上 `env`。 |
| `timeoutMs` | 覆盖整个运行过程：沙箱启动、命令本身和清理。 |
| `maxOutputBytes` | 限制捕获的输出大小。 |
| `signal` | 取消这次运行。 |

相对路径的根目录以 `cwd` 为基准解析。确保你传入的每个根目录都存在。

`command` 和 `args` 保持分开。在 Windows 上没有 shell 解析它们，所以 `%VAR%`、
`&` 和引号会原样传给命令。

无效输入（比如空的 `command`）会抛出错误。在 Windows 上，沙箱启动或运行失败也会抛出。
其他情况下，结果是三种之一：

- `completed`：命令在沙箱里运行了。你会拿到 `exitCode`、`stdout` 和 `stderr`。
- `unavailable`：命令没有运行，`sandboxed` 为 `false`。`reason` 说明原因：
  `doctor_not_ready`（未就绪）、`backend_launch_failed`（沙箱无法启动命令）或
  `unsupported_policy`（这个平台无法执行你要求的策略）。
- `execution_uncertain`：命令可能已经启动，但 KodaX 无法证明它是怎样运行的。
  不要盲目再次运行。

`runKodaXSandboxed` 从不在沙箱之外运行命令。在 `unavailable` 之后不经沙箱运行
是你自己的选择，而且不应把那次运行报告为沙箱内运行。

### Windows 上的读取

在 POSIX 上，`denyRead` 会收回读取权限。Windows 后端无法执行读取限制，所以在
Windows 上，非空的每命令 `denyRead` 会在任何配置或启动之前返回 `unavailable`，
原因为 `unsupported_policy`。

同样的限制也适用于通过 A2A 发布、且工具策略允许 Skill 脚本
（`toolPolicy.skillScripts`）的 Agent。它们在一条更严格的隔离路径上运行这些
脚本，这条路径从不退回到不经沙箱运行。在当前的 native protocol 10 上，这条路径
仅支持 POSIX；在 Windows 上不可用，因为它需要每命令 `denyRead`。

KodaX 怎样用沙箱运行自己的命令，见 [沙箱](../configuration/sandbox.zh-CN.md)。

## 媒体输入

`/media` 构建在你的进程里随提示词一起发送的输入构件：图片，以及文件和视频的
结构。Host 客户端改为以 blob 方式上传图片；见
[图片和附件](host-client.zh-CN.md#图片和附件)。

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';
import {
  createImageArtifactFromPath,
  getModelInputCapabilities,
  readAndNormalizeClipboardImage,
  validateInputArtifactsForModel,
} from '@kodax-ai/kodax/media';

const caps = getModelInputCapabilities({ provider, model });
if (!caps.image.sdkSupported) disableImageDrop();

// 剪贴板里没有图片，或模型不收图片时为 null
const pasted = caps.image.sdkSupported ? await readAndNormalizeClipboardImage() : null;
if (pasted) {
  const stored = await myImageStore.write(pasted.buffer, pasted.mediaType);
  const artifact = createImageArtifactFromPath(stored.path, { mediaType: pasted.mediaType, source: 'clipboard' });
  validateInputArtifactsForModel([artifact], { provider, model });
  await runKodaX({ provider, model, context: { inputArtifacts: [artifact] } }, promptText);
}
```

### 模型接受什么

`getModelInputCapabilities({ provider, model })` 针对提供商和模型的组合作答。
同名模型换一条接入路径，不会被默认为能接收图片。以 `imageInput: true` 注册的
自定义提供商算作能接收图片。

| 字段 | 含义 |
|---|---|
| `image.status: 'supported'` | KodaX 可以把图片发给这个模型。 |
| `video.status: 'provider-native-unwired'` | 模型能接收视频，但 KodaX 还不发送视频。 |
| `file.status: 'unsupported'` | KodaX 还不发送文件。 |

`validateInputArtifactsForModel()` 使用同样的规则，并抛出带稳定 `code` 和
`detail` 的 `KodaXMediaError`。用它们来禁用发送或说明原因。如果仍想使用某个
文件，自己提取文本并放进提示词。

### 构件

`KodaXInputArtifact` 有三种，每种都带一个 `path`：

- `image`：PNG、JPEG、WebP 或 GIF。用 `createImageArtifactFromPath()` 构建。
- `file`：用 `createFileArtifactFromPath()` 构建。
- `video`：MP4、MPEG、MOV、AVI、FLV、WebM、WMV 或 3GP。用
  `createVideoArtifactFromPath()` 构建；类型无法识别时，它抛出
  `KodaXMediaError`（`UNSUPPORTED_MEDIA_TYPE`）。

- 剪贴板图片输出为静态 PNG 或 JPEG。动画 GIF 可能失去动画。
- 从路径发送的 GIF 仍然是 GIF。模型怎样处理动画取决于提供商。
- `validateInputArtifactsForModel()` 只检查结构和模型，不会查看文件本身。

### 运行中追加输入

要给你进程里仍在进行的运行追加带图片的输入，使用
`enqueueWithArtifacts({ provider, model, sessionId, content, inputArtifacts })`。
它先校验，再把输入排入那次运行的队列。同时可能有多个会话在运行时，传入
`sessionId`；不传时，如果有两个运行处于活动状态，调用会失败，而不是去猜。这个
队列只存在于你的进程里。Host 客户端通过 Host 发送追加输入。

## 后台 Skill 学习

根运行结束后，KodaX 会在后台回顾这个会话。除了记忆笔记（见
[记忆](../configuration/memory.zh-CN.md)），回顾还可能为在该会话里经过验证确实
有效的流程提议一个 Skill。

- 回顾使用会话自己的提供商和模型，每天最多十次调用。它不会为 CLI 桥接提供商
  运行。
- 如果你的进程向 `runKodaX` 传入了自己的 `learningReviewer` 或
  `memoryReviewer`，内置回顾就不会运行。
- 提议的 Skill 一开始是 `ready`。在用户做出决定之前不会被使用。
- 纠正或失败是记忆的证据。单凭它们永远不会修改 Skill。

### 生命周期和决定

学到的能力有一个 `lifecycle`：`opportunity`、`drafting`、`ready`、`testing`、
`active_learned`、`promoted_user`、`quarantined`、`archived` 或 `rejected`。
用户的决定推动它变化：

| 决定 | 效果 |
|---|---|
| trust | 从现在起使用它，不经试用（`active_learned`）。 |
| review | 让它试用：Host 用它几次，并观察效果（`testing`）。 |
| reject、disable | 停止使用它。 |
| rollback | 回到上一个良好的修订。 |
| promote | 让它成为用户自己的 Skill（`promoted_user`）。 |

用户是否看过某个变化按客户端分别记录，通过 `learning.acknowledge` 和
`learning.snooze`。生命周期对所有客户端都一样。

### 提升

提升把一个已审阅的 `ready` 或 `active_learned` 修订复制到用户的 Skill 里，
通常是 `<data root>/skills/<slug>/SKILL.md`。

- 来源必须仍然匹配该修订记录的指纹。
- 那里已有内容相同的文件，算作成功。
- 那里已有不同的 Skill 时，以 `action_failed` 失败（经 Host 调用时为 `internal`），且从不覆盖。
- `user` 是唯一的范围。

### 在哪里查看和决定

- Host 客户端使用 `learning.*` 方法：`learning.list`、`learning.get`、用于
  角标的 `learning.snapshot`、`learning.events`，以及上面的各项决定。见
  [记忆和学习](host-platform.zh-CN.md#记忆和学习) 和
  [Host 协议参考](host-protocol-reference.md)。
- 在终端里：`/learn`、`/learn trust <name>` 和
  `/learn promote <name> --scope user`。

不要扫描学到的文件来判断哪些处于活动状态。只有记录表明它处于活动状态、且它的
文件仍然匹配时，Skill 才处于活动状态。

## 旧版受治理记忆

`/experimental-memory` 是早先受治理记忆的 API。KodaX 现在默认使用笔记记忆
（见 [记忆](../configuration/memory.zh-CN.md)），`KODAX_MEMORY_NOTES=0` 会切回
受治理记忆。这个入口只为这种回退而保留，会和它一起删除。不要在它上面开始新
工作。Host 客户端用 Host 的记忆方法管理用户的记忆；见
[记忆和学习](host-platform.zh-CN.md#记忆和学习)。

```ts
import { createMemoryAgent, createMemoryControlPlane } from '@kodax-ai/kodax/experimental-memory';

const identity = { tenantId: 't:acme', workspaceId: 'w:desktop', userId: 'u:42', agentId: 'a:reviewer', projectId: 'p:app', sessionId: 's:1' };
const memory = createMemoryAgent({ controlPlane: createMemoryControlPlane({ cwd: process.cwd(), identity, projectDocs: [], discoverSkills: false }) });

await memory.remember({ statement: 'Run npm run build before release.', evidenceRef: 'host:user-request:42' });
const session = await memory.startSession({ identity, objective: 'Review the shutdown change' });
const hint = session.recall({
  decisionRevision: 'd1',
  objective: 'Review the shutdown change',
  decisionContext: 'Choosing which checks to run',
  decisionIntent: 'verify',
  throughSequence: 0,
});
await session.complete({ status: 'succeeded', summary: 'Verified', evidence: [] });
await session.close();
```

- `list()`、`remember()` 和 `forget()` 管理已接受的记忆。`remember()` 用
  `status` 作答：`remembered`、`updated`、`already_known`、
  `needs_clarification`、`needs_review` 或 `rejected`。
- 提供你自己的持久 `evidenceRef`。不要把模型文本冒充为用户的请求。
- `recall()` 是同步的。`query()` 是有意为之的只读查询。没有可补充的内容时，
  两者都返回 `undefined`。
- 召回的记忆是弱证据。当前事实仍然来自工具和代码仓库。
- 身份必须完全一致。不要在身份里放凭据。
