# @kodax-ai/agent

通用 Agent 框架。源码开发时可从 `@kodax-ai/agent` 引入；npm SDK 用户通常安装单包 `@kodax-ai/kodax`，再从 `@kodax-ai/kodax/agent`、`/skills` 或 `/mcp` 引入需要的能力。

## 概述

`packages/agent` 是 KodaX 的平台层，不包含 coding 业务工具。当前包内聚合了 v0.7.43 之后内联的能力子树：

- Layer A primitives: `Agent`, `Runner`, handoff, guardrail, compaction policy
- Runtime substrate: admission, runtime middleware, idle-yield, one Actor/Turn
  scheduler, and session-scoped follow-up queues
- Session lineage: branchable session tree、compaction、persistence helpers
- Capabilities: MCP integration、Skills loader、builtin skills
- Observability: tracing spans / trace store
- Experimental governed memory: `MemoryAgent`, `MemorySession`, sparse
  `intervene()`, prompt-safe evidence envelopes, and trace-only receipts
- Workflow runtime: domain-neutral workflow execution primitives plus `WorkflowProcessEvent` / `WorkflowProcessSnapshot` process types

## 安装 / 导入

```bash
npm install @kodax-ai/kodax
```

```typescript
import { createAgent, Runner } from '@kodax-ai/kodax/agent';
import { SkillRegistry } from '@kodax-ai/kodax/skills';
import { createMcpManager } from '@kodax-ai/kodax/mcp';
```

仓库内部开发可直接使用 workspace 包名：

```typescript
import { createAgent, Runner } from '@kodax-ai/agent';
```

## 最小 Agent / Runner 示例

```typescript
import { createAgent, Runner } from '@kodax-ai/kodax/agent';

const agent = createAgent({
  name: 'summary-agent',
  instructions: 'Summarize the user request in one sentence.',
  reasoning: { default: 'off' },
});

const result = await Runner.run(agent, 'Explain the current task', {
  llm: async (messages) => {
    const last = messages.at(-1);
    return `Summary: ${typeof last?.content === 'string' ? last.content : 'request received'}`;
  },
  tracer: null,
});

console.log(result.output);
```

The generic `Runner` path can be used with a caller-provided `llm` callback. The coding preset wires a richer substrate through `@kodax-ai/coding` / `@kodax-ai/kodax/coding`.

## Skill 调用契约

Skill 的可见性与显式调用是两个独立维度：

| 来源 | 可用范围 | `disable-model-invocation: true` |
|---|---|---|
| 模型自然语言匹配 / `skill` 工具 | 仅 model-visible Skills | 不注入 catalog，并由工具拒绝 |
| 用户 `/<name>`、`/skill:<name>` | 所有已启用 Skills | 仍可调用 |
| SDK `SkillRegistry.invoke()` | 所有已启用 Skills | 仍可调用 |

```typescript
const registry = new SkillRegistry(process.cwd());
await registry.discover();

// 只包含允许模型发现的 name/description。
const modelCatalog = registry.getSystemPromptSnippet();

// 显式 SDK primitive；模型调用权限应由调用方的 tool admission 管理。
const result = await registry.invoke('manual-only-skill', 'src/', {
  workingDirectory: process.cwd(),
});
```

`user-invocable` 仅保留 frontmatter/DTO 兼容性；已启用 Skill 始终显式可调用并报告 `userInvocable: true`。宿主显式展开后应以结构化 `skillInvocation` 传递一次；模型写在 child objective 里的 slash 文本不是用户来源证明，仍必须走模型工具策略。

## 常用公开能力

- Agent primitives: `createAgent`, `createHandoff`, `Runner`, `DefaultSummaryCompaction`
- Runtime helpers: `runFanOut`, `runWithIdleYield`, `AgentActorController`,
  `AgentTurnScheduler`, and Actor-scoped message routing
- Session lineage: session tree, compaction, archive markers, persistence types
- Skills: `SkillRegistry`, `loadFullSkill`, `expandSkillForLLM`
- MCP: `McpCapabilityProvider`, `createMcpTransport`, catalog helpers
- Tracing: trace / span primitives and stores
- Workflow: `createWorkflowRuntime`, `runWorkflow`, `WorkflowAbortError`, `WorkflowLimitError`, `WorkflowProcessEvent`, `WorkflowProcessSnapshot`, `isFinalWorkflowProcessStatus`

Actor mailbox control and event telemetry are separate contracts. Model-facing
coordination yields on scoped mailbox activity, user input, interruption, or
timeout; progress remains on the Actor event stream for snapshot, replay, and
long-poll consumers. Completion notifications are acknowledged only after the
parent transcript commits. An explicit pending-delivery set restores an
unacknowledged root completion after restart without replaying acknowledged or
legacy historical mail.

Actor Turn metadata remains domain-neutral and opaque at this layer. The coding
package may store validated quality-strategy metadata and derive `PatternTrace`
facts, but the agent controller does not decide which pattern is good or
whether a task is complete. `MemorySession.intervene()` likewise exposes a
domain-neutral, bounded primitive while F228's memory-control plane remains the
only durable write authority.

The v0.7.77 release hardens the memory evidence envelope as one frozen policy
artifact: prompt-safety identity, claim/reference limits, reference count, and
token reserve all participate in its evidence fingerprint. Qualified
credential sentences are rejected before they can become model-visible memory
evidence.

The v0.7.79 release hardens Session-lineage reconciliation for upgraded
v0.7.78 data: the first full reconciliation reuses the exact persisted active
context, no-input reconciliation is idempotent, and an intentional same-content
new query remains a distinct lineage entry. Durable-island recovery preserves
parent-before-child order and compaction clone provenance.

The v0.7.80 release adds a structured `RunnerIterationLimitError` with a
recovery transcript: a Runner that exhausts its mechanical tool-loop fuse fails
with `code: 'RUNNER_ITERATION_LIMIT'` and carries the last legal transcript,
readable through `readRunnerRecoveryTranscript`, so callers can distinguish a
runaway tool loop from other failures.

The v0.7.81 release exports `getSessionMessageEntryId(message)`. It returns a
physical Session-lineage entry only when that exact message reference has one
unambiguous provenance source; reused or otherwise ambiguous references return
`undefined`. Runtime delivery uses this narrow proof instead of deriving an
entry from transcript order.

The v0.7.82 release makes managed cancellation cooperative and causal:
`AgentActorController.quiesce()` preserves turns admitted before the Stop while
preventing later Run-owned admission, and cancellation after required settlement
fails rather than disappearing. Runner guardrail and tool boundaries observe an
already-aborted signal before starting further work.

Windows process-tree cleanup now identity-checks observed roots and descendants
and returns an indeterminate outcome when evidence is incomplete. Snapshot
ancestry is not kernel containment, however; Issue 256 remains open. The
remaining Worker owner-lease boundary is scheduled for v0.7.87; v0.7.85's
daemon/per-effect Job containment does not claim descendant closure after an
intermediate parent exits.

The v0.7.83 release adds the daemon-owned Windows containment slice: the daemon
is assigned to a kill-on-close Job Object before it resumes, an external
supervisor waits for the Job to empty, and managed child cleanup can use that
kernel boundary instead of synchronous per-child tree hooks. The SDK's
`waitForRuntimeDaemonShutdown()` and `daemonShutdownVerification:1` make the
durable cleanup plus daemon/supervisor exits explicit. Legacy uncontained
daemons remain fail-closed and must be relaunched; Worker owner leasing for the
rest of Issue 256 remains open and is scheduled for v0.7.87.

The v0.7.86 release adds process-start identities to Runtime owner and learning
lock records, so PID reuse cannot preserve stale ownership. Abandoned inline
owner recovery remains atomic and ambiguous owners remain fail-closed.

The v0.7.84 release adds Issue 282 settlement recovery. Agent progress
persistence is bounded to one in-flight write plus one latest replacement;
same-owner Stop can reconcile a late Actor snapshot and retry an unknown
settlement, while Promise terminal facts outrank fallback callbacks and foreign
owners or unresolved stores remain fail-closed. This is runtime system-code
hardening, not a new Feature release.

The v0.7.85 release adds Session-scoped Runtime Event Journals, conversation-
first Memory management, the additive `MemoryManagementAgent` facade, and
bounded review/lesson pipeline behavior from F289/F290. Terminal Run startup
can restore authoritative terminal status without replaying complete journals,
and the semantic repo-intelligence Worker retires after its idle warm-cache
window. See the root release checklist for the complete system-code scope.

`DefaultSummaryCompaction` 是给自定义 Agent loop 使用的独立 primitive；它不替代、也不能关闭 KodaX coding runtime 在 FEATURE_272 中定义的始终开启大型压缩策略。

## Subpath 说明

根 npm 包 `@kodax-ai/kodax` 暴露：

- `/agent`: agent 完整公开 API
- `/skills`: skills 窄子集，只给 skill loader / IDE 插件等轻量消费者
- `/mcp`: MCP 窄子集，只给 MCP server host / popout UI 等轻量消费者

源码包 `@kodax-ai/agent` 还保留内部子路径，例如 `@kodax-ai/agent/workflow`，但根发布包没有 `@kodax-ai/kodax/agent/workflow` 这个 subpath；SDK 用户从 `/agent` 引入 workflow 符号即可。

## 构建与测试

```bash
npm run build -w @kodax-ai/agent
npm test -- packages/agent/src
```

## License

[KodaX-AI Fair Core License (KAI-FCL) 1.1](LICENSE). KodaX 0.7.70 and later
are source-available / fair-core, not OSI open source. Commercial or managed
use requires KodaX-AI authorization. Earlier released Apache-2.0 copies keep
their existing license.
