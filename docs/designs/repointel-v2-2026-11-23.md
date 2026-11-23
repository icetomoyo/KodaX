# RepoIntel v2：可信且不拖慢 KodaX 的仓库智能

日期：2026-11-23。状态：**方向已定，未开工**。实施排在其他工作之后，本记录是开工入口。
基线：`c9589bdc2`（v0.7.97-rc.1）。

## 1. 为什么要重做

用户反馈当前 RepoIntel 不省 token、找不准代码，还会截断导致看不全。2026-11-23 分截断、token、准确性、运行时四路做了只读审计，并在本仓库及临时 fixture 上实跑确认。详细条目在本地未入库的 `docs/research/2026-11-23-repointel-audit.md`，要点如下：

- **不准，但标着高置信度。** 编译器解析出的调用目标被丢弃，callTargets 改由全仓同名匹配重建（`semantic-build-materialize.ts:316-350`）。本仓库 27% 的边是纯同名匹配，会跨语言、指进测试文件。`.js` 的 import 不映射到 `.ts`，于是产生假的模块依赖和假循环。置信度恒在 0.91–0.99。`semantic_lookup` 只是子串匹配。
- **静默截断和伪造结果。** 每个文件最多 40 个符号、每个符号最多 8 个调用方、每个文件最多 12 个 import，签名只取第一行，大文件和未支持语言直接跳过，以上全都没有标记。查不到时返回伪造的 "worker unavailable" 结果。
- **更费 token。** 工作树一脏，每次编辑都全量 `createProgram`（约 10.5 秒、约 2GB），工具只等 2 秒，于是返回 "warming"。注入内容带时间戳，每个编辑任务都会重新追加约 430–1,075 token。
- **运行时问题。** 往用户仓库写约 60MB 的 `.agent/` 且不加 exclude；git 出错时被当成"没变"；大量错误被静默吞掉。

**根因是架构，不是零散 bug。** 现在把整仓全量分析放在每轮请求的关键路径上。后来每一次性能优化（加超时预算、退回同名匹配、加上限、用占位结果兜底）本质上都是不告知地降质量；又没有真值评测，结果越改越差。

v2 的两条总规矩：

1. 性能靠架构解决，不靠降质量。
2. 能力受限时必须告诉模型，不能静默降级。

## 2. 目标与非目标

v2 要回答好 grep 和单点 LSP 回答不好的四类问题：

1. **导航**：精确的定义和引用，跨文件、跨包。
2. **影响面**：传递的调用方和依赖方，带数量和排序。
3. **定位**：在陌生仓库里按概念找代码，用词面检索（标识符按驼峰和下划线拆词，加路径和 doc 注释，做 BM25）。
4. **地图**：按任务相关性排序、控制在 token 预算内的仓库地图。

保留：changed scope 和 changed diff（基于 git，便宜且准）。

**验收线**：在真实任务上，比只用 grep 加 LSP 更省轮次、更省 token，且成功率不降。达不到就不进默认。

**非目标**：

- **embedding / 向量检索。** owner 2026-11-23 决定不做，也不预留向量字段。理由：强模型通过迭代搜索加上仓库地图和 BM25，已经能覆盖大部分概念定位；embedding 要承担本地模型体积、重新 embedding 的新鲜度问题、远程 API 的隐私问题，结果也没有精确性保证。
- 运行时调用追踪、多仓库联合索引。

## 3. 设计原则

1. **诚实契约。** 每个结果都带三个标签：
   - **精度**：`precise`（编译器或 LSP）、`syntactic`（语法加作用域解析）、`heuristic`（同名推测）。
   - **完整性**：完整；或已截断（还有 N 个，附翻页方式）；或未索引（附原因：语言、大小、解析失败）。
   - **新鲜度**：哪些文件的索引已过期。

   "未找到"、"未索引"、"服务不可用"是三种不同结果，必须分开报告，永远不返回占位数据。
2. **请求路径永不等待构建。** 查询只读现有索引。过期文件现场单独分析（单文件毫秒级），或者标为过期后照常返回。
3. **按文件增量，按内容寻址。**
   - 每个文件的分析结果以内容 hash 作 key；改一个文件只重算这一个，再增量更新关系图。
   - KodaX 自己的编辑工具直接通知索引改了哪些文件；外部改动由 watcher 或 git 状态兜底。
4. **分层精度，按需升级。** 语法层覆盖全部语言、始终在线；精确层只针对被问到的符号按需计算，结果缓存。
5. **资源上限是硬约束。**
   - 独立进程，调低 OS 优先级，设内存上限，主代理请求进行中时让出资源。
   - 不写用户仓库。
6. **质量门禁先于功能。** 先建真值评测和性能基准。精确率、召回率或性能预算任何一项回退，都不能合入。

## 4. 架构

```text
L0 清单层   git ls-files + 目录级 Merkle hash；编辑工具事件 + watcher 兜底
L1 语法层   tree-sitter：定义 / 引用 / import / 完整签名 / doc 注释，单文件毫秒级
L2 解析层   真实模块解析（tsconfig paths、package exports、.js→.ts、Python 包、Go module、Cargo），
           作用域内名字解析；每条边标注证据类型
L3 精确层   按需：通过 Host 现有 LSP 服务（packages/coding/src/lsp/service.ts）解析被查询的符号，
           结果按相关文件 hash 回写缓存
查询层      定义 / 引用 / 调用方（带深度和计数）/ 影响面排序 / BM25 定位 / 仓库地图
```

### 4.1 实现形态与进程归属（已定）

- **语言：Rust。** 核心做成 Rust crate 并编译成独立二进制，复用现有 native 二进制的发布链路（与 `native/windows-sandbox-v2` 同一种形态）。
- **归属：由 Host 管理的子进程。**
  - 每个 Host 一个，按仓库管理索引，Host 上所有会话共用。
  - Host 负责拉起、监管、空闲回收和资源限额。
  - 生命周期跟随 Host，不新增独立 daemon。
- **独立可用。** low-level inline 调用方可以直接拉起该二进制，保持包的独立可用性。
- **分工：**
  - Rust 进程负责 L0–L2、存储和查询，不接触 LSP。
  - L3 由 Host 侧组合：用现有 LSP 服务解析，结果写回索引缓存。
- **磁盘缓存：** 放在 KodaX 数据目录，按仓库分开，按内容 hash 寻址；不同 profile 的 Host 可以复用文件级分析结果。

被否决的方案：

| 方案 | 否决理由 |
|---|---|
| Host 进程内 napi | 崩溃会拖垮所有会话；大内存和 CPU 跟 Host 抢，无法单独限额 |
| 独立全局索引 daemon | 要重复 Host daemon 已付出的所有权、版本兼容、Windows Job 监管和崩溃恢复成本；收益只在多 profile 并发同一仓库这种少见场景 |
| 每进程/每会话一个（现状） | 内存翻倍，重复冷启动 |

### 4.2 语言分级（已定）

| 级别 | 语言 | 覆盖层 |
|---|---|---|
| 首批一等 | TS/JS、Python、Go、Rust | L1 + L2 + L3（有语言服务器时） |
| 语法层 | Java、C++ | 只有 L1，结果标注 `syntactic`/`heuristic` |
| 其他 | tree-sitter 有语法的语言按需加入 L1 | 未支持的语言在结果中报告为"未索引" |

### 4.3 与 Agent 的接口

- **自动注入：**
  - 会话开始时注入一张小而稳定的仓库地图，不带任何时间戳，只在结构变化时重新生成，以命中 prompt cache。
  - 之后的任务只在内容确实变化时发增量。
- **工具：**
  - 按导航、影响面、定位、地图四种职责收敛，替代现在 RepoIntel 加 LSP 共 20 个工具（约 3.4k token 的定义）。
  - 具体怎么合并，用评测决定。不能隐藏某个工具后，逼模型多一轮发现才能拿到完整信息。
- **输出：** 紧凑、排序、可翻页，带精度标签；没有内容的行不打印。
- **提示词：** 定位成 grep 和 read 的补充，不要求先用结构化工具。按 ADR-033 写并补 eval。

## 5. 性能预算（目标值，以基准实测为准）

| 指标 | 目标 |
|---|---|
| 请求路径新增延迟 | 温索引查询 p95 < 50ms；永不等待构建 |
| 编辑后增量 | 单文件语法层 < 100ms |
| 冷启动 | 后台进行，不阻塞请求；1 万文件的语法层在十秒级 |
| 内存 | 1 万文件规模的仓库，索引进程 ≤ 300MB |
| 磁盘 | 不写用户仓库；体积远小于现在的 60MB |
| 安装包 | 二进制加语法库的增量要实测，作为发布门禁之一 |

## 6. 评测体系（阶段 0 就要建）

1. **真值集。**
   - 仓库：KodaX（TS monorepo），再加 Python、Go、Rust、混合语言的各一个。
   - 用 SCIP indexer 或 LSP 生成精确的定义和引用作为真值。
   - 衡量定义、引用、调用方、import 边的精确率和召回率，并按精度标签分开统计。
2. **任务级 A/B。** 同一批任务分别在有和没有 RepoIntel 时运行，比较成功率、轮次、计入缓存后的 token 和耗时。遵循 `benchmark/EVAL_GUIDELINES.md`。
3. **性能基准。** 扩展 `benchmark/perf/repo-intelligence-index.bench.ts`，覆盖冷启动、增量、内存、查询延迟和安装包体积。

## 7. 路线

| 阶段 | 内容 | 进入下一阶段的条件 |
|---|---|---|
| 0 | 旧引擎止血加收缩默认（见 §8）；建评测体系 | 用户不再受损；评测能跑出旧引擎的基线 |
| 1 | Rust 引擎 L0 + L1 + 诚实契约 + 外部存储，放在开关后，Host 管理 | 真值评测超过旧引擎，性能达到预算 |
| 2 | L2 模块解析 + 仓库地图注入 | 任务 A/B 赢过 grep 加 LSP |
| 3 | L3 按需精确层，影响面和调用方 | 首批语言的精确率和召回率达标 |
| 4 | BM25 定位 + 工具面收敛 | A/B 有收益 |
| 收尾 | 删除旧引擎（`packages/coding/src/repo-intelligence/` 的 semantic-* 及 worker） | 新引擎全面接管默认 |

## 8. 阶段 0 范围（对旧引擎）

1. **默认只保留 overview、changed_scope、changed_diff，并修复：**
   - 注入内容去掉 `analyzedAt` 和 `generatedAt`。
   - changed_scope 支持翻页。
   - git 状态未知时按"有改动"处理。
2. **退出默认：**
   - 工具：module_context、symbol_context、process_context、impact_estimate、semantic_lookup、relationship_scan、cyclic_dependencies。
   - 自动注入里的 module/impact。
   - 默认不再后台构建语义索引。
   - SDK 显式启用时仍然可用。
3. **诚实输出：**
   - 截断处标出"还有 N 个"。
   - 区分"未找到"和"服务不可用"，删除 `buildLimited*` 占位结果。
   - 查不到模块时报错，不再返回最大的模块。
4. **存储：** 移出用户仓库（至少写入 `.git/info/exclude`）；校验 `target_path`；删除只写不读的 index 文件。
5. **提示词：** 删去 "concepts rather than exact strings"、"before grepping"、"read/grep only after structured tools"；changed_scope 加上复用已注入 scope 的说明。按 ADR-033 写并补 eval。
6. **文档：** 关闭或重写 KNOWN_ISSUES #133，它引用的代码已经不存在。

### 8.1 实施结果

- **开关：** `auto`（默认）只开放 overview、changed_scope、changed_diff；显式 `full` 或 `light` 才开放语义工具、module/impact 注入和预热。直接调用 SDK 的 `getModuleContext` 等函数仍把 `auto` 当作 `full`，因为调用本身就是显式请求。
- **存储：** 默认写到 `<config home>/repo-intelligence/<目录名>-<路径哈希12位>`，不再写进用户仓库，因此不需要 `.git/info/exclude`。`KODAX_REPO_INTELLIGENCE_STORAGE_DIR` 可以覆盖；相对路径表示调用方有意放回工作区。`target_path` 超出执行目录和 Git 根目录时报错。删除了 `changed-scope.json`、`module-index.json`、`symbol-index.json`、`process-index.json` 这几个只写不读的文件。
- **错误语义：** 索引没响应时抛 `RepoIntelligenceUnavailableError`（`warming` 或 `unavailable`），worker 返回的"未找到"走 `RepoIntelligenceQueryError` 原样透出。relationship_scan 只在前者时停止并提示改用 read/grep/LSP。
- **KNOWN_ISSUES #133：** 以 Won't Fix 关闭，所指的测试和缓存已删除。

### 8.2 旧引擎基线（2026-11-23，KodaX 仓库，`npm run bench:repo-intel-truth`）

真值来自 TypeScript 编译器，覆盖 3,383 个源文件、20,355 个单元、25,841 条调用边。

| 关系 | 范围 | 精确率 | 召回率 |
|---|---|---|---|
| 调用目标 | 抽样 300 个符号 | 42.7% | 55.1% |
| 调用目标 | 全部 19,593 个符号 | 29.3% | 48.7% |
| 调用方（symbol_context 展示的每条 8 个） | 抽样 300 个符号 | 75.3% | 44.1% |
| 模块依赖边 | 全部 | 70% | 63.6% |

- 每个文件最多索引 40 个符号，79 个文件共丢掉 2,984 个符号。
- `.js` 后缀的 import 没有解析到 `.ts`，所以每个包都多出一条指向根模块 `.` 的假边，唯一报出的依赖环也是假的。
- 冷构建 13.8 秒、峰值 3.2 GB；worker 在 KodaX 上需要 6 GB 堆，2 GB 时内存溢出并静默返回 "unavailable"。
- 评测局限：只覆盖 TS/JS；接口调用、`any`、JSX 和嵌套函数没有完整计入；跑的是编译后的 dist。

### 8.3 提示词 eval（2026-11-23，`benchmark/repo-intel-prompt.eval.ts`）

基线是 HEAD 的提示词，候选是阶段 0 的改动。模型 glm-5.3-flash、deepseek-flash、kimi，4 个用例 × 2 组 × 每格 3 次，正式轮 72 次调用（含试跑共 82 次）。先盲评、写下结论，再揭盲。

| 用例 | 问题 | 结果 |
|---|---|---|
| C1 | 已注入 Change Scope 时是否还重复调 changed_scope | 候选 1/9，基线 2/9（deepseek 0/3 对 2/3，glm 1/3 对 0/3），持平偏候选 |
| C2 | 未注入时是否仍先调 changed_scope（防退化） | 两组 18/18，无退化 |
| C3 | 开启语义面时是否用描述句查 semantic_lookup | 只有 kimi 这样做：候选 2/3，基线 3/3；其余模型只用 grep |
| C4 | 默认面的子 Agent 是否先用自己有的工具 | 两组都没提 module_context；候选 4/9 先用 glob/grep，基线 0/9（基线用 bash dir/ls），三个模型方向一致 |

结论：发布。没有用例退化，可测到的方向都偏向候选。局限：
- 每格 3 次，只看方向。
- C2 到顶；C3 只有 kimi 表现出被测行为。
- changed_scope 与 semantic_lookup 的工具说明、repo-explorer 说明和低置信说明不在首个请求里（延迟工具只发简短提示），本 eval 测不到。
- 原始输出和盲评记录在本地 `%TEMP%/kodax-eval-dumps/repointel-p0-prompt/r3-full/`。

## 9. 待定项（开工时决定）

- 存储引擎：Rust 侧用 rusqlite（bundled）还是自定义文件格式；这只是进程内部的实现细节。
- 进程协议：stdio 上的 JSON-RPC 帧格式，复用 LSP 风格的 framing。
- 降优先级和内存上限在 Windows、Linux、macOS 上分别怎么实现；Windows 能否复用现有 Job 机制。
- tree-sitter 语法库是静态编进二进制，还是按需加载（取决于安装包体积预算）。
- 真值集用哪些外部仓库，以及它们的许可证。
