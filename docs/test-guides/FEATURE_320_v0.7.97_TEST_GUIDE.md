# FEATURE_320: Temporal artifact evidence for GIF, animated WebP and video

Implemented on local KodaX mainline, 2026-11-26 (v0.7.97 line, not yet released).

## Contract and scope

`artifact_open` identifies GIF, MP4, MOV and WebM by content. When a decoder is
available it adds a non-blocking `timeline` diagnostic. `artifact_capture` with
`kind: 'temporal'` returns PNG evidence at the requested seconds.

- GIF and animated WebP decode in the prepared Chromium through WebCodecs
  `ImageDecoder`. A sample is the composited frame displayed at that second.
- Video uses the absolute `ffmpegExecutable` the Host passes. A sample is the
  first frame at or after that second. Without ffmpeg, video stays unverified.
- Every result is `coverage: 'sampled'`. Continuous playback is never claimed.
- Video may be up to 1 GiB, hashed by streaming. Other inputs keep the 32 MiB limit.

Out of scope: native video delivery to a provider, audio, script/CSS animation.

## Automated checks

Run from the repository root (package-directory runs give false failures):

```bash
KODAX_ARTIFACT_TEST_BROWSER=<chrome.exe> KODAX_ARTIFACT_TEST_FFMPEG=<ffmpeg.exe> \
  npx vitest run packages/artifacts
```

Without the two variables the browser and ffmpeg cases are skipped. Playwright's
own ffmpeg (`ms-playwright/ffmpeg-*/ffmpeg-win64.exe`) is enough for the webm fixture.

Fixtures in `tests/fixtures/artifacts/`:

| File | Content |
| --- | --- |
| `animated.gif` | 8x8, red 0.5s (transparent 4x4 centre) → green 0.5s → blue 1s, loops forever |
| `animated.webp` | 16x16, red 0.4s → green 0.4s |
| `clip.webm` | 64x48 VP8 at 1 fps: red, green, blue |

## Manual verification

1. Register the artifact extension with `ffmpegExecutable` set to a real ffmpeg.
2. Ask: "Review loading.gif before I post it; check every state of the loop."
   Expect `artifact_open`, then a temporal capture whose times reach each frame
   state, with the frames delivered as images.
3. Ask for a review of an MP4 whose last frame matters. Expect the end sample at
   the last frame's start (duration minus 1/fps), not at the exact duration. A
   time inside the last frame returns `no-frame-at-time`.
4. Remove `ffmpegExecutable` and repeat step 3. Expect `timeline-unavailable` on
   open, `ffmpeg-unavailable` on capture, and a final report that keeps the
   video unverified.
5. Point `ffmpegExecutable` at another executable (for example Node). Capture
   must fail with "Configured video decoder is not ffmpeg."

## Prompt eval (2026-11-26)

`benchmark/artifact-temporal-prompt.eval.ts`, Layer 2. One response per cell;
model-selected tools never run. Aliases were `zhipu/glm53flash` and `ds/flash`,
3 samples each, 66 calls, about 210k tokens.

Baseline is the `artifact_open` and `artifact_capture` descriptions at
`361c0c0b5`. The two candidate-only cases need runtime output the baseline
cannot produce, so they measure adoption, not lift. T3 compares the
artifact-review skill body instead: both arms get the candidate tools, the
skill tool result and a real ffmpeg timeline for a 3s clip at 1 fps. Only the
loaded SKILL.md differs.

| Case | Result |
| --- | --- |
| T1 GIF after open (candidate only) | 6/6 temporal capture, all times in range; 5/6 reach all three frame states, one skipped the green frame |
| T2 video, no ffmpeg (candidate only) | 6/6 keep the video unverified: they probe for ffmpeg or capabilities; no fabricated frames, no installation |
| C1 GIF review from scratch (A/B) | candidate better 4, tie 2, baseline 0; baseline twice went to capabilities only, once bypassed with PIL |
| C2 static PNG (A/B) | 6/6 ties; no temporal misuse in either arm |
| C3 SVG SMIL (A/B) | candidate 2, baseline 1, tie 3; differences are first-step exploration order |
| T3 skill body, video end frame (A/B), first wording | candidate 0, baseline 1, tie 5; "start, end" plus "at least one frame interval before the end" led deepseek to sample 2.9s twice, which returns no frame |
| T3 skill body, final wording | candidate 1, baseline 0, tie 5; candidate samples the last frame at 2s in 6/6, baseline 5/6 (one ffprobe detour) |

Recommendation: recommend-ship. The final skill wording names the last frame's
start time as duration minus 1/fps; the first wording was rejected.
