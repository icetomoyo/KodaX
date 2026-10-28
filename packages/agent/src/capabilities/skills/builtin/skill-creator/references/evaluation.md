# 按证据选择评测

## 结构与描述语义筛查

`node scripts/quick-validate.js <skill-dir>` 只检查结构/frontmatter。
`node scripts/run-trigger-eval.js --skill-path <skill-dir> --evals <cases.json> --provider <provider> --model <model> --runs-per-query 1`
让模型仅根据一条 name/description/query 判断“应该使用吗”。输出的 precision/recall
是描述判断统计，没有竞争 catalog、真实工具调用或可见性执行证据；metadata 会标明
这是 description_semantic_screening，以及该 Skill 是否开放模型目录。

improve-description.js 根据结果生成候选；run-loop.js 串联筛查与改写。按需要限定
--max-iterations、--runs-per-query；只有明确要求写回时用 --write-best。改了评分器时
重读已有 raw，不能为了得到好分数无限重跑。不要把这些脚本的分数写成产品召回率。

## 真实触发

用产品相同的完整 Skill catalog、可见性和工具定义观察自然语言请求后的实际
skill 调用。保留请求、目录/工具的版本、原始响应、调用参数和未调用证据。覆盖
正例、邻近 Skill 的 near-miss、无关请求；否定回答中提到技能名不等于调用它。
描述被隐藏、工具未提供或环境不同的实验，不能证明生产模型发现正确。

## 执行 smoke

run-eval.js 通过公开 Skill SDK 加载/展开内容，使用独立 SDK 运行 with_skill /
without_skill；它不是重放当前 Space 会话。先明确当前环境中已授权的 provider/model
与凭据来源、输入文件和隔离 cwd；不要假定会继承产品会话的凭据、工具或工作目录。

示例（脚本路径相对本 Skill，路径含空格时按当前 Shell 引号规则处理）：

```text
node scripts/run-eval.js --skill-path <skill-dir> --evals <evals.json> --workspace <iteration-dir> --provider <provider> --model <model> --cwd <isolated-workspace> --runs 1 --max-iter 6
```

先用少量 case 验证脚本和任务有效。执行 smoke 与描述筛查、真实选择是不同证据，
端到端自由执行不能独自支持提示词优劣结论。冻结 case/config/runs/迭代上限，统计
实际调用与 token/费用；max-iter 不等于物理 Provider 请求上限。遵守当前项目的
预算与原始输出保留约定，超时与失败留存，不能盲目追加请求。

## 需要时再评审运行结果

- `grade-evals.js <workspace> --provider <provider> --model <model>` 读取各 run，写 grading。
- `aggregate-benchmark.js <workspace> --skill-name <name>` 聚合 grading/timing，不调用模型。
- `analyze-benchmark.js <workspace> --provider <provider> --model <model>` 形成有局限性说明的分析。
- `compare-runs.js <workspace> --provider <provider> --model <model>` 盲比两个 config。
- `generate-review.js <workspace> --static <review.html>` 生成静态人工评审页。

按任务加载 agents/ 中的对应契约和 [schemas.md](schemas.md)。报告任务有效性、差异、
失败归因、未验证范围及建议，不能用单一总分替代判断。若只做打包或静态修改，
不运行这些独立模型流程。当前 helper 为 KodaX 本地维护；没有锁定的外部版本时，
不要用外部最新代码覆盖当前宿主适配或声称已完成上游同步。
