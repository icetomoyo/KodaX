# FEATURE_318 CLI、REPL 命令、帮助与健康检查重构

状态：设计中（2026-11-23），在 `KodaX-next-dev` 上随 SDK v2 一起做，归 v0.7.97。

## 为什么

现状盘点（2026-11-23，只读代码得出）：

- `src/kodax_cli.ts` 有 4866 行，命令解析、帮助文字、Host 管理、补全脚本全在一个文件里。
- 帮助和命令清单分散在大约十处：`showBasicHelp`、`CLI_HELP_TOPICS`、ACP/skill 手写帮助、bare `memory`/`sessions` 的手写清单、Commander 自动帮助、三份互相不一致的子命令名单（`KODAX_CLI_SUBCOMMAND_NAMES`、`KODAX_COMPLETION_ROOT_SUBCOMMANDS`、`INTEGRATION_COMMAND_DESCRIPTIONS`）、补全脚本、REPL `COMMAND_CATEGORIES`、自我认知手册的 `commands` 主题。它们已经互相矛盾：
  - 基础帮助和 `project` 主题写着不存在的 `/project`；
  - `thinking` 主题和 `--effort` 帮助列的档位不同；
  - 补全缺 `daemon pair|devices`、`a2a enable|disable|migrate*`、`-s cleanup-acp`、`auth` 子命令，还在补 `--extension`。
- README 和 quickstart 写着 CLI 会拒绝的写法：`--fork`、`--mode plan|accept-edits|…`（`--mode` 只收 `json`）、`kodax /repo-intel status`（CLI 不执行 REPL 内置命令，会当成提示词发给模型）、`--session <name>` 能“按名字新建或恢复”（实际只当 Session ID）。
- Host 管理：
  - `kodax daemon status/stop` 走 v1 协议，v1 在 0.7.100 删除（FEATURE_314）；
  - `restart` 在 Host 没跑或已失效时不会启动，直接报失败（`kodax_cli.ts` 1680-1728，`stop` 早退时 `stopped:false` 走进失败分支），第三个分支永远走不到；
  - `status` 不论健康与否都退出 0，脚本无法判断；
  - 健康有三套说法：CLI 的 missing/mismatch/healthy/stale/unhealthy、`/healthz` 的 starting/ready/draining、`kodax doctor` 根本不查 Host。
- `mcp`、`integrations`、`extensions`、`a2a`、`sandbox`、`config paths`、`execpolicy` 只输出 JSON，没有 `--json` 开关；`integrations status` 在 `ok:false` 时也退出 0。
- 已经没用的旧开关还在：`-n`（no-op）、`-y`（非 REPL 无效）、`--extension`（运行时直接抛错）；REPL 的 `/repointel` 是隐藏的旧别名，`COMMAND_CATEGORIES` 里的 `plan` 没有对应命令。

## 已定决策（用户，2026-11-23）

- A：`kodax daemon` 改名 `kodax host`。`daemon` 作为隐藏别名保留到 0.7.100，与 v1 一起删除。
- B：常用的旧写法保留别名过渡（如 `-s list`、`/thinking`）。坏掉的或没用的直接删，报错并指向新写法（`-n`、`-y`、`--extension`、`/repointel`、`/plan`）。
- C：只输出 JSON 的命令改成默认文字，加 `--json` 输出机器可读结果。

## 目标形态

### 1. 一份命令表

CLI 子命令和 REPL 命令各有一份数据表，帮助、补全、名单、手册对照测试都从表里来，不再手写第二份。

- CLI 表的每一项：名字、一句话说明、子命令、开关（名字、参数、说明、是否隐藏）、别名、`deprecated`（换成什么写法、哪个版本删）、懒加载的处理函数。
- REPL 已有 `CommandRegistry`；给命令加 `category`，`/help` 的分类从命令自己的 `category` 生成，删掉手写的 `COMMAND_CATEGORIES`。
- 补全脚本由 CLI 表生成，bash/zsh/fish 三种只是输出格式不同。

### 2. Host 管理：`kodax host`

| 命令 | 作用 |
|---|---|
| `kodax host start` | 启动；已在运行就报告并退出 0 |
| `kodax host stop [--force]` | 停止 |
| `kodax host restart [--force]` | 先停再起；没在运行或已失效时直接启动 |
| `kodax host status` | 健康状态 |
| `kodax host logs [--lines n] [--follow]` | 日志；`--follow` 未经用户确认，见“未定” |
| `kodax host serve` | 前台运行（服务管理器用） |
| `kodax host pair` / `devices` / `devices revoke` | 设备配对，不变 |

- `kodax daemon …` 是隐藏别名，往 stderr 打一行“`kodax daemon` 已改名为 `kodax host`，0.7.100 删除”，其余行为相同。别名登记进 `src/host-protocol-v1-removal.test.ts` 的 0.7.100 清单，到期不删就构建失败。
- 全部走 v2：
  - 探测连接用 v2 `initialize` 加一个可选的 `client.purpose: 'probe'`。探测连接只能调 `ping`、`host.get`、`host.preflight`（只读），不算已连接的客户端，不重置空闲计时，也不出现在 `host.preflight` 的 `clients` 里。这和 v1 的 `connectionPurpose: 'probe'` 是同一件事，v2 原来没有；v2 在 Host 内部转到 v1 dispatcher 时带上 `probe`，沿用 v1 的只读限制。`status` 要的计数和待处理交互数由 `host.get` 与 `host.preflight` 给出。
  - 身份核对：`initialize` 结果里的 `host.id` 等于 `daemon.json` 的 `runtimeId`，锁文件的持有者与 `daemon.json` 一致。
  - `observeRuntimeDaemonHealth` 改为 v2 探测，调用方（status、stop、start、serve、A2A 归属检查、设备 CLI、process.ts）不变。
- 停止和日志用普通客户端连接调 `host.stop`、`host.logs`（v1 的 stop 也是普通连接）；Windows 进程树兜底和替换检测保持原样。

### 3. 一个健康模型

CLI、REPL `/status`、`/healthz`、`kodax doctor` 用同一组状态：

| 状态 | 意思 | `host status` 退出码 |
|---|---|---|
| `ready` | 在运行，身份对得上，接受新 Run | 0 |
| `starting` | 进程在，还没就绪 | 0 |
| `draining` | 在停止，不接新 Run | 0 |
| `stopped` | 没有 Host（没有状态文件，或进程已不在） | 3 |
| `stale` | 状态文件指向的进程不在了 | 3 |
| `unreachable` | 进程在，但连不上或握手失败 | 1 |
| `mismatch` | 连上的不是状态文件里的那个 Host | 1 |

- `/healthz` 继续只报 `starting`/`ready`/`draining`（网络探测只关心这三个），字段名不变。
- 退出码 3 表示“没在运行”，与 LSB `status` 约定一致（未经用户确认）。
- `kodax doctor` 增加 Host 一项：报告上面的状态；Host 不健康、存储坏、没有可用 Provider 凭据时退出 1。现在它永远退出 0。

### 4. 输出与退出码约定

- 默认输出给人看的文字；`--json` 输出一个 JSON 对象，字段就是现在的 JSON 输出，脚本迁移只需加 `--json`。
- 退出码：0 成功；1 失败；2 用法错误（未知开关、缺参数，Commander 已经这样）；3 只用于 `host status` 的“没在运行”。
- 结果里 `ok:false` 的命令（如 `integrations status`、`validate`）退出 1。
- 一次性运行（`-p`、带提示词）的退出码规则不变。

### 5. 旧写法

| 旧写法 | 处理 |
|---|---|
| `kodax daemon …` | 隐藏别名，0.7.100 删 |
| `-s list` / `-s delete <id>` / `-s delete-all` / `-s cleanup-acp` | 保留别名，指向 `kodax sessions list\|delete\|…`；`-s <id>` 保持“用这个 Session ID” |
| `-t, --thinking` | 保留，`--reasoning auto` 的别名 |
| `-n, --new` | 删，报错：新会话是默认行为 |
| `-y, --auto` | 删（现在任何地方都不读它），报错：权限模式用配置 `permissionMode` 或 REPL `/mode` |
| `--extension` | 删，报错：用 `kodax extensions add` |
| `/thinking`、`/think`、`/t` | 保留，是 `/reasoning` 的别名 |
| `/repointel`、`/ri` | 删，报错指向 `/repo-intel status` |
| `/plan`（分类里的残留） | 删；计划模式是 `/mode plan` |
| `/project`（帮助里的残留） | 从帮助和 `project` 主题删掉 |

- `kodax sessions` 收拢 `-s` 的各种操作：`list`、`delete`、`delete-all`、`cleanup-acp`、`dedupe`。

### 6. 文件拆分

`src/kodax_cli.ts` 只留入口和总表装配；每组命令一个文件放在 `src/cli/`：`host.ts`、`sessions.ts`、`run.ts`（根命令的一次性运行与恢复）、`skill.ts`、`tools.ts`、`help.ts`、`completion.ts`。integration 那组（`integration-cli.ts`）已经是独立文件，只接入总表并补上文字输出。

## 分期

1. **Host 管理与健康模型**：v2 `client.purpose: 'probe'`；`observeRuntimeDaemonHealth` 改 v2；`kodax host` 加 `daemon` 别名；restart 修好；健康状态表；`status` 退出码；`/status` 和 `doctor` 用同一个模型。
2. **CLI 命令表**：总表、帮助、补全从表生成；`--json` 与退出码约定；旧开关按上表处理；拆 `kodax_cli.ts`；README / quickstart 改正。
3. **REPL 命令**：`category` 字段生成 `/help`；`/thinking` 等合并成别名；删 `/repointel`、`/plan`、`/project` 残留。
4. **文档与防漂移测试**：
   - 帮助、补全、REPL `/help` 与命令表一一对应；
   - README、README_CN、`public_docs/` 里的 `kodax …` 示例逐条用命令表解析，开关或子命令不存在就失败；
   - 自我认知手册 `commands` 主题与两张表双向对照（扩展现有 `commands-manual-drift.test.ts`）。

每期单独提交、单独推送；每期结束跑全量测试。

## 影响

- **Space 与 SDK 调用方**：不调用这些 CLI 命令，走 SDK。v2 `initialize` 只加一个可选字段，`methods.contract.json` 随之更新。
- **脚本**：解析 `kodax mcp list` 等 JSON 输出的脚本要加 `--json`；CHANGELOG 和 SDK_MIGRATION 写明。
- **模型可见内容**：自我认知手册（`manual-topics.json`）的 `commands` 和 Host 相关主题要改写。按 ADR-033 写，并按 `benchmark/EVAL_GUIDELINES.md` 补一个 eval：问模型“怎么重启 Host / 怎么看 Host 日志”，答案用 `kodax host`。

## 未定（未经用户确认，按推荐先做）

- `host status` 用退出码 3 表示没在运行。
- `kodax host logs --follow`：现在没有，运维常用；第 1 期顺手加，代价小。
- `-s` 系列保留到什么时候删：建议和 `daemon` 一起在 0.7.100 删。
