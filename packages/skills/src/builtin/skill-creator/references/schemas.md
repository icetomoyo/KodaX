# Skill Creator Schemas

这份参考文档定义 KodaX 版 `skill-creator` 默认使用的评测文件格式。它不是强制协议，但建议优先沿用，方便后续聚合、review 和自动分析。

## `evals/evals.json`

用于保存测试提示集合。

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User task prompt",
      "expected_output": "What a good result should achieve",
      "files": [],
      "assertions": []
    }
  ]
}
```

字段说明：
- `skill_name`: skill 名称。
- `evals`: 测试用例数组。
- `id`: 用例唯一标识。
- `prompt`: 给 agent 的任务文本。
- `expected_output`: 对预期结果的简短说明。
- `files`: 需要作为输入提供的文件列表。
- `assertions`: 可选，后续 grading 用的断言定义。

## `eval_metadata.json`

用于单个 eval 目录，帮助 review 工具识别 prompt 和断言。

```json
{
  "eval_id": 1,
  "eval_name": "handles-empty-input",
  "prompt": "Implement validation for empty input",
  "expected_output": "Reject empty input with a clear message",
  "assertions": [
    {
      "text": "rejects empty input with a clear message"
    }
  ]
}
```

## `grading.json`

由 `grade-evals.js` 生成，用于保存单次运行后的断言判定结果。

```json
{
  "summary": {
    "passed": 2,
    "failed": 1,
    "total": 3,
    "pass_rate": 0.6667
  },
  "expectations": [
    {
      "text": "rejects empty input with a clear message",
      "passed": true,
      "evidence": "Observed in outputs/result.md"
    }
  ],
  "execution_metrics": {
    "total_tool_calls": 4,
    "errors_encountered": 0,
    "output_chars": 5120
  },
  "user_notes_summary": {
    "uncertainties": [],
    "needs_review": [],
    "workarounds": []
  },
  "overall_summary": "Mostly correct, but edge cases need review.",
  "timing": {
    "total_tokens": 84852,
    "total_duration_seconds": 23.3
  },
  "meta": {
    "generated_at": "2026-03-17T12:00:00.000Z",
    "eval_id": 1,
    "eval_name": "handles-empty-input",
    "config": "with_skill",
    "run_id": "run-1"
  }
}
```

要求：
- `expectations` 里的字段名固定为 `text`、`passed`、`evidence`。
- `pass_rate` 建议是 `0..1` 之间的小数。

## `timing.json`

用于保存一次运行的耗时与 token 信息。

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

## `benchmark.json`

由 `aggregate-benchmark.js` 生成，用于总览不同配置的表现。

```json
{
  "skill_name": "example-skill",
  "generated_at": "2026-03-17T12:00:00.000Z",
  "workspace": "/abs/path/to/iteration-1",
  "configs": {
    "with_skill": {
      "pass_rate": { "mean": 0.9, "stddev": 0.1, "min": 0.8, "max": 1.0 },
      "time_seconds": { "mean": 12.4, "stddev": 1.1, "min": 11.2, "max": 13.5 },
      "tokens": { "mean": 4200, "stddev": 380, "min": 3900, "max": 4700 }
    },
    "without_skill": {
      "pass_rate": { "mean": 0.6, "stddev": 0.2, "min": 0.4, "max": 0.8 },
      "time_seconds": { "mean": 9.5, "stddev": 0.7, "min": 8.9, "max": 10.2 },
      "tokens": { "mean": 3100, "stddev": 240, "min": 2900, "max": 3400 }
    }
  },
  "delta": {
    "pass_rate": "+0.3000",
    "time_seconds": "+2.9000",
    "tokens": "+1100.0000"
  },
  "runs": {
    "with_skill": [],
    "without_skill": []
  }
}
```

## `analysis.json`

由 `analyze-benchmark.js` 生成，用于总结 benchmark 的稳定收益、方差热点和下一步建议。

```json
{
  "skill_name": "example-skill",
  "generated_at": "2026-03-17T12:15:00.000Z",
  "workspace": "/abs/path/to/iteration-1",
  "verdict": "improves",
  "release_readiness": "needs_iteration",
  "recommendation": "Keep the skill, but reduce variance before release.",
  "key_findings": [
    "with_skill materially improves pass rate"
  ],
  "variance_hotspots": [
    "baseline repeatedly misses billing details"
  ],
  "suggested_actions": [
    "tighten assertions around billing coverage"
  ],
  "watchouts": [
    "token cost increased"
  ],
  "supporting_metrics": {
    "pass_rate_delta": "+0.3000",
    "time_seconds_delta": "+2.9000",
    "tokens_delta": "+1100.0000"
  },
  "failure_clusters": {}
}
```

## `comparison.json`

由 `compare-runs.js` 生成，用于 blind comparison 两个 config 的输出质量。

```json
{
  "workspace": "/abs/path/to/iteration-1",
  "generated_at": "2026-03-17T12:20:00.000Z",
  "config_a": "with_skill",
  "config_b": "without_skill",
  "summary": {
    "total_pairs": 3,
    "config_a_wins": 2,
    "config_b_wins": 0,
    "ties": 1,
    "inconclusive": 0
  },
  "comparisons": [
    {
      "eval_id": 1,
      "winner_label": "A",
      "winner_config": "with_skill",
      "confidence": 0.9,
      "rationale": "Candidate A is more complete and specific."
    }
  ]
}
```

## 推荐目录结构

```text
my-skill-workspace/
└── iteration-1/
    ├── eval-0/
    │   ├── eval_metadata.json
    │   ├── with_skill/
    │   │   ├── outputs/
    │   │   ├── grading.json
    │   │   └── timing.json
    │   └── without_skill/
    │       ├── outputs/
    │       ├── grading.json
    │       └── timing.json
    ├── benchmark.json
    ├── benchmark.md
    ├── analysis.json
    ├── analysis.md
    ├── comparison.json
    └── comparison.md
```
