# KodaX SDK Foundation Hardening Plan (2026-11-04)

> Status: approved 2026-11-04; Phase 1, the WP6 spike and WP8 are implemented (uncommitted). See section 0.
> Scope: work in the KodaX SDK repository (this worktree). The Space-side plan is a separate document:
> [space-workbuddy-class-evolution-handoff-2026-11-04.md](space-workbuddy-class-evolution-handoff-2026-11-04.md).
> Baseline: `@kodax-ai/kodax@0.7.97-beta.1`, branch `KodaX-next-dev` at `fc296bd56`.
> Every `path:line` below was read on 2026-11-04. Re-check line numbers before editing.

## 0. Implementation status (2026-11-04)

Phase 1, the WP6 spike and WP8 are implemented in the `KodaX-next-dev` working tree. Nothing is
committed or released. No tool description or system prompt changed, so prompt caching and model
behavior are unaffected and no prompt eval is needed.

| WP | State | Record |
|---|---|---|
| WP1 | Done | Issue 378 |
| WP2 | Done | Issue 379 |
| WP3 | Done | Issue 380 |
| WP4 | Done | Issue 381 |
| WP5 | Done (documentation; grants behavior settled, no code change) | `CLIENT_CONTRACT.md` "无人值守运行" |
| WP6 | Spike done; implementation waits for the Node floor decision | FEATURE_303, [v0.7.98](../features/v0.7.98.md#feature_303-proxy-and-private-ca-support) |
| WP7 | ADR-071 Proposed; code waits for review and confirmed callers | FEATURE_304, ADR-071 |
| WP8 | Done | see below |
| WP9 | Not started; lives in the `KodaX-Extensions` repository | — |

**Where the implementation differs from the plan below:**

- **WP1.** Besides removing the `events` guards, the extension runtime is bound at frame level, so
  every dispatch path sees the same runtime. The bridge wrapper and the construction `ctx` proxy were
  fixed so a call fires `tool:before` exactly once and nested constructed calls go through the gate.
- **WP2.** Implemented inside the existing `runHook` for `tool:before`, not as a separate
  `runToolBeforeHook`. Block messages from handlers are passed through verbatim. Evaluation stops
  at the first block, because nothing can override it; an allow no longer stops it.
- **WP3.** File tools do not go through `withFileMutation`, as step 1 assumed. They go through
  `assertTrustedTextMutationPolicy`, which now refuses `extensions/` and `integrations/` in every
  mode. Text tool writes to `runtime/`, `processes/` and `learned/` keep their earlier design: the
  outer permission policy decides, so a user can approve them. `extensions` is not added to
  `PROTECTED_DIRECTORIES`, so extension source stays readable.
- **WP4.**
  - Redirects are capped at 20, the same as `fetch()`, not 5. Every hop is checked.
  - There is no metadata hostname list. Any DNS name can point at a metadata address, and the
    resolved-address check already covers that.
  - No proxy-mode switch is needed. Node does not call `lookup()` when it routes through an
    environment proxy, so only address literals and the proxy's own address are checked in that mode.
    A hop the proxy resolved counts as public for the redirect rule.
  - A reused keep-alive socket also skips `lookup()`. Sockets connected directly are remembered,
    and their server is checked before a reused one sends the request.
  - The metadata set adds GCP `fd20:ce::254`, Oracle `fd00:c1::a9fe:a9fe` and Azure `168.63.129.16`.
    Volcengine is not confirmed and is not in the set.
- **WP5.** Persisted `allow_always` grants have no Session scope. They apply to every Run in the same
  Agent Home, including authorized Runs, within the Run's tool ceiling. This is documented; no opt-out
  was added because no Host has asked for one.
- **WP6.** Measured on Node 20.20.2, Node 22.23.1 and Space's Electron 42.5.0 (Node 24.17.0). Results
  are in [FEATURE_303](../features/v0.7.98.md#2-spike-结果2026-11-04). The main finding: Space can use
  a proxy today by passing `NODE_USE_ENV_PROXY=1` to the daemon. The SDK gap is `ws`, the Responses
  WebSocket client.
- **WP8.** The supervisor script reports `Add-Type` time on a `COMPILED:<ms>` line. Every launch emits
  a `runtime:windows` diagnostic: `debug` "Windows effect Job supervisor ready." with `readyMs` and
  `compileMs`, or `warn` "Windows effect Job supervisor failed to start." with the timings and the
  error, including the 15-second timeout. The SID probe is unchanged.

## 1. Why this work

KodaX Space wants to become an always-on office assistant on top of the KodaX SDK. It would run scheduled
jobs, take requests from chat apps, edit documents and drive a browser, often with nobody watching. Tencent
WorkBuddy is the reference product for that shape.

That product shape changes what the SDK must guarantee. In an interactive coding session a person sees
each step and can stop the agent. In an unattended run, the SDK's own policy surfaces are the only safety:

- extension policy hooks;
- the permission mode;
- the files the agent may write;
- the network the agent may reach.

Most of these surfaces are already well designed. Extension authority comes from the admitted Run. Host
tools are leased per Run. MCP can be scoped per session. Process launch uses fixed argv. Config reload
keeps the last good version. But several surfaces are enforced only on some paths, or fail open. A few
are missing. This plan closes those gaps first. It then adds one small seam (an `ask` result for policy
hooks) and publishes a contract for unattended runs.

What this plan does **not** do is just as important. The SDK will not grow a scheduler, a chat-channel
framework, a plugin bundle format or a marketplace. In WorkBuddy those all live in the desktop shell, not
in the agent core. In KodaX they belong to Space. Section 6 lists what is excluded and why.

## 2. How a tool call is decided today

This is the path a model-requested tool call takes. The gaps in section 3 refer to it.

1. **Dispatch.** A tool call reaches one of these dispatch paths:
   - the single-agent loop (`runSubstrate` → `runToolDispatch`);
   - the managed-task (AMA) Runner (`runner-driven.ts`);
   - the managed `tool_call` bridge (`agent-chain.ts`);
   - child agents (`child-executor.ts`), which re-enter `runKodaX`;
   - script-mode leaf calls (`script/run.ts`);
   - nested calls through `ExtensionExecutionScope.invokeTool`;
   - nested calls from constructed tools (`construction/ctx-proxy.ts`).
2. **Gate.** `getToolExecutionOverride` (`packages/coding/src/agent-runtime/permission-gate.ts:31-67`) runs two checks in order:
   1. **Host events.** The host's `events.beforeToolExecute` runs first. Inside the KodaX Runtime this is
      `wrapKodaXEvents` (`src/sdk-runtime.ts:20366`; its `beforeToolExecute` is at `:21169-21291`). It applies, in order:
      1. tool ceiling;
      2. stop;
      3. full-access policy;
      4. auto-mode guardrail;
      5. accept-edits bash rule;
      6. plan mode;
      7. persisted grants;
      8. host authorization.
   2. **Extension hooks.** Extension `tool:before` hooks run second, through `runActiveExtensionHook`
      (`extensions/runtime.ts:1857-1863`). A hook may return `false` (cancel), a string (block with that
      message) or nothing (allow). See `extensions/types.ts:358-361`.
3. **Forced permission.** Some calls must be approved by a person even in full-access mode. Today that is a
   shell command flagged by Exec Policy, or bash in accept-edits mode. These go through
   `authorizeForcedPermission` → `authorizeTrackedPermission` (`src/sdk-runtime.ts:20436-20506`), which
   bypasses persisted grants and the full-access shortcut. The request reaches clients as a permission
   interaction. It already has a `reason` field (`src/sdk-runtime.ts:2988`), but nothing fills it in. With
   no answer, it is denied after 5 minutes (`src/sdk-runtime.ts:4091`).
4. **File writes.** `withFileMutation` (`tools/_internal/file-mutation-queue.ts:48-52`) refuses writes to a
   small hard set of agent-home directories in every permission mode. The hard set is `runtime`,
   `processes` and `learned` (`permissions/agent-home-policy.ts:221-229`). A larger "protected" set
   (`agent-home-policy.ts:7-12`) is enforced only by the auto-mode guardrails.
5. **Network.** `web_fetch` is a `reads-network` tool. It is not prompted in accept-edits, auto or
   full-access, and is blocked only in plan mode.

## 3. Gaps

| # | Gap | Evidence | Who is exposed |
|---|---|---|---|
| G1 | Extension `tool:before` does not run on every dispatch path | AMA calls the gate only when `options.events` is set (`task-engine/runner-driven.ts:2424`, `_internal/managed-task/agent-chain.ts:256`). Constructed tools call `executeTool` directly for nested calls (`construction/ctx-proxy.ts:143`). **Suspected, not yet proven:** in AMA, `withExtensionRuntimeContext` records the runtime only if it is a plain `KodaXExtensionRuntime` (`extensions/runtime.ts:1893`), and AMA never calls `bindActiveExtensionExecutionRuntime` (the single-agent path does, `run-substrate.ts:809`). A host that passes a combined session+global runtime (`src/host-integrations.ts`, the shape Space receives) may therefore get no extension hooks in AMA. | SDK embedders that run AMA without `events`. Constructed tools in every mode. If the suspicion holds, every host using per-session runtimes in AMA, including the official sandbox blocklist. |
| G2 | Policy hooks fail open and combine unpredictably | `KodaXExtensionRuntime.runHook` (`extensions/runtime.ts:996-1021`) catches a handler error, logs it and continues, so a crashing policy means "allow". The first handler that returns any value wins, so one extension's allow can hide another's deny. `CombinedExtensionRuntime.runHook` (`:1592-1601`) has the same problem. There is no timeout on `tool:before`; the only hook timeout is `turn:complete` (`middleware/extension-queue.ts:83`). | Anyone relying on an extension for policy. |
| G3 | The agent can install code and integrations for itself | `extensions` is in neither the protected set nor the hard set (`agent-home-policy.ts:7-12, 221-229`), so file tools can write `~/.kodax/extensions` in every mode. The Host loads every extension in that directory at startup with full trust (`src/host-integrations.ts:31-50`). `~/.kodax/integrations/{mcp,extensions}.json` (`packages/repl/src/common/integration-config.ts:106-110, 297-311`) is hot-reloaded into the running Host (`src/integration-hot-reload.ts:72-108`). An MCP entry spawns a process and an extension path loads code. `integrations` is only in the soft protected set. | Every host. A prompt-injected agent can plant code that runs with full privileges, at next start for `extensions/` and live for `integrations/`. |
| G4 | `web_fetch` can read cloud credentials | Bare `fetch(url)` after a scheme check (`tools/web-fetch.ts:76-91`). Redirects are followed unchecked, with no DNS or IP check. Not prompted in accept-edits or auto; auto mode treats it as read-only (`guardrails/auto-mode/permission-analyzer.ts:3076-3077`). On a cloud VM, `http://169.254.169.254/...` hands the machine's cloud credentials to any plain GET, so injected text can make the agent read them silently. Reaching localhost, the LAN or a VPC is intended and stays allowed, because the agent works on its user's network. The only address guard today is `src/a2a/safe-fetch.ts`, which `packages/coding` cannot import. | Hosts running on cloud VMs (CI runners, remote dev boxes, server embedders). |
| G5 | Unattended runs have no written contract | User questions wait forever by default (`DEFAULT_USER_INPUT_TIMEOUT_MS = 0`, `src/sdk-runtime.ts:4092`), so a job whose agent asks a question hangs. Permission requests time out after 5 minutes (`:4091`). Whether interactive "always allow" grants apply to a run started for a job is not documented. A run's permission mode follows its Session settings by design: a person can loosen or tighten a running run through any client (`:11921-11969`), and approving a plan switches it to accept-edits (`:11212-11225`). The agent cannot change its own mode. This is intended and stays, but hosts need to know it. | Hosts running scheduled or chat-triggered work. |
| G6 | Policy extensions can only block, never escalate to a person | `tool:before` returns `void \| string \| false`. A rule like "bulk delete needs approval" has to block outright (`extensions/official-sandbox.ts:156-180`). | Space (billable or risky tools, chat approvals), the official sandbox. |
| G7 | No proxy or custom-CA support | No runtime proxy or CA code. `undici` is a dev dependency only (`package.json:238`). The engines floor is `>=20.16.0` (`package.json:243-245`), and Node 20 global `fetch` ignores proxy environment variables. Most provider traffic goes through `globalThis.fetch` (Anthropic, OpenAI, Azure, native HTTP), but the Responses socket uses `ws` (`packages/llm/src/providers/responses-socket.ts:24`). The daemon freezes its environment at first spawn (`src/runtime-daemon/process.ts:871-925`). | Users behind corporate proxies or TLS inspection. |
| G8 | Windows daemon containment depends on runtime C# compilation, with no telemetry | `windows-job-supervisor.ts:465` compiles C# through PowerShell `Add-Type` on every launch, with a 15 s startup timeout (`:8`) and no fallback. Nothing records its latency or failures. | Windows hosts. Unknown impact until measured. |

## 4. Work packages

The packages are grouped into three phases. Phase 1 fixes behavior without adding public API. Phase 2
adds the small contract unattended hosts need. Phase 3 adds the `ask` seam. Each package starts with
failing tests (RED), as the project TDD rule requires.

### Phase 1: trust floor (no new public API)

#### WP1. Every tool call passes the policy gate (G1)

**Goal:** an extension `tool:before` decision applies on every dispatch path, in every permission mode.

**Steps:**
1. **Settle the suspected gap first.** Write a test that runs AMA with a `CombinedExtensionRuntime` built
   by `createHostIntegrations().createSession(...)`, using a blocking `tool:before` hook. If the block is
   not applied, fix `runManagedTaskViaRunner` (`runner-driven.ts:891-902`) to bind the active execution
   runtime as `run-substrate.ts:809` does. The other option is to let `withExtensionRuntimeContext` keep
   any `ExtensionRuntimeContract`. Note the conflicting evidence: `tests/bundled-mcp-output-recovery.test.mjs`
   (`host-denied-ama`) passes today, so it may use a plain runtime.
2. **Remove the `events` guards.** Replace `if (options.events)` at `runner-driven.ts:2424` and
   `events ? … : undefined` at `agent-chain.ts:256` with `options.events ?? {}` / `events ?? {}`. The
   single-agent path already does this (`run-substrate.ts:825`).
3. **Gate nested calls from constructed tools.** Route the nested calls in `construction/ctx-proxy.ts:143`
   through the checked-invoke path, so a constructed tool cannot reach tools the policy would deny.
4. **Write the contract matrix test.** Cover each dispatch origin against each permission mode:
   - dispatch origins: single-agent loop, AMA direct, AMA bridge target, child agent, script leaf call,
     nested `invokeTool`, constructed-tool nested call;
   - permission modes: plan, accept-edits, auto, full-access.

   In every cell, an extension `tool:before` block must stop the call. The `script_exec` entry stays
   exempt by design (`runner-driven.ts:2423`), because its leaf calls are gated.
5. **Check the bridge for double firing.** The bridge wrapper and its target may both reach the hook.
   Decide on one firing and test it.

**Tests:**
- `packages/coding/src/agent-runtime/permission-gate.test.ts` (new);
- `packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts`;
- the agent-chain bridge tests;
- a construction test next to `ctx-proxy.ts`.

**Compatibility:** embedders that run AMA without `events` will now have their extensions' `tool:before`
applied. That is the documented intent, and it gets a CHANGELOG note.

**Effort:** 3-5 days.

#### WP2. Policy hooks fail closed and combine predictably (G2)

**Goal:** a broken, slow or overridden policy hook never turns into "allow".

**Changes**, applied only to `tool:before`; other hooks stay fail-open, and that is documented:
1. Add a dedicated `runToolBeforeHook` in `extensions/runtime.ts`, implemented by both
   `KodaXExtensionRuntime` and `CombinedExtensionRuntime`. `permission-gate.ts:53-59` calls it.
2. **Evaluate every handler.** Stop using first-result-wins. The most restrictive result wins: block
   beats allow. After WP7, block beats ask, and ask beats allow. The block message names the extension
   (`handler.source.label`).
3. **A throwing handler blocks.** The message is `Extension "<label>" policy check failed: <error>`. It must
   not equal `CANCELLED_TOOL_RESULT_MESSAGE`, because the gate tells cancel and block apart by exact
   string. Keep `recordFailure`.
4. **Add a fixed timeout.** Define `TOOL_BEFORE_HOOK_TIMEOUT_MS` (proposed 10 s) next to
   `EXTENSION_TURN_COMPLETE_TIMEOUT_MS`. A timeout blocks, with a message that names the extension.
   There is no config option.

**Tests:**
- `extensions/runtime.test.ts`: both runtimes; throw, timeout, deny after allow; extension naming; other
  hooks still fail-open.
- `permission-gate.test.ts`: block versus cancel.

**Compatibility:** an extension that returned a truthy non-`false` value to "allow early" no longer stops
later handlers. That was never in the type contract.

**Effort:** 2-3 days.

#### WP3. The agent cannot install code or integrations for itself (G3)

**Goal:** nothing the model writes becomes trusted Host code or a live integration without a user action.

**Changes:**
1. Add `extensions` and `integrations` to the hard set in `isHardAgentHomeRelativePath`
   (`agent-home-policy.ts:221-229`). File tools then refuse these paths in every mode, including
   full-access.
2. Add both paths to `WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES` (`src/sandbox-runtime.ts:533`), which feeds the shell sandbox `denyWrite` list (`:4461-4516`). This covers
   bash wherever the sandbox is active. State the limit honestly in the docs: full-access bash without a
   sandbox is not covered by this change.
3. Leave skill directories as they are for now. A planted skill runs commands only when it is invoked,
   through `admitHook`. Record this as a known residual risk.
4. Check whether `getDefaultSkillPaths` ignoring `KODAX_HOME`
   (`packages/agent/src/capabilities/skills/types.ts:358-383`) is intended. If it is not, open an issue.
   That bug is out of scope here.

**Product consequence:** the agent can no longer "install an MCP server or extension for you" by editing
these files. Users do that through the CLI integration commands or the Space UI. This is the intended
trade.

**Tests:**
- `permissions/agent-home-policy.test.ts`: classification;
- a `withFileMutation` rejection test in full-access;
- a sandbox `denyWrite` case.

**Effort:** 1-2 days.

#### WP4. `web_fetch` cannot read cloud credentials (G4)

**Goal:** prompt-injected text cannot make `web_fetch` read the cloud metadata service. Localhost, LAN,
VPC and intranet targets stay reachable as they are today.

**Why not block all private addresses.** A full block would remove much of the tool's value: an agent
working for a person reads intranet docs, internal APIs and local dev servers. It would also buy little.
The dangerous pattern is "read something private, then send it out", and the sending step goes to a
public address. The same pattern works with a local file. The real control is the run's authority:
which tools and hosts an unattended job may use, and which actions need approval. That is the Space
mandate (a hostname allowlist enforced through `tool:before`) plus WP5 and WP7. The metadata service is
different: no legitimate `web_fetch` reads it, and a single read yields credentials.

**Changes:**
1. **Blocked set.** A small address check in `packages/agent/src/runtime/network-address-policy.ts`, so
   `coding` can import it. It blocks:
   - link-local `169.254.0.0/16` and `fe80::/10` (AWS, Azure, GCP, Oracle and Tencent Cloud metadata
     live here);
   - `fd00:ec2::254` (AWS IPv6 metadata);
   - `100.100.100.200` (Alibaba Cloud metadata).

   Confirm the provider list during implementation. Do not block the rest of `100.64.0.0/10`, because
   Tailscale and carrier NAT use it.
2. **Check the resolved address.** Resolve the hostname and refuse a blocked address. Connect to the
   validated address (pinning, as `src/a2a/safe-fetch.ts:126-170` does with `node:http(s)` and a custom
   `lookup`), so a DNS name or DNS rebinding cannot reach the metadata service.
3. **Check every redirect.** Follow at most 5 redirects manually and re-check every hop. Also refuse a hop
   from a public address into a private or loopback one. A redirect is the classic way around URL checks,
   and a fetch the model meant for a public page should not land on the intranet silently. This is a
   judgment call with rare legitimate use; drop it if it causes real problems.
4. **Proxy mode.** When WP6 enables a proxy, the proxy resolves names. In that mode, check only literal
   IPs and known metadata hostnames, and document that the guarantee is weaker.
5. **Keep the existing limits:** 12 s timeout and 512 KiB body cap (`web-fetch.ts:15-16`).
6. **No configuration option, no tool-description change.** Only the error text is new, so no prompt
   eval is needed. If a server-side embedder later needs a full private-range block, it can enforce one
   through `tool:before` or network controls.

**Out of scope:**
- `web_search`, which calls fixed endpoints;
- MCP transports, which use URLs from user config (protected by WP3);
- the extension fetch helper, because extensions are trusted code.

**Tests:**
- `network-address-policy.test.ts` (new), with a table of blocked and allowed addresses (including
  loopback, RFC 1918 and Tailscale-range addresses, which must stay allowed);
- `tools/web-fetch.test.ts`: a metadata IP, a hostname resolving to it, a redirect into it, a
  public-to-private redirect, and a direct private target that still succeeds.

**Effort:** 2-3 days.

### Phase 2: unattended-run contract

#### WP5. Unattended-run contract (G5)

**Goal:** hosts that run scheduled or chat-triggered work know exactly what the SDK does and what they
must do. No new run-authority API.

**Mode changes stay as designed.** A person may loosen or tighten a running run's permission mode in real
time; that is a deliberate product feature. The agent cannot change its own mode. A host that wants a
job's mode to stay put runs the job in its own Session and does not change that Session's settings.

**Changes:**
1. **Settle persisted grants.** Check whether persisted `allow_always` grants apply to a Run that carries
   an authorization record. Document the answer. Add an opt-out only if a host needs one and there is no
   way today.
2. **Write the "Unattended runs" section in `docs/CLIENT_CONTRACT.md`.** It covers:
   - one Session per job, and why (mode and history follow the Session);
   - deterministic `inputId` for idempotency, with no exactly-once guarantee across a Host restart
     (`CLIENT_CONTRACT.md:284, 291`);
   - the tool ceiling in `RuntimeExecutionAuthorization`;
   - mode semantics: Session setting changes apply to running runs; plan approval switches to accept-edits;
   - interaction handling: the host must answer or reject every interaction; set a non-zero
     `--permission-timeout-ms` and `--user-input-timeout-ms` (`src/kodax_cli.ts:3015, 3020`), because
     questions otherwise wait forever; one-shot runs dismiss input (`src/one-shot-task.ts:202-214`);
   - the daemon environment is frozen at spawn.

**Tests:** a grants test only if step 1 changes behavior. Otherwise this is documentation.

**Effort:** 1-2 days.

#### WP6. Network environment: proxies and certificates (G7)

**Goal:** KodaX works behind a corporate proxy and with a custom root CA. Either it supports them, or it
says clearly that it cannot.

**Steps:**
1. **Spike (2 days).** Measure on Node 20.16, Node 22 LTS and the Electron runtime Space uses:
   - whether global `fetch`, `ws`, MCP HTTP transports and provider SDKs honor `HTTPS_PROXY`/`NO_PROXY`;
   - whether `NODE_USE_ENV_PROXY` works;
   - whether `NODE_EXTRA_CA_CERTS` and the system-CA flag work.

   The version facts are from memory and still need confirming. Node 20 left LTS support on 2026-04-30.
   Env-proxy support for `fetch` arrived in Node 24 and was backported to 22.x. `NODE_EXTRA_CA_CERTS`
   works on every supported version.
2. **Decide in writing.** There are two options:
   - Raise the engines floor to a Node 22 release that has env-proxy support, and document the
     environment variables. This adds no new dependency.
   - Keep Node 20, add `undici` as a runtime dependency, and install `EnvHttpProxyAgent` as the global
     dispatcher at the CLI and daemon entry points (root `src`, not `packages/llm`, so `@kodax-ai/llm`
     stays standalone).

   The recommendation is the first option, unless the spike finds a blocker. Node 20 is already past
   end of life, and the first option keeps the SDK lighter.
3. **Do the work for both options.**
   - Give `responses-socket.ts` a proxy agent when a proxy is set.
   - Add a one-time startup warning when a proxy variable is set but the runtime cannot honor it.
   - Document that a Host must restart the daemon to apply proxy changes.

**Effort:** 2 days for the spike; 3-5 days to implement.

### Phase 3: escalation seam

#### WP7. `ask` result for `tool:before` (G6)

**Goal:** a policy extension can require a person's approval for a specific call, even in full-access
mode, instead of only blocking it.

**Design** (to be written up as ADR-071 before code):
1. **Type.** `tool:before` may also return `{ decision: 'ask'; reason: string }`
   (`extensions/types.ts:358-361`).
2. **Gate.** On `ask`, `permission-gate.ts` calls a new optional `KodaXEvents.requestToolApproval(call, reason)`
   (`packages/coding/src/types.ts:827-831`). If the member is absent, the call is blocked with a clear
   message (fail-closed). Anything except allow-once is treated as a block.
3. **Runtime.** `wrapKodaXEvents` implements the member with the existing `authorizeTrackedPermission`. This
   already bypasses grants and the full-access shortcut. It fills in the existing `reason` field and
   marks the call in `forcedPermissionCalls` so the user is not asked twice. Only `allow_once` is honored;
   session or persistent answers are downgraded to once. A timeout means deny (the existing 5-minute
   default).
4. **Daemon mode.** No new wire hop is needed. Extension hooks and `wrapKodaXEvents` run in the
   Run-owning process: the Host owns the extension runtime (`src/kodax_cli.ts:4601-4610`).
5. **Propagation.**
   - Forward the member in `buildChildEvents` (`child-executor.ts:2330`; `beforeToolExecute` is forwarded at `:2529-2545`).
   - Audit the places that rebuild `KodaXEvents` field by field, so they do not drop it:
     - `orchestration.ts:943-984`;
     - `src/trusted-coding-entry.ts:47-59`;
     - `skill-invocation-policy.ts`;
     - `script/pilot.ts`.
   - Add a test that fails if any of them drops the member.
6. **Negotiation.** Add the named capability `toolHookAsk: { version: 1 }` to the embedded capabilities
   (`src/sdk-runtime.ts:4345-4453`) and the daemon capabilities (`src/runtime-daemon/server.ts:2790-2860`).
   An old client that requires it gets `client_upgrade_required` instead of hanging.
7. **First in-tree caller.** The official sandbox asks, instead of blocking, for bulk deletes
   (`official-sandbox.ts:156-180`). The rule is narrow: recursive deletes, or deletes outside the
   workspace.
8. **Callers.** The ADR must name three real callers before implementation starts:
   - the official sandbox bulk-delete rule;
   - billable or high-risk Space host tools;
   - Space's chat-channel approval relay.

**Docs:** `docs/CLIENT_CONTRACT.md` (permission interactions, capability list) and the extension
authoring guide.

**Prompt impact:** none, unless a tool description is changed to explain approval outcomes. Any such
change needs ADR-033 review and an eval under `benchmark/EVAL_GUIDELINES.md`.

**Tests:**
- `permission-gate.test.ts`: ask → approve, deny, timeout, absent member;
- `extensions/runtime.test.ts`: block beats ask beats allow;
- `src/sdk-runtime.test.ts`: forced path, grants ignored, full-access does not skip, daemon mode,
  capability;
- `child-executor` forward.

**Effort:** 6-8 days.

### Side items

| ID | Item | Effort | Note |
|---|---|---|---|
| WP8 | Measure the Windows job supervisor (G8). Record `Add-Type` compile time, failures and timeouts through `emitKodaXDiagnostic`. | 0.5-1 day | Data first. A native or Rust supervisor is decided later, only if the numbers justify it. |
| WP9 | Move the official `read_pdf` extension off the legacy `api.exec` shell strings and onto `executeProcess` with fixed argv | 1-2 days | Lives in the `KodaX-Extensions` repository, not this worktree. |

## 5. Schedule

The schedule assumes one engineer working full time, starting Wednesday 2026-11-04. Estimates are
working days. These are planning numbers, not commitments.

| Week | Dates | Work | Exit check |
|---|---|---|---|
| 1 | Nov 4 - Nov 10 | WP1 (the combined-runtime test on day 1), WP2 | Contract matrix green; throw and timeout block |
| 2 | Nov 11 - Nov 17 | WP3, start WP4 | Agent writes to `extensions/` and `integrations/` refused in full-access |
| 3 | Nov 18 - Nov 24 | Finish WP4; WP6 spike; WP8 | `web_fetch` refuses metadata targets and public-to-private redirects, while intranet targets still work; proxy decision written |
| | **Nov 24** | **Release R1**: Phase 1 | Tag after a full local regression run (CI runs only on tags) |
| 4 | Nov 25 - Dec 1 | WP5; ADR-071 drafted with Space's named callers; start WP7 | `CLIENT_CONTRACT` unattended section; grants behavior settled |
| 5-6 | Dec 2 - Dec 15 | WP7; WP6 implementation; WP9 (Extensions repo) | `ask` works in-process and through the daemon; capability negotiated |
| | **Dec 15** | **Release R2**: Phases 2 and 3 | |
| 7 | Dec 16 - Dec 22 | Cross-platform checks (Windows, macOS, Linux), docs, buffer | Stable candidate |

**Total:** 22-33 working days, which is about 4.5-6.5 weeks for one engineer. Phase 1 plus the spike and WP8
is 10.5-16 days, and there are 15 working days before R1. Phases 2-3 plus WP6 and WP9 are 11-17 days,
and there are 15 working days before R2. Both releases have a little slack at the middle of the estimate;
at the upper end R2 slips by a few days, and week 7 absorbs that. Two people can compress the schedule:
WP1-WP3 and WP4 touch different files.

**Release vehicles** (needs your decision):
- **R1** contains fixes only, with no new public API. It could ship as `0.7.97-beta.2`, so Space picks it
  up during its current move to the 0.7.97 line. Or it could open `0.7.98-alpha.1`.
- **R2** adds public contract (`ask`, `toolHookAsk`), so it belongs in the 0.7.98 line.

**Tracking** (after approval):
- WP1-WP4 become issues in `KNOWN_ISSUES.md`, because they are defects.
- WP6 and WP7 become features, with proposed IDs FEATURE_303-304. Their design goes in
  `docs/features/v0.7.98.md`. WP5 is documentation in the same release.
- WP7 gets ADR-071.

## 6. Deliberately excluded

| Not building | Why |
|---|---|
| SDK scheduler or automations engine | In WorkBuddy the scheduler lives in the desktop shell's main process. Space already owns this design (F097). The SDK provides runs, sessions and idempotent inputs. |
| `registerChannel` or another chat-channel framework | Channels are shell adapters that speak the existing client contract. There are no three SDK-side callers. |
| Rewriting tool input in `tool:before` | It would change what was admitted and audited. The one real caller needs `ask`, not rewrite. |
| Plugin bundle format, marketplace, trust-tier field | Space already has two installer formats. A trust-tier field enforces nothing; trust is an install policy. |
| Managed Python or other auto-installed runtimes | A Space product non-goal. No hidden downloads. |
| Windows computer use | WorkBuddy's own computer-use host refuses non-macOS. A native helper needs code signing and a product decision. |
| Hash-chained audit log in the SDK | The audit that matters for unattended work belongs to the host that grants the authority (Space). |
| More hook events (`tool:after`, `prompt:submit`, `permission:request`, `session:*`), a Claude-protocol hook adapter, MCP `_meta` passthrough for MCP Apps, file checkpoints, grant TTL, `.claude/skills` discovery, run identity in the hook context | Each waits for a named caller. Most will likely come from Space once scheduling and channels exist. |

## 7. What Space gets, and when

| Deliverable | Release | Space uses it for |
|---|---|---|
| Gate coverage, fail-closed hooks | R1 | Trusting its policy extensions (and the official sandbox) in every run mode |
| Protected `extensions/` and `integrations/` | R1 | Unattended runs cannot self-install code or MCP servers |
| `web_fetch` cannot read cloud metadata | R1 | Untrusted web content in background jobs cannot pull machine credentials; intranet access unchanged |
| Proxy/CA decision and docs | R1 (decision), R2 (code) | A proxy settings screen; env injection at daemon spawn |
| Unattended-run contract | R2 | The rules Space's scheduler and channels follow (one Session per job, timeouts, idempotent inputs, grants) |
| `ask` + `toolHookAsk` | R2 | Approval for billable or risky tools; chat-channel approval relay |

## 8. Process rules for this work

- **TDD.** Write the failing test first in each package. Run vitest from the repository root; running it
  inside a package directory gives false failures.
- **Layering.** `llm → agent → coding → repl`, with root `src` on top. The network classifier goes in
  `packages/agent` so `coding` can use it. Nothing in `packages/*` may import from root `src`.
- **No new configuration options.** Timeouts and ranges are code constants.
- **Prompt changes.** Any change to LLM-facing text needs ADR-033 review and an eval. None is planned.
- **Docs to update:** `CHANGELOG.md`, `docs/CLIENT_CONTRACT.md` (WP5, WP7), `docs/SPACE_SDK_SEAMS.md` (new
  seams), and the extension authoring docs (WP2, WP7).

## 9. Risks

| Risk | Mitigation |
|---|---|
| The combined-runtime gap in AMA is real and wider than expected | It is tested on day 1. If it is real, it becomes the first fix and may move R1 by a few days. |
| Fail-closed hooks break buggy third-party extensions | Intended. The block message names the extension, so the cause is visible. |
| Blocking link-local addresses or public-to-private redirects breaks a rare legitimate target | The error message points to `bash`/`curl`, which go through normal permission checks. Drop the redirect rule if it causes real problems. |
| The proxy fix needs a new dependency | The preferred option (raise the Node floor) avoids it. The spike decides. |

## 10. Decisions needed from the product owner

1. **Release vehicle for R1:** `0.7.97-beta.2` (recommended, so Space gets the fixes in its current
   migration), or `0.7.98-alpha.1`.
2. **Node floor:** raise to Node 22 LTS if the spike confirms env-proxy support (recommended), or keep
   Node 20 and add `undici`.
3. **Protecting `integrations/`** means the agent can no longer add MCP servers by editing config. The
   recommendation is to accept this.
4. **Tracking:** register WP1-WP4 as issues and WP5-WP7 as features now, or after review.
