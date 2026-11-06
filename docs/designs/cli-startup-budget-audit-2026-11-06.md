# CLI startup budget re-audit — 2026-11-06

The small-context recovery changes require a **5,071 KiB (5,192,704 byte)** CLI ceiling. This is the smallest whole-KiB ceiling that accommodates the measured five-platform composition below; it retains **49 KiB** beneath the existing 5 MiB outer limit. The former ceiling was 5,064 KiB (56 KiB reserve). The initial 5,070 KiB proposal would retain 50 KiB, but five-platform evidence requires using one further KiB of reserve; the 5 MiB outer limit is unchanged. No runtime behavior, dependency, minification setting, lazy boundary or data-resource placement is changed to satisfy the gate.

## Source and method

- Runtime source: `c5f5dc38e` (includes `ada535a13` read-cache fix and the Windows management-wire schema fix). Compiler: Node `v22.23.1`, TypeScript `5.9.3`, esbuild `0.27.7`, Windows x64.
- The full build had passed package and native compilation, then failed the CLI size gate. Its CLI is **5,190,291 bytes**, SHA-256 `4dd79c02990e7ca6038f1b86d212d85bce572d7fdf3f11e9d57c3d7cc3e8b93b`.
- A temporary copy of the existing builder executed only its schema generation and CLI build, using unchanged production esbuild options and a temporary output directory. It included the latest `src/runtime-daemon/schema.ts`, reproduced the CLI byte count, and retained the eager-heavy-import and single-provider-credential assertions. It did not replace repository `dist`, run a full build, or modify source.
- A paired baseline overlaid the seven modified pre-existing production modules with `37baedc7c` source, transpiled with the same ES2022 options. Transpiling the current versions exactly matched their compiled `dist` JavaScript after line-ending/source-map-comment normalization. The removed baseline import makes the new `read-text-page` module unreachable. This is a controlled source-overlay comparison, **not a fresh historical checkout build**.
- `git diff 37baedc7c c5f5dc38e -- package.json package-lock.json packages/*/package.json` is empty. Metafile comparison adds exactly one input, `packages/coding/dist/tools/read-text-page.js` (1,137 → 1,138 inputs), removes none, and leaves the unique external `(kind,path)` import set unchanged. Both existing startup assertions pass.

## Measured growth and platform allowance

| Composition | CLI bytes | Meaning |
| --- | ---: | --- |
| Paired baseline, actual Windows native manifest | 5,185,122 | Before the capacity/read production changes |
| Current, actual Windows native manifest | 5,190,291 | **+5,169 bytes**; exceeds old ceiling by 4,755 bytes |
| Current, five manifests, Linux host selection | 5,191,792 | Models the release workflow's Linux host collecting all native artifacts |
| Current, five manifests, Windows host selection | 5,192,263 | Larger measured selection; 441 bytes below the new ceiling |

The five-platform probes preserve the actual Windows manifest and synthesize Linux/Darwin x64/arm64 manifests from `scripts/build-native.mjs`'s current exact JSON shape: filenames, platform/architecture, protocol 5, license record, and fixed-length 64-character SHA-256 strings. They are **bundle-size composition probes, not builds or execution tests of those four native binaries**. `.github/workflows/release.yml` collects those five manifests before bundling. The chosen ceiling must still be enforced against the real universal artifact in CI.

The current local build alone would fit 5,070 KiB, but the five-manifest Linux composition exceeds it by 112 bytes and the Windows selection by 583 bytes. Therefore 5,070 is insufficient; 5,071 is sufficient without an arbitrary extra growth allowance. The 441-byte margin is narrow by design: later growth must trigger another evidence-backed audit.

Metafile attribution: `read-text-page` +1,845 bytes; overflow-message classification +1,012; summary request guard +807; compaction reduction +762; read integration +670; batch invalidation +34; result budget +29; remaining minifier/reference-name changes +10. These are necessary bounded reading/recovery behaviors, not a new heavyweight dependency graph. Their sum is the measured 5,169-byte increase.

## Gate verification and limits

`node --test --test-name-pattern='CLI retains room' tests/bundled-manual-budget.test.mjs` failed against the old 5,064 KiB ceiling, then passed against 5,071 KiB using the same emitted artifact. The builder and published-artifact test use the same fixed expression, `5 * 1024 * 1024 - 49 * 1024`; there is no environment override or automatic ceiling growth. The existing import/credential checks remain before the size assertion.

This audit approves only the ceiling adjustment. Full build, SDK declarations, packaged behavior and real universal-native release gates remain separate checks. It does not establish startup-latency improvement or next-dev integration safety.

The frozen [next-dev integration assessment](next-dev-integration-assessment-2026-11-06.md) correctly records 5,064 KiB for its `37baedc7c` baseline. For a future merge containing this audit, W0/W5 and A10 must use **5,071 KiB**, retain all heavy-import boundaries, and rebuild the actual combined artifact; neither branch's historical size is a substitute.
