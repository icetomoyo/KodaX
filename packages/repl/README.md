# @kodax-ai/repl

KodaX 的交互式终端层，基于 Ink/React，同时保留 readline 传统 REPL。源码开发时可从 `@kodax-ai/repl` 引入；npm SDK 用户通常从 `@kodax-ai/kodax/repl` 或更窄的 `@kodax-ai/kodax/session` 引入。

## 概述

`packages/repl` 负责终端体验和本地用户配置，不承载 coding agent 核心逻辑。主要能力包括：

- Ink TUI 入口：`runInkInteractiveMode`
- 传统 readline REPL：`runInteractiveMode`
- Slash command parsing / execution
- Provider、custom provider、MCP server 配置读写
- Permission mode helpers and path/tool allow logic
- File-backed session storage and public session-management SDK
- Terminal host detection and renderer policy

Bare `-r` starts with the searchable session picker rather than importing the
full CLI. Selecting a session transfers stdin to the resumed REPL; Esc releases
the picker stdin and returns to the invoking terminal. Auto Mode configuration
is passed to the Runtime guardrail, which decides before the permission UI.
Automatic large-context compaction is always enabled: `triggerPercent` defaults
to 75 (15-90), optional `triggerTokens` adds an absolute ceiling, and the smaller
effective threshold wins. Runtime-backed REPL paths let the Runtime own the
durable compact transaction and update only the local live projection after its
acknowledgement.

`session.resume` / `session.autoResume` selects the newest non-empty
conversation from a broad scan and skips zero-message ACP/bootstrap records.
The rule is shared by Ink and classic startup, and explicit IDs win. Both
interactive surfaces restore persisted workspace/runtime identity before the
next turn. Shift-Tab cycles Plan -> Edits -> Auto[LLM] -> Full Access while
Shift+Enter inserts a newline. Auto[LLM] reviews only a proven pre-start host
boundary after the sandbox cannot execute; Full Access bypasses sandbox and
reviewer but still applies Exec Policy. Legacy Rules settings normalize to
Auto[LLM] without reading or migrating legacy rule files.

For strict host observation, `readSessionCapture()` returns active context and
full transcript from one immutable storage boundary. `readFullTranscript()` and
`readSessionCapture()` are timeout/cancellation-aware and never migrate or
recover legacy data as a read side effect. `exportSessionBundle()` preserves
the exact main/sidecar bytes plus hashes and compatibility diagnostics.
For an ordinary chat view, use `readConversationHistory()`: it folds only
provenance/topology-proven compaction copies, reports ambiguity, and leaves raw
append-order audit entries unchanged.

## 安装 / 导入

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runInkInteractiveMode, loadConfig } from '@kodax-ai/kodax/repl';
import { listSessions } from '@kodax-ai/kodax/session';
```

仓库内部开发可直接使用 workspace 包名：

```typescript
import { runInkInteractiveMode } from '@kodax-ai/repl';
```

`@kodax-ai/kodax/repl` 会自动绑定 KodaX 原生 trusted-text host。直接嵌入
`@kodax-ai/repl` 时，宿主必须通过 `options.context.trustedTextMutationHost`
提供同等 authority；REPL 包不会绕过独立分层去加载根包的 native 实现。

## 启动 Ink REPL

```typescript
import { runInkInteractiveMode, type InkREPLOptions } from '@kodax-ai/kodax/repl';

const options: InkREPLOptions = {
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  session: {
    resume: true,
  },
};

await runInkInteractiveMode(options);
```

## 传统 REPL

```typescript
import { runInteractiveMode, type RepLOptions } from '@kodax-ai/kodax/repl';

const options: RepLOptions = {
  provider: 'zhipu-coding',
  reasoningMode: 'off',
};

await runInteractiveMode(options);
```

## 显式 Skill 调用

Ink、Classic 和非交互 CLI 都由宿主解析用户输入中的 `/<name>` 与
`/skill:<name>`；token 可位于 query 头部或中间，后缀文本作为参数。
一个请求只能激活一个已知 Skill；多个引用会得到明确诊断，Immediate 与 queued
路径都不会静默只执行第一个。
忙碌时识别出的 Skill 输入以 host-owned queue entry 保存，不能被 Runtime
mid-turn drain 当成普通自然语言提前送给模型。

嵌入式终端宿主可复用同一解析/展开入口：

```typescript
import { resolveUserSkillInvocation } from '@kodax-ai/kodax/repl';

const userInput = '/manual-only-skill src/';
const request = await resolveUserSkillInvocation(userInput, {
  workingDirectory: process.cwd(),
  projectRoot: process.cwd(),
});
```

返回的 `request.skillInvocation` 是后续 Workflow/child 复用显式 Skill 的
结构化来源证明。`disable-model-invocation` 只影响模型 catalog/tool，不影响
此入口。需要完整 hooks、权限和 finalize 生命周期的宿主应继续使用导出的
`prepareInvocationExecution`，不要把 `request.prompt` 当普通用户文本重复注入。
prepared options 的 `context.rawUserInput` 保留用户逐字输入，供 canonical
transcript/title 使用；生成的 provider prompt、hook additional context 和 Skill
展开内容只属于执行 overlay。`PreToolUse` 命令失败或返回非法 JSON 时拒绝目标
工具，`PostToolUse` 失败则只报告诊断。

## 配置管理

```typescript
import {
  loadConfig,
  listCustomProviders,
  upsertCustomProvider,
  listMcpServers,
  upsertMcpServer,
} from '@kodax-ai/kodax/repl';

const config = loadConfig();
console.log(config.provider);

upsertCustomProvider({
  name: 'my-openai-compatible',
  protocol: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: 'MY_LLM_API_KEY',
  model: 'my-model',
});

console.log(listCustomProviders().length);
console.log(Object.keys(listMcpServers()).length);
upsertMcpServer('local-tools', { command: 'node', args: ['server.js'] });
```

## 权限与 Session SDK

```typescript
import {
  computeConfirmTools,
  isPermissionMode,
  listSessions,
  readConversationHistory,
  readSessionCapture,
  exportSessionBundle,
  forkSession,
  watchSessions,
} from '@kodax-ai/kodax/repl';

if (!isPermissionMode('default')) {
  throw new Error('unexpected permission mode');
}

const confirmTools = computeConfirmTools('default');
console.log(confirmTools);

const firstPage = await listSessions({
  limit: 20,
  scope: 'user',
  surface: 'repl',
});
const first = firstPage[0];
const nextPage = firstPage.at(-1)?.cursor
  ? await listSessions({
      limit: 20,
      scope: 'user',
      surface: 'repl',
      cursor: firstPage.at(-1)?.cursor,
    })
  : [];

const capture = first
  ? await readSessionCapture(first.id, { timeoutMs: 10_000 })
  : null;
const conversation = first
  ? await readConversationHistory(first.id, { timeoutMs: 10_000 })
  : null;
const bundle = first
  ? await exportSessionBundle(first.id, { timeoutMs: 10_000 })
  : null;

if (first) {
  await forkSession(first.id, { title: `${first.title} copy` });
}

const watcher = watchSessions((event) => {
  console.log(event.kind, event.sessionId);
});

watcher.close();
```

Session-only consumers can import the same session APIs from `@kodax-ai/kodax/session` to avoid the full REPL surface.

## 常用公开能力

- Entrypoints: `runInkInteractiveMode`, `runInteractiveMode`, `processSpecialSyntax`
- Commands: `InteractiveContext`, `parseCommand`, `executeCommand`, `BUILTIN_COMMANDS`
- Explicit Skills: `resolveUserSkillInvocation`, `createUserSkillInvocation`, `prepareInvocationExecution`
- Config: `loadConfig`, `prepareRuntimeConfig`, `saveConfig`, custom-provider CRUD, MCP-server CRUD
- Sessions: `FileSessionStorage`, `findMostRecentResumableSession`, `listSessions`, `loadSession`, `readConversationHistory`, `readFullTranscript`, `readSessionCapture`, `exportSessionBundle`, `forkSession`, `rewindSession`, `archiveSession`, `watchSessions`
- Permissions: `computeConfirmTools`, `isPermissionMode`, `isToolCallAllowed`, `getPlanModeBlockReason`
- Headless events: JSON/CLI event output includes `sidecar.message` for Sidecar Verifier `revise` / `blocked` messages
- UI exports: `App`, `SimpleApp`, hooks, contexts, components, terminal-host utilities

## 构建与测试

```bash
npm run build -w @kodax-ai/repl
npm test -- packages/repl/src
```

## License

[KodaX-AI Fair Core License (KAI-FCL) 1.0](LICENSE). KodaX 0.7.70 and later
are source-available / fair-core, not OSI open source. Commercial or managed
use requires KodaX-AI authorization. Earlier released Apache-2.0 copies keep
their existing license.
