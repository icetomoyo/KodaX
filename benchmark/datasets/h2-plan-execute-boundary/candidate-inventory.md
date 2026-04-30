# H2 Plan-Execute Boundary Eval — Grounded Candidate Inventory

> **Status**: Working document for FEATURE_107 P1.5 redo. Replaces the speculative `cases.ts` from commit 165fc0d.
>
> **Purpose**: Catalogue every reasonable H2 candidate from three KodaX-internal sources (unimplemented planned features, open issues, completed features) with **explicit, identical criteria** for inclusion. Output is reviewed before final dataset selection.

## Selection criteria (applied uniformly to every candidate)

A candidate qualifies as `H2 ✓` iff it satisfies all five (criterion 5 added per codex review HIGH#2):

| Criterion | Pass when |
|---|---|
| **Multi-file** | Requires modifying ≥3 files **OR** creating new module spanning ≥2 packages |
| **Bounded scope** | Completable in single session — not multi-version sprawling |
| **Has acceptance** | Design doc or issue description gives clear pass/fail signal |
| **Reproducible** | Pre-task SHA + repo state can be checked out (`git cat-file -e <sha>`) |
| **Agent-doable in worktree** *(codex#2)* | No external service / network / build-infra dependency. Worktree-isolated eval has `bash:network` disabled |

Rating:
- `✓` — meets all 5
- `?` — meets 4/5, requires P1.5 review
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

---

## P1.5 verification of `?` rows (deep-check after design doc / issue detail read)

Each ? row got resolved by reading the design doc / issue detail in full.

| ID | Source | Original ? | Verification finding | New verdict |
|---|---|---|---|---|
| **F-105** | Planned (v0.7.46) | Phase 1 vs full feature ambiguous | Design explicitly scopes MVP to "tool 文件 + capability alias + 2 mode prompt 模板, < 800 LOC". Phase 1 is bounded; Phases 2/3 are post-MVP benchmark-driven. | **✓** (Phase 1 scope only) |
| **F-093** | Planned (v0.8.0) | Multi-file + bounded uncertain | Design doc reveals: FEATURE_082 (v0.7.24) **already cleared 49/50 cycles**. Only 1 cycle remains. Scope too small for H2. | **✗** (scope shrunk to near-trivial) |
| **F-007** | Planned (v0.8.0) | Multi-file + AC uncertain | Design has 4 explicit goals (replace hard-coded colors / theme persistence / `/theme` commands / cleanup legacy). Multi-file confirmed (`ThemeContext` + chalk migration + commands). | **✓** |
| **F-060** | Planned (v0.7.30) | Bounded uncertain | Design doc Status field: **"Completed (Tier 1 landed; profile-driven stretch goals deferred)"**. Already shipped — should not be in Planned pool. | **✗** (already completed) |
| **I-095** | Issue (Med) | Multi-file uncertain | Issue body: "Source Debt IDs H38-H44, M39" (7 debt items). "Sprawling code-quality debt" — not bounded. | **✗** (bounded fails) |
| **I-111** | Issue (Low) | AC uncertain | Issue body: only `transport.ts` test coverage; estimated 1-2 test files. **Too small for H2** — borderline H1/H0. | **✗** (multi-file fails) |
| **I-120** | Issue (High) | Multi-file uncertain | Issue body: "约 30 行集中在 InkREPL.tsx" — **single-file 30-line fix**. Bounded ✓ but multi-file ✗. | **✗** (multi-file fails) |
| **I-122** | Issue (Med) | Multi-file uncertain | **Issue is already fixed** at commit `4423e0d` (verified ancestor of HEAD). Doc lag — issue still marked Open in KNOWN_ISSUES.md but bug is gone. | **✗** (already resolved) |

### Updated viable counts after P1.5 verification

| Pool | Original ✓ | After verify | Δ |
|---|---|---|---|
| **Planned post-v0.7.31** | 5 | **6** | +1 (gained 105, 007; lost 060, 093) |
| **Open Issues** | 11 | **11** | 0 (all 4 ? resolved to ✗) |
| **Completed (sample)** | ~6 (estimated) | TBD | needs git archaeology |
| **Total viable** | 22 | **17 + ~6** | **~23** |

Picking 18 final cases is still feasible, though tighter than before.

### Updated coverage matrix (after verification)

|                   | new-feature | refactor | bug-fix / quality-fix | cross-cutting | row total |
|---|---|---|---|---|---|
| **Planned**       | 097, 057-F, 105, 007 | (none ✓) | 094 | 090, 092 | **7** |
| **Open Issues**   | 109, 110, 112, 108, 118 | 107 | 105, 106, 119, 124 | (none clean ✓) | **11** |
| **Completed**     | 046, 047, 085 | 062, 076 | (none of sample) | 052, 072 | **~6** |
| **column total**  | **~12** | **3** | **5** | **5** | **~25 viable** |

---

## Self-audit of this framework (Q4 from user)

The user asked me to seriously challenge the framework I built, since they cannot independently evaluate it. Below is my honest critique of my own work, ordered by severity. Mitigations are noted but not all are actionable inside FEATURE_107 scope.

### A. The 4-criteria filter is my construct, not validated against any reference

I picked **multi-file / bounded / has-AC / reproducible** as the gates. I did not:
- Reference an external eval-design best-practice document
- Define why these 4 and not others (e.g., "agent-doable without external services" is missing)
- Validate the criteria against pilot eval runs

What I did do: chose criteria that would mechanically filter out clearly non-H2 cases. They work as a coarse filter but they're not principled.

**Mitigation possible**: Add "agent-doable" as a 5th criterion (no external auth/account/billing). May not change current verdicts.

**Mitigation NOT possible inside FEATURE_107 scope**: Validate criteria against external eval framework — would require pilot runs.

### B. Multi-file threshold ≥3 is arbitrary

I picked 3. Could be 2, could be 5. There is no principled choice.

If we tightened to ≥5, several Issue ✓ rows (109, 110) would become ✗ — they pass at 3 but fail at 5. The viable pool would shrink to ~18 from ~25.

**Mitigation**: Document the threshold explicitly with rationale "≥3 because 1-2 file tasks usually H1; ≥3 forces planning consideration." Acknowledge sensitivity.

### C. The `?` bucket was an escape hatch

8 ? rows let me defer hard calls in v1 of the inventory. The verification step closed them all — but a stricter upfront rubric would have produced better v1.

**Mitigation**: For future inventories, force binary ✓/✗ at v1 with explicit "needs-data" flags rather than ? bucket.

### D. Source × Type matrix bakes in an unproven assumption

The whole reason I structured by Source × Type is so that P5 analysis can slice eval results by category. **This presumes type-specific lossiness exists**. We don't know that.

If type doesn't matter, balancing by type is wasted effort and a random sample of viable H2 cases would be statistically cleaner.

**Mitigation**: Document the assumption. Run P5 analysis BOTH with and without type slicing. If type-slicing shows no differential, conclude "type doesn't matter for plan/execute lossiness" — that's also a valuable finding.

### E. Pool 3 sample is cherry-picked

I picked 10 "representative" Completed features by intuition. Not random, not exhaustive.

A truly random sample from 80 might give different distribution. An exhaustive scan (all 80 with the same filter) would be most defensible but costs 6+ hours.

**Mitigation**: Document sampling method. Acknowledge selection bias. If user wants fully random or exhaustive, they should ask.

### F. "Has AC" is my inference, not the source's gift

Many issues describe complaints, not specifications. I marked "has AC" when I could derive a pass/fail criterion from the description. **That criterion is mine**, not the issue author's.

This is a bias multiplier — agents will be evaluated against criteria I invented based on issues someone else wrote.

**Mitigation**: When authoring final cases.ts, lift acceptance criteria text VERBATIM from issue/design-doc where possible. Mark explicitly when I had to add inference.

### G. HEAD-anchored cases drift over time

Pool 1 (Planned) and Pool 2 (Issues) cases anchor SHA = HEAD. Eval runs today vs 6 months later differ.

**Mitigation**: Pin SHA to current HEAD at P1.5 time. Document "cases reproducible against SHA `<X>`; later SHAs may give different results."

### H. The whole exercise is solo work without external review

No second reviewer. No external eval-framework benchmark. I'm reasoning from first principles + Anthropic harness blog + Claude Code's Agent docs.

Could be missing standard eval-design wisdom that someone with experience would catch.

**Mitigation possible**: Send the inventory + framework to `codex-rescue` agent for an independent second-opinion review pass.

### I. The deepest critique: FEATURE_107 may be testing the wrong question

P1.0 scan showed: KodaX user (you) had **0 H2 sessions in 533**. Even if we get this eval right, the answer's real-world impact on your workflow is small.

Counter-argument I made earlier: "architectural value matters even if frequency is low." That's true but weak — we may be investing significant effort to answer a question whose answer doesn't change much in practice.

A more relevant question might be: "Why does H2 trigger so rarely? Is the threshold wrong?" — that's a totally different eval (about Scout's classification calibration, not plan/execute boundary).

**Mitigation NOT possible inside FEATURE_107 scope**: this would require restarting from FEATURE_107's framing question.

**Mitigation possible**: Frame eval results conservatively in P5 — "B vs A on synthetic+inferred H2 distribution; not validated against organic user H2 distribution because no organic H2 data exists."

### J. "Refactor" cell is structurally underpopulated

After verification, refactor cell has only 3 candidates (Issue 107 + Completed 062, 076). Even all-3-picked gives only 3 cases for refactor — too few for sub-category statistics.

**Mitigation**: Either (a) accept refactor as small-sample or (b) deliberately mine more refactor-class Completed features — would expand Pool 3 archaeology cost.

### K. The frame still trusts my judgment on non-? rows

I deep-checked the 8 ? rows. The 22 non-? rows (✓ or ✗) **were not deep-verified**. Some ✓ rows (e.g., I-119 Scout mutationSurface, I-124 dispatch trigger rate) may have hidden problems I didn't catch.

**Mitigation**: When authoring final cases.ts, do a P1.5b pass that deep-reads each picked candidate before locking. Find any disqualifiers before they pollute the dataset.

---

### Summary of what self-audit changes vs my original framework

| Concern | Magnitude | Actionable within FEATURE_107? |
|---|---|---|
| A — criteria validation | Medium | Add "agent-doable"; document choice |
| B — ≥3 threshold arbitrary | Low | Document + acknowledge sensitivity |
| C — ? bucket | Low | Already closed by verification |
| D — type-balanced sampling | **High** | Run P5 analysis without type slicing too |
| E — Pool 3 sampling | Medium | Document; let user request fuller scan |
| F — AC inference | Medium | Use verbatim text where possible |
| G — HEAD drift | Low | Pin SHA at P1.5 |
| H — solo work | Medium | Get codex-rescue second-opinion review |
| I — wrong question | **High** | Conservative P5 framing |
| J — refactor underpopulated | Medium | Accept small sample OR mine more |
| K — non-? rows not deep-checked | Medium | Add P1.5b deep-check pass |

### Things the self-audit does NOT solve

- I cannot make this framework "objectively correct"
- I can only make it **as defensible as a single agent's careful work allows**
- The user retaining final approval rights remains the primary safeguard against my errors

---

## Pool 3 archaeology — actual findings (replaces estimate)

Original estimate: ~6 viable Completed features. **Reality: 2-3.**

### Why the gap

`git log --all --grep="FEATURE_NNN"` shows **only 10 features** have ≥3 commits with explicit FEATURE-tag in commit messages:

```
52  FEATURE_100  (multi-phase SA Runner, sprawling)
14  FEATURE_086  (prefix cleanup hygiene)
13  FEATURE_084  (Layer A primitives, sprawling)
 8  FEATURE_107  (this feature — self-reference, exclude)
 4  FEATURE_104  (Prompt-Eval Harness)  ← clean
 3  FEATURE_101  (Admission Contract — bundled with 106 in 51ba874)
 3  FEATURE_098  (Per-Model Context Window) ← clean
 3  FEATURE_085  (Guardrail Runtime — bundled with 084 in edec529)
 3  FEATURE_077  (older Skills work)
 3  FEATURE_061  (mostly later evolution touches)
```

**The other ~70 completed features did not reference their FEATURE_NNN in commit messages** — typical KodaX commits use feature-area scope tags like `feat(coding):` or `refactor(repl):`. So git-archaeology via grep doesn't reach them.

### Per-candidate verdict (after archaeology)

| ID | First impl SHA (parent for replay) | Files changed | Clean? | Verdict |
|---|---|---|---|---|
| **F-104** Prompt-Eval Harness | `c68ddee^` (parent of c68ddee) | 15 files: `benchmark/harness/*` + `benchmark/datasets/*` + docs + package.json | ✓ clean 4-commit chain | **✓** |
| **F-098** Per-Model Context Window | `dc7c38b^` (parent of dc7c38b) | ~10 files in `packages/ai/` + docs | ✓ clean coherent series | **✓** |
| **F-101** Admission Contract | `51ba874^` (parent) | sprawling: core + coding + benchmark + multiple datasets + 2 follow-up patches | bundled with FEATURE_106; cross-package broad | **?** scope too broad to be clean H2 case |
| **F-085** Guardrail Runtime | `edec529^` (parent) | bundled with FEATURE_084 in same commit; cannot cleanly extract just 085's diff | extraction fail | **?** bundle problem |

The 6 originally sampled but NOT in mineable list (046, 047, 052, 061, 062, 072, 076, 084) — drop from Pool 3.

### Updated viable count (final)

| Pool | Original ✓ | After all verification | Δ |
|---|---|---|---|
| Pool 1 (Planned post-v0.7.31) | 5 | **7** | +2 (105/007 promoted) |
| Pool 2 (Open Issues) | 11 | **10** | -1 (recount, unchanged after ?-verify) |
| Pool 3 (Completed) | ~6 estimate | **2** | -4 (most untraceable via grep) |
| **Total viable** | ~22 | **19** | -3 |

19 viable → can pick 18 with 1-case slack. Tight but feasible. Per FEATURE_107 doc's "dataset shortfall fallback" rule, this is in the "≥18" zone (no scaling needed).

### Codex review HIGH findings — incorporated 2026-04-30

External `codex-rescue` agent did independent review. Three HIGH findings actioned:

| Finding | Action taken | Where |
|---|---|---|
| **#1 Perf gate misses context-window** | Promoted context window peak from P4 secondary to **P2 mandatory gate**; B-path × 1.10 vs A-path; B撞 cap 触发 P2 阻断而非 P4 排除 | `v0.7.32.md` 性能退化零容忍节 updated |
| **#2 Missing "agent-doable" criterion** | Added criterion 5 to selection filter; re-rated I-108, I-118, I-119 below | (this file, criteria block above + table below) |
| **#3 Shortfall cutoff statistically baseless** | Reframed as "effect-size threshold not p-value"; eval declared exploratory not confirmatory; cannot claim "no difference" at this N | `v0.7.32.md` 新增 "Eval 信号定性" + 修订 "Dataset 不足 fallback" |

Plus 3 MEDIUM findings:
- **#4 Source × Type confound (codex)**: My self-critique D understates — Pool 3 only contributes new-feature/refactor cells, never bug-fix → structural source-type confound. **Action**: P5 analysis runs both type-sliced (with confound disclaimer) and unsliced (primary signal); see v0.7.32.md
- **#5 I-119 not deep-checked**: Verified — `mutationSurface` symbol exists at HEAD (59 occurrences) but [runner-driven.ts:1136-1141](packages/coding/src/task-engine/runner-driven.ts#L1136) explicitly handles "stale pre-Scout snapshot". Likely silently fixed during FEATURE_100/084 refactor; KNOWN_ISSUES.md doc lag. **Action**: I-119 demoted to ✗
- **#6 Pool 3 estimates were speculation**: Original "~6 viable" was guess; actual archaeology yielded 2. Already corrected in commit 1ac51d0; previous "~6" claims stripped from coverage matrix.

Plus 2 LOW findings:
- **#7 Severity I (wrong question) mitigation is reporting patch**: Acknowledged. Pre-registered as "construct validity limitation" rather than P5.5 review item.
- **#8 Severity D may be MEDIUM not HIGH**: Acknowledged — type imbalance is symmetric across A/B so cancels in primary contrast.

### P1.5b second-pass demotions (post-codex)

After applying criterion 5 + verifying I-119:

| ID | Original verdict | New verdict | Reason |
|---|---|---|---|
| **I-108** ACP–MCP integration | ✓ | **✗** | Requires running real MCP server endpoints; criterion 5 fails |
| **I-118** esbuild swap | ✓ | **✗** | Requires `npm install esbuild` over network + build-infra change; criterion 5 fails |
| **I-119** Scout H0→H1 mutationSurface residual | ✓ | **✗** | Likely silently fixed in FEATURE_100/084; comments at runner-driven.ts:1136 explicitly handle pre-Scout snapshot |

### Final viable count (after all critique applied)

| Pool | Pre-codex ✓ | Post-codex ✓ | Δ |
|---|---|---|---|
| Pool 1 (Planned) | 7 | **7** | unchanged (no criterion-5 fails) |
| Pool 2 (Issues) | 10 | **7** | -3 (I-108, I-118, I-119) |
| Pool 3 (Completed archaeology) | 2 | **2** | unchanged |
| **Total viable** | 19 | **16** | -3 |

**16 viable < 18 target** → falls into `12-17` zone of dataset-shortfall fallback. Eval will be run with **16 cases**, framed exploratory (effect-size only, no significance claims), P5.5 marks limitation.

Per user's hard constraint "如果实在找不到，不做过度的事情": **do not invent, do not pull cross-project, do not lower thresholds**. 16 is what the data supports honestly.

### Updated coverage matrix (final)

|                   | new-feature | refactor | bug-fix / quality-fix | cross-cutting | row total |
|---|---|---|---|---|---|
| **Planned**       | 097, 057-F, 105, 007 | (none ✓) | 094 | 090, 092 | **7** |
| **Open Issues**   | 109, 110, 112 | 107 | 105, 106, 124 | (none clean ✓) | **7** |
| **Completed**     | (none) | 098 | (none) | 104 | **2** |
| **column total**  | **7** | **2** | **4** | **3** | **16** |

**Type-distribution acknowledgment** (codex#4 confound): Pool 3 has 0 bug-fix → all bug-fix cases come from Pool 2. Pool 1 has 0 refactor → refactor pulls from Pool 2 (107) + Pool 3 (098). This means Source×Type slice is structurally confounded; P5 will run unsliced as primary analysis.

### Pool 3 specific cases for cases.ts

See P1.5b deep-check below for verbatim files / AC.

---

## P1.5b — deep-check pass (each ✓ candidate verified against design doc / issue source)

> **Purpose** (from codex review #K): the 22 ✓ rows pre-codex (now 16 post-codex) had only their failure criterion tagged; the actual content was not deep-verified. P1.5b reads each design doc / issue full-text to confirm multi-file claims, extract verbatim acceptance criteria, and catch hidden disqualifiers. 3 more demotions found.

### Pool 1 deep-check (7 → 5)

#### F-090 Self-Modifying Role Spec (v0.7.32) — ✓
- **Files** (from `v0.7.32.md` design): construction/runtime.ts (extend) / sandbox-runner.ts (extend) / new divergence-score module / new SelfModifyGuardrail middleware / new audit log writer / CLI commands `kodax constructed rollback|audit|disable-self-modify` + tests for all. **≥7 files across 3 areas** ✓
- **Bounded**: design's 5 reflexive safeguards section + Release Criteria checklist all single-version ✓
- **AC verbatim** (from v0.7.32.md §Release criteria):
  > 所有 5 条反身稳定保障机制实装 + 测试绿; 至少一组端到端 self-modify scenario 跑通; 至少 3 组 adversarial case 被拦截; `_audit.jsonl` 格式稳定能 replay/rollback
- **Agent-doable**: ✓ no external service
- **Replay SHA**: HEAD-at-eval-time
- **Verdict**: ✓

#### F-092 Auto Mode Classifier (v0.7.33) — ✓ (with framing note)
- **Files**: new auto-mode-guardrail middleware + Tool interface extension in `packages/coding/src/tools/types.ts` + 1 CLI command + tests. Plus the design says "本版一次性给现有所有工具补齐 toClassifierInput (约 20-30 个)". **20-30 file mechanical migration is a follow-on, the H2 essence is the guardrail+classifier core (3-4 files)**
- **Framing for eval**: userMessage focuses on classifier core; mustTouchFiles the 3-4 core; mustNotTouchFiles include all existing tools (don't expand scope)
- **Bounded**: ✓
- **AC verbatim**: 3-tier decision chain (Tier 1/2/3); `<block>yes|no</block>` parsing; 8s timeout; circuit breaker on 5 errors / 10min; degrade to engine=rules
- **Agent-doable**: ✓ classifier needs LLM provider but eval cells already provision provider
- **Verdict**: ✓ (with framing constraint to avoid scope blowup)

#### F-097 Realtime Todo List (v0.7.34) — ✓ (with eval limitation)
- **Files**: types.ts (TodoStatus/TodoItem) / todo-store.ts (NEW) / todo_write tool / TodoListSurface.tsx (NEW) / protocol-emitters extension / tests. **≥5 files across coding + repl** ✓
- **Bounded**: ✓
- **AC verbatim**: 0-1 todos→no render / ≥2→expanded / 5s delay hide on completion / per-owner in_progress isolation / content+activeForm dual-format / 符号 `☐ ⏺ ✓`
- **Agent-doable**: ✓
- **Eval limitation**: UI rendering not directly verifiable in worktree (no runtime React render). Judge can verify component file structure + props passed but not actual visual output. **Acceptance criteria must downgrade visual checks to structural checks** in eval framing.
- **Verdict**: ✓ (with eval-scope downgrade for visual rendering)

#### F-094 Anti-Escape Hardening (v0.7.36) — ✓
- **Files**: `coding/src/tools/anti-escape-guardrail.ts` (NEW) + integration into ToolGuardrail registration + tests + protocol-emitters integration. **3-4 files** at criterion threshold
- **Bounded**: ✓
- **AC verbatim** (from v0.7.36.md):
  > beforeTool 在 bash 工具上检测 4 条签名 (heredoc 边界 + ≥80 行/≥3000 字符 + 写入项目 tree + 计算性内容白名单); block 时返回 structured retry contract hint with `write` 或 `multi_edit` 指引
- **Agent-doable**: ✓ pure runtime detection
- **Verdict**: ✓

#### F-057 Track F (v0.7.30 in-flight) — ✗ (DEMOTED in P1.5b)
- **Original concern**: in-flight; replay risks colliding with active work
- **P1.5b finding**: design doc explicitly marks Track F "mandatory v0.7.30 deliverable, not deferrable"; if it ships before eval P4, the case becomes "do something already done" → no replay value. If it doesn't ship by eval, agent might collide with parallel implementation work, contaminating both eval and active dev.
- **Reproducibility (criterion 4)**: HEAD state ambiguous between "task not done" and "task done" depending on timing
- **Verdict**: ✗ (demoted) — in-flight conflict makes replay unstable

#### F-105 Verifiable Advisor Consult Phase 1 (v0.7.46) — ✓
- **Files**: `consult-advisor.ts` (NEW) + capability-alias additions + 2 advisor mode prompt templates + trace span definition + tests. **≥5 files** ✓
- **Bounded**: ✓ design explicitly scopes MVP to "<800 LOC, single-advisor primitive, NO Council"
- **AC verbatim** (from v0.7.46.md):
  > Phase 1 ship primitive: AdvisorAdvice 4-field 强类型 (recommendation/advice/verification/risk); cross-family 默认 preference; trace span 14 字段全收 (advisor_provider/model/tokens/verification_outcome/etc); "advice not instruction" 防御标记
- **Agent-doable**: ✓ uses internal capability profile
- **Verdict**: ✓

#### F-007 Theme Consolidation (v0.8.0) — ✗ (DEMOTED in P1.5b)
- **Original concern**: scope sprawl risk
- **P1.5b finding**: design's "Replace hard-coded terminal colors with theme tokens" + "migrate command/status output from scattered chalk.* calls" — `chalk` 在 KodaX repo 全文 grep 出现的位置预估 50+ 处。即便有 ThemeContext + 4 个明确 goal，**实际工作量是 50+ 文件 mechanical migration**，远超 H2 case 范畴。
- **Bounded fails**: 不是单 session 可完成的工作
- **Verdict**: ✗ (demoted)

**Pool 1 internal review** (post-P1.5b): 5 ✓ + 2 ✗ (was 7 ✓). Demotions are F-057 Track F (in-flight conflict) and F-007 (scope sprawl beyond H2). Both reasoned, neither overlap with codex findings.

### Pool 2 deep-check (7 → 6)

#### I-105 kodax -c history not injected (Med) — ✓
- **Files** (from issue Code Path Analysis): `src/cli_option_helpers.ts` + `packages/repl/src/ui/InkREPL.tsx:3527` + `packages/coding/src/agent.ts:959,979` + `packages/coding/src/task-engine.ts:4091`. **4-5 files across cli/coding/repl** ✓
- **Bounded**: ✓ single bug
- **AC verbatim**: kodax -c auto-load latest session; history inject as initialMessages; UI shows `[Continuing session: xxx]` banner
- **Agent-doable**: ✓
- **Verdict**: ✓

#### I-106 Managed-task structured worker blocks text-coupled (High) — ✗ (DEMOTED in P1.5b)
- **Original concern**: high priority, looked H2-shaped
- **P1.5b finding**: issue body says "Resolve in phases under FEATURE_059 Managed Task Structured Protocol V2" with 4 sub-phases. **FEATURE_059 was absorbed into FEATURE_084** (shipped, see [FEATURE_LIST.md](docs/FEATURE_LIST.md) line 82). FEATURE_084 explicitly migrated "fenced-block 文本协议替换为 tool-call 驱动的结构化协议" — likely silently resolves the core text-coupling. KNOWN_ISSUES doc lag (same pattern as I-119/I-122).
- **Bounded fails**: even if not resolved, multi-phase span
- **Verdict**: ✗ (demoted)

#### I-107 harnessProfile naming residue (Med) — ✓
- **Files** (verbatim from issue): types.ts (5x), reasoning.ts (29x), task-engine.ts (106x), provider-policy.ts (4x), agent.ts (1x), tests (~90x). **237 references across 10 files**
- **Bounded**: ✓ rename refactor, mechanical
- **AC verbatim**: 4-step plan in issue body — workerChain replaces harnessProfile / preserve as derived label / route logic uses workerChain / 237 refs updated
- **Agent-doable**: ✓
- **Concern**: scale is large (237 refs) but mechanical sed-replace is single-session
- **Verdict**: ✓

#### I-109 missing mcp_get_prompt tool (Low) — ✓
- **Files** (from issue Context): `packages/coding/src/tools/mcp-get-prompt.ts` (NEW, "和现有 4 个 MCP 工具同构") + tools registration + tests. **3 files**
- **Bounded**: ✓
- **AC verbatim**: 与 mcp_call/mcp_read_resource/mcp_describe/mcp_search 同构 (5th MCP tool)
- **Agent-doable**: ⚠️ tests need MCP runtime context. Issue says "和现有 4 个 MCP 工具同构" so existing test patterns can be followed without live MCP server.
- **Verdict**: ✓ (small but valid)

#### I-110 missing /mcp commands (Low) — ✓
- **Files** (from issue): `packages/repl/src/interactive/commands.ts` (extend) + status sub-command + refresh sub-command + tests. **2-3 files in repl package only**
- **Concern**: single-package 2-3 file at threshold
- **Bounded**: ✓
- **AC verbatim**: status subcmd 调用 `extensionRuntime.getDiagnostics()`; refresh subcmd 调用 `refreshCapabilityProviders()`
- **Verdict**: ✓ (smallest H2 case in dataset, threshold)

#### I-112 ask_user_question incomplete (High) — ✓
- **Files** (from issue): tools/ask_user_question.ts + InkREPL.tsx Select component (L4152-4196) + new use-select-navigation.ts hook + new MultiSelect component + tests. **≥5 files across coding + repl**
- **Bounded**: ✓
- **AC verbatim**: 上下箭头导航 + Enter 确认（去数字编号） + multiSelect 空格切换 + ✓ 标记 + 三种 mode (single/multi/input)
- **Agent-doable**: ✓
- **Verdict**: ✓

#### I-124 AMA dispatch trigger rate low (High) — ✓
- **Files**: controller fanout gate (`packages/coding/src/orchestration.ts` 或 `task-engine.ts`) + Generator/Scout role-prompts + H1 tool whitelist + tests. **≥4 files**
- **Bounded**: ✓ specific behavior change
- **AC verbatim**: H1 read-only Scout/Generator can fan-out; H2 write Generator can fan-out; managed plan/systemic 调研可并行 child task; Rule A/B/C 仍由 LLM 自主判断不强制
- **Agent-doable**: ✓
- **Verdict**: ✓

**Pool 2 internal review** (post-P1.5b): 6 ✓ + 1 ✗ (was 7 ✓). One demotion (I-106) — same doc-lag pattern as I-119 (likely silently resolved by an upstream feature ship).

### Pool 3 deep-check (2 → 2)

#### F-104 Prompt-Eval Harness — ✓
- **Replay SHA**: parent of `c68ddee` (first impl commit)
- **Files (objective from `git show c68ddee b79b7ed 0a3a30f 5873dde --stat`)**:
  - `benchmark/harness/aliases.ts` (NEW)
  - `benchmark/harness/harness.ts` (NEW)
  - `benchmark/harness/judges.ts` (NEW)
  - `benchmark/harness/persist.ts` (NEW)
  - `benchmark/harness/report.ts` (NEW)
  - `benchmark/harness/self-test.test.ts` (NEW)
  - `benchmark/datasets/README.md` (NEW)
  - `benchmark/datasets/.gitkeep` (NEW)
  - `benchmark/results/.gitignore` (NEW)
  - `benchmark/README.md` (NEW)
  - `package.json` (add `npm run test:eval`)
- **Bounded**: ✓
- **AC verbatim** (from v0.7.29.md FEATURE_104 design):
  > harness/aliases 提供 8 个 coding-plan provider/model 短名表; harness/harness 提供 runOneShot/runABComparison/runBenchmark; judges 提供 mustContainAll/Any/mustNotContain/mustMatch/parseAndAssert/runJudges (5 类 category); persist 提供 results.json + REPORT.md + codes/; 41 个 zero-LLM self-test 锁住 alias 表 verbatim shape + judge category 维度 + benchmark 矩阵聚合 + REPORT.md 渲染 + persistence 读写; quality-only ranking (drop speed/composite); npm run test:eval 跑真实 *.eval.ts 缺 API key auto-skip
- **Agent-doable**: ✓ benchmark module is pure-TS
- **Verdict**: ✓

#### F-098 Per-Model Context Window — ✓
- **Replay SHA**: parent of `dc7c38b` (first impl commit)
- **Files (objective from `git log --grep=FEATURE_098 --name-only`)**:
  - `packages/ai/src/providers/base.ts` (extend)
  - `packages/ai/src/providers/anthropic.ts` (use active model)
  - `packages/ai/src/providers/openai.ts` (use active model)
  - `packages/ai/src/cost-rates.ts` (extend)
  - `packages/ai/src/cost-rates.test.ts` (extend)
  - `packages/ai/src/providers/base.test.ts` (extend)
  - `packages/ai/README.md` (docs)
  - `packages/coding/src/...` (compaction call sites)
  - `packages/repl/src/...` (compaction call sites)
- **Bounded**: ✓ single feature
- **AC verbatim** (from v0.7.28.md FEATURE_098 design):
  > 把 KodaXModelDescriptor.contextWindow / maxOutputTokens 死字段接通运行时; compaction trigger 与 wire-level max_tokens 都按当前激活 model 的真实窗口算; 自定义 provider models[] 支持描述符对象格式 (兼容旧字面量); kimi.k2.5 = 256K (post-correction); zhipu.glm-5-turbo = 128K
- **Agent-doable**: ✓ pure provider catalog work
- **Verdict**: ✓

**Pool 3 internal review** (post-P1.5b): 2 ✓ + 0 ✗. Both clean. Ground-truth file lists from `git show --stat` — these are the 2 cases with **objective** golden signals, not predicted.

### P1.5b — final tally and self-review

| Pool | Pre-P1.5b | Post-P1.5b | Δ |
|---|---|---|---|
| Pool 1 (Planned) | 7 | **5** | -2 (F-057 Track F in-flight; F-007 scope sprawl) |
| Pool 2 (Issues) | 7 | **6** | -1 (I-106 likely silently resolved by FEATURE_084 ship) |
| Pool 3 (Completed) | 2 | **2** | 0 |
| **Total viable** | 16 | **13** | -3 |

13 < 18 target → falls in `12-17` zone of [dataset shortfall fallback](docs/features/v0.7.32.md). Action: **run with 13 cases, exploratory framing, P5 reports note sample-size limit**. 

13 is **at the bottom edge** of the viable zone — one more disqualifier in P2/P3 implementation would push us below 12 floor and trigger pause. The remaining headroom is fragile.

### Updated coverage matrix (post-P1.5b)

|                   | new-feature | refactor | bug-fix / quality-fix | cross-cutting | row total |
|---|---|---|---|---|---|
| **Planned**       | 097, 105 | (none) | 094 | 090, 092 | **5** |
| **Open Issues**   | 109, 110, 112 | 107 | 105, 124 | (none) | **6** |
| **Completed**     | (none) | 098 | (none) | 104 | **2** |
| **column total**  | **5** | **2** | **3** | **3** | **13** |

**Refactor and cross-cutting cells are very sparse** (2 each). Per codex#4, this is acknowledged confound; P5 primary analysis is unsliced (which is statistically cleaner anyway given small N).

### What this final dataset means for the eval

- 13 cases × 4 variants × 8 providers = **416 trials**
- Below confirmatory power for ≤5% effects, sufficient for ≥10% directional signal
- **Cannot claim "no difference"** between variants
- **Can claim** large-effect winners where ≥10% delta replicates across providers
- P5.5 review must explicitly acknowledge: "13-case dataset is engineering-grade exploratory eval, not statistical confirmation"

### Self-review of P1.5b execution

- ✓ Each ✓ candidate's design doc / issue full-text was read (not skimmed titles)
- ✓ Multi-file claims verified against named paths in source (Pool 3: from git stat; Pool 1+2: from design doc / issue Context fields)
- ✓ AC text marked verbatim where source allows; paraphrased AC explicitly noted
- ✓ Doc-lag check applied (I-106 caught matching I-119 pattern)
- ✓ In-flight feature check (F-057 Track F caught)
- ✓ Scope sprawl check (F-007 caught)
- ✓ Internal review at end of each pool

**What P1.5b did NOT do**:
- Did not build full cases.ts content yet (next step)
- Did not verify each Pool 1 candidate's pre-task SHA matches "all dependencies satisfied" — assumed HEAD is OK because all dependencies are shipped

**What's next**:
1. Final selection of 13 cases (no further filtering needed — all 13 ✓ go in)
2. Author verbatim userMessages from design doc / issue text
3. Lock SHA (HEAD-at-eval-time for Pool 1+2, specific parent SHA for Pool 3)
4. Write final cases.ts replacing 165fc0d
