# Actor settlement bundle audit — 2026-11-07

The Actor consistency repair requires a **5,077 KiB (5,198,848 byte)** CLI ceiling, retaining **43 KiB** beneath the unchanged 5 MiB outer limit. This is the smallest whole-KiB ceiling accommodating the measured five-manifest composition. The prior 5,071 KiB ceiling retained 49 KiB. The adjustment follows a measured failure and composition audit; no dependency, minification, import boundary, runtime behavior or resource placement is removed to fit.

## Method and frozen inputs

Node v22.23.1, TypeScript 5.9.3, esbuild 0.27.7, Windows x64. Baseline: `77bafbee0`. Current production blobs:

- `src/sdk-runtime.ts`: `adf5fded8ca0141d1aceac2ebc69effe54ea4dce`
- `packages/agent/src/actors/controller.ts`: `0c41547ab388df49490cc53924c2dd1f5847615a`
- `packages/coding/src/agent-runtime/actor-runtime.ts`: `a79b5825592003c234f9567e5c6120563e78e30d`

Before the final Shell cleanup repair, the actual builder failed at its CLI gate after emitting 5,196,025 bytes (SHA-256 `1f19a283433878889aad69f93b9b957401376c0aa8276022c1da58922d11b3b3`). The published-artifact size test also failed at the old ceiling. The final frozen-source probe emits 5,196,207 bytes (SHA-256 `76ae8781f649d05ecc742f2f87b1023afb739152dc32a92a2ac7948e0a2701f3`). This probe is a temporary copy of the production builder executing schema generation and CLI bundling with unchanged esbuild options, retaining both startup import and provider-credential uniqueness assertions. It writes only to its private OS temporary directory and does not replace the final complete build.

The paired baseline overlays those three modules from `77bafbee0`: source TypeScript for the SDK and ES2022-transpiled JavaScript for the two package modules. This is a controlled source-overlay comparison, not a historical checkout build. Its 5,190,291-byte result reproduces the previous frozen local baseline. All 1,138 inputs remain present; added/removed input sets and unique external `(kind,path)` import differences are empty. Package manifests and lockfile are unchanged.

## Measurements

| Composition | CLI bytes |
| --- | ---: |
| Paired baseline, actual Windows manifest | 5,190,291 |
| Actor repair, actual Windows manifest | 5,196,207 |
| Actor repair, five manifests / Linux host selection | 5,197,708 |
| Actor repair, five manifests / Windows host selection | 5,198,179 |

The net local increase is **5,916 bytes**. The largest composition exceeds 5,076 KiB by 355 bytes and fits 5,077 KiB with 669 bytes remaining. Therefore preserving 44 KiB is insufficient; preserving 43 KiB fits without an arbitrary additional allowance.

Five-manifest probes retain the actual Windows manifest and synthesize Linux/Darwin x64/arm64 manifests with the current native builder's exact shape and fixed-length hashes. These measure release composition, not native execution or compilation on those four targets. The real universal artifact remains subject to the same gate in release CI. Raw scripts, metafiles and artifacts remain local in OS temporary directory `kodax-actor-bundle-audit-CVt3i3`; `final-audit.log` records this final-source rerun.

## Verification boundary

The builder and published-artifact test must use the same fixed ceiling, `5 * 1024 * 1024 - 43 * 1024`. There is no override or automatic budget growth. Final complete build, SDK declarations, packaged smoke checks and full source regressions are recorded in the Actor implementation report, independently of this size audit. This audit establishes neither startup latency nor next-dev merge safety. Future combined builds must measure their actual artifact; neither branch's historical byte count is sufficient.

The final complete build subsequently passed and emitted **5,196,207 bytes**, SHA-256 `76ae8781f649d05ecc742f2f87b1023afb739152dc32a92a2ac7948e0a2701f3`, matching the final local composition probe exactly. All 102 bundled regressions passed, including the published-artifact size gate; all 37 package export targets are present in the local tarball. These final checks use the same frozen production blobs listed above and do not convert the synthetic non-Windows compositions into native execution evidence.
