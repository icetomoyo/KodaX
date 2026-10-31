# Issue 375: Constrained Skill shell patterns admit extra effects

Observed on `aeb16fef`, 2026-10-29; first affected version unknown.

## Contract

`Bash(pattern)` is an additional Skill restriction, not a replacement for Host
authorization or the sandbox. A constrained shell rule admits only a matching,
single command understood by the existing shell parser. Compound statements,
pipelines, redirects and unsupported syntax/command substitution are rejected.
Ordinary arguments and quoted literal punctuation remain usable. Compound work
can be issued as separate permitted calls; a Skill author can explicitly declare
unrestricted `Bash` when that broader scope is intended. Bare Bash, wildcard tool
authority and an omitted restriction keep their existing semantics and Host
checks. Non-shell tool rules and hook matcher patterns retain their meanings.

The declared shell contract selects dialect handling (legacy Windows defaults
to cmd). cmd additionally rejects variable expansion and caret escapes, and
checks unquoted operators using cmd's double-quote rules; single quotes cannot
hide command separators. Double-quoted literal punctuation remains usable.
PowerShell/pwsh also checks its own quote boundaries: a POSIX backslash cannot
hide an operator or escape a quote. Backtick escapes, smart quotes and multiline
commands are conservatively rejected by this constrained rule. Ordinary quoted
punctuation and Windows path arguments remain usable.
This is syntax admission, not a claim that arbitrary allowed executables or
shell profiles cannot have effects; normal Host authorization still applies.

## Regression

`Bash(git diff *)` previously admitted `git diff --stat && git commit -am x`
while rejecting the standalone commit. The regression invokes the actual Skill
policy with a temporary Skill and a fake admission callback; no shell commands
are executed. It covers logical operators, background operators, CR/LF command
boundaries, pipes, redirection, substitution, spaces and quoted punctuation.

```powershell
npx vitest run packages/coding/src/skill-invocation-policy.test.ts packages/coding/src/permissions/bash-ast.test.ts --maxWorkers=2
```

Verify that blocked commands never reach Host admission; permitted commands
still reach it and obey rejection. Preserve multi-Skill intersection, trusted
policy rehydration, hooks, model selection and dynamic-context guards.

On 2026-10-29 all 43 Skill-policy tests passed, including RED-to-GREEN cmd and
PowerShell cases. The fixture quotes its YAML `allowed-tools` scalar so `*` is
tested as wildcard authority, not accidentally parsed as a YAML alias. Parser
regressions, production/test typechecks and the full build also passed.

## Whole-repository validation scope (2026-10-29)

The initial default suite reported 17,941 passed, six failed, 97 skipped and
19 TODO tests across 1,287 files. It overlapped the final edits and build, so
this is not a clean final-tree green run. Three failures were stale Issue 373
token assertions; two PowerShell assertions ran in the process started before
the dialect fix; one daemon smoke failed with the explicit earlier-build
launcher guard during the rebuild. The full daemon smoke file subsequently
passed all 26 cases in a new process. Managed-child cleanup warnings retained
their isolated temporary records and were not treated as successful cleanup.

After freezing the final source and build, a fresh combined run passed all 291
cases across 11 files: Skill policy/parser, REPL question adapter, daemon facade,
both SDK interaction suites, SDK/SessionView streaming, SDK-to-REPL activity,
Classic display and the complete daemon smoke suite. This includes every
initially failing case. Final production/test typechecks also passed. Standards
and Spec reviews each have zero remaining actionable findings.

The rebuilt-bundle cold-resume fixture passed with 220 exited records (ready
3,370 ms, concurrent first history reads 68 ms, restart 1,908 ms). Packaged
Ink/Classic token units and Ink streaming/settled history wheel return passed.
These checks do not close Issue 371's historical first-read latency.
