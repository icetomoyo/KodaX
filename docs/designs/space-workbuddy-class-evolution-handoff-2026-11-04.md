# KodaX Space: Evolving into an Always-On Office Assistant — Handoff to the Space Team (2026-11-04)

> **From:** KodaX SDK side. **To:** the KodaX Space team. **Status:** recommendations, not decisions.
> The Space team owns the plan, the order and the dates. Items in section 8 need a product owner's decision.
>
> **Baseline:**
> - Space `main` at `7801a8ca` (`0.1.47-alpha.3`, SDK pin `@kodax-ai/kodax@0.7.97-alpha.11`).
> - KodaX SDK `0.7.97-beta.1`.
>
> Space file references were read on 2026-11-03/04 and may have moved.
>
> **Companion document:** the SDK work this plan depends on is in
> [`sdk-foundation-hardening-plan-2026-11-04.md`](sdk-foundation-hardening-plan-2026-11-04.md) (KodaX repo).

> **SDK progress (2026-11-04):** the R1 fixes are implemented in the KodaX working tree but not yet
> released. They are recorded as Issues 378-381 in `docs/KNOWN_ISSUES.md`. The unattended-run contract
> (WP5) is in `docs/CLIENT_CONTRACT.md` under "无人值守运行". The `ask` result is drafted as ADR-071
> and waits for Space to confirm two callers: billable or high-risk Host tools, and the chat-channel
> approval relay (sections 4.4, 4.6 and 4.8). The proxy spike result is in section 4.10.

## 1. Summary

The product goal is that KodaX Space can do what Tencent WorkBuddy does:
- run jobs on a schedule;
- take requests from chat apps;
- work with office documents, a browser, knowledge bases and business connectors;
- keep working when the window is closed.

**Most of that is Space work, not SDK work.** WorkBuddy keeps its scheduler, chat gateway and keep-awake
logic in the desktop shell (Electron main process). Its agent engine just executes runs. KodaX is split
the same way: the SDK runs agents, and Space is the shell. So the scheduler, chat channels, tray
behavior, login item, credential UI and install policy all belong in Space.

**The SDK still has to provide a safe base for unattended work.** In two releases it will add:
- **R1:** gate coverage, fail-closed policy hooks, protected config directories, a `web_fetch`
  that cannot read cloud metadata, and a decision on proxy support. Target 2026-11-24.
- **R2:** a written contract for unattended runs and an `ask` result
  that lets policy require a person's approval. Target 2026-12-15.

**Space should not copy WorkBuddy's permission defaults.** WorkBuddy automations run with full access
and no approval UI by default. Its chat bot runs in a bypass-permissions mode. Section 4.2 proposes a
"mandate" model instead: an unattended job gets only the authority a person granted in advance.

**The first step is to catch up with the SDK** (section 3). Space is pinned two published releases back
and still registers several tools through a legacy path. Every workstream here assumes the current SDK
contract.

## 2. Where Space is today

| Area | Current state | Reference (Space repo) |
|---|---|---|
| SDK version | Pinned to `0.7.97-alpha.11`. The only adaptation plan targets an unpublished SDK commit (`f6a010462`) and is untracked. | `package.json:59`, `apps/desktop/package.json:16`, `docs/research/kodax-unified-host-space-adaptation-plan-2026-10-31.md` |
| Tool registration | Partner, artifact and control tools still use the legacy `registerTool` fallback. Only artifact, office, manual and `space_control` tools use Host tool leases. Partner is not admitted to the shared Host. | `kodax/real-session.ts:1615-1623`, `space-host-tools.ts:162`, `runtime-host-adapter.ts:3578` |
| Tray and background | Tray on Windows only. macOS keeps running without a tray. Linux exits when the last window closes. Close behavior is configurable (F140). No login item, `powerSaveBlocker` or `powerMonitor`. The daemon is requested as `'interactive'`; `'persistent'` exists but is unused. | `main.ts:390`, `main.ts:2079`, `runtime-host-adapter.ts:2372` |
| Scheduler | Designed (F097, v0.2.6) but not built. | `docs/features/v0.2.6.md` |
| Chat channels | No IM, bot or webhook code. The slot registry (F102) is shelved. | `PRD.md:659-660`, `PRD.md:411` |
| Office | Writing via `create_office_artifact` (JSZip/SheetJS). Reading only inside Partner (`partner_source_read` worker: mammoth, pdfjs, xlsx). F137 Native Document Skill Suite planned for v0.1.61. PPTX Studio (F129) planned for v0.1.67. | `office-writers.ts`, `docs/features/v0.1.61.md:439-457` |
| Browser | F050 Governed Browser Runtime planned for v0.2.0. ADR-007 prefers an in-process Space tool, with MCP as fallback. | ADR-007 |
| Knowledge | Partner-only SQLite FTS5/BM25 index. Not available as a tool to other sessions. F125-F128 and F117 planned. | `partner-knowledge-index.ts` |
| Connectors | F146 in progress: Feishu (bundled `feishu-cli`), WeCom, DingTalk, Tencent Meeting/Docs, IMAP, Notion, Airtable, Atlassian, Slack, Zoom, GitHub. Exposed as run-scoped `partner_connector_*` tools. Credentials in the OS keychain. Admin allow/deny policy. | F146 |
| Extensions and skills | Declarative Space Extension manifest (`hostApiVersion` 1-4; archives limited to `manifest.json` and `ui/index.html`). `.mcpb`/`.dxt` installer with a command allowlist. Vetted built-in skills (F135). Signing planned (F101, v0.1.72). SDK filesystem extensions are gated by `KODAX_SPACE_ENABLE_SDK_EXTENSIONS`, but see section 4.9. | ADR-003 |
| Permissions | Modes plan, accept-edits (default), auto and full-access. Immutable authorization snapshot per input. Persisted grants in `~/.kodax/permissions.json`. Admin policy audit store (F098). No concept of standing authorization for unattended runs. | `runtime-input-authorization-store.ts`, `admin-policy-audit-store.ts` |
| Network | No proxy or custom-CA support. | — |
| KodaX home | Space does not set `KODAX_HOME` by default, so the SDK uses `~/.kodax`, the same directory the user's KodaX CLI uses. | `apps/desktop/electron/kodax/data-paths.ts:83-130` |

## 3. Step zero: catch up with the SDK

**Why first.** Every later workstream relies on SDK contracts that exist only in `0.7.97-beta.1` or
later:
- the tool ceiling;
- `ask`;
- the `web_fetch` metadata guard;
- the unattended-run contract.

Tools on the legacy `registerTool` path sit outside the Host tool-lease model, so a per-run tool ceiling
cannot reason about them cleanly. Space should not claim a WorkBuddy-class capability until it runs on
a published SDK contract that has a test.

**Work:**
1. **Re-baseline the adaptation plan.** Re-baseline `kodax-unified-host-space-adaptation-plan-2026-10-31.md`
   against the published `0.7.97-beta.1` instead of the unpublished `f6a010462`. Keep its slices:
   - T0: freeze the contract;
   - T1: split install and exit evidence;
   - T2: single-connection startup;
   - T3: Partner bridge;
   - T4: Session writes via the Host;
   - T5: recovery and update;
   - T6: packaging gates.

   Re-check its blockers against beta.1:
   - B1: `RuntimeInlineOwnerHandle` removed;
   - B2: Partner admission;
   - B3: Partner default skill;
   - B4: queued authorization;
   - B5: exit evidence;
   - B6: installer restart race.
2. **Move the legacy tools to Host tool leases**, the way `space-host-tools.ts` already does for artifact
   and office tools. The legacy tools are:
   - Partner sources, knowledge and deliverables;
   - file proposals;
   - checkpoints;
   - helpers;
   - `space_control_*`.
3. **Admit Partner to the shared Host.**
4. **Plan the two SDK releases into the schedule** (R1 ~2026-11-24, R2 ~2026-12-15). Each is a normal SDK
   version bump.

**Done when:**
- Space runs on `0.7.97-beta.1` with no legacy `registerTool` fallback;
- the Space test suite and packaging gates pass;
- Partner runs through the shared Host.

## 4. Workstreams

Each workstream lists why it matters, what to build, what it needs from the SDK, and when it is done.

### 4.1 Always-on shell

**Why.** Scheduled jobs and chat requests only work if Space keeps running when its window is closed.
WorkBuddy does this from its desktop shell.

**Build:**
- **Tray.** A tray on macOS and Linux, matching Windows. Linux should not exit on last-window-close
  while always-on is enabled.
- **Login item.** An opt-in launch-at-login setting (`app.setLoginItemSettings`), off by default.
- **Keep-awake.** `powerSaveBlocker.start('prevent-app-suspension')` only while an unattended run is
  active, released when it ends. Do not keep the machine awake all the time.
- **Sleep and resume.** `powerMonitor` `suspend`/`resume` handling, so the scheduler can catch up after
  sleep (section 4.3).
- **Daemon lifecycle.** Request `daemonLifecycle: 'persistent'` when always-on is enabled. Keep
  `'interactive'` otherwise.
- **Close and quit.** Reuse F140's close behavior. Always-on must have an obvious "Quit completely" path
  and a visible indicator that background work is running.

**SDK needs:** none. These are existing Electron and SDK features.

**Done when:**
- with always-on enabled, closing the window leaves scheduled and channel work running;
- "Quit completely" stops it;
- after sleep and resume, missed jobs follow the catch-up policy;
- all of this holds on Windows, macOS and Linux.

### 4.2 Standing authorization ("mandate")

**Why.** A scheduled job or a chat message runs with nobody watching. Its authority has to be set in
advance by a person, and only a person may change it while the job runs.

WorkBuddy instead defaults automations to full access (`permissionMode ?? 'fullAccess'`, reason
`background-automation-no-approval-ui`). Its chat bot runs with permissions bypassed. Text from a web
page or a chat message can then steer an agent that holds full authority. That is the design choice
Space should not copy.

**Concept.** A mandate is a saved record that a person approves for one unattended source: a scheduled
job or a chat binding. It holds:
- the allowed tools (and connector actions);
- the permission mode the job starts in (recommended default: accept-edits; never full-access by default);
- the workspace roots;
- the hosts `web_fetch` and the browser may reach, including intranet hosts (see below);
- which actions must ask a person first;
- time and cost limits;
- an expiry date.

A mandate has revisions. Editing it creates a new revision, and the person must approve it again.

**Enforcement on every dispatch:**
- **Tool ceiling.** Pass the mandate's tools as the run's tool ceiling. `RuntimeExecutionAuthorization`
  supports this today.
- **Mode.** Start the run in the mandate's mode. By design, the SDK applies a person's mode change to a
  running run, so a user can loosen or tighten a job in real time; approving a plan also switches it to
  accept-edits. The agent cannot change its own mode. Three rules keep a job's mode meaningful:
  - **One Session per run.** Use a fresh Session for each unattended run. A Session the user also chats
    in would carry their interactive mode changes, settings and history into the job.
  - **No automated mode changes.** Chat adapters, schedulers and other Space automation never change a
    job Session's mode. Only a person in the UI does.
  - **Audit mode changes.** Record any mode change a person makes to a job's Session, with who and when.
- **Interactions.** Every permission or question interaction in an unattended run needs an answer:
  - route it to the mandate's approval channel (chat or desktop notification), or deny it;
  - use short timeouts, where a timeout means deny;
  - never leave a question waiting. SDK user questions wait forever by default.
- **Persisted grants.** Do not let "always allow" grants from interactive use apply to unattended runs.
  The SDK is checking whether this needs a new switch (SDK plan WP5).
- **Align the control tool.** Space's control tool assumes a run keeps the mode it started with
  (`space-control/tools.ts:46-49`), which is the opposite of the SDK's design. If a user switches a run
  to plan mid-run, that tool may still act under the old mode. Its actions are low-risk UI changes, but
  it should read the run's current mode. Check whether it already refreshes.
- **Revalidate before each run.** Check that the mandate is still valid and unchanged before each
  dispatch.
- **Network reach.** The SDK lets `web_fetch` reach localhost, the LAN and intranet hosts on purpose,
  because that is where much of a user's work lives. It blocks only cloud metadata. Which hosts an
  unattended job may reach is therefore the mandate's call. Enforce it with a Space `tool:before` policy
  that matches the URL's hostname against the mandate's allowlist. Hostname rules don't need the DNS
  defenses an IP-range rule does. This matters because the dangerous pattern is "read something
  private, then send it out", and the sending step goes to a public address.

**Audit.** For each run, record:
- mandate id and revision;
- trigger (job or message id);
- Session and run ids;
- every permission decision and who made it;
- the outcome.

Extend the existing admin audit store. Keep the audit outside `~/.kodax`, so an agent with file access
cannot edit its own record.

**SDK needs:**
- now: the tool ceiling;
- R2: the "Unattended runs" contract in `CLIENT_CONTRACT.md` and `ask` (for "must ask first" actions).

**Done when:**
- an unattended run cannot use a tool outside its mandate;
- its mode changes only when a person changes it, and the change is audited;
- every interaction gets an answer or a timeout denial;
- the audit shows who allowed what.

### 4.3 Scheduler (F097)

**Why.** Scheduled jobs are the core of an always-on assistant.

**Build F097 as already designed** in `docs/features/v0.2.6.md`:
- Space owns the job definitions and the wake-up logic;
- the SDK Runtime owns the runs;
- revisions are immutable;
- every dispatch has an idempotency key;
- each dispatch revalidates;
- missed runs are skipped or serialized.

**Additions:**
- **One mandate per job.** Show it to the user when they create the job.
- **Idempotent dispatch.** Derive a deterministic `inputId` from job id, revision and scheduled time,
  and pass it to `inputs.submit`. The SDK deduplicates on `sessionId + inputId`. It does not guarantee
  exactly-once delivery across a Host restart, so after a restart look up the `inputId` before you
  resubmit.
- **Catch-up policy.** Decide what happens to runs missed during sleep or while Space was closed: skip,
  run once, or run all, with a time window. WorkBuddy checks every 30 s and catches up runs missed within
  the last 24 h. That is a reasonable reference, not a requirement.
- **Concurrency.** At most one active run per job. A global limit on concurrent unattended runs.
- **Results.** Show results in Space (notification and history). Send them to a chat channel only if the
  mandate allows it.

**SDK needs:**
- now: the existing `inputs.submit` idempotency and sessions;
- R2: the unattended-run contract.

**Done when:**
- jobs run on time with the window closed;
- missed runs follow the policy;
- a restart never produces a duplicate run;
- every run is tied to a mandate revision.

### 4.4 Chat channels (IM)

**Why.** Many WorkBuddy users start work from a chat app instead of opening the desktop app.

**Product decision needed first** (section 8): `PRD.md:659` says Space has no mobile client. A chat bot is
not a mobile client, but it serves the same need.

**Recommended approach:**
- **Feishu first**, reusing F146's Feishu credentials and the bundled `feishu-cli`. DingTalk and WeCom
  can come next. Defer personal WeChat and global channels.
- **No public webhook.** Prefer Feishu's long-connection (WebSocket) event subscription, which needs no
  inbound port on the user's machine. Check the Feishu Open Platform docs and tenant settings before
  committing to this.
- **Pairing.** A chat user is bound to the Space user with a one-time code shown in Space.
- **Sender binding.** Only bound senders can trigger work.
- **Group chats.** Off by default. If enabled, require an @mention from a bound sender.
- **Mandate per binding** (section 4.2). Never full-access.
- **Delivery.** Each message becomes `inputs.submit` with `inputId` = the platform message id, so a
  redelivered message is not run twice.
- **Approvals in chat.** When a run hits an `ask`, post an approve/deny card to the bound sender. Only
  that sender can answer. A timeout means deny.
- **Untrusted input.** Treat inbound text as untrusted. The mandate's tool limits, not the prompt, keep a
  forwarded malicious message from doing damage.
- **Output.** Reply with a summary and a reference. Do not upload local files unless the mandate allows
  it.

**Not an SDK feature.** A channel adapter is Space code that uses the existing client contract (inputs,
interactions, events). The SDK will not add a `registerChannel` API.

**SDK needs:**
- R1: the `web_fetch` metadata guard;
- R2: `ask` (approval relay).

**Done when:**
- a bound Feishu user can start a job and approve or deny an action from Feishu;
- unbound senders and group messages are ignored;
- redelivered messages do not run twice.

### 4.5 Office documents

**Why.** Office files are the most common input and output of office work.

**Build:**
- Continue F137 (Native Document Skill Suite, v0.1.61) and F129 (PPTX Studio, v0.1.67).
- Make document reading available beyond Partner. Expose a read-only Host tool lease that uses the
  existing `partner_source_read` worker (docx, pdf, xlsx), so general sessions and scheduled jobs can
  read office files.
- Keep auto-installing Python or LibreOffice out of scope (`v0.1.61.md:451`).

**SDK needs:** none. A separate fix in the KodaX-Extensions repo moves the official `read_pdf` extension to
safe process execution.

**Done when:** a non-Partner session can read and write docx, xlsx and pdf through Host tools.

### 4.6 Browser

**Why.** Many office tasks happen in web applications.

**Build F050 as planned** (v0.2.0, ADR-007), with these additions for unattended use:
- a separate browser profile for agent use;
- a per-mandate domain allowlist;
- `ask` before submitting forms, logging in, paying or sending.

**SDK needs:** R2 `ask`.

**Done when:** an unattended run can browse only allowed domains, and every submit-type action waits for
approval.

### 4.7 Knowledge search

**Why.** "Answer from my documents" is a common request, and today only Partner has a knowledge index.

**Build:**
- A read-only knowledge search Host tool lease over the existing FTS5 index, available to Coder and
  general sessions (F125-F128, F117).
- Start with keyword search. Add a vector index only if there is a measured need.

**SDK needs:** none.

### 4.8 Connectors (F146)

**Why.** Connectors let jobs act on Feishu, WeCom, DingTalk, mail and other business systems.

**Build:** continue F146, with these rules:
- every connector tool goes through Host leases and the mandate's tool ceiling;
- write or billable actions require `ask` in unattended runs, unless the mandate allows them explicitly.
  Examples: send a message, create a meeting, send mail.

**SDK needs:** R2 `ask`.

### 4.9 Extension and skill trust policy

**Why.** In-process extensions run with full Node privileges. No sandbox isolates them. WorkBuddy's own
mod sandbox (a Node `vm` realm) is not a security boundary either. So whether to allow third-party code
is a trust decision, not a technical one.

**What the Space team needs to know about the SDK:**
- **The extensions directory loads unconditionally.** At startup the SDK Host loads every extension in
  `<KODAX_HOME>/extensions` (`src/host-integrations.ts:31-50`). The
  `KODAX_SPACE_ENABLE_SDK_EXTENSIONS` flag does not change this.
- **Integration config is live.** The Host watches `<KODAX_HOME>/integrations/mcp.json` and
  `extensions.json` and applies changes while running (`src/integration-hot-reload.ts`).
- **Space shares this directory with the CLI.** Space does not set `KODAX_HOME` by default, so its
  `KODAX_HOME` is `~/.kodax`, the same directory the KodaX CLI uses. Extensions and MCP servers the user
  installs for the CLI also load into Space's Host.
- **The agent can write these paths today.** Until SDK R1, an agent with file-write access can write
  into these paths. R1 blocks agent writes to `extensions/` and `integrations/` in every permission mode.

**Recommended policy:**
- **Tier 1, built-in (vetted).** First-party code, shipped with Space (F135).
- **Tier 2, signed.** After F101 signing exists.
- **Tier 3, user-local.** Explicit consent and a visible warning.
- **Third-party code.** Third-party publishers get declarative skills and MCP servers only. No in-process
  code until signing exists.
- **The shared directory.** Never install third-party code into `<KODAX_HOME>/extensions`. Decide
  whether Space should use its own `KODAX_HOME`, so the CLI's extensions do not load into Space. If Space
  keeps the shared home, show the user which extensions and MCP servers are loaded.

**SDK needs:** R1 (protected directories, fail-closed policy hooks).

### 4.10 Proxy and certificates

**Why.** Corporate users often sit behind a proxy or TLS inspection with a private root CA. Today neither
works.

**Build:**
- A proxy and CA settings screen.
- **Environment injection at spawn.** Space passes `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS`
  into the daemon environment when it spawns the daemon. It also passes any switch the SDK decision
  requires, such as `NODE_USE_ENV_PROXY`.
- **Restart on change.** The daemon's environment is fixed at spawn, so changing the settings must
  restart the daemon.

**SDK needs:** the WP6 decision (R1) and code (R2). The SDK will either raise its Node floor to a version
that honors proxy variables or install a proxy dispatcher.

**Spike result (2026-11-04).** Space's daemon runs on Electron 42.5.0, which embeds Node 24.17.0. On that
runtime, with `NODE_USE_ENV_PROXY=1`, `fetch`, `http`/`https` and both model SDKs go through
`HTTPS_PROXY` and respect `NO_PROXY`; `NODE_EXTRA_CA_CERTS` works for HTTPS and WSS. So Space can
ship the settings screen and spawn-time injection without waiting for the SDK. The one SDK gap is the
OpenAI Responses WebSocket (`ws`), which connects directly until FEATURE_303 lands. Details are in
`docs/features/v0.7.98.md` (KodaX repo).

### 4.11 Not now

- **Bundled Python or other auto-installed runtimes.** This stays a product non-goal.
- **Computer use (desktop control) on Windows.** WorkBuddy's computer use is macOS-only. A Windows version
  needs a signed native helper and a security review. Revisit after the browser work, if users ask for it.
- **A Space backend** (accounts, cloud relay, share links, a marketplace). Stay local-first at least until
  the first chat channel ships.

## 5. What Space gets from the SDK, and when

Dates are the SDK team's plan, not commitments.

| SDK release | Target | Contents | Unblocks in Space |
|---|---|---|---|
| `0.7.97-beta.1` | available | Current Host contract, tool ceiling, input idempotency | Step zero |
| R1 (`0.7.97-beta.2` or `0.7.98-alpha.1`) | ~2026-11-24 | Policy gate on every dispatch path; fail-closed policy hooks; agent cannot write `extensions/` or `integrations/`; `web_fetch` refuses cloud-metadata addresses and public-to-private redirects (intranet stays reachable); proxy decision | 4.9 trust policy; background jobs can read untrusted web content without exposing machine credentials |
| R2 (`0.7.98` line) | ~2026-12-15 | "Unattended runs" section in `CLIENT_CONTRACT.md`; `ask` result for policy hooks with `toolHookAsk` capability; proxy support | 4.2 mandate; unattended 4.3; 4.4 approvals; 4.6 and 4.8 approvals; 4.10 |

**What `ask` looks like to Space.** A policy extension (Space's own, or the official sandbox) returns `ask`
for a tool call. The SDK then raises a normal permission interaction, with its `reason` field filled in.
This happens even in full-access mode, and stored "always allow" grants are ignored. Space answers it the
same way it answers any permission interaction:
- only "allow once" is honored;
- a timeout means deny.

A client that requires `ask` must check the `toolHookAsk` capability. Older Hosts answer with
`client_upgrade_required`.

**Space must name its `ask` uses.** The SDK will only build `ask` against three named uses:
- the official sandbox's bulk-delete rule;
- Space's billable or high-risk tools;
- Space's chat approval relay.

Please confirm the second and third, with concrete tool names, before ~2026-11-25.

## 6. Suggested order for Space

The Space team should set its own dates. This is the dependency order.

| Stage | Can start | Contents | Exit |
|---|---|---|---|
| S0 | Now | Step zero (beta.1 adoption, legacy tool migration, Partner admission); product decisions (section 8); always-on shell basics (4.1) | Space on beta.1; always-on works on 3 OSes |
| S1 | After R1 | Trust policy (4.9); proxy settings (4.10); scheduler (4.3) for **attended** jobs only (a person approves each run's interactions) | Jobs run on schedule; no third-party in-process code |
| S2 | After R2 | Mandates (4.2); **unattended** jobs; Feishu channel (4.4); approvals for browser and connectors (4.6, 4.8) | An unattended job and a chat request each run inside a mandate, with audit |
| S3 | After S2 | Office read beyond Partner (4.5); knowledge search tool (4.7); more channels | Wider coverage |

## 7. What not to build

| Don't | Why |
|---|---|
| Full access by default for scheduled or chat-triggered runs | Untrusted text (web pages, forwarded messages) can steer the agent. The mandate limits the damage. |
| A public webhook server inside the desktop app | It opens an inbound port on user machines. Use long-connection event APIs. |
| A second plugin format or an untiered marketplace | Space already has two installer formats. Trust tiers are install policy. |
| Requests for an SDK scheduler or channel API | They belong in the shell. Ask the SDK for contracts (tool ceiling, `ask`, events) instead. |
| Auto-installed Python or LibreOffice | A product non-goal. Hidden downloads hurt trust and support. |
| Marketing "fully unattended" before mandates and audit ship | It conflicts with `PRD.md:660` and with the safety model. |

## 8. Decisions for the product owner

Some of these conflict with current Space documents, which would need updating:
- `PRD.md:659` (no mobile client);
- `PRD.md:660` (no "fully unattended" marketing);
- `PRD.md:411` (external triggers only an observation item);
- `FEATURE_LIST.md:183` (WorkBuddy modes out of scope);
- `docs/features/v0.1.30.md:311` (not WorkBuddy parity);
- ADR-007:48.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Should Space become always-on (tray-resident, runs jobs with the window closed)? | Yes. Login item opt-in, off by default. | This is the core of the product shape. Scheduling and chat depend on it. |
| 2 | Default authority for unattended runs | A mandate per job or binding. Bash and network only if the mandate grants them. Never full-access by default. | WorkBuddy's full-access default is its riskiest choice. A mandate keeps most of the value with a bounded blast radius. |
| 3 | First chat channels and market | Feishu first, then DingTalk and WeCom. Defer personal WeChat and global channels. | Official bot APIs with pairing and sender binding. F146 already has Feishu credentials. |
| 4 | Windows computer use | Defer. | WorkBuddy's is macOS-only. Large effort, needs signing, no concrete caller. |
| 5 | Backend scope (accounts, relay, share links, marketplace) | Local-first. Revisit a thin self-hosted relay after the first channel ships. | Nothing through S2 needs a backend. It would compete with shell work for the same team. |
| 6 | Third-party in-process extensions | Not until signing. Third parties get skills and MCP only. | In-process code has no isolation boundary. |
| 7 | Pause new feature work for SDK adoption | Yes. Adopt beta.1 first. | Every workstream assumes the current contract. Legacy tools cannot be governed by the tool ceiling. |

## 9. Open checks before building

These were not verified during the analysis.

**KodaX and Space:**
1. Does Space's daemon have a single `KODAX_HOME` for all profiles? What does sharing `~/.kodax` with the
   CLI mean for the user's existing extensions and MCP servers?
2. Does Feishu's long-connection event mode work for the tenant types Space targets, without a public
   callback URL?
3. Does a deterministic `inputId` behave as expected when the Host restarts between dispatch and
   acknowledgement? (`CLIENT_CONTRACT.md` makes no exactly-once promise.)
4. On Windows, does the daemon keep its job-object containment when the UI window closes during a run?
5. The negative checks (no login item, power API or proxy code) only covered `apps/desktop/electron`.
   Check the rest of the repository.

**WorkBuddy behavior** (for calibration only; run in an isolated profile, never against personal data):
1. An automation with default settings fires with the window closed. Record its permission mode,
   missed-run catch-up and concurrency.
2. In a chat-bot (Claw) session, record the permission mode, group behavior and whether approvals reach
   the chat.
3. What happens on an approval timeout during an unattended run.
4. Missed runs after system sleep, and keep-awake behavior.
5. Proxy, PAC and custom-CA behavior.

## 10. References

**KodaX repository:**
- `docs/designs/sdk-foundation-hardening-plan-2026-11-04.md` (SDK plan and schedule);
- `docs/CLIENT_CONTRACT.md` (client contract; the "Unattended runs" section arrives in R2);
- `docs/SPACE_SDK_SEAMS.md` (Space-SDK seams).

**Space repository:**
- `docs/features/v0.2.6.md` (F097 scheduler);
- `docs/features/v0.1.61.md` (F137 documents);
- ADR-007 (browser);
- ADR-003 (extensions);
- `docs/research/kodax-unified-host-space-adaptation-plan-2026-10-31.md` (adaptation plan, untracked).
