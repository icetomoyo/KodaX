# KodaX 长时间运行模式指南

本文档提供使用 `--init` 开发完整项目的最佳实践和提示词范例。

---

## 目录

1. [核心概念](#核心概念)
2. [提示词最佳实践](#提示词最佳实践)
3. [项目类型模板](#项目类型模板)
4. [常见问题与解决](#常见问题与解决)

---

## 核心概念

### 两种上下文模式

| 模式 | 上下文来源 | 适用场景 |
|------|-----------|----------|
| **会话模式** | Session 文件 (`~/.kodax/sessions/`) | 短期任务、快速修复 |
| **长运行模式** | 项目状态文件 (`feature_list.json`, `PROGRESS.md`, git log) | 完整项目、多日开发 |

### 长运行模式工作流

```
┌─────────────────────────────────────────────────────────────┐
│  1. --init "项目描述"                                        │
│     → 创建 feature_list.json + PROGRESS.md + init.sh        │
│     → 执行第一个 session，完成初始功能                        │
├─────────────────────────────────────────────────────────────┤
│  2. --auto-continue 或 "继续开发"                            │
│     → 读取 feature_list.json，选择未完成功能                  │
│     → 读取 PROGRESS.md，了解历史进度                          │
│     → 读取 git log，了解最近提交                              │
│     → 实现功能 → 测试 → git commit → 更新 PROGRESS.md         │
├─────────────────────────────────────────────────────────────┤
│  3. 重复步骤 2 直到所有功能完成                               │
│     → Agent 输出 <promise>COMPLETE</promise> 自动停止        │
└─────────────────────────────────────────────────────────────┘
```

---

## 提示词最佳实践

### 初始化提示词结构

一个优秀的 `--init` 提示词应包含：

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
node dist/kodax.js --init "TypeScript CLI 工具：<工具名称>

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
node dist/kodax.js --init "Express REST API：<API 名称>

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
node dist/kodax.js --init "React 前端应用：<应用名称>

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
node dist/kodax.js --init "Node.js 数据处理脚本：<脚本名称>

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

## 提示词完整范例

### 范例 1：Todo CLI

```bash
node dist/kodax.js --init "TypeScript Todo CLI 工具

功能：
1. 添加任务：todo add \"任务内容\" --priority high
2. 列出任务：todo list [--done|--pending]
3. 完成任务：todo done <id>
4. 删除任务：todo delete <id>
5. 清理已完成：todo clear

数据存储：
- 使用 JSON 文件存储（~/.todo.json）
- 支持任务 ID、内容、优先级、创建时间、完成状态

技术要求：
- 使用 commander 处理命令行参数
- 单文件实现（todo.ts）
- 编译为 node dist/todo.js

约束条件：
- 不使用数据库
- 不需要认证
- 代码不超过 300 行
- 每个命令有 --help 说明

验收标准：
- 所有命令正常工作
- 数据持久化正确
- 错误处理友好"
```

### 范例 2：博客 API（完整版）

```bash
node dist/kodax.js --init "Express + TypeScript 博客 API

核心功能：
1. 用户认证
   - POST /auth/register - 用户注册（用户名、邮箱、密码）
   - POST /auth/login - 登录返回 JWT token
   - GET /auth/me - 获取当前用户信息

2. 文章管理
   - GET /posts - 获取文章列表（分页、排序）
   - POST /posts - 创建文章（需要认证）
   - GET /posts/:id - 获取单篇文章
   - PUT /posts/:id - 更新文章（仅作者）
   - DELETE /posts/:id - 删除文章（仅作者）

3. 评论系统
   - GET /posts/:id/comments - 获取评论列表
   - POST /posts/:id/comments - 发表评论（需要认证）
   - DELETE /comments/:id - 删除评论（仅作者）

4. 搜索功能
   - GET /search?q=keyword - 搜索文章标题和内容

数据模型：
- User: id, username, email, password_hash, created_at
- Post: id, title, content, author_id, created_at, updated_at
- Comment: id, content, post_id, author_id, created_at

技术栈：
- Express + TypeScript
- SQLite + better-sqlite3
- JWT 认证 (jsonwebtoken)
- 密码哈希 (bcrypt)

约束条件：
- 单文件实现（blog_api.ts）
- 代码不超过 800 行
- 不需要前端界面
- 不需要图片上传
- 不需要邮件验证

质量要求：
- 所有端点有错误处理
- 返回正确的 HTTP 状态码
- TypeScript 编译无错误"
```

### 范例 3：代码分析器

```bash
node dist/kodax.js --init "TypeScript 代码分析工具

功能：
1. 代码统计
   - 统计代码行数、注释行数、空行数
   - 按文件类型分类统计
   - 计算注释率

2. 复杂度分析
   - 函数圈复杂度
   - 函数长度统计
   - 识别过长函数

3. 依赖分析
   - 解析 import 语句
   - 生成依赖关系图
   - 识别循环依赖

4. 报告生成
   - 控制台彩色输出
   - JSON 格式导出
   - Markdown 报告

使用方式：
- code-analyzer analyze <path>
- code-analyzer stats <path>
- code-analyzer deps <path>
- code-analyzer report <path> --format json

技术要求：
- 使用 TypeScript Compiler API 解析代码
- 单文件实现
- 编译为 node dist/code-analyzer.js

约束条件：
- 只分析 TypeScript/JavaScript 代码
- 不修改源文件
- 代码不超过 500 行"
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

**解决**：使用 `--max-sessions` 限制

```bash
# 限制最多 10 个 session
node dist/kodax.js --auto-continue --max-sessions 10
```

---

## 继续开发的提示词

初始化后，继续开发时可以使用：

```bash
# 标准继续
node dist/kodax.js "继续开发"

# 聚焦特定功能
node dist/kodax.js "继续开发，优先完成用户认证功能"

# 修复问题
node dist/kodax.js "检查测试失败的原因并修复"

# 添加新功能
node dist/kodax.js "在现有功能基础上，添加搜索功能"

# 代码审查
node dist/kodax.js "审查代码质量，找出可以改进的地方"

# 第二天继续
node dist/kodax.js --session resume "继续昨天的工作"
```

---

## 信号系统

Agent 可以使用特殊信号控制流程：

| 信号 | 含义 | 示例 |
|------|------|------|
| `<promise>COMPLETE</promise>` | 所有功能完成，停止 | 功能全部实现并测试通过 |
| `<promise>BLOCKED:原因</promise>` | 需要人工干预 | 缺少 API Key |
| `<promise>DECIDE:问题</promise>` | 需要用户决策 | 选择数据库类型 |

---

## TypeScript 项目特有建议

### 类型安全

```
验收要求：
- TypeScript strict 模式编译通过
- 所有函数有类型注解
- 无 any 类型（除非必要）
```

### 构建和测试

```
技术要求：
- npm run build 编译无错误
- 源码在 src/ 目录
- 编译输出在 dist/ 目录
```

### 依赖管理

```
约束条件：
- 使用 esbuild 或 tsc 编译
- 运行时依赖最小化
- 开发依赖单独管理
```

---

## 总结

### 成功的 `--init` 提示词清单

- [ ] 明确的技术栈
- [ ] 具体的功能列表
- [ ] 清晰的约束条件
- [ ] 适中的功能粒度
- [ ] 明确的验收标准
- [ ] 包含测试要求
- [ ] TypeScript 类型安全（如适用）

### 一句话总结

> **好的提示词 = 明确的技术栈 + 具体的功能 + 清晰的约束 + 可验证的标准**
