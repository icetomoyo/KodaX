# 快速开始

## 四种使用方式

| 形式 | 命令 / 导入 | 适用场景 |
|---|---|---|
| **REPL** | `kodax` | 流式 UI 的交互式多轮编程会话，含权限管理和斜杠命令 |
| **CLI** | `kodax -p "你的任务"` | 单次脚本任务、CI 运行、批量处理 |
| **库** | `import { runKodaX } from '@kodax-ai/kodax'` | 嵌入自有工具 / Agent / Web 服务 |
| **单文件二进制** | `./kodax` | 分发到没有 Node 的机器——无需安装 |

## 启动 REPL

```bash
kodax
```

然后在 REPL 里自然提问：

```
读取 package.json 并概括架构
/mode
/help
```

Shift-Tab 在 Plan → Edits → Auto[LLM] → Full Access 之间切换权限模式；Shift+Enter 输入换行。

## 运行单次 CLI 任务

```bash
kodax "Review 这个仓库并概括架构"
kodax --session review "找出 src/ 中最危险的部分"
kodax --session review "给出具体的修复建议"
```

## 基本工作流

1. **打开项目** — 在你的项目目录里运行 `kodax`。KodaX 自动检测仓库结构并构建仓库智能快照。
2. **给出任务** — 用自然语言描述你想做什么。合规的 Shell 命令首先在沙箱中执行；只有经过验证的预启动宿主边界才会触发 Edits 审批或 Auto[LLM] 审查。
3. **审查改动** — KodaX 在应用编辑前展示差异。使用 Plan 模式（Shift-Tab）可在任何编辑发生前先看计划。
4. **运行测试** — 让 KodaX 运行你的测试套件并修复失败。
5. **继续会话** — 会话按项目持久化。`kodax -r` 选择已保存的会话，`kodax -r <id>` 直接恢复，`kodax -c` 继续最近一次符合条件的会话。

## 有用的斜杠命令

| 命令 | 作用 |
|---|---|
| `/mode` | 查看或切换权限模式 |
| `/provider` | 查看或切换 LLM 提供商 |
| `/model` | 查看或切换模型 |
| `/effort` | 调整推理强度 |
| `/session` | 列出、Fork 或管理会话 |
| `/sandbox` | 查看沙箱就绪状态 |
| `/help` | 完整命令参考 |

## 下一步

- [配置文件](../configuration/config-files.zh-CN.md) — 核心设置与优先级
- [权限模式](../configuration/permissions.zh-CN.md) — 沙箱优先权限策略
- [沙箱](../configuration/sandbox.zh-CN.md) — 平台隔离与配置
- [SDK 嵌入指南](../sdk/embedder-guide.md) — 在你的应用中嵌入 KodaX
