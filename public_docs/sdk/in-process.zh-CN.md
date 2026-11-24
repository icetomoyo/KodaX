# 在自己的进程里运行 KodaX

本指南面向在自己的 Node 进程里直接运行 KodaX agent、不经过 Host 的开发者。
你的代码直接调用 agent，自己管理存储，自己回答工具审批。要改为连接 Host，
请看 [host-client.zh-CN.md](host-client.zh-CN.md)。整体介绍见 [overview.zh-CN.md](overview.zh-CN.md)。
下面没有列出的子路径，见 [optional-modules.zh-CN.md](optional-modules.zh-CN.md)。

## 导入

| 入口 | 包含内容 |
|---|---|
| `@kodax-ai/kodax` | 运行入口、`allowAll`、workflow、agent、`FileSessionStorage` |
| `@kodax-ai/kodax/coding` | 同样的运行入口，不含 REPL 附加功能 |
| `@kodax-ai/kodax/agent` | agent 框架和诊断 sink |
| `@kodax-ai/kodax/llm` | provider、模型能力、凭据检查 |
| `@kodax-ai/kodax/mcp` | `McpManager` 和 MCP 传输层 |
| `@kodax-ai/kodax/skills` | `SkillRegistry`、Skill 加载、变量解析器 |
| `@kodax-ai/kodax/session` | `createSessionManager` 和会话读取函数 |

## 选择入口

所有入口运行的都是同一个托管根 Run，区别只在驱动方式。

| 你想要 | 使用 |
|---|---|
| 一个提示词，一个结果 | `runKodaX(options, prompt)` |
| 一个运行中可以停止或切换模型的提示词 | `startKodaX(options, prompt)` |
| 多次调用之间保留历史的对话 | `new KodaXClient(options)` |
| 自己对每种失败分类 | `runManagedTask(options, prompt)` |
| 多个任务，任务之间有依赖 | `createKodaXTaskRunner` 配合 `runOrchestration` |

```ts
import { allowAll, runKodaX } from '@kodax-ai/kodax';

const result = await runKodaX(
  { provider: 'anthropic', events: { beforeToolExecute: allowAll } },
  'Summarize the README in this folder.',
);
console.log(result.lastText);
```

`startKodaX` 立即返回一个 `RunningSession`。它的 `result` promise 的结束方式
与 `runKodaX` 相同。`setProvider`、`setModel` 和 `setReasoning` 在下一轮生效。
`abort(reason)` 会停止运行，`options.abortSignal` 也会。
`KodaXClient` 在多次 `send(prompt)` 之间保留会话 id、消息和 token 快照。
`getSessionId()`、`getMessages()` 和 `clear()` 用来读取或重置这些状态。
`Client` 是同一个类。

`createKodaXTaskRunner({ baseOptions })` 构造一个 runner，交给
`runOrchestration({ tasks, workspaceDir, runner })` 使用。每个任务有 `id`、
`title`、`prompt`，以及可选的 `dependsOn`。任务的 `budget.maxIter`、
`provider` 和 `model` 会覆盖基础选项。`execution: 'parallel'` 的任务会并行运行，
最多 `maxParallel` 个（默认 1）。

## 读取结果

`runKodaX` 对所有预期内的结果都正常 resolve。它只在输入无效和上下文容量错误时
抛出异常。`runManagedTask` 在失败时也会抛出。

| 字段 | 含义 |
|---|---|
| `success` | 最终信号为 `BLOCKED` 或运行失败时为 `false` |
| `lastText` | 最后一段助手文本 |
| `signal` | agent 给出信号时为 `COMPLETE`、`BLOCKED` 或 `DECIDE` |
| `failure` | provider 或本地错误结束运行时设置 |
| `limitReached` | 运行达到轮数上限时为 `true` |
| `interrupted` | 运行被停止时为 `true` |
| `sessionId`、`messages` | 会话及其历史，失败时也保留 |
| `usage`、`contextTokenSnapshot` | 本次运行的 token 用量 |

在 `failure` 中，`safeMessage` 是 KodaX 固定的摘要，从不包含上游文本。
把它展示给最终用户。`detail` 是底层原因，例如 provider 的响应。它已脱敏凭据，
并截断到 1,000 个字符。把它写进日志。`errorClass` 给出类别，例如
`rate_limit`、`provider_overloaded` 或 `local_execution_error`。按它分支处理。
`provider`、`model`、`httpStatus`、`retryable` 和 `retryAfterMs` 在已知时设置。

`maxIter` 限制根 agent 的模型轮数。不设置时，只有 500 轮的安全熔断。
达到上限时，`limitReached` 为 `true`。

## 审批工具调用

不设置 `events.beforeToolExecute` 时，只有读取类工具会运行。仅影响会话的工具
也会运行：`todo_create`、`todo_update`、`create_goal`、`update_goal` 和
`skill`。其他调用都会被拒绝。模型收到一条工具结果，说明没有设置审批回调。
进程收到一次 `process.emitWarning`，代码为 `KODAX_TOOL_APPROVAL_MISSING`。传入 `allowAll`
可以运行所有调用。

你的回调给出三种回答之一：

- `true` 运行该调用。
- `false` 取消该调用，如同用户停止了它。
- 字符串会阻止该调用。模型把这个字符串当作工具结果看到。

```ts
import { runKodaX } from '@kodax-ai/kodax';

await runKodaX({
  provider: 'anthropic',
  events: {
    beforeToolExecute: async (tool) =>
      tool === 'bash' ? 'Shell commands are not allowed here.' : true,
  },
}, 'Fix the failing test.');
```

- 子 agent、Skill 和 workflow agent 使用同一个回调。
- 扩展的 `tool:before` hook 可以请求审批。请求交给
  `events.requestToolApproval`。没有这个回调时，调用会被阻止。
- `context.resolveShellPermissionMode` 只是向模型描述当前模式。
  它不批准任何调用。
- `options.guardrails` 中的护栏，例如 `createAutoModeToolGuardrail` 生成的，
  只能收紧权限。调用仍然必须通过你的审批回调。

KodaX 把其他警告和错误发送到诊断 sink，而不是控制台。用
`@kodax-ai/kodax/agent` 中的 `setKodaXDiagnosticSink` 设置 sink。
没有 sink 时，诊断信息不输出，除非设置 `KODAX_DIAGNOSTICS_STDERR=1`。

## 把会话保存到磁盘

只有设置了 `session.storage`，运行才会保存会话。只有 `session.id` 时不保存
任何内容。KodaX 会通过诊断 sink 报告一次这种情况。

```ts
import { createSessionManager } from '@kodax-ai/kodax/session';

const sessions = createSessionManager();
const options = {
  provider: 'anthropic',
  events: { beforeToolExecute: allowAll },
  session: { id: 's_support_42', storage: sessions.storage },
};
await runKodaX(options, 'Find where the config is loaded.');
await runKodaX(options, 'Now add a test for it.'); // same history
```

- 每个进程创建一个会话管理器并复用它。
- 带有已存储 `session.id` 的运行，会在开始前加载那段历史。
  也可以用 `session.initialMessages` 直接提供历史。
- 不带 id 的 `session.resume` 或 `session.autoResume` 会选择最新的非空会话。
  设置 `context.gitRoot` 可以把范围限制在一个项目内。
- 保存失败会作为错误诊断报告。运行继续进行。
- `createSessionManager({ sessionsDir, configHome })` 可以改变文件位置。
- 管理器也能读取和编辑已存储的会话：`listSessions`、
  `loadSession`、`readFullTranscript`、`forkSession`、`rewindSession`、
  `compactSession`、`archiveSession` 和 `deleteSession` 等。

## 定制提示词

- `context.agentProfile.instructions` 放在提示词开头。它只替换 KodaX 的身份
  描述，其余 KodaX 指导保留。结果中会回传 `agentProfile`。
- `context.systemPromptOverride` 放在开头，替换 KodaX 的身份描述和指导。
  环境、记忆和信任相关的段落仍然跟在后面。
- `context.prompt` 是一个 prompt spec。其中的条目进入对话的运行上下文，
  而不是系统提示词。
- `selfManual` 把你的产品主题加入 `kodax_manual` 工具。

```ts
import { allowAll, runKodaX } from '@kodax-ai/kodax';

await runKodaX({
  provider: 'anthropic',
  events: { beforeToolExecute: allowAll },
  context: {
    agentProfile: { surface: 'support', instructions: 'You are Acme Support.' },
    prompt: { context: [{ key: 'tone', kind: 'rule', text: 'Answer in two sentences.' }] },
  },
}, 'Why does login fail?');
```

prompt spec 的规则如下：

- `kodaxGuidance: 'omit'` 去掉 KodaX 的工作风格。工具说明和项目规则保留。
  默认值是 `keep`。
- `rule` 像项目规则一样被遵守，并会传给会写入的子 agent。`reference`
  只作为根 agent 的参考依据。
- key 必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$` 且不能重复。text 不能为空。
  所有条目的 text 合计最多 8,000 个字符。未知字段会报错。
- 每次运行的条目替换上一次运行的条目。省略的条目会被撤下。
- 无效的 spec 会抛出 `code: 'invalid_params'` 的错误。

`selfManual` 接受 `productName`、`topics` 和 `baseTopics`。一个主题有
`id`、`title`、`summary` 和 `body`。与 KodaX 主题 id 相同的主题会替换它。
`baseTopics: []` 去掉所有 KodaX 主题。要限制模型能看到的工具，设置
`context.excludeTools` 或 `context.toolVisibilityPolicy`。该策略收到
`{ name, sideEffect, planModeAllowed }`，返回 `true` 表示显示该工具。

## 模型与 provider

以下函数来自 `@kodax-ai/kodax/llm`。

- `getModelCapabilities(provider, model)` 描述一个内置模型。
  `resolveModelCapabilities` 还会检查自定义 provider。
- `getProviderModelDescriptors(provider)` 列出一个 provider 的已知模型。
  `listAllModelCapabilities()` 列出所有已知模型。
- `resolveWireEffort({ provider, model, desiredEffort })` 返回 KodaX 实际发送的
  effort，以及它是否被调整过。
- `listProviderModels(provider)` 返回 provider 的内置模型列表，不发请求。其
  `source` 为 `static` 或 `failed`。

能力记录包含 `contextWindow`、`maxOutputTokens`、`supportsThinking`、
`reasoningCapability`、`multimodalSupport`、`cacheCapabilities` 和
`toolCapabilities`。`maxOutputTokens` 是 KodaX 请求的值，不是模型的上限。

`verifyProviderCredential(provider, { timeoutMs, signal })` 用一个小请求检查
密钥。当 `ok` 为 `false` 时，`error` 为 `unauthorized`、`network`、
`timeout`、`unsupported`、`unconfigured`、`server_error`、`rate_limited` 或
`unknown`。`message` 最多 240 个字符。`approxTokensSpent` 和 `durationMs`
说明这次检查的开销。

## MCP 服务器

进程内运行通过扩展运行时访问 MCP 服务器。

```ts
import { allowAll, createExtensionRuntime, registerConfiguredMcpCapabilityProvider, runKodaX } from '@kodax-ai/kodax';

const runtime = createExtensionRuntime();
await registerConfiguredMcpCapabilityProvider(runtime, {
  files: { type: 'stdio', command: 'mcp-server-filesystem', args: ['/repo'] },
});
await runKodaX({
  provider: 'anthropic', extensionRuntime: runtime, events: { beforeToolExecute: allowAll },
}, 'List the files in /repo.');
await runtime.dispose();
```

之后模型能看到 `mcp_search`、`mcp_describe`、`mcp_call`、
`mcp_read_resource` 和 `mcp_get_prompt`。只有 `mcp_search` 和
`mcp_describe` 在没有审批回调时也能运行。

要做设置界面，用 `@kodax-ai/kodax/mcp` 中的 `createMcpManager(servers)`
构造一个 `McpManager`。`listServers()` 为每个服务器返回一行状态。
`startServer(id)` 和 `stopServer(id)` 连接和断开单个服务器。
`getServerLogs(id)` 返回它的状态和最近一次错误。`listTools(id)` 返回它的工具，
`getCatalog(id)` 还会加上资源和提示词。`dispose()` 关闭所有服务器。
服务器的 `status` 为 `idle`、`connecting`、`ready`、`error` 或 `disabled`。
管理器不会感知配置变化，修改配置后要新建一个。要读写 KodaX 配置中的服务器，
使用 `@kodax-ai/kodax/repl` 中的 `listMcpServers`、`upsertMcpServer` 和
`removeMcpServer`。

## Skill

运行从 `context.gitRoot` 查找 Skill；没有时用 `context.executionCwd`；
再没有时用当前目录。传入 `context.skillRegistry` 可以提供你自己的
`SkillRegistry`。模型用 `skill` 工具加载 Skill。Skill 可以包含
`` !`cmd` `` 块。KodaX 会把每个块替换为该命令的输出。

`options.skillDynamicContext` 决定这些命令如何运行：

| 设置 | 效果 |
|---|---|
| `{ execute: (command, cwd) => Promise<string> }` | 由你的函数运行每条命令。抛出异常即拒绝该命令。 |
| `{ disable: true }` | 拒绝所有命令。 |
| 未设置，有审批回调 | 运行内置的安全只读命令列表，超时 5 秒。 |
| 未设置，没有审批回调 | 拒绝所有命令，Skill 的 hook 也被拒绝。 |

要自己展开 Skill，调用 `@kodax-ai/kodax/skills` 中的 `createResolver(context)`。
它返回一个 `IVariableResolver`，其 `resolve(content, args, context)` 会填充
`$ARGUMENTS`、`$0`、`$1` 等变量。context 需要 `workingDirectory`。它的
`executeDynamicContext` 和 `disableDynamicContext` 字段与上面的选项作用相同。
`resolveSkillContent(content, args, context)` 一次调用完成同样的事。

## Agent

你可以添加有名字的 agent，由模型作为子 agent 启动。markdown agent 是
`<configHome>/agents/` 或 `<project>/.kodax/agents/` 下的文件。同名时，
项目 agent 优先于用户 agent。

```markdown
---
name: db-reviewer
description: Reviews database migrations for safety
tools: [read, grep]
---
You review database migrations. Check locking and backfill cost.
```

- `name` 和 `description` 是必填项。没有 front matter 或没有 `name` 的文件
  会被跳过。缺少 `description` 会作为失败报告。
- `provider`、`model`、`effort`、`tools` 和 `skills` 是可选项。
- 在运行前调用 `loadAgentsFromMarkdown({ cwd, configHome })`。它返回
  `{ loaded, failed }`。`discoverMarkdownAgents` 只列出文件，不注册。

扩展可以在激活时注册 agent：

```ts
export default async function activate(api: KodaXExtensionAPI) { // 来自 '@kodax-ai/kodax'
  await api.registerAgent('python-reviewer', {
    instructions: 'You review Python code for type hints.',
    description: 'Python type-hint reviewer',
  });
}
```

`registerAgent` 返回一个 dispose 函数的 promise，所以要 await 它。agent 被拒绝时
它会抛出异常，这会中止扩展的加载。

模型用 `spawn_agent` 加上 agent 的 `agent_id` 启动已注册的 agent。
`listCodingDispatchableAgents` 和 `resolveCodingDispatchableAgent` 让你的代码
读取同一份列表。它们返回的是描述，不是可运行的 agent。

## Workflow

workflow 是一个运行多个 agent 的脚本。只有同时设置 `agentMode: 'ama'`、
`workflowRunsBaseDir`（存放运行记录的目录）和
`context.workflowIntent: 'explicit'` 三项时（提示词要求 workflow 时 KodaX 会自己设置后者），
模型才会得到 `run_workflow` 工具。你的代码也可以自己启动 workflow。

```ts
import { createWorkflowRunManager, generateWorkflowFromOptions } from '@kodax-ai/kodax';

const generated = await generateWorkflowFromOptions({ request: 'Review src/auth', options });
if (generated.kind === 'generated') {
  const run = createWorkflowRunManager().startFromOptions({
    module: generated.module, scriptSnapshot: generated.scriptSnapshot,
    args: {}, options, runId: 'wf-1', runDir: '/data/workflows/wf-1',
  });
  await run.done;
}
```

`generateWorkflowFromOptions` 返回 `kind: 'generated'`，或带 `reason` 的
`kind: 'declined'`。`authorWorkflowViaWorker({ request, options })` 改由一个
完整的 agent 编写脚本。它需要 `workflowRunsBaseDir`。

过程事件告诉 UI 运行的进展。`events.onWorkflowProcessEvent` 发送
`workflow_started`、`workflow_updated` 和 `workflow_finished`，每个都带一份
快照。运行管理器的 `subscribeWorkflowProcess(listener)` 对你自己启动的运行
做同样的事。`events.onWorkflowAgentDigest` 报告子 agent 的摘要，
摘要变化或子 agent 结束时会再次报告。

`createWorkflowLifecycleController({ runManager, runBaseDir })` 控制运行：
`stopWorkflow`、`pauseWorkflow`、`resumeWorkflow`、`readWorkflowResult`、
`deleteWorkflowRun` 和 `pruneWorkflowRuns`。`workflow.maxConcurrency` 限制
并行 agent 数量，默认为 8。

### 路由与成本

workflow 子 agent 可以请求 `fast`、`balanced` 或 `deep` 模型。用
`modelTiers: { fast: { provider, model }, deep: { provider, model } }` 映射这些
档位。`balanced` 使用父 agent 的模型。会写入的子 agent 永远不会得到 `fast`
模型。子 agent 的路由信息说明实际发生了什么。`requestedTier` 是它请求的档位。
`tierOutcome` 为 `applied`、`balanced-parent`、`fast-write-ineligible`、
`unconfigured`、`shadowed-by-selector` 或 `inherited`。缺失的字段视为未知。

每次运行结束都会在运行目录写入 `run.json`。其中的 `efficiencyReport` 记录
token 总量和子 agent 数量。只有 `tokenCoverage.ok` 为 `true` 时，
`totalModelTokens` 才可信。

## 上下文压缩

对话接近上下文窗口时，KodaX 会自动压缩。这个功能始终开启。在
`options.compaction` 中，`triggerPercent` 是开始压缩的占用比例。默认值为 75，
限制在 15 到 90 之间。`triggerTokens` 增加一个绝对阈值。`contextWindow`
覆盖窗口大小，用于 KodaX 不认识的模型。`events.onContextCompactionFinished`
报告每次压缩。`events.onCompactedMessages` 给你新的历史。如果它返回 promise，
KodaX 会等待它完成。

## Agent 邮箱与事件

模型用 `wait_agent` 等待子 agent。子 agent 发来消息或完成、有新的用户输入、
运行被停止或超时，都会结束等待。超时范围是 10 秒到 1 小时，默认 2 分钟。
子 agent 的进度不会结束等待，所以忙碌的子 agent 不会唤醒模型。要在 UI 中显示
子 agent 的活动，请改用事件回调。事件的 `childAgentId` 和 `childAgentName`
说明它来自哪个 agent。

## Shell 执行

`context.shellExecution` 设置 shell 命令如何运行。不设置时，命令使用平台默认
shell 和 `process.env`。设置后，KodaX 通过你指定的 shell 读取环境，然后在该
shell 中运行每条命令。设置 `version: 1`。

- `shell.kind` 为 `pwsh`、`powershell`、`cmd`、`bash` 或 `zsh`。
  `executable`、`args` 和 `profile` 是可选项。
- `environment.inherit: 'filtered'` 保留你的进程的变量。`'none'` 只保留
  操作系统需要的变量。`set` 添加变量。`denyPatterns` 按名称移除变量。
- `environment.setup` 是在读取环境之前运行的 shell 代码，例如用来激活版本管理器。
- 在 Windows 上，`environment.windowsPath: 'registry'` 会从注册表重新读取 `PATH`。
- `cache.ttlMs` 设置已解析环境的复用时长。`0` 关闭缓存。修改
  `cache.refreshToken` 会强制重新解析。

`clearShellExecutionEnvironmentCache()` 清除所有缓存的环境。
