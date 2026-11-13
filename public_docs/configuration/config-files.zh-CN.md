# 配置文件

KodaX 从 `~/.kodax/` 读取配置，采用严格的分文件布局。

## 文件结构

| 文件 | 用途 |
|---|---|
| `~/.kodax/config.json` | 核心配置（严格 JSON） |
| `~/.kodax/config.example.jsonc` | 包含所有设置的注释参考文件 |
| `~/.kodax/exec-policy.jsonc` | 用户宿主执行策略（可选 JSONC） |
| `~/.kodax/integrations/mcp.json` | MCP 服务器定义 |
| `~/.kodax/integrations/extensions.json` | 扩展定义 |
| `~/.kodax/integrations/a2a.json` | A2A Agent 定义 |

`config.example.jsonc` 第一行指向所有分文件，并记录每个受支持的核心设置。

## 核心配置示例

```json
{
  "provider": "zhipu-coding",
  "effort": "auto"
}
```

工作模式（`agent | coding | script`）是会话级别的选择，不是全局 `config.json` 字段。通过 `--work-mode`、`/work-mode` 或 `client.sessions.updateSettings` 修改；切换需要会话空闲。默认为 Coding，Script 为实验性功能。

## 环境变量

并非每个设置都有 `KODAX_*` 环境变量等价项。常见支持的映射如下；更多提供商、回退、仓库智能和诊断映射记录在注释模板中。优先级从高到低：

1. 显式 CLI/SDK 选项
2. 环境变量（`KODAX_*`）
3. `config.json`
4. 内置默认值

| JSON 键 | 环境变量 | 默认值 |
|---|---|---|
| `provider` | `KODAX_PROVIDER` | —（首次运行时提示） |
| `effort` | `KODAX_EFFORT` | `auto` |
| （主目录） | `KODAX_HOME` | `<OS 用户主目录>/.kodax` |

JSON 键使用 camelCase，环境变量使用 `KODAX_大写下划线_命名`。

## 代理与私有根证书

KodaX Host 启动时读取以下标准环境变量：

- `NODE_EXTRA_CA_CERTS=/path/to/root.pem`：为模型请求和 `web_fetch` 追加私有根证书。
- `HTTPS_PROXY`、`HTTP_PROXY`：指定代理，小写变量名同样有效。
- `NO_PROXY`：不走代理的主机列表，例如 `localhost,127.0.0.1,.corp.example`。

在 Node 22.21+ 或 24.5+ 上还需要设置 `NODE_USE_ENV_PROXY=1`，否则 Node 会忽略代理变量。Node 20 以及更早的 22/24 版本无法使用代理变量，请升级 Node 或改用单文件二进制。二进制版本的模型请求无需额外设置即可走代理；如果 `web_fetch` 也必须走代理，同样设置 `NODE_USE_ENV_PROXY=1`。

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root.pem
export HTTPS_PROXY=http://proxy.corp.example:3128
export NO_PROXY=localhost,127.0.0.1,.corp.example
export NODE_USE_ENV_PROXY=1
kodax daemon stop   # 已运行的 Host 沿用它启动时的环境变量
kodax -p "Review this repository"
```

设置了代理变量、但仍有请求会绕过代理时，Host 会向 `kodax daemon logs` 写入一条 `[runtime:network]` 警告。警告只给出变量名，不会打印变量值。

## 共享 Host 所有权

产品 CLI 使用共享 Daemon Host。产品 SDK 应用使用 `ensureKodaXClient` 或 `connectKodaXClient`。详见 [SDK 迁移指南](../../docs/SDK_MIGRATION.md)。

```bash
kodax daemon start
kodax -p "Review 这个仓库"
kodax daemon stop
```

Daemon 状态、配置和 Runtime 会话存储默认使用解析后的 `KODAX_HOME`（通常为 `<OS 用户主目录>/.kodax`），CLI 和 SDK 客户端因此收敛到同一个本地 Daemon。

`--home <dir>` 为测试、CI 或项目级实验选择隔离的 `<dir>/.kodax` 命名空间。

## Shell 环境

模型发出的 Shell 命令继承宿主环境（包括常规开发凭据）。废弃的 `sandbox.envPass` 字段因升级兼容性被忽略，不应写入新模板。

## 执行策略（Exec Policy）

执行策略与 `config.json` 刻意分离，仅在操作即将在 OS 沙箱外执行时才进行评估。策略文件缺失等同于无用户规则，不会阻塞启动。

```jsonc
{
  "rules": [
    {
      "prefix": [["npm", "pnpm"], "publish"],
      "decision": "prompt",
      "justification": "发布会修改外部注册表",
      "match": ["npm publish"],
      "notMatch": ["npm test"]
    }
  ]
}
```

每条规则包含 token `prefix`、决策（`allow`、`prompt` 或 `forbidden`）和非空说明。`match` 与 `notMatch` 是加载时的校验示例，不是额外的运行时谓词。最严格的匹配决策优先。

仓库策略文件 `<repo>/.kodax/exec-policy.jsonc` 仅在受信 SDK Host 将该仓库根目录加入 `execPolicy.trustedProjectRoots` 后才生效，以防新克隆的仓库自行获得非沙箱权限。诊断 CLI 使用 `--trust-project-policy` 参数才会包含它：

```bash
kodax execpolicy check -- git push origin main
kodax execpolicy check --trust-project-policy -- git push origin main
```

## 另见

- [提供商](./providers.zh-CN.md) — 提供商配置
- [自定义提供商](./custom-providers.zh-CN.md) — 自定义端点配置
- [沙箱](./sandbox.zh-CN.md) — OS 级别隔离
- [SDK 嵌入指南](../sdk/embedder-guide.md) — Runtime SDK 与 Daemon API
