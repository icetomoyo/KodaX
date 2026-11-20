# 按证据选择评测

## 结构检查

`node scripts/quick-validate.js <skill-dir>` 只检查结构/frontmatter。

## 真实触发

`node scripts/run-trigger-eval.js --skill-path <skill-dir> --evals <cases.json> --provider <provider> --model <model> --runs-per-query 1`

脚本把候选 SKILL.md（或 --description 给的描述）放进临时项目的 `.kodax/skills/`。
项目级 Skill 优先，所以它会盖住已安装的同名版本，并和用户、插件、内置 Skill 同台竞争。
每条查询跑一次 AMA 根的第一轮回复：调用了 `skill` 且名字匹配才算触发。工具调用只
记录、不执行，每个 attempt 的 tool_calls 列出模型实际选了什么，包括选错的 Skill。
设置了 disable-model-invocation 的 Skill 不进 catalog，脚本会直接报错。

每条查询的输入和产品一样，约为完整 Worker 提示词加 catalog，比单条判断贵得多；先用
少量用例和 --runs-per-query 1 确认用例有效。覆盖正例、邻近 Skill 的 near-miss 和
无关请求。分数只说明第一轮的选择，不代表整轮任务质量，也不能直接当成产品召回率。

improve-description.js 根据失败用例单次请求生成候选描述；run-loop.js 串联触发评测与
改写。按需要限定 --max-iterations、--runs-per-query；只有明确要求写回时用
--write-best。改了用例或评分方式时重读已有结果，不要为了好分数无限重跑。

## 执行 smoke

run-eval.js 通过公开 Skill SDK 加载/展开内容，在与产品默认相同的 AMA 根上运行 with_skill /
without_skill；它不是重放当前 Space 会话。先明确当前环境中已授权的 provider/model
与凭据来源、输入文件和隔离 cwd；不要假定会继承产品会话的凭据、工具或工作目录。

示例（脚本路径相对本 Skill，路径含空格时按当前 Shell 引号规则处理）：

```text
node scripts/run-eval.js --skill-path <skill-dir> --evals <evals.json> --workspace <iteration-dir> --provider <provider> --model <model> --cwd <isolated-workspace> --runs 1 --max-iter 6
```

先用少量 case 验证脚本和任务有效。执行 smoke 与真实触发是不同证据，
端到端自由执行不能独自支持提示词优劣结论。冻结 case/config/runs/迭代上限，统计
实际调用与 token/费用；max-iter 不等于物理 Provider 请求上限。遵守当前项目的
预算与原始输出保留约定，超时与失败留存，不能盲目追加请求。

## 需要时再评审运行结果

评分、分析和盲比都是单次模型请求，材料直接写在请求里，不跑 agent 循环、不调用工具。

- `grade-evals.js <workspace> --provider <provider> --model <model>` 读取各 run，写 grading。
- `aggregate-benchmark.js <workspace> --skill-name <name>` 聚合 grading/timing，不调用模型。
- `analyze-benchmark.js <workspace> --provider <provider> --model <model>` 形成有局限性说明的分析。
- `compare-runs.js <workspace> --provider <provider> --model <model>` 盲比两个 config。
- `generate-review.js <workspace> --static <review.html>` 生成静态人工评审页。

按任务加载 agents/ 中的对应契约和 [schemas.md](schemas.md)。报告任务有效性、差异、
失败归因、未验证范围及建议，不能用单一总分替代判断。若只做打包或静态修改，
不运行这些独立模型流程。当前 helper 为 KodaX 本地维护；没有锁定的外部版本时，
不要用外部最新代码覆盖当前宿主适配或声称已完成上游同步。
