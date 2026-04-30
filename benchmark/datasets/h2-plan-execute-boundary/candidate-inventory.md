# H2 Plan-Execute Boundary Eval — Grounded Candidate Inventory

> **Status**: Working document for FEATURE_107 P1.5 redo. Replaces the speculative `cases.ts` from commit 165fc0d.
>
> **Purpose**: Catalogue every reasonable H2 candidate from three KodaX-internal sources (unimplemented planned features, open issues, completed features) with **explicit, identical criteria** for inclusion. Output is reviewed before final dataset selection.

## Selection criteria (applied uniformly to every candidate)

A candidate qualifies as `H2 ✓` iff it satisfies all four:

| Criterion | Pass when |
|---|---|
| **Multi-file** | Requires modifying ≥3 files **OR** creating new module spanning ≥2 packages |
| **Bounded scope** | Completable in single session — not multi-version sprawling |
| **Has acceptance** | Design doc or issue description gives clear pass/fail signal |
| **Reproducible** | Pre-task SHA + repo state can be checked out (`git cat-file -e <sha>`) |

Rating:
- `✓` — meets all 4
- `?` — meets 3/4, requires P1.5 review
- `✗` — fails ≥2, exclude

Below, when a row is `✗` or `?`, the **specific failed criterion** is named (not a vague verdict). This is the protection against gut-feel filtering.

---

## Pool 1: Unimplemented Planned Features (post-v0.7.31)

KodaX shipped v0.7.31; features planned for v0.7.32+ are genuinely unimplemented. SHA = HEAD (current) since these would be implemented forward from now.

| ID | Title | v# | Multi-file? | Bounded? | Has AC? | Repro? | Verdict | Failure / Note |
|---|---|---|---|---|---|---|---|---|
| 090 | Self-Modifying Role Spec (Tier 4) | v0.7.32 | ✓ ≥5 files in `coding/construction/` + tests + audit log | ✓ — single feature | ✓ — `v0.7.32.md` lists 5 reflexive safeguards as AC | ✓ HEAD | **✓** | strong candidate |
| 092 | Auto Mode Classifier (LLM-reviewed) | v0.7.33 | ✓ — guardrail wiring + policy gate + classifier provider | ✓ | ✓ — `v0.7.33.md` per design | ✓ HEAD | **✓** | depends on 085 (shipped); risk of conflating with 085 |
| 097 | AMA Realtime Todo List | v0.7.34 | ✓ — TodoListSurface + onTodoUpdate + tool registration | ✓ | ✓ — has component spec | ✓ HEAD | **✓** | UI-heavy; cross-package (coding + repl) |
| 094 | Anti-Escape Hardening | v0.7.36 | ✓ — guardrail + retry contract + tests | ✓ | ✓ | ✓ HEAD | **✓** | similar safeguard genre to 092 |
| 102 | Multi-Provider Orchestration Runtime | v0.7.45 | ✓ — telemetry + routing + fallback (4 phases) | **✗ multi-version** (4 phases per design) | partial | ✓ HEAD | **✗** | Bounded fails — sprawling 4-phase delivery |
| 105 | Verifiable Advisor Consult | v0.7.46 | ✓ — primitive + tracing + 4-field verdict | ? — Phase 1 alone is bounded; full feature is 3 phases | ✓ for Phase 1 | ✓ HEAD | **?** | Use **Phase 1 primitive only** as scope |
| 093 | Coding↔REPL Circular Dep Decoupling | v0.8.0 | ✓ — touches both packages structurally | ? — depends how deep (could be mechanical or architectural) | partial | ✓ HEAD | **?** | needs design-doc check on bounded |
| 007 | Theme System Consolidation | v0.8.0 | ? — likely mostly repl package | ✓ | ? | ✓ HEAD | **?** | Multi-file uncertain |
| 030 | Multi-Surface Delivery | v0.8.0 | ✓ — packaging + binaries + IDE-extension | **✗ multi-version sprawling** | ✗ | ✓ HEAD | **✗** | Bounded fails |
| 057-Track F | Cell-level diff renderer | in-flight | ✓ — substrate/ink rewrite | ✓ | ✓ | ✓ HEAD | **✓** | currently in-progress; replay risks colliding with active work |
| 060 | Bounded-Memory Runtime | v0.7.30 | ✓ | ? | ✓ | ✓ HEAD | **?** | Status unclear post v0.7.30 release |

**Pool 1 verdict counts**: ✓ = 5, ? = 4, ✗ = 2. Subtotal viable: **5 strong + 4 borderline = 9**.

---

## Pool 2: Open Issues (24 entries, excluding won't-fix #126)

From [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md). All status=Open. SHA = HEAD (issue still exists).

| ID | Title (truncated) | Pri | Multi-file? | Bounded? | Has AC? | Verdict | Failure / Note |
|---|---|---|---|---|---|---|---|
| 082 | packages/ai 缺少单元测试 | Low | ✓ — many files | ✗ — sprawling test backfill | ? | **✗** | Not a bounded H2 task |
| 091 | 缺少一等公民 MCP/WebSearch/CodeSearch 工具体系 | High | ✓ | ✗ — multi-version platform work | partial | **✗** | Bounded fails |
| 092 | Team 模式 + 原生多 Agent 架构 | High | ✓ | ✗ — architectural multi-version | partial | **✗** | Bounded fails |
| 093 | 缺少 IDE/Desktop/Web 分发表面 | Low | ✓ | ✗ — platform expansion | ✗ | **✗** | Same as Planned 030 |
| 094 | 核心工作流文件函数过大 | Med | ✓ — many files | ✗ — code-quality sprawling | ? | **✗** | Not bounded |
| 095 | Agent/REPL 主流程重复编排 | Med | ✓ | ? | ? | **?** | Need to read full description |
| 096 | 类型边界过宽且共享可变状态较多 | Low | ✓ | ✗ — code-quality sprawling | ✗ | **✗** | Same family as 094 |
| 097 | 错误处理、阻塞 I/O 副作用清理 | Med | ✓ | ✗ — sprawling | partial | **✗** | Same family |
| 098 | 重复 helper / 魔法数字收敛 | Low | ✓ | ✗ | ✗ | **✗** | Same family |
| 099 | 测试辅助代码重复 | Low | ✓ | ✗ | ✗ | **✗** | Same family |
| 105 | kodax -c 历史不注入 LLM context | Med | ✓ — resume + context paths | ✓ | ✓ — issue describes "what good looks like" | **✓** | strong candidate |
| 106 | Managed-task worker blocks text-coupled | High | ✓ — protocol + parser + emitters | ✓ | ✓ | **✓** | strong candidate; protocol drift fix |
| 107 | harnessProfile 类型命名残留 | Med | ✓ — types + emitters + tests | ✓ | ✓ — explicit "replace with worker-chain" | **✓** | rename-style refactor; could be small if mechanical |
| 108 | ACP server 链路未接入 MCP | High | ✓ — ACP + MCP + bridge | ✓ | ✓ | **✓** | strong candidate; integration work |
| 109 | 缺少 mcp_get_prompt 工具 | Low | ✓ — tool def + handler + types | ✓ | ✓ | **✓** | small but valid bounded task |
| 110 | 缺少 /mcp status / refresh REPL 命令 | Low | ✓ — command + handler + UI | ✓ | ✓ | **✓** | bounded; cross repl + coding |
| 111 | SSE/Streamable HTTP MCP 缺测试 | Low | ✓ — test files | ✓ | ? — "add tests" with which coverage? | **?** | AC vague |
| 112 | ask_user_question 不完备 | High | ✓ — input + multiSelect + UI | ✓ | ✓ — issue lists missing modes | **✓** | strong; UX feature gap |
| 118 | esbuild 打包替代 tsc | Med | ✓ — build config + scripts + CI | ✓ | ✓ | **✓** | bounded; build-tooling H2 |
| 119 | Scout H0→H1 残留 mutationSurface | High | ✓ — task-engine paths | ✓ — specific bug | ✓ | **✓** | strong candidate; real bug |
| 120 | Skill/Plan-mode 流式注入失效 | High | ? — likely few files | ✓ | ✓ | **?** | Multi-file uncertain |
| 122 | edit/multi_edit 错误消息过度精简 | Med | ? — likely tools/ + tests | ? | ✓ | **?** | Borderline single-file |
| 124 | AMA 子 Agent dispatch 触发率偏低 | High | ✓ — controller + gate + tool whitelist | ✓ | ✓ — issue analyzes 2 root causes | **✓** | strong candidate |
| 125 | Thinking-mode cross-provider replay 待实证 | Low | ✓ — provider adapters | ✗ — investigation, not fix | ✗ | **✗** | Not a fix task |

**Pool 2 verdict counts**: ✓ = 11, ? = 4, ✗ = 9. Subtotal viable: **11 strong + 4 borderline = 15**.

---

## Pool 3: Completed Features (sample, NOT exhaustive)

80 completed features total. Exhaustive analysis is overkill — sample chosen to cover:
- Recent (v0.7.x) — easier git archaeology
- Different categories (refactor / new-feature / cross-cutting)
- Different scopes

Selected sample (10 entries) — others can be added in P1.5 if coverage matrix shows gaps:

| ID | Title | Released | Type | Notes |
|---|---|---|---|---|
| 046 | AMA Handoff Integrity (artifact-backed) | v0.7.x | new-feature, cross-pkg | Has design + acceptance criteria; impl commit identifiable |
| 047 | Invisible Adaptive Parallelism | v0.7.x | new-feature, cross-cutting | Tactical fan-out infra |
| 052 | Dual-Profile AMA Harness | v0.7.x | new-feature, cross-cutting | SA/AMA boundary |
| 061 | Scout-First AMA Architecture Simplification | v0.7.16 | refactor (massive) | The very thing FEATURE_107 is testing — meta but valid |
| 062 | Managed Task Budget Simplification | v0.7.16 | refactor, single-pkg | Bounded; clear pre/post |
| 072 | Lineage-Native Compaction | v0.7.x | refactor, cross-cutting | Compaction subsystem rewrite |
| 076 | Round-Boundary Message Shape | v0.7.x | refactor, single-pkg | Bounded scope |
| 084 | Layer A Agent/Handoff/Runner Adoption | v0.7.26 | refactor (large) | May be too sprawling — verify in P1.5 |
| 085 | Guardrail Runtime | v0.7.26 | new-feature, cross-cutting | Bounded primitive |
| 100 | SA Runner Frame Adoption | v0.7.29 | refactor (large) | Listed Critical priority; multi-phase per design — may fail bounded |

Each requires P1.5 work to:
1. Find exact impl commit SHA via `git log --all --grep "FEATURE_NNN"`
2. Capture parent SHA → pre-feature state
3. Run `git show <impl-sha> --stat` → ground-truth files-changed
4. Cross-reference with design doc acceptance criteria

**Pool 3 status**: 10 sampled, none deeply verified yet. Estimated 60% will pass bounded check → 6 viable. P1.5 to verify.

---

## Coverage matrix (Source × Type, with viable counts)

Using only `✓` candidates (P1.5 review may promote `?` → `✓`):

|                   | new-feature | refactor | bug-fix / quality-fix | cross-cutting | row total |
|---|---|---|---|---|---|
| **Planned**       | 097, 057-F  | (none ✓) | 094 (anti-escape)     | 090, 092      | **5** |
| **Open Issues**   | 109, 110, 112, 108, 118 | 107 | 105, 106, 119, 124 | (none clean ✓) | **11** |
| **Completed**     | 046, 047, 085 | 062, 076 | (none of sample) | 052, 072 | **~6** (after P1.5 verify) |
| **column total**  | **9** | **3** | **5** | **5** | **22 viable** |

### Coverage gap analysis

- **Refactor cell underpopulated** in Planned and Completed-sample. Mitigation: include 107 (rename refactor) from Issues; consider 062/076 from Completed; if still thin, mine more Completed features tagged "refactor" in design docs.
- **Bug-fix in Completed**: zero in sample because most bugs go to KNOWN_ISSUES.md, not FEATURE_LIST.md. This is an inherent skew — bug-fix coverage relies on Open Issues (which is fine, that's what they're for).
- **Cross-cutting in Open Issues**: zero clean ✓. Most cross-cutting Open issues fail bounded (092 team mode, 091 first-class tooling, 094 file-too-big family). Mitigation: rely on Planned (090, 092) and Completed (052, 072) for cross-cutting.

### Distribution check

If we pick **18 final cases** with target ~4-5 per type column (9+3+5+5 = 22 candidates → pick 18):
- new-feature: 4-5 cases (subset of 9 candidates)
- refactor: 3 cases (all 3 candidates, possibly add 1 more)
- bug-fix: 4-5 cases (subset of 5)
- cross-cutting: 4-5 cases (subset of 5)

This is balanced and **does not require fabricating any case**.

---

## What this inventory does NOT cover

- **Plan-complexity dimension** (linear / branching / iterative): not yet tagged per candidate. Would need design-doc deep read for each.
- **Existing-code-dependency dimension** (greenfield / extension / modification): not yet tagged. Mostly trivial post-design-read.
- **Subjective quality of "user prompt"**: each picked case will need a userMessage authored. The userMessage should paraphrase the issue/feature description, NOT be invented.

These secondary dimensions become relevant in P1.5 selection, not for the viable/non-viable filter.

---

## Process from here (proposed)

1. **You review this inventory** — challenge any rating, especially `?` rows where I marked criteria as uncertain
2. **You signal which Pool sources to prioritize** — e.g., "issues over completed" or "include all of Pool 1 ✓"
3. **I do P1.5 verification for the picks**:
   - Each case: read design doc / issue detail in full; lock acceptance criteria
   - Each Completed case: identify impl commit + parent SHA + files changed
   - Author userMessage from source material (no invention)
   - Resolve `?` ratings to `✓` or `✗`
4. **Output**: rewritten `cases.ts` replacing the 165fc0d speculative version

**No code changes** until step 4. This document + your sign-off is the gate.

---

## Honest caveats about this inventory

- **Multi-file column is preliminary**: I tagged based on issue title + design-doc skim, not full file-path enumeration. P1.5 will lock this.
- **Bounded column relies on design-doc claims**: some "✓ bounded" features may turn out larger when implementing — but at design-time-truth they are bounded, which is what eval needs.
- **Has-AC column is "can I find a pass criterion"**, not "criteria are unambiguous". P1.5 may downgrade some `✓` → `?` if criteria turn out to be narrative without verifiable assertion.
- **My ratings can be wrong**: this artifact is for you to overrule. Each row's failure reason is named so you can verify or challenge it.
