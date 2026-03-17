# Skill Creator Schemas

这份参考文档定义 KodaX 版 `skill-creator` 默认使用的几个评测文件格式。它不是强制协议，但建议优先沿用，方便后续聚合和 review。

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
  "assertions": [
    {
      "text": "rejects empty input with a clear message"
    }
  ]
}
```

## `grading.json`

用于单次运行后的断言判定结果。

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
      "evidence": "Observed in outputs/report.md"
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
    └── benchmark.md
```
