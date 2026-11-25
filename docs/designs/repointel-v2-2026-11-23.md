# RepoIntel v2：可信且不拖慢 KodaX 的仓库智能

日期：2026-11-23。状态：**阶段 0 已发布（v0.7.97-beta.12）；阶段 1 进行中（2026-11-25 起，计划见 §10）。**
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

## 9. 开工时的决定（2026-11-24 用户确认）

体积实测（2026-11-24，Windows，发布用的编译设置）：程序本身 0.13 MB；rusqlite（bundled）+1.70 MB；语法库 TypeScript 含 TSX 2.93、JavaScript 0.49、Python 0.54、Go 0.30、Rust 1.19、Java 0.49、C++ 3.50 MB；七种全部 9.07 MB，再加 SQLite 10.77 MB（gzip 后 1.88 MB）。现在的 npm 包把五个平台的原生程序放在同一个包里，`0.7.97-rc.2` 解压后 35.0 MB，其中原生程序 4.5 MB。

1. **存储：rusqlite（bundled）。** 增量更新、写到一半崩溃不坏库、多读者都是现成的。bundled 的 SQLite 编译时开了 FTS5，阶段 4 的 BM25 直接用它。
2. **进程协议：JSON-RPC 2.0，消息前带 `Content-Length` 头（和 LSP 一样）。** Host 侧用 LSP 客户端已经依赖的 `vscode-jsonrpc`，请求配对、取消和错误处理都现成。
3. **降优先级和内存上限：三个平台同一套做法。**
   - 降优先级：索引进程启动时自己进入后台模式，不需要特权。Windows 用 `PROCESS_MODE_BACKGROUND_BEGIN`；Linux 用 nice 10 加磁盘 IO 的 idle 级；macOS 用 `PRIO_DARWIN_BG`。
   - 内存：索引进程自己盯着用量，接近 300 MB 预算时停止扩大缓存，结果标为降级。Host 每隔几秒读它的实际内存，超过硬上限就结束它、标为降级，退避后重启。
   - 不单独给 Windows 套带内存上限的嵌套 Job：Linux 和 macOS 没有不需要特权的对等手段，硬上限还是要靠 Host 监视。Linux 的 `RLIMIT_AS` 按虚拟地址空间计，SQLite 和 Rust 的预留会被误判成超限。
   - 索引进程是 Host 的子进程，本来就在 Host 的 Job 里，Host 退出它跟着退出，这部分不用写代码。
4. **语法库和安装包。**
   - 语法库静态编进程序，不在运行时加载外来原生代码。
   - RepoIntel 不做成扩展。接入代码（拉起和监管进程、地图注入、工具、L3）留在核心里；原生程序是可以缺的组件，缺了就退回只用 git 的工具面，并如实报告"未索引"。
   - 阶段 1、2 放在开关后面，原生程序不进 npm 包，CI 为五个平台编出来放进 GitHub Release 的附件。
   - 默认打开之前按评测结果二选一：值得默认打开就按平台拆包（npm `optionalDependencies`，和 Claude Code、Codex 一样）；只对部分人有用就做成按需下载的组件（和 pi 下载 rg、fd 一样）。
   - 现有的必需原生程序（Windows 沙箱 helper、文本事务）留在主包里，不拆出去：它们缺了 Host 起不来，拆出去会让离线环境里漏同步一个包变成装好了却打不开。
   - 离线安装（客户里有离线环境，用户 2026-11-24 要求）：
     - 单文件版：GitHub Release 每个平台的压缩包里同时放 RepoIntel 程序，拷一个包就齐了。离线环境首推这个。
     - npm 加内网仓库：同步主包时，把目标机器平台的 RepoIntel 包一起同步，版本和主包一致。在另一种系统的机器上装一遍来填内网仓库，会漏掉其他平台的包；安装文档列出要同步的包名。
     - 如果选了按需下载：另外提供本地文件安装，指定从 Release 下载的压缩包，用主包里记下的哈希校验。
     - 组件缺失或版本对不上时不阻塞使用：RepoIntel 退回只用 git 的工具面，`kodax doctor` 和 RepoIntel 的状态里写明缺哪个包、哪个版本、怎么补。
5. **真值集：** 每个仓库固定到某个提交，评测时下载，不放进本仓库；检出时核对许可证。
   - TypeScript：KodaX 本身加 `honojs/hono`（MIT）。KodaX 同时充当混合语言仓库（TS、Rust、少量 Python）。
   - Python：`encode/httpx`（BSD-3）。
   - Go：`gin-gonic/gin`（MIT）。
   - Rust：`BurntSushi/ripgrep`（MIT/Unlicense）。
   - Java（只有语法层）：`google/gson`（Apache-2.0）。
   - C++（只有语法层）：`fmtlib/fmt`（MIT）。
   - 1 万文件的性能基准：`microsoft/vscode`（MIT）。
   - 真值来源：SCIP 索引器（scip-typescript、scip-python、scip-go）和 rust-analyzer 的 SCIP 输出。
## 10. 阶段 1 实施计划（2026-11-25）

范围按 §7：Rust 引擎 L0 + L1、诚实契约、外部存储，放在开关后，由 Host 管理。

### 10.1 分层提交

1. 本节计划。
2. crate `native/repo-intel`：stdio 上的 JSON-RPC（`Content-Length` 分帧）、`initialize` / `shutdown`、启动即进入后台优先级。
3. L0：`git ls-files` 清单、内容 hash、SQLite 存储；按文件增量。
4. L1：七种语言的 tree-sitter 提取（定义、引用、import、完整签名、doc 注释）。用各语法库自带的 `tags.scm`，TS 要叠加 JS 的查询；签名和注释由引擎按节点补。
5. 查询和诚实契约：精度、完整性（翻页）、新鲜度、未索引原因。
6. Host 侧：找程序、拉起、监管、空闲回收、编辑通知、`kodax doctor` 状态。
7. 评测：真值集适配和性能基准。
8. 构建：`build:native` 和 CI 只把程序放进 Release 附件。

### 10.2 引擎协议（阶段 1）

| 方法 | 作用 |
|---|---|
| `initialize` | Host 给出存储根目录和内存预算；引擎回版本和支持的语言 |
| `workspace.open` / `workspace.close` | 开始或停止维护一个仓库的索引；后台进行，立即返回 |
| `workspace.status` | 状态（索引中 / 就绪 / 降级）、已索引和过期文件数、按原因分组的未索引文件、引擎自报内存 |
| `files.changed` | Host 的编辑工具通知改了哪些文件 |
| `symbols.definitions` / `symbols.references` | 按名字查；每条带精度，整体带完整性和新鲜度 |
| `file.outline` | 一个文件的定义、签名和注释；文件过期就现场重新分析 |

- 阶段 1 的引用都是名字匹配，标为 `heuristic`；定义标为 `syntactic`。
- 外部改动的兜底：引擎在后台定期比对清单里文件的修改时间和大小，并重跑 `git ls-files` 发现新文件。阶段 1 不引入文件监视库。

### 10.3 未经用户确认的实现选择

- **开关：** 环境变量 `KODAX_REPO_INTELLIGENCE_ENGINE=v2`。打开后 Host 拉起引擎并维护索引。阶段 1 不改 Agent 看到的工具和提示词，地图注入和工具在阶段 2 起接入，所以本阶段不需要提示词 eval。
- **内存上限：** 引擎自己报 RSS，Host 定时读取。超过硬上限、或者 ping 不回，Host 就结束它、标为降级，并退避重启。这样 Host 不用为读别的进程的内存加新的原生代码。引擎不保留语法树，SQLite 页缓存有上限，所以内存靠设计封顶。
- **进入下一阶段的门槛：** 阶段 1 没有 L2 的模块解析，调用边只能是名字匹配，跟旧引擎比调用边精确率不公平。门槛定为：
  - 在 KodaX 上按编译器真值，定义的精确率和召回率都要高于旧引擎（旧引擎每个文件最多 40 个符号）；
  - 每条引用都标 `heuristic`，没有静默截断；
  - 性能达到 §5 的预算（KodaX 和 `microsoft/vscode`）。
  - 调用边照常统计，只作为阶段 2 的基线。
- **存储位置：** `<config home>/repo-intelligence-v2/<目录名>-<路径哈希12位>/index.sqlite`，和阶段 0 的旧存储分开。
- **大纲的范围：** 阶段 1 的签名就是定义所在的那一行，去掉首尾空白，最长 200 个字符。阶段 1 不提取 doc 注释和 import，留到 L2 再做，因为它们要按节点去补。阶段 1 的门槛只看定义，所以缺这两样不影响门槛。
- **新鲜度：** 状态里不报过期文件数。要报这个数就得逐个 stat 文件，代价和一次全量扫描一样。改为每条命中自己带 `stale`：查询时比对该文件现在的大小和修改时间。`file.outline` 遇到过期文件就现场分析，并通知索引跟上。
- **翻页：** `limit` 默认 50，最大 500。回答带 `total`、`offset` 和 `nextOffset`（没有下一页时为 null）。回答还带 `coverage`：索引状态、已索引数、有语法错误的文件数，以及按原因分组的未索引数。
- **Host 侧（第 6 层）：**
  - 找程序：先看 `KODAX_REPO_INTELLIGENCE_ENGINE_PATH`，再按现有原生程序的位置找（`native/<平台>`、`dist/native/<平台>`、可执行文件旁的 `vendor/kodax-native/<平台>`），最后找源码目录里 `cargo build --release` 的产物。阶段 1 程序不进 npm 包，所以需要这个环境变量。程序不做哈希校验：它只读仓库、只写自己的存储目录，和沙箱 helper 不同。
  - 监管：第一个 Run 打开仓库时才拉起。每 5 秒读一次 `engine.status`，兼作心跳；5 秒不回，或者常驻内存超过预算的两倍（默认 600 MB），就结束它，从 1 秒起每次翻倍、最长 5 分钟后重启，并重新打开原来的仓库。稳定运行 10 分钟以上再出错，等待时间从头算。10 分钟没人用就停掉，忘掉打开过的仓库，下一个 Run 再打开。
  - 硬上限取预算的两倍：预算是引擎自己收缩缓存的线，硬上限应在它之上，只用来处理卡住或泄漏的进程。
  - 编辑通知：`run.started` 打开该 Run 的仓库（会话的 gitRoot，没有就用执行目录）；`tool.finished` 里文件工具记下的改动路径换成仓库内的相对路径后转给引擎。shell 命令改的文件靠引擎 15 秒一次的扫描跟上。路径不在该仓库内的改动（例如在别的 worktree 里）不转发。
  - 引擎启动时到达的编辑通知会丢掉，因为打开仓库时本来就会全量扫描一遍。
  - `kodax doctor` 报告开关、程序在哪或在哪些位置找过，以及把程序拉起一次读到的版本、语言和后台优先级。程序缺失或起不来只报告，不让 doctor 失败。
