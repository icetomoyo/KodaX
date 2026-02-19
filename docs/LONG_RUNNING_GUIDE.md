# KodaX 长时间运行模式指南

本指南介绍如何使用 KodaX 进行长时间运行的项目开发，包括会话管理、CLI 自动化模式和交互式项目模式。

---

## 目录

1. [核心概念](#核心概念)
2. [会话管理](#会话管理)
3. [CLI 长运行模式](#cli-长运行模式)
4. [交互式项目模式](#交互式项目模式)
5. [提示词最佳实践](#提示词最佳实践)
6. [项目类型模板](#项目类型模板)
7. [常见问题与解决](#常见问题与解决)

---

## 核心概念

### 三种上下文模式

| 模式 | 上下文来源 | 适用场景 | 触发方式 |
|------|-----------|----------|----------|
| **单次模式** | 无持久化 | 快速问答、一次性任务 | `kodax "prompt"` |
| **会话模式** | `~/.kodax/sessions/` | 短期任务、多轮对话 | `kodax -i` 或 `-c` |
| **长运行模式** | `feature_list.json` + `PROGRESS.md` | 完整项目、多日开发 | `--init` 或 `/project` |

### 长运行模式架构

```
┌─────────────────────────────────────────────────────────────┐
│                       长运行模式                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  CLI 模式（自动化）           交互式模式（人机协作）          │
│  ├── --init <task>           ├── /project init <task>       │
│  ├── --auto-continue         ├── /project next              │
│  └── 无人值守执行             ├── /project auto              │
│                              └── 每步可确认/跳过             │
│                                                             │
│              ↓                            ↓                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │               共享项目状态                             │   │
│  │  ├── feature_list.json  (功能列表)                   │   │
│  │  ├── PROGRESS.md        (进度日志)                   │   │
│  │  └── .kodax/            (会话计划)                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 会话管理

### 会话存储位置

```
~/.kodax/
├── sessions/              # 会话文件
│   └── YYYYMMDD_HHMMSS.jsonl
├── plans/                 # Plan Mode 计划
│   └── {planId}.json
└── config.json            # 全局配置
```

### 会话文件格式

```jsonl
{"_type":"meta","title":"会话标题","id":"20250219_123456","gitRoot":"/path/to/project","createdAt":"..."}
{"role":"user","content":"用户消息"}
{"role":"assistant","content":[...]}
```

### CLI 会话命令

| 命令 | 说明 |
|------|------|
| `kodax -i` | 启动交互式模式（自动恢复最近会话） |
| `kodax -c, --continue` | 继续最近的会话 |
| `kodax -r, --resume [id]` | 恢复指定会话（无参数时显示选择器） |
| `kodax -s list` | 列出所有会话 |
| `kodax -s delete <id>` | 删除指定会话 |
| `kodax -s delete-all` | 删除当前项目所有会话 |
| `kodax --no-session` | 不保存会话（单次模式） |

### 交互式会话命令

在交互式 REPL 中：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/save` | - | 保存当前会话 |
| `/load <id>` | `/resume` | 加载指定会话 |
| `/sessions` | `/ls`, `/list` | 列出最近会话 |
| `/delete <id>` | `/rm` | 删除会话 |
| `/history` | `/hist` | 显示对话历史 |

---

## CLI 长运行模式

### 初始化项目

```bash
kodax --init "项目描述"
```

创建以下文件：
- `feature_list.json` - 功能列表和完成状态
- `PROGRESS.md` - 进度日志
- `.kodax/session_plan.md` - 当前会话计划

### 自动继续模式

```bash
kodax --auto-continue
```

自动循环执行直到所有功能完成。支持以下限制参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--max-sessions <n>` | 最大会话数 | 50 |
| `--max-hours <n>` | 最大运行时间（小时） | 2 |

### Promise 信号系统

Agent 可以输出特殊信号控制流程：

| 信号 | 含义 | 场景 |
|------|------|------|
| `<promise>COMPLETE</promise>` | 所有功能完成，停止 | 全部实现并测试通过 |
| `<promise>BLOCKED:原因</promise>` | 需要人工干预 | 缺少 API Key、依赖问题 |
| `<promise>DECIDE:问题</promise>` | 需要用户决策 | 选择技术方案 |

### CLI 工作流程

```
1. kodax --init "项目描述"
   ↓
   Agent 分析需求，创建 feature_list.json
   ↓
2. kodax --auto-continue
   ↓
   循环：
   ├── 读取 feature_list.json，选择未完成功能
   ├── 读取 PROGRESS.md，了解历史进度
   ├── 读取 git log，了解最近提交
   ├── 实现 → 测试 → commit → 更新 PROGRESS.md
   └── 检测 COMPLETE 信号，退出循环
```

---

## 交互式项目模式

交互式项目模式提供更细粒度的控制，适合需要人工监督的开发场景。

### 启动检测

当检测到项目存在 `feature_list.json` 时，启动时会显示：

```
📁 Long-running project detected
  Use /project status to view progress
  Use /project next to work on next feature
```

### `/project` 命令组

| 命令 | 别名 | 说明 |
|------|------|------|
| `/project init <task>` | `/proj i` | 初始化长运行项目 |
| `/project status` | `/proj st` | 显示项目状态和进度 |
| `/project next` | `/proj n` | 执行下一个未完成功能 |
| `/project auto` | `/proj a` | 进入自动继续模式 |
| `/project pause` | - | 暂停自动继续 |
| `/project list` | `/proj l` | 列出所有功能 |
| `/project mark <n> [done\|skip]` | `/proj m` | 标记功能状态 |
| `/project progress` | `/proj p` | 查看 PROGRESS.md |

### 命令详解

#### `/project init <task>`

初始化一个新的长运行项目：

```
/project init "TypeScript + Express 构建博客 API"
```

选项：
- `--append`：追加到现有项目
- `--overwrite`：覆盖现有项目

#### `/project status`

显示项目当前状态：

```
Project Status:
  Total Features:   15
  Completed:        8  [53%]
  Pending:          7
  Skipped:          0

Next Feature (Index 8):
  User authentication (register, login, logout)
```

#### `/project next`

执行下一个未完成功能：

```
Next Feature: Todo list page

Plan:
  1. [READ] Check current structure
  2. [WRITE] Create TodoList component
  3. [EDIT] Add routes

Execute? (y/n) >
```

选项：
- `--no-confirm`：跳过确认
- `--index <n>`：执行指定索引的功能

#### `/project auto`

进入自动继续模式：

```
Auto-Continue Mode
  Max runs: unlimited
  Current run: 3

[1/7] Todo list page - ✓
[2/7] REST API - ✓
[3/7] User profile - running...
```

执行每个功能前会要求确认（除非使用 `--no-confirm`）。

#### `/project mark <index> [done|skip]`

手动标记功能状态：

```
/project mark 3 done    # 标记为完成
/project mark 5 skip    # 跳过该功能
```

### 交互式工作流程

```
1. /project init "项目描述"
   ↓
   确认后创建 feature_list.json
   ↓
2. /project status
   ↓
   查看功能列表，了解进度
   ↓
3. /project next
   ↓
   查看计划 → 确认 → 执行 → 完成
   ↓
4. 重复步骤 3，或使用 /project auto
```

### CLI vs 交互式模式对比

| 特性 | CLI 模式 | 交互式模式 |
|------|----------|------------|
| 执行方式 | 无人值守 | 人机协作 |
| 确认机制 | 无 | 每步可确认 |
| 中断恢复 | 信号控制 | 手动控制 |
| 进度查看 | 日志输出 | 实时显示 |
| 适用场景 | CI/CD、批处理 | 日常开发 |
| 风险控制 | 低风险任务 | 关键任务 |

---

## 提示词最佳实践

### 初始化提示词结构

一个优秀的初始化提示词应包含：

```text
--init "<技术栈> <项目类型>：核心功能描述

关键要求：
- 要求1
- 要求2
- 要求3

约束条件：
- 约束1
- 约束2"
```

### 五个关键要素

#### 1. 明确技术栈

**好的例子**：
```
--init "TypeScript + Express + SQLite 构建博客 API"
--init "React + TypeScript + Vite 构建仪表盘"
--init "Node.js + Fastify + PostgreSQL 构建用户服务"
```

**不好的例子**：
```
--init "做一个博客"                    # 技术栈不明确
--init "用最新的技术做一个网站"          # 太模糊
```

#### 2. 具体功能描述

**好的例子**：
```
用户可以注册、登录、发布文章、评论文章
支持 Markdown 格式，文章可以分类和标签
```

**不好的例子**：
```
功能齐全的博客系统                      # 太笼统
有所有常见功能                          # 不明确
```

#### 3. 明确约束条件

**好的例子**：
```
约束条件：
- 单文件实现，代码不超过 800 行
- 使用 SQLite，不需要外部数据库
- API 返回 JSON 格式
- 不需要前端界面
```

**不好的例子**：
```
代码要简洁                              # 没有具体标准
要好用                                  # 太主观
```

#### 4. 分解粒度适中

Feature 应该：
- 每个 feature 可在 **1-2 个 session** 内完成
- 有明确的 **验收标准**
- 尽量 **独立**，减少依赖

#### 5. 包含测试要求

```
每个功能完成后需要：
- 编写对应的单元测试
- 测试通过才能标记完成
```

---

## 项目类型模板

### 模板 1：Node.js CLI 工具

```bash
kodax --init "TypeScript CLI 工具：<工具名称>

功能：
- 命令行入口支持多个子命令
- 配置文件支持 (JSON/YAML)
- 彩色输出和进度显示
- 错误处理和日志记录

技术要求：
- 使用 commander 或 yargs
- 单文件实现
- 支持 --help 和 --version

约束条件：
- 不依赖外部服务
- 支持 Windows/macOS/Linux
- 代码不超过 600 行"
```

### 模板 2：REST API

```bash
kodax --init "Express REST API：<API 名称>

核心资源：
- User: 注册、登录、资料管理
- Post: CRUD 操作、分页、搜索
- Comment: 关联 Post、用户权限

端点设计：
- POST /auth/register
- POST /auth/login
- GET/POST/PUT/DELETE /posts
- GET/POST /posts/:id/comments

技术要求：
- Express + TypeScript
- SQLite 数据库
- JWT 认证
- 自动 API 文档

约束条件：
- 不需要前端
- 不需要文件上传
- 代码不超过 800 行"
```

### 模板 3：Web 前端

```bash
kodax --init "React 前端应用：<应用名称>

页面结构：
- 登录/注册页
- 首页仪表盘
- 列表页 + 详情页
- 设置页

功能：
- 表单验证
- 数据分页
- 搜索过滤
- 响应式布局

技术要求：
- React + TypeScript
- Vite 构建
- CSS Modules 或 Tailwind
- React Router

约束条件：
- 使用 mock 数据，不需要后端
- 不需要国际化
- 组件不超过 20 个"
```

### 模板 4：数据处理脚本

```bash
kodax --init "Node.js 数据处理脚本：<脚本名称>

输入：
- 读取 CSV/JSON 文件
- 支持命令行指定路径

处理：
- 数据清洗和验证
- 聚合计算
- 生成统计报告

输出：
- 结果导出为 CSV/JSON
- 控制台打印摘要

技术要求：
- 使用 Node.js 流式处理
- 支持大文件
- 详细的日志输出

约束条件：
- 单文件实现
- 内存使用不超过 500MB
- 处理 100 万行数据在 30 秒内"
```

---

## 常见问题与解决

### 问题 1：Feature 太大

**症状**：一个 feature 多个 session 都完成不了

**解决**：拆分成更小的 feature

```
# 不好
"用户认证系统"  # 太大

# 好
"用户注册 API"
"用户登录 API"
"JWT token 验证"
"获取当前用户 API"
```

### 问题 2：Feature 太小

**症状**：一个 feature 几分钟就完成，产生大量琐碎的 feature

**解决**：合并相关的 feature

```
# 不好
"添加用户名字段"
"添加邮箱字段"
"添加密码字段"

# 好
"用户注册 API - 接收用户名、邮箱、密码，验证并存储"
```

### 问题 3：功能依赖混乱

**症状**：后面的 feature 依赖前面未完成的 feature

**解决**：明确依赖关系，按顺序排列

```
# 正确顺序
1. 数据库模型定义
2. 用户注册 API
3. 用户登录 API
4. 文章创建 API（依赖登录）
5. 评论 API（依赖文章和登录）
```

### 问题 4：Agent 过早宣布完成

**症状**：Feature 标记为 passes: true 但实际没有完全工作

**解决**：在提示词中强调测试验证

```bash
--init "...你的项目描述...

验收要求：
- 每个功能完成后必须手动测试
- 测试通过才能更新 passes 为 true
- TypeScript 编译无错误"
```

### 问题 5：Agent 陷入循环

**症状**：Agent 反复尝试同一个失败的操作

**解决**：使用限制参数或交互式模式

```bash
# CLI 模式：限制会话数
kodax --auto-continue --max-sessions 10

# 交互式模式：手动控制每步
/project next  # 每步确认
```

### 问题 6：需要修改 Feature 列表

**症状**：发现 Feature 定义不合理，需要调整

**解决**：使用交互式命令或直接编辑

```bash
# 查看当前列表
/project list

# 标记跳过
/project mark 3 skip

# 手动编辑 feature_list.json
```

---

## 继续开发的提示词

初始化后，继续开发时可以使用：

```bash
# CLI 模式
kodax --auto-continue                    # 自动继续
kodax "继续开发，优先完成用户认证功能"      # 聚焦特定功能
kodax "检查测试失败的原因并修复"           # 修复问题

# 交互式模式
/project next                            # 执行下一个功能
/project auto                            # 自动继续模式
```

---

## 总结

### 模式选择指南

| 场景 | 推荐模式 |
|------|----------|
| 快速问答 | 单次模式 (`kodax "prompt"`) |
| 短期多轮对话 | 会话模式 (`kodax -i`) |
| CI/CD 自动化 | CLI 长运行 (`--auto-continue`) |
| 日常项目开发 | 交互式项目模式 (`/project`) |
| 关键任务 | 交互式项目模式（每步确认） |

### 成功的提示词清单

- [ ] 明确的技术栈
- [ ] 具体的功能列表
- [ ] 清晰的约束条件
- [ ] 适中的功能粒度
- [ ] 明确的验收标准
- [ ] 包含测试要求
- [ ] TypeScript 类型安全（如适用）

### 一句话总结

> **好的提示词 = 明确的技术栈 + 具体的功能 + 清晰的约束 + 可验证的标准**
