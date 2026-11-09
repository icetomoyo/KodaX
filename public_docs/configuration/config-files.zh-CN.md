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

## 共享 Host 所有权

产品 CLI 使用共享 Daemon Host。产品 SDK 应用使用 `ensureKodaXClient` 或 `connectKodaXClient`。详见 [SDK 迁移指南](../../docs/SDK_MIGRATION.md)。

```bash
kodax daemon start
kodax -p "Review 这个仓库"
kodax daemon stop --profile default
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
